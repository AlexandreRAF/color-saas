'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { coverage, finalDiscoveryCoverage, paletteQueries, selectComplementarySources,
  recoveryPriority } = require('../discovery_pipeline');
const { indexResults } = require('../research_plan');
const { structuredExtraction } = require('../structured_extraction');
const { auditOmissions, supportedReconsideration } = require('../omission_review');
const { CodeMatchPipeline } = require('../code_match_pipeline');
const { candidateInventory, reviewedColors } = require('../candidate_inventory');
const { acceptance } = require('../evaluate_vehicles');

test('Corolla reference accepts the published Blizzard Pearl identity but rejects a code-only label', () => {
  const result = { colors: [{ name: 'Blizzard Pearl', codes: ['070'] }] };
  assert.equal(acceptance('corolla', result, []).checks.pearl070Found, true);
  result.colors[0].name = 'TOY-070';
  assert.equal(acceptance('corolla', result, []).checks.pearl070Found, false);
});

test('a reviewed full finish-bearing name with one published code survives longer-name ambiguity', () => {
  const candidates = candidateInventory([{ id: 'P1', url: 'https://paints.test/model', candidates: [
    { name: 'Blizzard Pearl Tricoat', evidence: ['COLOR CODE 070 - Blizzard Pearl Tricoat'] },
    { name: 'Branco Blizzard', evidence: ['Branco Blizzard'] },
    { name: 'Hyper', evidence: ['P2S - Hyper'] },
    { name: 'Hyper Silver', evidence: ['P2S - Hyper Silver'] },
  ] }]);
  const decisions = Object.fromEntries(candidates.map(candidate => [candidate.id, {
    name: null, name_status: 'complete', confidence: 'low', source_ids: ['P1'], reason: 'Published name.',
  }]));
  const unresolved = [];
  const colors = reviewedColors(candidates, decisions, { onUnresolved: lead => unresolved.push(lead) });
  assert.ok(colors.some(color => color.name === 'Blizzard Pearl'));
  assert.ok(unresolved.some(lead => lead.name === 'Hyper'));
  assert.ok(!colors.some(color => color.name === 'Hyper'));

  const blizzard = candidates.find(candidate => candidate.name === 'Blizzard Pearl');
  decisions[blizzard.id].name_status = 'unresolved';
  assert.ok(!reviewedColors(candidates, decisions).some(color => color.name === 'Blizzard Pearl'));
});

test('discovery needs independent palettes, not merely one model-linked candidate', () => {
  const page = (host, count) => ({ url: `https://${host}/model`, status: 'ok', candidates: Array(count).fill({}) });
  assert.equal(coverage([page('one.test', 10)], Array(10)).needsExpansion, true);
  assert.equal(coverage([page('one.test', 10), page('two.test', 4), page('three.test', 1)], Array(10)).needsExpansion, false);
  assert.ok(paletteQueries({ brand: 'Honda', model: 'CB 500' }).every(query => query.includes('Honda CB 500')));
});

test('exhausted recovery accepts two independently corroborating full palettes', () => {
  const page = (host, names) => ({ url: `https://${host}/model`, status: 'ok',
    candidates: names.map(name => ({ name })) });
  const first = page('club.example', ['Prata Continental', 'Verde Tropical', 'Branco Polar', 'Azul Marinho']);
  const second = page('archive.example', ['Prata Continental', 'Verde Tropical', 'Branco Polar', 'Vermelho Rubi']);
  const candidates = Array(8);

  assert.equal(coverage([first, second], candidates).needsExpansion, true);
  assert.deepEqual(coverage([first, second], candidates, { afterRecovery: true }), {
    domains: 2, palettes: 2, candidates: 8, crossCheckedTwoDomains: true, needsExpansion: false,
  });
  assert.equal(coverage([first, page('archive.example', ['Prata Continental', 'Verde Tropical', 'Vermelho Rubi'])],
    candidates, { afterRecovery: true }).needsExpansion, true);
});

