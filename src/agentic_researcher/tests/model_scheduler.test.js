const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { ModelScheduler, retryAfterMs, durationMs } = require('../model_scheduler');
const { RunTiming } = require('../run_timing');

test('wall-clock deadlines keep running during capacity waits', async () => {
  const timing = new RunTiming({ pauseForCapacity: false });
  const signal = timing.deadline(20);
  const endWait = timing.beginWait();
  try {
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(signal.aborted, true);
    assert.equal(timing.remainingMs(signal), 0);
    assert.ok(timing.capacityWaitMs() >= 20);
  } finally { endWait(); timing.close(); }
});
const { requestJson } = require('../runtime');

const limits = { primary: { tokensPerMinute: 1000, requestsPerMinute: 100, reserveTokens: 300, concurrency: 1 },
  secondary: { tokensPerMinute: 1000, requestsPerMinute: 100, concurrency: 2 } };
const acquire = (scheduler, options = {}) => scheduler.acquire({ choices: [{ model: 'primary' }], tokens: 100, ...options });
const ok = { ok: true, status: 200, headers: new Headers() };

test('separate model pools preserve primary capacity for review and matching', async () => {
  const scheduler = new ModelScheduler({ limits, windowMs: 600000 });
  const page = await acquire(scheduler, { tokens: 700, kind: 'pageAnalysis' });
  page.complete(ok);
  const overflow = await acquire(scheduler, { tokens: 100, kind: 'pageAnalysis',
    choices: [{ model: 'primary' }, { model: 'secondary' }] });
  assert.equal(overflow.model, 'secondary');
  const review = await acquire(scheduler, { tokens: 250 });
  assert.equal(review.model, 'primary');
  overflow.complete(ok); review.complete(ok);
});

test('matching has priority over queued pages; cancellation removes work without charging it', async () => {
  const scheduler = new ModelScheduler({ limits });
  const first = await acquire(scheduler);
  const page = acquire(scheduler, { kind: 'pageAnalysis' });
  const controller = new AbortController();
  const cancelled = acquire(scheduler, { signal: controller.signal });
  const rejection = assert.rejects(cancelled, /cancelled/);
  controller.abort(new Error('cancelled'));
  await rejection;
  const matcher = acquire(scheduler, { kind: 'databaseMatcher' });
  first.complete(ok);
  const next = await matcher;
  assert.equal(scheduler.queue.length, 1);
  next.complete(ok);
  (await page).complete(ok);
  assert.equal(scheduler.queue.length, 0);
});

test('an older discovery page gets capacity before a newly queued review', async () => {
  let now = 0;
  const scheduler = new ModelScheduler({ limits, now: () => now });
  const first = await acquire(scheduler);
  const order = [];
  const page = acquire(scheduler, { kind: 'pageAnalysis', runId: 'later-vehicle' }).then(ticket => {
    order.push('page'); ticket.complete(ok);
  });
  now = 10_000;
  const review = acquire(scheduler, { kind: 'candidateReview', runId: 'earlier-vehicle' }).then(ticket => {
    order.push('review'); ticket.complete(ok);
  });
  first.complete(ok);

  await Promise.all([page, review]);
  assert.deepEqual(order, ['page', 'review']);
});

test('requested-family reviews use the first available slot ahead of broad triage', async () => {
  const scheduler = new ModelScheduler({ limits });
  const first = await acquire(scheduler);
  const order = [];
  const broad = acquire(scheduler, { kind: 'candidateReview' }).then(ticket => {
    order.push('broad'); ticket.complete(ok);
  });
  const requested = acquire(scheduler, { kind: 'candidatePriority' }).then(ticket => {
    order.push('requested'); ticket.complete(ok);
  });
  first.complete(ok);
  await Promise.all([broad, requested]);
  assert.deepEqual(order, ['requested', 'broad']);
});

test('new omission audits yield to requested-family reviews while retaining their own slot', async () => {
  const scheduler = new ModelScheduler({ limits });
  const first = await acquire(scheduler);
  const order = [];
  const audit = acquire(scheduler, { kind: 'omissionAudit' }).then(ticket => {
    order.push('audit'); ticket.complete(ok);
  });
  const requested = acquire(scheduler, { kind: 'candidatePriority' }).then(ticket => {
    order.push('requested'); ticket.complete(ok);
  });
  first.complete(ok);
  await Promise.all([audit, requested]);
  assert.deepEqual(order, ['requested', 'audit']);
});

