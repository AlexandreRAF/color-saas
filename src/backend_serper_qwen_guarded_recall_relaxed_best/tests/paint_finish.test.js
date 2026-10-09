const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePaintFinish, finishSearchTerms, finishRelation, finishReviewSchema, finishDecisions, candidateFinishRelation } = require('../paint_finish');
const { validateVehicle } = require('../agentic_loop_helpers');
const { seedQueries, selectSources } = require('../research_plan');
const { reviewSchema, reviewedColors } = require('../candidate_inventory');
const { reviewInput } = require('../review_input');
const { finalOutput } = require('../final_output');
const { AgenticLoop } = require('../ai');
const { ModelScheduler } = require('../model_scheduler');

const vehicle = { brand: 'Hyundai', model: 'Azera', country: 'Brazil', predominantColor: 'branco', paintFinish: 'perolizado' };
const names = ['Moon White', 'Fleet White', 'Ice White'];
const passages = ['Moon White - P1 - pearl finish', 'Fleet White - S1 - solid finish', 'Ice White - W1'];
const candidates = names.map((name, index) => ({ id: `C${index + 1}`, name,
  sources: [{ page_id: 'P1', url: 'https://source.test/chart', evidence: [passages[index]] }] }));
const pages = [{ id: 'P1', url: 'https://source.test/chart', text: passages.join('\n') }];
const input = reviewInput(vehicle, candidates, pages);
const include = { action: 'include', name: null, confidence: 'high', source_ids: ['P1'], reason: 'Documented for model' };
const response = Object.fromEntries(candidates.map((candidate, i) => [candidate.id, {
  ...include, finish_status: ['compatible', 'incompatible', 'unknown'][i],
  finish_evidence_ids: i === 2 ? [] : [`E${i + 1}`],
}]));

test('inline palette names cannot lend their finish words to another paint', () => {
  const color = { name: 'Branco Aurora' };
  assert.equal(candidateFinishRelation(color, ['Cores: Branco Aurora, Cinza Satin Steel, Preto Eclipse'], 'acetinado'), 'unknown');
  assert.equal(candidateFinishRelation(color, ['Branco Aurora: solid; Moon White: pearl finish'], 'perolizado'), 'incompatible');
  assert.equal(candidateFinishRelation(color, ['Branco Aurora. Finish: pearlescent.'], 'perolizado'), 'compatible');
});

test('high solids product chemistry is not a solid color finish', () => {
  const text = 'Hyper Metallic WJX is a professional High Solid paint for repair';
  assert.equal(finishRelation(text, 'sólido'), 'incompatible');
  assert.equal(candidateFinishRelation({ name: 'Hyper Metallic' }, [text], 'sólido'), 'unknown');
  assert.equal(candidateFinishRelation({ name: 'Hyper Metallic' }, [text], 'metálico'), 'unknown');
});

test('paintFinish is optional, validated, normalized and separate from hue', () => {
  assert.equal(normalizePaintFinish('PEARLESCENT'), 'perolizado');
  assert.equal(normalizePaintFinish(' metálica '), 'metálico');
  assert.equal(normalizePaintFinish('matte'), 'fosco');
  assert.equal(normalizePaintFinish('acetinado'), 'acetinado');
  assert.equal(normalizePaintFinish('tri-coat'), 'tricamada');
  assert.equal(normalizePaintFinish('perolizado fosco'), 'perolizado fosco');
  assert.equal(normalizePaintFinish('custom effect'), 'custom effect');
  for (const value of [undefined, null, '', 'unknown', 'not specified']) assert.equal(normalizePaintFinish(value), null);
  for (const value of [42, [], {}, 'x'.repeat(101)]) assert.throws(() => validateVehicle({ ...vehicle, paintFinish: value }), /paintFinish/);
  const clean = validateVehicle({ ...vehicle, paintFinish: 'pearl' });
  assert.equal(clean.paintFinish, 'perolizado');
  assert.equal(clean.predominantColor, 'branco');
  assert.equal(Object.hasOwn(validateVehicle({ model: 'Gol' }), 'paintFinish'), false);
});

test('finish targets existing search slots while retaining broad palette queries', () => {
  const withFinish = seedQueries(validateVehicle(vehicle));
  const without = seedQueries(validateVehicle({ ...vehicle, paintFinish: null }));
  assert.equal(withFinish.length, without.length);
  assert.deepEqual(withFinish.slice(0, 3), without.slice(0, 3));
  assert.match(withFinish[3], /perolizado/);
  const period = seedQueries(validateVehicle({ ...vehicle, manufacturingYear: 2017 }));
  assert.ok(period.some(query => /Azera 2017 branco perolizado cat[aá]logo cores/i.test(query)));
  assert.equal(period.length, seedQueries(validateVehicle({ ...vehicle,
    manufacturingYear: 2017, paintFinish: null })).length + 1);
  assert.equal(finishSearchTerms('perolizado fosco'), 'pearlescent matte');
});