test('an expired sparse discovery reports its two-source cross-check at finalization', () => {
  const page = (host, names) => ({ url: `https://${host}/model`, status: 'ok',
    candidates: names.map(name => ({ name })) });
  const pages = [page('club.example', ['Prata Continental', 'Branco Polar', 'Amarelo Puma']),
    page('archive.example', ['Prata Continental', 'Branco Polar', 'Amarelo Puma', 'Vermelho Mont Carlo'])];
  const run = { pages, discoverySignal: { aborted: true }, discoveryCoverage: { needsExpansion: true },
    candidates: () => pages.flatMap(source => source.candidates) };

  assert.deepEqual(finalDiscoveryCoverage(run), { domains: 2, palettes: 2, candidates: 7,
    crossCheckedTwoDomains: true, needsExpansion: false, sourceLimit: 'discovery_deadline' });
  assert.equal(finalDiscoveryCoverage({ ...run, discoverySignal: { aborted: false } }).needsExpansion, true);
});

test('late independent query sources retain priority over more pages from an existing domain', () => {
  const repeated = { url: 'https://first.test/model/other', title: 'Model paint chart', rank: 0, queries: ['seed'] };
  const independent = { url: 'https://second.test/model', title: 'Model paint chart', rank: 9, queries: ['palette'] };
  const run = { index: new Map([repeated, independent].map(source => [source.url, source])), attempted: new Set(),
    pages: [{ url: 'https://first.test/model', queries: ['seed'] }] };
  assert.equal(selectComplementarySources(run, { model: 'Model' }, 1)[0].url, independent.url);
});

test('owner manuals remain available as lower-ranked sources when page slots remain', () => {
  const manual = { url: 'https://maker.example/2025/model-manual-do-proprietario.pdf',
    title: '2025 Model manual do proprietario paint codes', rank: 0, queries: ['seed'] };
  const palette = { url: 'https://colors.example/model-2025-paint-colors',
    title: '2025 Model paint colors', rank: 1, queries: ['seed'] };
  const run = { index: new Map([manual, palette].map(source => [source.url, source])),
    attempted: new Set(), pages: [] };

  const selected = selectComplementarySources(run,
    { brand: 'Maker', model: 'Model', manufacturingYear: 2025 }, 2);
  assert.deepEqual(selected.map(source => source.url), [palette.url, manual.url]);
});

test('recovery favors current-year paint pages over manuals and social pages', () => {
  const vehicle = { brand: 'Chevrolet', model: 'S10', manufacturingYear: 2025 };
  const article = { url: 'https://news.test/2025/s10-cores', title: 'S10 2025 cores', candidates: [] };
  const manual = { url: 'https://maker.test/2025/s10-manual-do-proprietario.pdf',
    title: 'S10 2025 manual do proprietário', candidates: [] };
  const video = { url: 'https://youtube.com/watch?v=abc', title: 'S10 cores', candidates: [] };

  assert.ok(recoveryPriority(article, vehicle) > recoveryPriority(manual, vehicle));
  assert.ok(recoveryPriority(article, vehicle) > recoveryPriority(video, vehicle));
});

test('a paginated search result also admits the first palette page without losing pagination', () => {
  const index = new Map();
  indexResults([{ query: 'Model paint chart', results: [{ url: 'https://catalog.test/Model.html?page=3',
    title: 'Model paints', rank: 4 }] }], index);
  assert.ok(index.has('https://catalog.test/Model.html'));
  assert.ok(index.has('https://catalog.test/Model.html?page=3'));
  assert.deepEqual(index.get('https://catalog.test/Model.html').queries, ['Model paint chart']);
});

test('structured extraction preserves code rows and never claims prose was fully parsed', () => {
  const rows = 'Paint Codes\nA1 - Moon White\nB2 - Ocean Blue';
  const parsed = structuredExtraction(rows);
  assert.equal(parsed.complete, true);
  assert.deepEqual(parsed.candidates.map(candidate => candidate.name), ['Moon White', 'Ocean Blue']);
  assert.equal(parsed.candidates[0].evidence[0], 'A1 - Moon White');
  const contextual = structuredExtraction(`${rows}\nMoon White is solid for Model. Other colors may exist.`);
  assert.equal(contextual.complete, false);
  assert.match(contextual.text, /Moon White is solid for Model/);
});

