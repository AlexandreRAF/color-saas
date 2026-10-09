'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { candidateInventory, inventoryCodes } = require('../candidate_inventory');
const { outputColors } = require('../final_output');
const { groupCatalogReviews, expandGroupDecision } = require('../review_groups');
const { reviewInventory } = require('../review_stage');
const { repairUnreviewed } = require('../completion_review');
const { RunTiming } = require('../run_timing');
const { pipelineDeadlines } = require('../research_deadlines');
const { applyChecks } = require('../final_verification_agent');
const { AiBudget } = require('../ai_budget');
const { CatalogResearch } = require('../catalog_research');
const { ReviewBatcher } = require('../review_batcher');
const { splitPaintNames } = require('../paint_name');
const { requestMainAgent } = require('../research_model');

const vehicle = { brand: 'Toyota', model: 'Corolla', manufacturingYear: 2018 };

test('unknown marketing hues receive evidence triage and uncertain repairs receive full review', async () => {
  const route = name => ({ add: async () => name });
  const run = { options: {}, reviewBatcher: route('full'), broadReviewBatcher: route('triage'),
    retryReviewBatcher: route('full-repair'), retryBroadReviewBatcher: route('full-repair-other') };
  const schema = { properties: { action: {} } };
  const inspect = (name, color, stage = 'research_review_C1') => requestMainAgent(run, stage, schema,
    { vehicle: { ...vehicle, predominantColor: color }, candidates: [{ name }] }, '', undefined);
  assert.equal(await inspect('Underground', 'branco'), 'triage');
  assert.equal(await inspect('Crystal Ice', 'branco'), 'triage');
  assert.equal(await inspect('Prata Shark', 'cinza'), 'full');
  assert.equal(await inspect('Hyper White', 'branco'), 'full');
  assert.equal(await inspect('Underground', undefined), 'full');
  assert.equal(await inspect('Crystal Ice', 'branco', 'research_review_completion_C1'), 'full-repair-other');
});

test('uncertain triage requests a first full review without consuming completion repair', async () => {
  const signal = new AbortController().signal;
  const input = { vehicle: { ...vehicle, predominantColor: 'branco' }, candidates: [{ name: 'Crystal Ice' }] };
  let fullReviews = 0;
  const run = { options: {}, broadReviewBatcher: { add: async () => {
    throw Object.assign(new Error('Evidence needs full review'), { code: 'REVIEW_REQUIRED' });
  } }, reviewBatcher: { add: async item => {
    fullReviews++;
    assert.equal(item.signal, signal);
    assert.equal(item.input.candidates, input.candidates);
    assert.equal(item.input.review_issue, 'Evidence needs full review');
    return { action: 'include' };
  } } };
  const result = await requestMainAgent(run, 'research_review_C1', { properties: { action: {} } }, input, '', signal);
  assert.equal(result.action, 'include');
  assert.equal(fullReviews, 1);
  assert.equal(run.retryBroadReviewBatcher, undefined);
});
const page = { id: 'P1', url: 'https://catalog.test/toyota', status: 'ok',
  text: 'Color code: 070 Blizzard Pearl. Color code: 209 Black Sand Pearl.',
  candidates: [
    { name: 'TOY-209 / TOY-070', evidence: ['TOY-209 / TOY-070, two-tone 2KR'] },
    { name: 'Blizzard Pearl', evidence: ['Color code: 070 Blizzard Pearl'] },
    { name: 'Silver 77', evidence: ['Silver 77'] },
    { name: 'Rosso 2C', evidence: ['Rosso 2C'] },
    { name: 'TOY-999', evidence: ['TOY-999'] },
  ] };

test('catalog references inside parentheses never become separate paint candidates', () => {
  assert.deepEqual(splitPaintNames('YELLOW (COMM.) (PAG.835/MAZ.3), Moon White'),
    ['YELLOW (COMM.) (PAG.835/MAZ.3)', 'Moon White']);
  assert.deepEqual(splitPaintNames('Pearl (Ivory/White), Silver 77'), ['Pearl (Ivory/White)', 'Silver 77']);
});

