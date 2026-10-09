const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { searchRequest, sharedSearch } = require('../search_request');
const { browse } = require('../openserp_browse');
const { RunTiming } = require('../run_timing');
const { researchBudget } = require('../research_deadlines');
const { sparseResearchQueries } = require('../research_plan');
const { searchFailure } = require('../search_errors');

const ok = results => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ results }) });

test('processing deadline errors retain a retryable search timeout diagnosis', () => {
  const error = searchFailure(new Error('Processing deadline exceeded'), undefined, 'openserp');
  assert.equal(error.details.code, 'SEARCH_TIMEOUT');
  assert.equal(error.details.retryable, true);
});

test('Retry-After pauses only the affected engine and avoids a retry that cannot fit', async () => {
  const state = {}, events = [], signal = new AbortController().signal;
  let calls = 0;
  await assert.rejects(searchRequest('https://search.test', { engine: 'google', state, signal,
    remainingMs: () => 1500, onEvent: (event, detail) => events.push({ event, ...detail }),
    request: async () => { calls++; return { ok: false, status: 429,
      headers: new Headers({ 'retry-after': '2' }), json: async () => ({ error: 'rate limited' }) }; },
  }), error => error.status === 429 && error.retryAfterMs === 2000);
  assert.equal(calls, 1);
  assert.ok(state.cooldowns.get('google') > Date.now());
  await searchRequest('https://search.test', { engine: 'bing', state, signal, request: async () => ok([]) });
  await assert.rejects(searchRequest('https://search.test', { engine: 'google', state, signal,
    remainingMs: () => 500, request: async () => { throw new Error('Must remain paused'); } }), /cooldown/);
  assert.ok(events.some(event => event.event === 'search_engine_attempt_failed' && event.status === 429));
});

test('a timeout cannot start a retry with less than the minimum useful time', async () => {
  let remaining = 3000, calls = 0;
  await assert.rejects(searchRequest('https://search.test', { engine: 'google', state: {},
    signal: new AbortController().signal, remainingMs: () => remaining,
    request: async () => { calls++; remaining = 500; throw new DOMException('Timed out', 'TimeoutError'); },
  }), /Timed out/);
  assert.equal(calls, 1);
});

test('identical pending searches share work; cancellation of one subscriber preserves its peer', async () => {
  const state = {}, first = new AbortController(), second = new AbortController();
  let calls = 0, release;
  const operation = async ({ signal, onSource }) => {
    calls++;
    await new Promise(resolve => { release = resolve; });
    assert.equal(signal.aborted, false);
    onSource('source');
    return 'result';
  };
  const left = sharedSearch(state, 'key', operation, { signal: first.signal });
  const received = [];
  const right = sharedSearch(state, 'key', operation, { signal: second.signal, onSource: row => received.push(row) });
  const rejected = assert.rejects(left, /caller stopped/);
  await Promise.resolve();
  first.abort(new Error('caller stopped'));
  release();
  await rejected;
  assert.equal(await right, 'result');
  assert.equal(calls, 1);
  assert.deepEqual(received, ['source']);
  assert.equal(state.pending.size, 0);
});

test('a fast source streams before a slow redirect finishes', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const delivered = [];
  const result = browse(['query'], { host: 'localhost:7000', engines: ['google'],
    onSource: row => { delivered.push(row.results[0].url); release(); },
    request: async url => {
      if (new URL(url).hostname === 'localhost') return ok([
        { url: '/goto?url=slow', title: 'Slow' }, { url: 'https://paint.test/fast', title: 'Fast' },
      ]);
      await blocked;
      return { status: 302, headers: new Headers({ location: 'https://paint.test/slow' }) };
    },
  });
  await result;
  assert.deepEqual(delivered, ['https://paint.test/fast', 'https://paint.test/slow']);
});

test('a shared run queue caps each engine at two requests across overlapping browse calls', async () => {
  const active = {}, peak = {}, state = {};
  const request = async url => {
    const engine = new URL(url).pathname;
    active[engine] = (active[engine] || 0) + 1;
    peak[engine] = Math.max(peak[engine] || 0, active[engine]);
    await delay(5);
    active[engine]--;
    return ok([]);
  };
  await Promise.all([browse(['a', 'b', 'c'], { host: 'localhost:7000', request, state }),
    browse(['d', 'e', 'f'], { host: 'localhost:7000', request, state })]);
  assert.deepEqual(Object.values(peak), [2, 2, 2]);
});

test('starved discovery extends existing stage signals without consuming review reserves', async () => {
  const timing = new RunTiming({ pauseForCapacity: false });
  const events = [];
  const budget = researchBudget(timing, 360, () => true, event => events.push(event));
  try {
    await delay(145);
    assert.equal(budget.signals.search.aborted, false);
    assert.ok(events.includes('research_budget_extended'));
    assert.ok(timing.remainingMs(budget.signals.recovery) < 140);
    await delay(50);
    assert.equal(budget.signals.search.aborted, true);
  } finally { budget.close(); timing.close(); }
});

test('irrelevant candidates still trigger broad catalog recovery for the actual vehicle', () => {
  const candidates = [{ name: 'Race Red', sources: [{ url: 'https://paint.test/ford/puma', evidence: ['Ford Puma Race Red'] }] }];
  assert.equal(sparseResearchQueries({ brand: 'Puma', model: 'Puma GTS' }, candidates).length, 2);
  candidates[0].sources[0].evidence.push('Puma GTS Race Red');
  assert.equal(sparseResearchQueries({ brand: 'Puma', model: 'Puma GTS' }, candidates).length, 0);
});