test('model palettes take priority over a redundant same-site brand index without banning broad sources', () => {
  const sources = [
    { url: 'https://catalog.test/brand/all', title: 'All Brand paint colors', snippet: 'Azera and other models', rank: 0 },
    { url: 'https://catalog.test/azera', title: 'Azera paint chart', snippet: '', rank: 1 },
    { url: 'https://independent.test/azera', title: 'Azera factory paint brochure', snippet: '', rank: 2 },
  ];
  const index = new Map(sources.map(source => [source.url, source]));
  assert.deepEqual(selectSources(index, new Set(), vehicle, 2, [sources[0].url]).map(source => source.url),
    [sources[1].url, sources[2].url]);
  assert.equal(selectSources(index, new Set(), vehicle, 3).length, 3);
  assert.equal(selectSources(new Map([[sources[0].url, sources[0]]]), new Set(), vehicle, 1).length, 1);
});

test('effect, sheen and coat count stay separate; ambiguous descriptions stay unknown', () => {
  for (const [text, requested, expected] of [
    ['Branco Aurora perolizado', 'pearl', 'compatible'],
    ['Azul Oceano sólido', 'perolizado', 'incompatible'],
    ['Vermelho Aurora metálico perolizado', 'pearl', 'compatible'],
    ['Vermelho Aurora metálico', 'pearl', 'unknown'],
    ['Nero Satin', 'fosco', 'incompatible'],
    ['Preto Estelar perolizado fosco', 'perolizado fosco', 'compatible'],
    ['Preto Estelar perolizado', 'perolizado fosco', 'unknown'],
    ['Pearl White', 'brilhante', 'unknown'],
    ['White Tricoat', 'perolizado', 'unknown'],
    ['Pearl White', 'tricamada', 'unknown'],
    ['Metálico', 'sólido', 'incompatible'],
    ['Solid and pearl paints available', 'perolizado', 'unknown'],
    ['Not pearl', 'perolizado', 'unknown'],
    ['Moon White pearl. Not available on all trims.', 'perolizado', 'compatible'],
    ['Pérola do Mar', 'perolizado', 'unknown'],
    ['Ice White', 'perolizado', 'unknown'],
  ]) assert.equal(finishRelation(text, requested), expected, `${text} / ${requested}`);
});

test('finish review rejects explicit conflicts and retains unknown names without extra review calls', () => {
  const schema = reviewSchema(candidates);
  assert.equal(finishReviewSchema(schema, { vehicle: {} }), schema);
  assert.deepEqual(finishReviewSchema(schema, input).properties.C1.anyOf[1].properties.finish_evidence_ids.items.enum, ['E1']);
  const decisions = finishDecisions(response, input);
  const colors = reviewedColors(candidates, decisions);
  assert.deepEqual(colors.map(color => [color.name, color.finishMatch, color.confidence]), [
    ['Moon White', 'confirmed', 'high'], ['Ice White', 'unknown', 'low'],
  ]);
  assert.equal(decisions.C2.exclude_reason, 'incompatible_finish');
  assert.equal(colors[1].sources[0], 'https://source.test/chart');
});

test('unrelated citations and unsupported finish claims cannot filter or confirm a color', () => {
  assert.throws(() => finishDecisions({ ...response, C1: { ...response.C1, finish_evidence_ids: ['E2'] } }, input), /Invalid paint-finish evidence/);
  assert.throws(() => finishDecisions({ ...response, C1: { ...response.C1, finish_evidence_ids: [] } }, input), /Missing paint-finish evidence/);
  const unknown = finishDecisions({ ...response, C3: { ...response.C3,
    finish_status: 'incompatible', finish_evidence_ids: ['E3'] } }, input);
  assert.equal(unknown.C3.action, 'include');
  assert.equal(unknown.C3.finishMatch, 'unknown');
  assert.equal(unknown.C3.confidence, 'low');
  assert.throws(() => finishDecisions(response, { ...input, evidence: { ...input.evidence, E1: 'Another Paint pearl' } }), /candidate name/);
});

test('marketing names and URL parameters alone cannot confirm paint finish', () => {
  const local = { vehicle, candidates: [{ id: 'C1', name: 'Ivory Pearl',
    sources: [{ evidence_ids: ['E1'] }] }], evidence: { E1: '[Ivory Pearl](https://source.test/pearl/finish)' } };
  const decision = { C1: { ...include, finish_status: 'compatible', finish_evidence_ids: ['E1'] } };
  assert.equal(finishDecisions(decision, local).C1.finishMatch, 'unknown');
  local.evidence.E1 = 'Ivory Pearl. Paint finish: pearlescent.';
  assert.equal(finishDecisions(decision, local).C1.finishMatch, 'confirmed');
});