test('documented web code combinations are checked before splitting; real numbered names survive', () => {
  const artifacts = [];
  const candidates = candidateInventory([page], { manufacturer: 'Toyota', onArtifact: row => artifacts.push(row) });
  assert.deepEqual(candidates.map(row => row.name), ['Blizzard Pearl', 'Silver 77', 'Rosso 2C', 'TOY-999']);
  assert.deepEqual(artifacts.map(row => row.name), ['TOY-209 / TOY-070']);
  assert.ok(inventoryCodes([page]).has('070'));
  assert.ok(candidateInventory([page], { manufacturer: 'Other' }).some(row => row.name === 'TOY-070'));
});

test('final formatting cannot reintroduce documented code labels after matching or completion repair', () => {
  const colors = ['TOY-070', 'TOY-209', 'Blizzard Pearl', 'Silver 77'].map(name => ({ name,
    universal_code: name.startsWith('TOY') ? '2KR' : '070', sources: [page.url], code_candidates: [] }));
  const artifacts = [];
  const output = outputColors(colors, { manufacturer: 'Toyota', documentedCodes: inventoryCodes([page]),
    onArtifact: row => artifacts.push(row) });
  assert.deepEqual(output.map(row => row.name), ['Blizzard Pearl', 'Silver 77']);
  assert.equal(artifacts.length, 2);
  assert.equal(colors.length, 4, 'formatting must not mutate the agent palette');
});

function aliases() {
  const evidence = ['Toyota Corolla: Moon White / Branco Lunar, color code A1. Finish: pearl.'];
  const sources = [{ page_id: 'P1', url: page.url, evidence }];
  return ['Moon White', 'Branco Lunar'].map((name, index) => ({ id: `C${index}`, name,
    sources: structuredClone(sources) }));
}

const row = { manufacturer: 'Toyota', universal_code: 'A1', complete_name_match: true,
  model: 'Corolla', model_match: 'exact', year: '2018', paintFinish: ['perolizado'] };

test('web aliases need explicit shared names, code, finish and identical applicability evidence', async () => {
  const candidates = aliases();
  const catalogs = { get: async () => ({ candidates: [row] }) };
  let groups = await groupCatalogReviews(candidates, catalogs, vehicle);
  assert.equal(groups.length, 1);
  const decisions = expandGroupDecision(groups[0], { C0: { action: 'include', source_ids: ['P1'] } });
  assert.deepEqual(decisions.C1.source_ids, ['P1']);
  candidates[1].sources.push({ page_id: 'P2', url: 'https://other.test/', evidence: ['Branco Lunar is for Corolla Cross only.'] });
  groups = await groupCatalogReviews(candidates, catalogs, vehicle);
  assert.equal(groups.length, 2, 'a qualification must prevent shared review');
  const independent = aliases();
  independent[1].sources[0].evidence = ['Corolla Branco Lunar A1'];
  assert.equal((await groupCatalogReviews(independent, catalogs, vehicle)).length, 2);
  assert.equal((await groupCatalogReviews(aliases(), { get: async () => ({ candidates: [
    row, { ...row, universal_code: 'B2' },
  ] }) }, vehicle)).length, 2);
});

test('only proved aliases with unchanged matched codes and finishes share final verification', () => {
  const colors = aliases().map(candidate => ({ name: candidate.name, sources: [page.url],
    universal_code: 'A1', code_candidates: [], paintFinish: ['perolizado'] }));
  assert.equal(outputColors(colors).length, 2, 'same code alone does not prove aliases');
  const options = { aliasGroups: [['Moon White', 'Branco Lunar']] };
  const output = outputColors(colors, options);
  assert.equal(output.length, 1);
  assert.equal(output[0].name, 'Branco Lunar');
  assert.deepEqual(output[0].aliases, ['Moon White']);
  assert.equal(outputColors([colors[0], { ...colors[1], universal_code: 'B2' }], options).length, 2);
});

