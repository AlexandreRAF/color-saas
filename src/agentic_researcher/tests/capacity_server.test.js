'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { startCapacityServer } = require('../capacity_server');
const { CapacityClient } = require('../capacity_client');
const { ModelScheduler } = require('../model_scheduler');
const { admitRun } = require('../run_admission');
const { RunTiming } = require('../run_timing');

const limits = { test: { tokensPerMinute: 1000, requestsPerMinute: 100, reserveTokens: 0, concurrency: 1 } };

async function broker(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-broker-test-'));
  const socket = path.join(directory, 'broker.sock');
  const server = await startCapacityServer(socket, { scheduler: new ModelScheduler({ limits }), ...options });
  t.after(async () => { await server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { ...server, socket };
}

test('separate processes share one concurrency pool and release tickets', async t => {
  const server = await broker(t);
  const child = name => fork(path.join(__dirname, 'fixtures/capacity_worker.cjs'), [server.socket, name],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const first = child('first');
  t.after(() => first.kill());
  assert.equal((await once(first, 'message'))[0].granted, true);
  const second = child('second');
  t.after(() => second.kill());
  let granted = false;
  second.once('message', () => { granted = true; });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(granted, false);
  const next = once(second, 'message');
  const firstExit = once(first, 'exit');
  first.send('release');
  assert.equal((await next)[0].granted, true);
  const secondExit = once(second, 'exit');
  second.send('release');
  await Promise.all([firstExit, secondExit]);
  assert.equal(server.scheduler.state('test').active, 0);
});

test('domain scope survives the coordinator protocol across independent clients', async t => {
  const scheduler = new ModelScheduler({ limits: { test: { ...limits.test,
    concurrency: 3, scopeConcurrency: 1 } } });
  const server = await broker(t, { scheduler });
  const firstClient = new CapacityClient(server.socket), secondClient = new CapacityClient(server.socket);
  t.after(() => { firstClient.close(); secondClient.close(); });
  const options = { choices: [{ model: 'test' }], tokens: 1, scope: 'paint.test' };
  const first = await firstClient.acquire(options);
  let granted = false;
  const queued = secondClient.acquire(options).then(ticket => { granted = true; return ticket; });
  const different = await secondClient.acquire({ ...options, scope: 'catalog.test' });
  assert.equal(granted, false);
  first.complete();
  (await queued).complete();
  different.complete();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(scheduler.scopes.size, 0);
});

test('coordinator shares the combined model ceiling and repair headroom across clients', async t => {
  const scheduler = new ModelScheduler({ modelConcurrency: 3, completionSlots: 1,
    limits: Object.fromEntries(['one', 'two', 'three', 'four'].map(model => [model, limits.test])) });
  const server = await broker(t, { scheduler });
  const firstClient = new CapacityClient(server.socket), secondClient = new CapacityClient(server.socket);
  t.after(() => { firstClient.close(); secondClient.close(); });
  const first = await firstClient.acquire({ choices: [{ model: 'one' }], tokens: 1, kind: 'pageAnalysis' });
  const second = await secondClient.acquire({ choices: [{ model: 'two' }], tokens: 1, kind: 'candidateReview' });
  let granted = false;
  const pending = firstClient.acquire({ choices: [{ model: 'three' }], tokens: 1, kind: 'candidateReview' })
    .then(ticket => { granted = true; return ticket; });
  const repair = await secondClient.acquire({ choices: [{ model: 'four' }], tokens: 1, kind: 'reviewRepair' });
  assert.equal(granted, false);
  assert.equal([...scheduler.models.values()].reduce((sum, model) => sum + model.active, 0), 3);
  first.complete();
  repair.complete();
  (await pending).complete();
  second.complete();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok([...scheduler.models.values()].every(model => model.active === 0));
});

test('coordinator receives temporary credit pressure from another worker', async t => {
  const scheduler = new ModelScheduler({ limits: { test: { ...limits.test, concurrency: 4 } }, now: () => 100 });
  const server = await broker(t, { scheduler });
  const client = new CapacityClient(server.socket);
  t.after(() => client.close());
  const ticket = await client.acquire({ choices: [{ model: 'test' }], tokens: 1 });
  ticket.complete({ ok: false, status: 402, headers: new Headers() }, { capacityHold: true });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(scheduler.state('test').blockedUntil, 1600);
  assert.equal(scheduler.state('test').concurrencyLimit, 2);
});

test('coordinator receives a first-content stall from a worker', async t => {
  const scheduler = new ModelScheduler({ limits: { test: { ...limits.test, concurrency: 4 } }, now: () => 100 });
  const server = await broker(t, { scheduler });
  const client = new CapacityClient(server.socket);
  t.after(() => client.close());
  const ticket = await client.acquire({ choices: [{ model: 'test' }], tokens: 1 });
  ticket.complete(undefined, { firstContentStall: true });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(scheduler.state('test').blockedUntil, 600);
  assert.equal(scheduler.state('test').concurrencyLimit, 2);
});

test('queue cancellation refunds unsent work and coordinator failure stays explicit', async t => {
  const server = await broker(t);
  const client = new CapacityClient(server.socket);
  t.after(() => client.close());
  const first = await client.acquire({ choices: [{ model: 'test' }], tokens: 10 });
  const controller = new AbortController();
  const pending = client.acquire({ choices: [{ model: 'test' }], tokens: 10, signal: controller.signal });
  controller.abort(new Error('Cancelled'));
  await assert.rejects(pending, /Cancelled/);
  first.cancel();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(server.scheduler.state('test').active, 0);
  const absent = new CapacityClient(server.socket + '-missing');
  await assert.rejects(absent.acquire({ choices: [{ model: 'test' }], tokens: 10 }));
  absent.close();
});

test('disconnected worker keeps its unknown-use lease until expiry', async t => {
  const server = await broker(t, { leaseMs: 80 });
  const client = new CapacityClient(server.socket);
  await client.acquire({ choices: [{ model: 'test' }], tokens: 10 });
  client.close();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(server.scheduler.state('test').active, 1);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(server.scheduler.state('test').active, 0);
  assert.ok(server.scheduler.state('test').tokens < 995);
});

test('same-priority vehicles take turns when model capacity is released', async () => {
  const scheduler = new ModelScheduler({ limits });
  const acquire = runId => scheduler.acquire({ choices: [{ model: 'test' }], tokens: 1, runId });
  const first = await acquire('A');
  const order = [];
  const queued = ['A', 'A', 'B'].map(runId => acquire(runId).then(ticket => {
    order.push(runId); ticket.cancel();
  }));
  first.cancel();
  await Promise.all(queued);
  assert.deepEqual(order, ['B', 'A', 'A']);
});

test('a faulty wait observer cannot disconnect other requests', async t => {
  const server = await broker(t);
  const client = new CapacityClient(server.socket);
  t.after(() => client.close());
  const first = await client.acquire({ choices: [{ model: 'test' }], tokens: 1 });
  const queued = client.acquire({ choices: [{ model: 'test' }], tokens: 1,
    onWait: () => { throw new Error('Observer failed'); } });
  await new Promise(resolve => setTimeout(resolve, 20));
  first.cancel();
  const next = await queued;
  next.cancel();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(server.scheduler.state('test').active, 0);
});

test('cancellation bounds a stalled coordinator connection without sending an acquisition', async () => {
  const client = new CapacityClient('/not-connected');
  let release;
  client.connect = () => new Promise(resolve => { release = resolve; });
  client.send = () => assert.fail('Cancelled connection must not send work');
  const controller = new AbortController();
  const result = client.acquire({ choices: [{ model: 'test' }], tokens: 1, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('Connection cancelled'));
  await assert.rejects(result, /Connection cancelled/);
  release({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.pending.size, 0);
});

test('independent clients share production run admission through one coordinator', async t => {
  const scheduler = new ModelScheduler({ limits: { 'network:run': limits.test } });
  const server = await broker(t, { scheduler });
  const clients = Array.from({ length: 7 }, () => new CapacityClient(server.socket));
  const timing = new RunTiming({ pauseForCapacity: false });
  t.after(() => { clients.forEach(client => client.close()); timing.close(); });
  // Establish sockets first; this test measures run admission rather than startup.
  await Promise.all(clients.map(client => client.connect()));
  const results = await Promise.allSettled(clients.map(client => admitRun({ production: true,
    scheduler: client, admissionTimeoutMs: 40 }, client, timing, () => {}, {})));
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.filter(row => row.reason?.code === 'RUN_CAPACITY_BUSY').length, 6);
  for (const result of results) if (result.status === 'fulfilled') result.value.cancel();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(scheduler.state('network:run').active, 0);
});