test('occupied completion slots do not count twice against ordinary admission', async () => {
  const scheduler = new ModelScheduler({ modelConcurrency: 4, completionSlots: 1,
    limits: { primary: { ...limits.primary, reserveTokens: 0, concurrency: 10 } } });
  const tickets = [];
  try {
    tickets.push(await acquire(scheduler, { kind: 'candidateReview' }));
    tickets.push(await acquire(scheduler, { kind: 'databaseMatcher' }));
    tickets.push(await acquire(scheduler, { kind: 'reviewRepair' }));
    tickets.push(await acquire(scheduler, { kind: 'candidateReview', signal: AbortSignal.timeout(500) }));
    assert.equal(scheduler.state('primary').active, 4);
    assert.equal(scheduler.ordinaryActive, 2);
    let granted = false;
    const pending = acquire(scheduler, { kind: 'candidateReview' }).then(ticket => { granted = true; return ticket; });
    await delay(5);
    assert.equal(granted, false);
    tickets[1].cancel();
    tickets.push(await pending);
    assert.equal(scheduler.ordinaryActive, 3);
    tickets[1].cancel(); // Idempotent cancellation cannot refund a second slot.
    assert.equal(scheduler.ordinaryActive, 3);
  } finally { tickets.forEach(ticket => ticket.cancel()); }
  assert.equal(scheduler.ordinaryActive, 0);
});

test('usage refunds unused reservations and provider headers lower local limits', async () => {
  const scheduler = new ModelScheduler({ limits, now: () => 0 });
  const ticket = await acquire(scheduler, { tokens: 500 });
  ticket.complete({ ...ok, headers: new Headers({ 'x-ratelimit-limit-tokens': '800',
    'x-ratelimit-remaining-tokens': '600', 'x-ratelimit-limit-project-tokens': '750' }) },
  { usage: { input_tokens: 100, output_tokens: 50 } });
  assert.equal(scheduler.state('primary').tokens, 600);
  assert.equal(scheduler.state('primary').tokensPerMinute, 750);
  assert.equal(scheduler.state('primary').active, 0);
  ticket.complete(ok); // Completion is idempotent.
  assert.equal(scheduler.state('primary').active, 0);
});

test('in-flight credit holds briefly reduce shared route admission without treating every 402 as capacity', async () => {
  const scheduler = new ModelScheduler({ limits: { primary: { ...limits.primary, concurrency: 4 } }, now: () => 100 });
  const first = await acquire(scheduler);
  first.complete({ ok: false, status: 402, headers: new Headers() });
  assert.equal(scheduler.state('primary').blockedUntil, 0);
  assert.equal(scheduler.state('primary').concurrencyLimit, 4);

  const second = await acquire(scheduler);
  second.complete({ ok: false, status: 402, headers: new Headers() }, { capacityHold: true });
  assert.equal(scheduler.state('primary').blockedUntil, 1600);
  assert.equal(scheduler.state('primary').concurrencyLimit, 2);
});

test('a stalled first-content attempt reduces only that model pool briefly', async () => {
  const scheduler = new ModelScheduler({ limits: { primary: { ...limits.primary, concurrency: 4 },
    secondary: limits.secondary }, now: () => 100 });
  const ticket = await acquire(scheduler);
  ticket.complete(undefined, { firstContentStall: true });
  assert.equal(scheduler.state('primary').concurrencyLimit, 2);
  assert.equal(scheduler.state('primary').blockedUntil, 600);
  assert.equal(scheduler.state('secondary').concurrencyLimit, 2);
});

test('invalid, oversized and overlong queued requests fail explicitly', async () => {
  assert.throws(() => new ModelScheduler({ windowMs: 0 }), /Invalid/);
  const scheduler = new ModelScheduler({ limits, maxWaitMs: 15 });
  await assert.rejects(acquire(scheduler, { tokens: 1001 }), /exceeds/);
  const first = await acquire(scheduler);
  await assert.rejects(acquire(scheduler), /capacity wait exceeded/);
  first.complete(ok);
  assert.equal(scheduler.queue.length, 0);
});

test('parses rate reset units and Retry-After variants', () => {
  assert.equal(durationMs('1m2.5s'), 62500);
  assert.equal(durationMs('12ms'), 12);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '3' })), 3000);
  assert.equal(retryAfterMs(new Headers({ 'retry-after-ms': '25' })), 25);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': 'Thu, 01 Jan 1970 00:00:03 GMT' }), {}, 0), 3000);
  assert.equal(retryAfterMs(null, { error: { message: 'Please try again in 1.242s.' } }), 1242);
});

test('capacity intervals count their union and pause processing deadlines', async () => {
  const timing = new RunTiming();
  try {
    const deadline = timing.deadline(25);
    const endFirst = timing.beginWait();
    const endSecond = timing.beginWait();
    await delay(40);
    endFirst();
    assert.equal(deadline.aborted, false);
    endSecond();
    const summary = timing.summary();
    assert.ok(summary.capacityWaitMs >= 35);
    assert.equal(summary.totalMs, summary.processingMs + summary.capacityWaitMs);
    assert.ok(summary.processingMs < 25);
    await delay(35);
    assert.equal(deadline.aborted, true);
  } finally { timing.close(); }
});

test('maximum capacity waiting and caller cancellation abort every processing deadline', async () => {
  const timing = new RunTiming({ maxCapacityWaitMs: 10 });
  const signal = timing.deadline(1000);
  const end = timing.beginWait();
  await delay(20);
  assert.match(signal.reason.message, /Capacity wait exceeded/);
  assert.equal(timing.deadline(100).aborted, true);
  end(); timing.close();
  const parent = new AbortController();
  const cancelled = new RunTiming({ signal: parent.signal });
  const child = cancelled.deadline(1000);
  parent.abort(new Error('user cancelled'));
  assert.equal(child.reason.message, 'user cancelled');
  cancelled.close();
});