test('name verification checks every alias; shared codes cannot confirm an unmentioned alias', () => {
  const color = { name: 'Moon White', aliases: ['Branco Lunar'], codes: ['A1'], sources: [], paintFinish: [] };
  const p = { id: 'P1', url: page.url, text: 'Corolla Moon White A1' };
  const check = { source_id: 'P1', quote: p.text, confirmed: ['name', 'codes'], conflicting: [] };
  const checked = applyChecks(color, [check], [p], vehicle, true);
  assert.ok(checked.verification.unknown.includes('name'));
  assert.ok(checked.verification.confirmed.includes('codes'));
  const p2 = { id: 'P2', url: 'https://local.test/', text: 'Corolla Branco Lunar A1' };
  const complete = applyChecks(color, [check, { ...check, source_id: 'P2', quote: p2.text }], [p, p2], vehicle, true);
  assert.ok(complete.verification.confirmed.includes('name'));
});

test('failed candidates enter only one completion wave and valid decisions are never repeated', async () => {
  const candidates = ['A', 'B'].map(id => ({ id, name: `Named Paint ${id}`, sources: [] }));
  const initial = [], repairs = [];
  const run = { options: {}, routing: {}, timing: { signal: new AbortController().signal },
    reviewSignal: new AbortController().signal, catalogs: { get: async () => ({ candidates: [] }) },
    log() {}, warn() {}, dump() {},
    reviewPipeline: { finish: async candidate => {
      initial.push(candidate.id);
      if (candidate.id === 'B') throw new Error('Malformed answer');
      return { A: { exclude_reason: 'unrelated_vehicle', reason: 'Other model' } };
    } }, reviewCandidate: async candidate => { repairs.push(candidate.id); throw new Error('Still invalid'); } };
  const state = await reviewInventory(run, vehicle, candidates);
  assert.deepEqual(initial, ['A', 'B']);
  await repairUnreviewed(run, vehicle, candidates, state);
  await repairUnreviewed(run, vehicle, candidates, state);
  assert.deepEqual(repairs, ['B']);
  assert.deepEqual(state.unreviewedCandidates.map(candidate => candidate.id), ['B']);
  assert.equal(state.reviewedCandidates.length, 1);
});

test('a budget failure is not retried when no new funds are available', async () => {
  const budget = new AiBudget(0.06, {}, { matchingFraction: 0.06, omissionFraction: 0.1, verificationFraction: 0.2 });
  budget.spent = 0.06;
  budget.finishReviews();
  assert.equal(budget.canRetryReview({ details: { estimatedRequestUsd: 0.001 } }), false);
  budget.spent = 0.02;
  assert.equal(budget.canRetryReview({ details: { estimatedRequestUsd: 0.001 } }), true);
});

test('completion repair starts before an independent slow first-pass review finishes', async () => {
  const candidates = ['A', 'B'].map(id => ({ id, name: `Named Paint ${id}`, sources: [] }));
  const events = [];
  let releaseSlow;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  const decision = id => ({ [id]: { exclude_reason: 'unrelated_vehicle', reason: 'Other model' } });
  const signal = new AbortController().signal;
  const run = { options: {}, routing: {}, timing: { signal }, reviewSignal: signal,
    catalogs: { get: async () => ({ candidates: [] }) }, log() {}, warn() {}, dump() {},
    reviewPipeline: { finish: async candidate => {
      if (candidate.id === 'B') throw new Error('Malformed answer');
      await slow;
      events.push('slow_finished');
      return decision('A');
    } }, reviewCandidate: async candidate => {
      events.push('repair_started');
      releaseSlow();
      return decision(candidate.id);
    } };

  const state = await reviewInventory(run, vehicle, candidates);
  assert.deepEqual(events, ['repair_started', 'slow_finished']);
  assert.equal(state.reviewedCandidates.length, 2);
  assert.deepEqual(state.repairSummary, { attempted: 1, recovered: 1 });
});