test('normalized finish aliases cannot confirm themselves or borrow a neighboring row', () => {
  const local = { vehicle, candidates: [{ id: 'C1', name: 'Pure White', aliases: ['Pure White Pearl'],
    sources: [{ evidence_ids: ['E1'] }] }], evidence: {
    E1: '[`N2` ### Pure White Pearl 2005–2015 · White](https://catalog.test/pearl)',
  } };
  const decision = { C1: { ...include, finish_status: 'compatible', finish_evidence_ids: ['E1'] } };
  assert.equal(finishDecisions(decision, local).C1.finishMatch, 'unknown');
  local.evidence.E1 = 'Pure White Pearl\nOther White - X1 - pearl finish';
  assert.equal(finishDecisions(decision, local).C1.finishMatch, 'unknown');
  local.evidence.E1 = 'Pure White Pearl. Paint finish: pearlescent.';
  assert.equal(finishDecisions(decision, local).C1.finishMatch, 'confirmed');
  local.evidence.E1 = 'Pure White Pearl - N2 - solid finish';
  decision.C1.finish_status = 'incompatible';
  assert.equal(finishDecisions(decision, local).C1.exclude_reason, 'incompatible_finish');
  local.evidence.E1 = 'Pure White Pearl. Our paints offer a pearl finish.';
  decision.C1.finish_status = 'compatible';
  assert.equal(finishDecisions(decision, local).C1.finishMatch, 'unknown');
});

test('contradictory finish evidence across sources remains unknown even if the model selects only one source', () => {
  const conflicting = structuredClone(input);
  conflicting.candidates[0].sources.push({ page_id: 'P2', evidence_ids: ['E4'] });
  conflicting.evidence.E4 = 'Moon White - P1 - solid finish';
  assert.equal(finishDecisions(response, conflicting).C1.finishMatch, 'unknown');
  const rejected = finishDecisions({ ...response, C1: { ...response.C1,
    finish_status: 'incompatible', finish_evidence_ids: ['E4'] } }, conflicting);
  assert.equal(rejected.C1.action, 'include');
  assert.equal(rejected.C1.finishMatch, 'unknown');
  assert.equal(rejected.C1.confidence, 'low');
});

test('finish and per-color uncertainty survive compact and expanded output with fetchedPages last', () => {
  const result = { paintFinish: 'perolizado', colors: reviewedColors(candidates, finishDecisions(response, input)),
    research: { status: 'complete' }, fetchedPages: [{ url: 'https://source.test/chart', status: 'ok' }] };
  for (const format of ['compact', 'expanded']) {
    const output = finalOutput(result, { format });
    assert.equal(format === 'compact' ? output.vehicle.paintFinish : output.paintFinish, 'perolizado');
    assert.deepEqual(output.colors.map(color => color.finishMatch), ['confirmed', 'unknown']);
    assert.equal(Object.keys(output).at(-1), 'fetchedPages');
  }
});

for (const automobileType of ['car', 'motorcycle', 'truck', 'tractor']) {
  test(`finish flows through the full ${automobileType} pipeline using existing calls and quotas`, async () => {
    let calls = 0, extractions = 0;
    const loop = new AgenticLoop({ batchReviews: false, catalogLookupFn: async () => ({ catalogs_queried: ['lazzumix', 'basf', 'basf_models'], candidates: [] }), verification: false, apiKey: 'test', debugDirectory: false, maxPageFetches: 4, maxNameSearches: 0,
      scheduler: new ModelScheduler(), modelRouting: { openrouterApiKey: '', geminiApiKey: '', candidateReviewQwen: false },
      browseFn: async queries => queries.map(query => ({ query, results: Array.from({ length: 4 }, (_, i) => ({
        url: `https://source${i}.test/azera-paint-chart`, title: 'Hyundai Azera paint chart', snippet: 'Exterior paints',
      })) })),
      fetchFn: async ([url]) => [{ url, status: 'ok', text: passages.join('\n') }],
      analyzePageFn: async (_page, requestVehicle) => {
        extractions++;
        assert.equal(requestVehicle.paintFinish, 'perolizado');
        return { candidates: names.map((name, i) => ({ name, evidence: [passages[i]] })) };
      },
      request: async (_url, options) => {
        calls++;
        const body = JSON.parse(options.body), request = JSON.parse(body.input);
        assert.equal(request.vehicle.paintFinish, 'perolizado');
        const output = body.text.format.name === 'research_plan'
          ? { queries: [], preferred_urls: [], rationale: 'Already indexed' }
          : Object.fromEntries(request.candidates.map(candidate => {
            const i = names.indexOf(candidate.name);
            return [candidate.id, { ...include, source_ids: candidate.sources.map(source => source.page_id),
              finish_status: response[`C${i + 1}`].finish_status,
              finish_evidence_ids: i === 2 ? [] : candidate.sources[0].evidence_ids }];
          }));
        return { ok: true, json: async () => ({ status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] }) };
      },
      databaseCodeAgentFn: async (palette, options) => {
        assert.equal(options.paintFinish, 'perolizado');
        assert.equal(palette.paintFinish, 'perolizado');
        assert.deepEqual(palette.colors.map(color => color.name), names);
        return palette;
      },
    });
    const result = await loop.loop({ ...vehicle, automobileType });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.colors.map(color => color.name), ['Moon White', 'Ice White']);
    assert.equal(result.vehicle.paintFinish, 'perolizado');
    assert.equal(calls, 4, 'An unscoped model palette gets one year-coverage plan; all three candidates still receive independent reviews');
    assert.equal(extractions, 1, 'Shared content is still extracted once');
    assert.equal(result.pageFetchAttempts, 4);
  });
}
