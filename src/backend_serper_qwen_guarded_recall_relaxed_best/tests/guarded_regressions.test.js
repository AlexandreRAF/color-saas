const test = require('node:test');
const assert = require('node:assert/strict');

const { ReviewBatcher } = require('../review_batcher');
const { searchAmbiguousPeriodCode } = require('../code_clarification');
const { catalogHueAliases, catalogHueHints } = require('../candidate_review');
const { hueConflicts } = require('../hue_review');
const { finalOutput, outputColors } = require('../final_output');

test('an uncolored name cannot be rejected by compact hue triage without contrary evidence', () => {
  const batcher = new ReviewBatcher(async () => {}, { triage: true });
  const candidate = { name: 'Hyper Metallic', visual_swatches: [], sources: [] };
  const item = { input: { vehicle: { predominantColor: 'prata' },
    candidates: [candidate], evidence: { E1: 'Hyper Metallic - select' } } };

  assert.throws(() => batcher.decision('unrelated_hue', item), { code: 'REVIEW_REQUIRED' });
  candidate.visual_swatches = [{ approximate_family: 'red' }, { approximate_family: 'silver-gray' }];
  assert.throws(() => batcher.decision('unrelated_hue', item), { code: 'REVIEW_REQUIRED' });
  assert.equal(batcher.decision('unrelated_vehicle', item).exclusion, 'unrelated_vehicle');
});

test('one code clarification search may run for a model-linked paint without a requested year', async () => {
  const candidate = { name: 'Hyper Metallic', sources: [{ page_id: 'P1',
    url: 'https://paint.example/ix35', evidence: ['Hyper Metallic - select'] }] };
  const searches = [];
  const run = { searchBlocked: false, pages: [{ id: 'P1', status: 'ok',
    url: 'https://paint.example/ix35', title: 'Hyundai ix35 colors' }],
  candidates: () => [candidate], catalogs: { get: async () => ({ candidates: [
    { manufacturer: 'HYUNDAI', name_match: 'all_words', universal_code: 'NLA' },
    { manufacturer: 'HYUNDAI', name_match: 'all_words', universal_code: 'WJX' },
  ] }) }, log: () => {}, search: async queries => searches.push(...queries) };

  await searchAmbiguousPeriodCode(run, { brand: 'Hyundai', model: 'ix35',
    predominantColor: 'prata', country: 'Brazil' }, new AbortController().signal);
  assert.equal(searches.length, 1);
  assert.match(searches[0], /Hyundai ix35 "Hyper Metallic"/);
});

test('same-code catalog aliases route an included paint to independent hue review', () => {
  const rows = [
    { catalog: 'basf', description: 'MURANOROT PERLEFFEKT', manufacturer: 'VOLKSWAGEN',
      universal_code: 'LC3X', complete_name_match: true },
    { catalog: 'lazzumix', description: 'VERMELHO MURANO P./EC', manufacturer: 'VW',
      universal_code: 'LC3X', complete_name_match: false },
  ];
  const vehicle = { brand: 'Volkswagen', predominantColor: 'prata' };
  const aliases = catalogHueAliases(rows, vehicle);
  assert.deepEqual(aliases, [{ name: 'VERMELHO MURANO P./EC', code: 'LC3X', catalog: 'lazzumix' }]);

  const candidate = { id: 'C1', name: rows[0].description, catalog_check: { hue_aliases: aliases } };
  assert.deepEqual(hueConflicts([candidate], { C1: { action: 'include' } }, 'prata'), [candidate]);
  assert.deepEqual(catalogHueAliases([rows[0], { ...rows[1], universal_code: 'OTHER' }], vehicle), []);
  assert.deepEqual(catalogHueAliases([rows[0], { ...rows[1], manufacturer: 'FORD' }], vehicle), []);
});

test('requested-family aliases keep a model-linked ambiguous paint eligible', () => {
  const candidate = { name: 'Hyper Metallic', name_check: { required: true } };
  const rows = [{ manufacturer: 'HYUNDAI', description: 'HYPER MET', universal_code: 'WJX',
    name_match: 'all_words', finish_descriptions: ['GRAPHITE GRAY MET', 'HYPER MET'] }];
  assert.deepEqual(catalogHueHints(candidate, rows,
    { brand: 'Hyundai', predominantColor: 'prata' }), ['GRAPHITE GRAY MET']);
});

test('distinct code identities sharing a suffix-free name remain separate variants', () => {
  const colors = outputColors([
    { name: 'DARK CHARCOAL', sources: ['catalog:basf_models:58888'],
      source_evidence: [{ source_name: 'DARK CHARCOAL', passages: [] }],
      universal_code: 'I239', code_candidates: [{ universal_code: 'I239' }], confidence: 'low' },
    { name: 'DARK CHARCOAL', sources: ['catalog:basf_models:58889'],
      source_evidence: [{ source_name: 'DARK CHARCOAL MAT', passages: [] }],
      universal_code: '', code_candidates: [], confidence: 'low' },
  ]);

  assert.equal(colors.length, 1);
  assert.equal(colors[0].name, 'Dark Charcoal');
  assert.deepEqual(colors[0].variants.map(variant => variant.paintFinish),
    [['desconhecido'], ['fosco']]);
  assert.deepEqual(colors[0].variants.map(variant => variant.code_candidates),
    [[{ universal_code: 'I239' }], []]);
  assert.equal(colors[0].catalogSources.length, 2);
});

test('compact output keeps per-variant codes and evidence with one public display name', () => {
  const colors = [
    { name: 'DARK CHARCOAL', sources: ['catalog:basf_models:58888'], universal_code: 'I239',
      code_candidates: [{ universal_code: 'I239' }], confidence: 'low' },
    { name: 'DARK CHARCOAL', sources: ['catalog:basf_models:58889'], universal_code: '',
      source_evidence: [{ source_name: 'DARK CHARCOAL MAT', passages: [] }],
      code_candidates: [], confidence: 'low' },
  ];
  const result = finalOutput({ make: 'Nissan', model: 'Versa', year: 2017,
    runId: 'offline', colors, research: { status: 'complete', warnings: [],
      unreviewedCandidates: [], unresolvedNames: [] } });

  assert.equal(result.colors.length, 1);
  assert.deepEqual(result.colors[0].codes, ['I239']);
  assert.deepEqual(result.colors[0].variants.map(variant => variant.codes), [['I239'], []]);
  assert.deepEqual(result.colors[0].variants.map(variant => variant.paintFinish),
    [['desconhecido'], ['fosco']]);
});