test('completion carries the failed route and validation issue without restarting its provider', async () => {
  const candidate = { id: 'A', name: 'Named Paint', sources: [] };
  const signal = new AbortController().signal;
  const failure = Object.assign(new Error('Model stalled'), {
    routeId: 'openrouter:qwen/example', code: 'MODEL_ROUTE_TIMEOUT',
  });
  const run = { options: {}, routing: {}, timing: { signal }, reviewSignal: signal,
    catalogs: { get: async () => ({ candidates: [] }) }, log() {}, warn() {}, dump() {},
    reviewPipeline: { finish: async () => { throw failure; } },
    reviewCandidate: async (_candidate, _vehicle, _signal, _stage, recovery) => {
      assert.deepEqual(recovery, { startAfter: failure.routeId, issue: failure.message });
      return { A: { exclude_reason: 'unrelated_vehicle', reason: 'Other model' } };
    } };
  const state = await reviewInventory(run, vehicle, [candidate]);
  assert.equal(state.reviewedCandidates.length, 1);
});

test('stage deadlines are absolute, include queue waits and cannot be extended by retries', async () => {
  const timing = new RunTiming({ pauseForCapacity: false });
  try {
    const stages = pipelineDeadlines(timing, 100, 100);
    assert.equal(stages.cutoffs.verification, 98);
    assert.equal(timing.extendDeadline(stages.signals.review, 9999), false);
    const release = timing.beginWait();
    await new Promise(resolve => setTimeout(resolve, 80));
    release();
    assert.equal(stages.signals.review.aborted, true);
    assert.equal(stages.signals.repair.aborted, true);
    assert.equal(timing.signal.aborted, false, 'partial results can still be serialized');
  } finally { timing.close(); }
});

test('matching reuses all catalog rows only while the complete name and source codes are unchanged', async () => {
  let calls = 0;
  const catalogs = new CatalogResearch(vehicle, { signal: new AbortController().signal,
    deferIdentity: true, lookup: async () => {
      calls++;
      return { catalogs_queried: ['lazzumix', 'basf', 'basf_models'], candidates: [row] };
    } });
  try {
    const candidate = { name: 'Moon White', sources: [{ evidence: ['Color code: A1 Moon White'] }] };
    await catalogs.get(candidate);
    const color = { name: candidate.name, source_evidence: [{ source_name: candidate.name,
      passages: candidate.sources[0].evidence }] };
    assert.equal((await catalogs.cachedFor(color)).candidates.length, 1);
    assert.equal(calls, 1);
    assert.equal(await catalogs.cachedFor({ ...color, name: 'Another White' }), null);
    assert.equal(await catalogs.cachedFor({ ...color,
      source_evidence: [{ source_name: color.name, passages: ['Color code: B2 Moon White'] }] }), null);
  } finally { catalogs.close(); }
});

test('main-review cancellation keeps validated siblings without a nested repair or split wave', async () => {
  let calls = 0;
  const batcher = new ReviewBatcher(async () => {
    calls++;
    throw Object.assign(new Error('deadline'), { code: 'MODEL_ROUTE_TIMEOUT', partialOutput: { R1: { done: true } } });
  }, { size: 2, repairInvalid: false, splitTimeouts: false });
  const item = { instructions: '', schema: { type: 'object', properties: { done: { type: 'boolean' } },
    required: ['done'], additionalProperties: false },
    input: { vehicle, candidates: [], evidence: {}, pages: [] }, signal: new AbortController().signal };
  const results = await Promise.allSettled([batcher.add(item), batcher.add(item)]);
  assert.equal(calls, 1);
  assert.deepEqual(results[0].value, { done: true });
  assert.equal(results[1].status, 'rejected');
});
