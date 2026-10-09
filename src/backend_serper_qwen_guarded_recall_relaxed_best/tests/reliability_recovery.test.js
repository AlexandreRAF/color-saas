'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { recoverDiscovery, initialSourceAllowance } = require('../discovery_pipeline');
const { reviewInventory } = require('../review_stage');
const { exactCatalogIdentity } = require('../database_code_agent');
const { groupCatalogReviews, combinedCandidate, expandGroupDecision } = require('../review_groups');
const { paletteCoverage, repairUnreviewed } = require('../completion_review');
const { ModelScheduler } = require('../model_scheduler');
const { AiBudget } = require('../ai_budget');
const { isCatalogCodeLabel } = require('../model_evidence');

const vehicle = { brand: 'Example', model: 'Example GT', manufacturingYear: 2018 };
const row = { manufacturer: 'Example', description: 'Moon White', universal_code: 'A1',
  candidate_id: 1, complete_name_match: true, paintFinish: ['perolizado'] };

test('unique complete catalog names match without borrowing another output color code', () => {
  assert.deepEqual(exactCatalogIdentity('Moon White', [row], 'Example'), [row]);
  assert.deepEqual(exactCatalogIdentity('Moon White', [row, { ...row, universal_code: 'A2' }], 'Example'), []);
  assert.deepEqual(exactCatalogIdentity('Moon White', [row], 'Another'), []);
  assert.deepEqual(exactCatalogIdentity('Moon White', [row], 'Example', ['A2']), []);
  assert.deepEqual(exactCatalogIdentity('Moon', [row], 'Example'), []);
  assert.deepEqual(exactCatalogIdentity('Moon White', [{ ...row, complete_name_match: false }], 'Example'), []);
});

test('recovery admits manufacturer catalogs only after inadequate model evidence', async () => {
  const run = { pages: [], maxPages: 24, searchJobs: [], attempted: new Set(),
    index: new Map(), queries: new Set(), candidates: () => [], log() {}, warn() {},
    search: async queries => {
      assert.ok(queries.every(query => !query.includes('Example Example')));
      run.index.set('https://catalog.test/paint', { url: 'https://catalog.test/paint',
        title: 'Example original paint colors', snippet: 'Manufacturer palette', rank: 1 });
    },
    readSources: async sources => { run.selected = sources; },
  };
  await recoverDiscovery(run, vehicle, new AbortController().signal);
  assert.equal(run.selected.length, 1);
  assert.equal(run.discoveryCoverage.recoveryAttempted, true);
  run.searchBlocked = new Error('No credits');
  run.search = () => { throw new Error('Must not retry exhausted credits'); };
  await recoverDiscovery(run, vehicle, new AbortController().signal);
});

test('adequate independent paint coverage does not refill a download quota', async () => {
  const pages = ['one', 'two', 'three'].map(host => ({ url: `https://${host}.test/paint`, status: 'ok',
    candidates: [{ name: 'Moon White' }, { name: 'Night Black' }, { name: 'Ocean Blue' }] }));
  const run = { pages, maxPages: 24, candidates: () => pages[0].candidates,
    search: () => assert.fail('No recovery searches for adequate coverage'),
    readSources: () => assert.fail('No replacement pages just to reach 20 downloads'),
  };
  await recoverDiscovery(run, vehicle, new AbortController().signal);
});

test('many readable pages on one domain still require independent source recovery', async () => {
  let searches = 0;
  const run = { pages: Array.from({ length: 20 }, (_, index) => ({
    url: `https://one.test/paint/${index}`, status: 'ok', candidates: [{ name: 'Moon White' }] })),
    maxPages: 24, candidates: () => [{ name: 'Moon White' }], searchJobs: [],
    index: new Map(), attempted: new Set(), log() {}, warn() {},
    search: async () => { searches++; }, readSources: async () => {},
  };
  await recoverDiscovery(run, vehicle, new AbortController().signal);
  assert.equal(searches, 1);
  assert.equal(run.discoveryCoverage.needsExpansion, true);
});

