'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SettledReviewWork } = require('../settled_review_work');

test('only settled approved colors can start early verification evidence', async () => {
  const offered = [];
  const run = { options: { verification: false },
    verificationResearch: { offer: colors => offered.push(...colors) },
    codeMatches: { start() {} }, warn() {} };
  const source = { page_id: 'P1', url: 'https://paint.example/model', evidence: ['Opal White paint'] };
  const included = { id: 'C1', name: 'Opal White', sources: [source] };
  const excluded = { id: 'C2', name: 'Other White', sources: [source] };
  const queue = new SettledReviewWork(run, {});
  queue.add([included, excluded], { C1: { action: 'include', confidence: 'low',
    source_ids: ['P1'], reason: 'Published paint' }, C2: { action: 'exclude',
    exclude_reason: 'unrelated_vehicle', reason: 'Other model' } });
  queue.flush();

  assert.deepEqual(offered.map(color => color.name), ['Opal White']);
});

test('settled exclusions are audited early once; protected funds release only at the join', async () => {
  const calls = [];
  let released = 0;
  const run = { options: {}, omissionSignal: new AbortController().signal,
    codeMatches: { start() { assert.fail('Excluded paints cannot be matched'); } },
    routing: { budget: { finishOmissionAudit() { released++; } } },
    evidencePages: () => [], warn() {}, dump() {}, log() {},
    mainAgent: async (_stage, _schema, input) => {
      calls.push(input.candidates.map(candidate => candidate.id));
      return { reconsiderations: [] };
    } };
  const queue = new SettledReviewWork(run, {});
  const candidates = Array.from({ length: 25 }, (_, i) => ({ id: `C${i}`, name: `Paint ${i}`, sources: [] }));
  const decisions = Object.fromEntries(candidates.map(candidate => [candidate.id,
    { exclude_reason: 'unrelated_vehicle', reason: 'Another model' }]));
  queue.add(candidates.slice(0, 24), decisions);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(released, 0);
  const summary = await queue.finish(candidates, decisions, []);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.flat(), candidates.map(candidate => candidate.id));
  assert.equal(summary.checked, 25);
  assert.equal(summary.total, 25);
  assert.equal(released, 1);
});

test('failed early audits remain incomplete and never overwrite an existing decision', async () => {
  const decision = { exclude_reason: 'unrelated_vehicle', reason: 'Other model' };
  const candidates = [{ id: 'C1', name: 'Named Paint', sources: [] }];
  const decisions = { C1: decision };
  const queue = new SettledReviewWork({ options: {}, omissionSignal: new AbortController().signal,
    codeMatches: { start() {} }, routing: {}, evidencePages: () => [], warn() {}, dump() {}, log() {},
    mainAgent: async () => { throw new Error('Unavailable'); },
  }, {});
  const summary = await queue.finish(candidates, decisions, []);
  assert.equal(summary.incomplete, 1);
  assert.equal(summary.checked, 0);
  assert.equal(decisions.C1, decision);
});

test('slow omission repairs do not occupy audit slots needed by untouched candidates', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const events = [];
  let audits = 0;
  const run = { options: {}, omissionSignal: new AbortController().signal,
    codeMatches: { start() {} }, routing: {}, warn() {}, dump() {}, log() {},
    evidencePages: () => [{ id: 'P1', url: 'https://example.test/paint', text: 'Model links the named paint.' }],
    mainAgent: async (_stage, _schema, input) => {
      events.push(`audit${++audits}`);
      if (audits === 3) { release(); return { reconsiderations: [] }; }
      const candidate = input.candidates[0];
      return { reconsiderations: [{ candidate_id: candidate.id, issue: 'vehicle',
        evidence_ids: candidate.sources[0].evidence_ids }] };
    },
    reviewCandidate: async candidate => {
      await blocked;
      events.push('repair_complete');
      return { [candidate.id]: { exclude_reason: 'unrelated_vehicle', reason: 'Another model' } };
    } };
  const candidates = Array.from({ length: 72 }, (_, i) => ({ id: `C${i}`, name: `Paint ${i}`,
    sources: [{ page_id: 'P1', url: 'https://example.test/paint', evidence: ['Model links the named paint.'] }] }));
  const decisions = Object.fromEntries(candidates.map(candidate => [candidate.id,
    { exclude_reason: 'unrelated_vehicle', reason: 'Another model' }]));
  const timer = setTimeout(release, 500);
  try {
    const summary = await new SettledReviewWork(run, {}).finish(candidates, decisions, []);
    assert.equal(summary.checked, 72);
    assert.ok(events.indexOf('audit3') < events.indexOf('repair_complete'));
  } finally { clearTimeout(timer); }
});

test('waiting omission work coalesces at admission and the final join includes newly started batches', async () => {
  const releases = [], batches = [];
  let active = 0, peak = 0, releasedBudget = false;
  const run = { options: {}, omissionSignal: new AbortController().signal,
    codeMatches: { start() {} }, evidencePages: () => [], warn() {}, dump() {}, log() {},
    routing: { budget: { finishOmissionAudit() { releasedBudget = true; } } },
    mainAgent: async (_stage, _schema, input) => {
      active++; peak = Math.max(peak, active);
      batches.push(input.candidates.map(candidate => candidate.id));
      if (batches.length <= 2) await new Promise(resolve => releases.push(resolve));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(releasedBudget, false);
      active--;
      return { reconsiderations: [] };
    } };
  const queue = new SettledReviewWork(run, {});
  const candidates = Array.from({ length: 52 }, (_, i) => ({ id: `C${i}`, name: `Paint ${i}`, sources: [] }));
  const decisions = Object.fromEntries(candidates.map(candidate => [candidate.id, 'unrelated_vehicle']));
  for (const candidate of candidates) { queue.add([candidate], decisions); queue.flush(); }
  assert.deepEqual(batches.map(batch => batch.length), [24, 24]);
  const pending = queue.finish(candidates, decisions, []);
  releases.forEach(release => release());
  const summary = await pending;
  assert.deepEqual(batches.map(batch => batch.length), [24, 24, 4]);
  assert.equal(peak, 2);
  assert.equal(summary.checked, 52);
  assert.equal(new Set(batches.flat()).size, 52);
  assert.equal(queue.activeAudits, 0);
  assert.equal(releasedBudget, true);
});
