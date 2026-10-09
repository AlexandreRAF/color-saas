const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cases } = require('../evaluate_vehicles');
const { parseArgs, summarize, runSuite } = require('../vehicle_test_runner');

test('vehicle CLI defaults to every case and validates arguments before paid work', () => {
  assert.deepEqual(parseArgs([]).labels, Object.keys(cases));
  assert.deepEqual(parseArgs(['all']).labels, Object.keys(cases));
  assert.deepEqual(parseArgs(['ix35', 'azera', 'ix35', '--repeat=2', '--json']), {
    labels: ['ix35', 'azera'], repeat: 2, concurrency: 1, json: true, help: false, list: false,
  });
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['--list']).list, true);
  assert.equal(parseArgs(['--concurrency=2']).concurrency, 2);

  for (const args of [['unknown'], ['all', 'ix35'], ['--repeat=0'], ['--repeat=4'], ['--repeat='],
    ['--concurrency=0'], ['--concurrency=8'], ['--concurrency=1.5'], ['--typo']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('explicit vehicle concurrency is bounded and reports remain separate', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-vehicle-concurrent-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let active = 0, peak = 0;
  const directories = new Set();
  const result = await runSuite(parseArgs(['corolla', 'ix35', 'azera', '--concurrency=2']), {
    directory, log: () => {}, evaluate: async (label, caseDirectory) => {
      directories.add(caseDirectory);
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active--;
      return { label, colors: [], cost: 0.01, acceptance: { passed: true, checks: {} } };
    },
  });
  assert.equal(peak, 2);
  assert.equal(directories.size, 3);
  assert.equal(result.concurrency, 2);
  assert.equal(result.runsCompleted, 3);
  assert.equal(result.estimatedCostUsd, 0.03);
});

test('suite runs sequentially, preserves reports and continues after failed checks or exceptions', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-vehicle-suite-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [], messages = [];
  let active = 0;

  const summary = await runSuite(parseArgs(['ix35', 'azera', 'gol', '--repeat=2']), {
    directory, log: message => messages.push(message),
    evaluate: async (label, caseDirectory) => {
      assert.equal(active++, 0);
      calls.push([label, path.basename(caseDirectory)]);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      if (label === 'azera') throw new Error('Provider unavailable');

      return { label, timeMs: 39000, cost: 0.04, colors: [{ name: 'Example Paint' }],
        verification: { status: 'partial' }, searchCache: { HIT: 1 },
        acceptance: { passed: label === 'ix35', checks: { referenceFound: label === 'ix35' } } };
    },
  });

  assert.deepEqual(calls.map(([, name]) => name), ['ix35-1', 'ix35-2', 'azera-1', 'azera-2', 'gol-1', 'gol-2']);
  assert.equal(summary.completed, true);
  assert.equal(summary.passed, 2);
  assert.equal(summary.failed, 4);
  assert.equal(summary.estimatedCostUsd, 0.16);
  assert.equal(summary.runsWithoutCost, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'summary.json'), 'utf8')), summary);
  assert.equal(fs.readFileSync(path.join(directory, 'summary.jsonl'), 'utf8').trim().split('\n').length, 6);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'azera-1/error.json'), 'utf8')).error, 'Provider unavailable');
  assert.ok(messages.some(message => message.includes('verification is partial')));
  assert.ok(messages.some(message => message.includes('Search cache hits: 1')));
  assert.ok(messages.some(message => message.includes('Failed: referenceFound')));
});

test('JSON mode emits one parseable record per case and keeps full color information', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-vehicle-json-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lines = [];

  await runSuite(parseArgs(['ix35', '--json']), {
    directory, log: line => lines.push(line),
    evaluate: async label => ({ label, timeMs: 33000, cost: 0.03,
      colors: [{ name: 'Shimmering Silver', codes: ['N3S'], paintFinish: ['metálico'] }],
      acceptance: { passed: true, checks: { referenceFound: true } } }),
  });

  assert.equal(lines.length, 1);
  const result = JSON.parse(lines[0]);
  assert.equal(result.colors[0].name, 'Shimmering Silver');
  assert.deepEqual(result.colors[0].codes, ['N3S']);
  assert.equal(result.report, path.join(directory, 'summary.json'));
});

test('partial summaries distinguish unfinished runs from failed cases and unknown costs', () => {
  const summary = summarize([{ acceptance: { passed: true }, cost: 0.02 }], 7, '/tmp/example');
  assert.equal(summary.completed, false);
  assert.equal(summary.runsCompleted, 1);
  assert.equal(summary.expectedRuns, 7);
  assert.equal(summary.failed, 0);
});