test('streamed search results leave half the initial slots for the completed search inventory', () => {
  const run = { pages: [] };
  assert.equal(initialSourceAllowance(run, vehicle, 20), 4);
  run.pages.push(...Array(5).fill({}));
  assert.equal(initialSourceAllowance(run, vehicle, 20), 4);
  run.pages.push(...Array(5).fill({}));
  assert.equal(initialSourceAllowance(run, vehicle, 20), 0);
  assert.equal(initialSourceAllowance({ pages: [] }, vehicle, 1), 1);
  assert.equal(initialSourceAllowance({ pages: [] }, vehicle, 0), 0);
});

test('stable candidates reach transport batching without waiting for earlier decisions', { timeout: 2000 }, async () => {
  const candidates = Array.from({ length: 240 }, (_, index) => ({
    id: `C${index}`, name: `Documented Paint ${index}`, sources: [],
  }));
  let admitted = 0, release;
  const allAdmitted = new Promise(resolve => { release = resolve; });
  const run = { options: {}, reviewSignal: new AbortController().signal,
    timing: { signal: new AbortController().signal }, log() {}, warn() {}, dump() {},
    catalogs: { get: async () => ({ candidates: [] }) }, routing: {},
    reviewPipeline: { finish: async candidate => {
      admitted++;
      if (admitted === candidates.length) release();
      await allAdmitted;
      return { [candidate.id]: { exclude_reason: 'unrelated_vehicle', reason: 'Documented different model' } };
    } },
  };
  const state = await reviewInventory(run, vehicle, candidates);
  assert.equal(admitted, 240);
  assert.equal(state.reviewedCandidates.length, 240);
  assert.equal(state.unreviewedCandidates.length, 0);
});

test('an explicit candidate admission limit still bounds independent reviews', async () => {
  let active = 0, peak = 0;
  const candidates = Array.from({ length: 6 }, (_, index) => ({ id: `C${index}`, name: 'Documented Paint', sources: [] }));
  const run = { options: { reviewConcurrency: 2 }, reviewSignal: new AbortController().signal,
    timing: { signal: new AbortController().signal }, log() {}, warn() {}, dump() {},
    catalogs: { get: async () => ({ candidates: [] }) }, routing: {},
    reviewPipeline: { finish: async candidate => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return { [candidate.id]: { exclude_reason: 'unrelated_vehicle', reason: 'Documented different model' } };
    } },
  };
  await reviewInventory(run, vehicle, candidates);
  assert.equal(peak, 2);
});

test('catalog-only aliases share a review but distinct scope, finish and web evidence do not', async () => {
  const candidate = (id, name) => ({ id, name, sources: [{ page_id: id, catalog: 'basf_models',
    url: `catalog:basf_models:${id}`, evidence: [`Paint ${name}, code A1`],
    catalog_record: { model: 'GT', model_match: 'exact', year: '2018', universal_code: 'A1' } }] });
  const a = candidate('A', 'Moon White'), b = candidate('B', 'Branco Lunar');
  const lookup = { get: async () => ({ candidates: [row] }) };
  const groups = await groupCatalogReviews([a, b], lookup, vehicle);
  assert.equal(groups.length, 1);
  assert.equal(combinedCandidate(groups[0]).sources.length, 2);
  const expanded = expandGroupDecision(groups[0], { A: { action: 'include', source_ids: ['A'], reason: 'catalog' } });
  assert.deepEqual(expanded.B.source_ids, ['B']);
  b.sources[0].catalog_record.year = '2019';
  assert.equal((await groupCatalogReviews([a, b], lookup, vehicle)).length, 2);
  b.sources[0].catalog_record.year = '2018';
  delete b.sources[0].catalog;
  assert.equal((await groupCatalogReviews([a, b], lookup, vehicle)).length, 2);
  const unknown = { get: async () => ({ candidates: [{ ...row, paintFinish: [] }] }) };
  assert.equal((await groupCatalogReviews([a, candidate('C', 'Other White')], unknown, vehicle)).length, 2);
});

test('manufacturer-prefixed code labels require documented component codes', () => {
  const codes = new Set(['089', '209']);
  assert.equal(isCatalogCodeLabel('TOY-089 / TOY-209', 'Toyota', codes), true);
  assert.equal(isCatalogCodeLabel('TOY-089', 'Toyota', codes), true);
  assert.equal(isCatalogCodeLabel('TOY-999', 'Toyota', codes), false);
  assert.equal(isCatalogCodeLabel('Moon White 089', 'Toyota', codes), false);
  assert.equal(isCatalogCodeLabel('TOY-089', 'Another', codes), false);
});