test('matching retries only failed identities, preserving successful no-match results', async () => {
  const calls = [];
  const pipeline = new CodeMatchPipeline(async colors => {
    calls.push(colors.map(color => color.name));
    const result = colors.map(color => ({ ...color, universal_code: calls.length > 1 ? 'A1' : '' }));
    if (calls.length === 1) Object.defineProperty(result, 'incompleteNames', { value: ['Moon White'] });
    return result;
  });
  const result = await pipeline.finish([{ name: 'Moon White' }, { name: 'Unknown Paint' }]);
  assert.deepEqual(calls, [['Moon White', 'Unknown Paint'], ['Moon White']]);
  assert.deepEqual(result.map(color => color.universal_code), ['A1', '']);
  assert.ok(!JSON.stringify(result).includes('incompleteNames'));
});

test('persistently failed matching gets only one retry across repeated finish calls', async () => {
  let calls = 0;
  const pipeline = new CodeMatchPipeline(async colors => {
    calls++;
    const result = colors.map(color => ({ ...color, universal_code: '' }));
    Object.defineProperty(result, 'incompleteNames', { value: colors.map(color => color.name) });
    return result;
  });
  await pipeline.finish([{ name: 'Moon White' }]);
  await pipeline.finish([{ name: 'Moon White' }]);
  assert.equal(calls, 2);
});

test('omission verification repairs flagged candidates through the main reviewer exactly once', async () => {
  const candidate = { id: 'C1', name: 'Silver Mist', aliases: [], sources: [
    { page_id: 'P1', url: 'https://source.test', evidence: ['Model uses Silver Mist.'] }], catalog_check: { rows: [] } };
  const decisions = { C1: { exclude_reason: 'unrelated_hue', reason: 'Looks gray' } };
  let repairs = 0;
  const run = { options: {}, reviewSignal: new AbortController().signal,
    reviewState: { repairsAttempted: new Set(['C1']) },
    evidencePages: () => [{ id: 'P1', url: 'https://source.test', text: 'Model uses Silver Mist.' }],
    mainAgent: async (stage, schema, input, instructions, signal, validate) => {
      assert.match(stage, /^final_verification_omissions_/);
      assert.equal(input.candidates[0].catalog_check, undefined);
      const result = { reconsiderations: [{ candidate_id: 'C1', issue: 'hue', evidence_ids: ['E1'] }] }; validate(result); return result;
    },
    reviewCandidate: async checked => {
      repairs++; assert.equal(checked.omission_check.previous_decision.exclude_reason, 'unrelated_hue');
      assert.deepEqual(checked.omission_check.issues, [{ issue: 'hue', passages: ['Model uses Silver Mist.'] }]);
      return { C1: { action: 'include', name_status: 'complete', source_ids: ['P1'] } };
    }, warn: () => {}, log: () => {}, dump: () => {} };
  const summary = await auditOmissions(run, { model: 'Model', predominantColor: 'prata' }, [candidate], decisions);
  assert.equal(repairs, 1);
  assert.deepEqual(summary, { total: 1, checked: 1, flagged: 1, recovered: 1, incomplete: 0, repairFailures: 0 });
  assert.equal(candidate.omission_check, undefined);
  decisions.C1 = { exclude_reason: 'unrelated_hue' };
  const second = await auditOmissions(run, { model: 'Model', predominantColor: 'prata' }, [candidate], decisions);
  assert.equal(repairs, 1);
  assert.equal(second.repairFailures, 1);
});

test('one malformed omission repair retries with a larger response limit', async () => {
  const candidate = { id: 'C1', name: 'Silver Mist', sources: [{ page_id: 'P1',
    url: 'https://source.test', evidence: ['Silver Mist is gray on Model.'] }] };
  const decisions = { C1: { exclude_reason: 'unrelated_hue', reason: 'Looks blue' } };
  const stages = [];
  const run = { options: {}, reviewSignal: new AbortController().signal,
    evidencePages: () => [{ id: 'P1', url: 'https://source.test', text: 'Silver Mist is gray on Model.' }],
    mainAgent: async () => ({ reconsiderations: [{ candidate_id: 'C1', issue: 'hue', evidence_ids: ['E1'] }] }),
    reviewCandidate: async (_candidate, _vehicle, _signal, stage) => {
      stages.push(stage);
      if (stages.length === 1) throw new Error('Model response did not complete: length');
      return { C1: { action: 'include', name_status: 'complete', source_ids: ['P1'] } };
    }, warn: () => {}, log: () => {}, dump: () => {} };
  const summary = await auditOmissions(run, { model: 'Model', predominantColor: 'prata' },
    [candidate], decisions);
  assert.equal(summary.repairFailures, 0);
  assert.equal(summary.recovered, 1);
  assert.deepEqual(stages, ['research_review_omission_C1', 'research_review_omission_C1_retry']);
});