test('HTTP timeouts start after admission and retries honor shared provider cooldowns', async () => {
  const scheduler = new ModelScheduler({ limits: { primary: { tokensPerMinute: 100000, concurrency: 1 } } });
  const first = await acquire(scheduler);
  const timing = new RunTiming();
  let attempts = 0;
  const resultPromise = requestJson('https://api.openai.com/v1/responses', {
    body: JSON.stringify({ model: 'primary', service_tier: 'fast' }),
  }, { scheduler, timing, timeoutMs: 10, request: async () => {
    attempts++;
    return attempts === 1 ? { ok: false, status: 429, headers: new Headers({ 'retry-after-ms': '2100' }),
      json: async () => ({ error: { message: 'Rate limit reached' } }) }
      : { ...ok, json: async () => ({ usage: { input_tokens: 10, output_tokens: 2 } }) };
  } });
  await delay(25);
  first.complete(ok);
  try {
    const result = await resultPromise;
    assert.equal(result._requestModel, 'primary');
    assert.equal(attempts, 2);
    assert.ok(timing.summary().capacityWaitMs >= 2100);
    assert.equal(scheduler.queue.length, 0);
  } finally { timing.close(); }
});

test('billing failures are not retried', async () => {
  let calls = 0;
  const scheduler = new ModelScheduler();
  await assert.rejects(requestJson('https://api.openai.com/v1/responses', {
    body: JSON.stringify({ model: 'primary' }),
  }, { scheduler, request: async () => {
    calls++;
    return { ok: false, status: 429, json: async () => ({ error: { code: 'insufficient_quota' } }) };
  } }), /HTTP 429/);
  assert.equal(calls, 1);
});

test('exhausted provider headers delay admission and rate errors reduce concurrency', async () => {
  const scheduler = new ModelScheduler({ limits: { primary: {
    tokensPerMinute: 1000, requestsPerMinute: 100, concurrency: 8,
  } }, windowMs: 50 });
  const first = await acquire(scheduler);
  first.complete({ ok: false, status: 429, headers: new Headers({
    'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '30ms', 'retry-after-ms': '20',
  }) });
  assert.equal(scheduler.state('primary').concurrencyLimit, 4);
  const start = performance.now();
  (await acquire(scheduler)).complete(ok);
  assert.ok(performance.now() - start >= 25);
  for (let i = 0; i < 7; i++) (await acquire(scheduler, { tokens: 1 })).complete(ok);
  assert.equal(scheduler.state('primary').concurrencyLimit, 5);
});

test('queue limits and lowered provider capacity fail explicitly without leaks', async () => {
  const scheduler = new ModelScheduler({ limits, maxQueue: 1 });
  const first = await acquire(scheduler);
  const queued = acquire(scheduler, { tokens: 700 });
  const rejected = assert.rejects(queued, /exceeds provider token capacity/);
  await assert.rejects(acquire(scheduler), /queue is full/);
  first.complete({ ...ok, headers: new Headers({ 'x-ratelimit-limit-tokens': '500' }) });
  await rejected;
  assert.equal(scheduler.queue.length, 0);
});

test('an admitted HTTP request still times out while another job pauses the run clock', async () => {
  const scheduler = new ModelScheduler();
  const timing = new RunTiming();
  const deadline = timing.deadline(1000);
  const endWait = timing.beginWait();
  try {
    await assert.rejects(requestJson('https://api.openai.com/v1/responses', {
      body: JSON.stringify({ model: 'primary' }),
    }, { scheduler, timing, signal: deadline, retries: 0, timeoutMs: 15,
      request: async (url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    }), { name: 'TimeoutError' });
    assert.equal(deadline.aborted, false);
    assert.ok(timing.modelRequestMs >= 10);
    assert.equal(scheduler.state('primary').active, 0);
  } finally { endWait(); timing.close(); }
});

test('one shared concurrency ceiling spans models and reserves headroom for completion', async () => {
  const scheduler = new ModelScheduler({ modelConcurrency: 3, completionSlots: 1 });
  const first = await scheduler.acquire({ choices: [{ model: 'first' }], tokens: 1, kind: 'candidateReview' });
  const second = await scheduler.acquire({ choices: [{ model: 'second' }], tokens: 1, kind: 'pageAnalysis' });
  let admitted = false;
  const waiting = scheduler.acquire({ choices: [{ model: 'third' }], tokens: 1, kind: 'catalogResearch' })
    .then(ticket => { admitted = true; return ticket; });
  const repair = await scheduler.acquire({ choices: [{ model: 'third' }], tokens: 1, kind: 'reviewRepair' });
  const network = await scheduler.acquire({ choices: [{ model: 'network:fetch' }], tokens: 1 });
  assert.equal(admitted, false);
  first.complete({ ok: true });
  repair.complete({ ok: true });
  (await waiting).complete({ ok: true });
  second.complete({ ok: true });
  network.complete({ ok: true });
  assert.ok([...scheduler.models.values()].every(state => state.active === 0));
});