test('completion audit restores lost supported colors but respects confirmed finish exclusions', () => {
  const approved = [{ name: 'Moon White' }, { name: 'Dark White' }];
  const audited = paletteCoverage(approved, [], [{ name: 'Dark White', reason: 'incompatible_finish' }],
    { needsExpansion: true }, [{ name: 'Unreviewed' }]);
  assert.deepEqual(audited.colors.map(color => color.name), ['Moon White']);
  assert.deepEqual(audited.summary.unresolvedCodes, ['Moon White']);
  assert.equal(audited.summary.discoveryIncomplete, true);
  assert.equal(audited.summary.unreviewedCandidates, 1);
});

test('domain admission preserves capacity for other domains and releases once', async () => {
  const scheduler = new ModelScheduler({ limits: { fetch: { tokensPerMinute: 1000,
    requestsPerMinute: 1000, reserveTokens: 0, concurrency: 3, scopeConcurrency: 1 } } });
  const options = { choices: [{ model: 'fetch' }], tokens: 1, scope: 'one.test' };
  const first = await scheduler.acquire(options);
  let secondStarted = false;
  const second = scheduler.acquire(options).then(ticket => { secondStarted = true; return ticket; });
  const other = await scheduler.acquire({ ...options, scope: 'two.test' });
  assert.equal(secondStarted, false);
  first.complete();
  first.complete();
  (await second).complete();
  other.complete();
  assert.equal(scheduler.scopes.size, 0);
});

test('reviews cannot consume the matcher and repair reserves', async () => {
  const budget = new AiBudget(1, {}, { verificationFraction: 0.2,
    reviewFraction: 0.35, matchingFraction: 0.1, repairFraction: 0.08 });
  budget.spent = 0.63;
  budget.reviewSpent = 0.35;
  const route = { provider: 'openai', model: 'gpt-6-luna', serviceTier: 'fast' };
  await assert.rejects(budget.reserve(route, {}, 'candidateReview'), { code: 'AI_BUDGET_LIMIT' });
  (await budget.reserve(route, {}, 'databaseMatcher')).cancel();
  budget.finishReviews();
  (await budget.reserve(route, {}, 'candidateReview')).cancel();
  budget.finishCompletionRepairs();
  (await budget.reserve(route, {}, 'verification')).cancel();
});

test('the final repair recovers an unfinished candidate with its own source evidence', async () => {
  const candidate = { id: 'C1', name: 'Moon White', sources: [{ page_id: 'P1',
    url: 'https://paint.test', evidence: ['Moon White paint for Example GT'] }] };
  const state = { decisions: {}, colors: [], reviewedCandidates: [],
    unreviewedCandidates: [{ id: 'C1', name: 'Moon White' }], unresolvedNames: [] };
  const run = { reviewSignal: new AbortController().signal, log() {}, warn() {},
    reviewCandidate: async (_candidate, _vehicle, _signal, stage) => {
      assert.equal(stage, 'research_review_completion_C1');
      return { C1: { action: 'include', name: null, confidence: 'low',
        source_ids: ['P1'], reason: 'Documented model paint' } };
    } };
  const result = await repairUnreviewed(run, vehicle, [candidate], state);
  assert.equal(result.recovered, 1);
  assert.equal(state.unreviewedCandidates.length, 0);
  assert.equal(state.colors[0].name, 'Moon White');
  assert.deepEqual(state.colors[0].sources, ['https://paint.test']);
});

test('an omission audit cannot consume the final-color verification reserve', async () => {
  const budget = new AiBudget(1, {}, { verificationFraction: 0.2,
    matchingFraction: 0.1, repairFraction: 0.08 });
  budget.finishReviews();
  budget.spent = 0.81;
  budget.stageSpent.matching = 0.1;
  const route = { provider: 'openai', model: 'gpt-6-luna', serviceTier: 'fast' };
  const audit = { text: { format: { name: 'final_verification_omissions_1' } } };
  await assert.rejects(budget.reserve(route, audit, 'verification'), { code: 'AI_BUDGET_LIMIT' });
  budget.finishCompletionRepairs();
  (await budget.reserve(route, {}, 'verification')).cancel();
});