test('failed omission checks are reported without changing a decision', async () => {
  const decisions = { C1: { exclude_reason: 'unrelated_vehicle' } };
  const summary = await auditOmissions({ options: {}, evidencePages: () => [],
    mainAgent: async () => { throw new Error('Provider unavailable'); },
    reviewCandidate: async () => { throw new Error('Must not repair unchecked candidates'); },
    warn: () => {}, log: () => {}, dump: () => {} }, {}, [{ id: 'C1', sources: [] }], decisions);
  assert.equal(summary.incomplete, 1);
  assert.equal(summary.checked, 0);
  assert.equal(decisions.C1.exclude_reason, 'unrelated_vehicle');
});

test('omission audit also checks names withheld after the main agent approved them', async () => {
  let audited = false;
  const candidate = { id: 'C1', name: 'Hyper', sources: [] };
  const decisions = { C1: { action: 'include', name_status: 'complete' } };
  const summary = await auditOmissions({ options: {}, evidencePages: () => [],
    mainAgent: async (_stage, _schema, input) => {
      audited = true;
      assert.match(input.candidates[0].withheld_reason, /completeness/);
      return { reconsiderations: [] };
    }, warn: () => {}, log: () => {}, dump: () => {} }, {}, [candidate], decisions, [{ name: 'Hyper' }]);
  assert.equal(audited, true);
  assert.equal(summary.checked, 1);
  assert.equal(summary.recovered, 0);
});

test('omission repair needs candidate-owned evidence that addresses the excluded fact', () => {
  const candidate = { id: 'C1' };
  const input = { candidates: [{ id: 'C1', sources: [{ evidence_ids: ['E1'] }] }],
    evidence: { E1: 'Prata Shark has a gray appearance.', E2: 'Another paint is white.' } };
  const decision = { exclude_reason: 'unrelated_hue' };
  const item = { issue: 'hue', evidence_ids: ['E1'] };
  const check = (flag, vehicle = { predominantColor: 'prata' }, previous = decision) =>
    supportedReconsideration(flag, candidate, previous, input, vehicle, false);

  assert.equal(check(item), true);
  assert.equal(check(item, { predominantColor: 'branco' }), false);
  assert.equal(check({ ...item, evidence_ids: ['E2'] }), false);
  assert.equal(check({ ...item, issue: 'vehicle' }), false);
  assert.equal(check({ ...item, issue: 'unsupported_limit' }), false);
  assert.equal(check({ ...item, issue: 'name' }), false);
  assert.equal(check({ issue: 'hue' }), false);
  assert.equal(check({ ...item, issue: 'unsupported_limit' }, {}, { action: 'include' }), false);
  assert.equal(check({ ...item, issue: 'name' }, {}, { name_status: 'unresolved' }), true);
  assert.equal(check({ ...item, issue: 'unsupported_limit' }, {},
    { exclude_reason: 'authoritative_exclusion' }), true);
});

test('unsupported omission flags are visible without spending another main review', async () => {
  const candidate = { id: 'C1', name: 'Blue Velvet', sources: [
    { page_id: 'P1', evidence: ['Corolla Blue Velvet.'] }] };
  const decisions = { C1: { exclude_reason: 'unrelated_hue' } };
  const summary = await auditOmissions({ options: {}, evidencePages: () => [],
    mainAgent: async () => ({ reconsiderations: [{ candidate_id: 'C1', issue: 'vehicle', evidence_ids: ['E1'] }] }),
    reviewCandidate: async () => assert.fail('Unsupported flag must not trigger repair'),
    warn: () => {}, log: () => {}, dump: () => {},
  }, { predominantColor: 'branco' }, [candidate], decisions);

  assert.equal(summary.checked, 1);
  assert.equal(summary.flagged, 0);
  assert.equal(summary.unsupportedFlags, 1);
  assert.equal(decisions.C1.exclude_reason, 'unrelated_hue');
});
