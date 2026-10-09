'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { literalPaintRows } = require('../literal_paint_rows');
const { structuredExtraction } = require('../structured_extraction');
const { matchesReference, COROLLA_PEARL_070 } = require('../vehicle_reference_checks');
const { sourceCodes } = require('../paint_evidence');
const { nameSourceMatches } = require('../name_research');
const { isPaintCodeCombination } = require('../paint_name');
const { modelEvidencePages } = require('../model_evidence');
const { candidateInventory } = require('../candidate_inventory');
const { seedQueries, conflictingMakeModel } = require('../research_plan');
const { vehicleModelName } = require('../agentic_loop_helpers');
const { paletteQueries, selectComplementarySources, plannedSourceHints } = require('../discovery_pipeline');

// Synthetic publisher structure, deliberately unrelated to the reference car.
const card = '### Moon Pearl Tricoat\n\nMfr. Color Code: A1\n\nFor hatchback models only.\n';
const image = '![Image 1: Example Moon Pearl Tricoat A1 swatch](https://image.test/a1.jpg)';

test('queries mention a make once when the model already begins with it', () => {
  const puma = { brand: 'Puma', model: 'Puma GTS', manufacturingYear: 1978,
    predominantColor: 'vermelho', country: 'Brazil' };
  assert.equal(vehicleModelName(puma), 'Puma GTS');
  assert.ok(seedQueries(puma).every(query => !/Puma Puma/i.test(query)));
  assert.ok(paletteQueries(puma).every(query => !/Puma Puma/i.test(query)));
  assert.equal(vehicleModelName({ brand: 'Nissan', model: 'Versa' }), 'Nissan Versa');
});

test('complementary discovery favors paint pages over same-query social posts', () => {
  const vehicle = { brand: 'Puma', model: 'Puma GTS', manufacturingYear: 1978,
    predominantColor: 'vermelho', country: 'Brazil' };
  const sources = [
    { url: 'https://instagram.com/p/example', title: 'Puma GTS 1978 cor vermelha',
      snippet: 'cores pintura', queries: ['Puma GTS 1978 cores'], rank: 0 },
    { url: 'https://archive.test/puma-gts-1978-paint', title: 'Puma GTS 1978 pintura original',
      snippet: 'cores pintura', queries: ['Puma GTS 1978 cores'], rank: 1 },
  ];
  const selected = selectComplementarySources({ index: new Map(sources.map(source => [source.url, source])),
    attempted: new Set(), pages: [] }, vehicle, 2);

  assert.equal(selected[0].url, sources[1].url);
});

test('a different maker sharing the model word cannot pass as this vehicle brand', () => {
  const puma = { brand: 'Puma', model: 'Puma GTS' };
  assert.equal(conflictingMakeModel({ url: 'https://paint.test/ford-europe-puma',
    title: 'Ford Europe Puma paint colors' }, puma), true);
  assert.equal(conflictingMakeModel({ url: 'https://paint.test/paint-ford-puma',
    title: 'Ford Puma paint colors' }, puma), true);
  assert.equal(conflictingMakeModel({ url: 'https://pumaclube-es.com.br/cores-da-linha-puma.html',
    title: 'Cores da linha PUMA' }, puma), false);
  assert.equal(conflictingMakeModel({ url: 'https://paint.test/toyota-corolla',
    title: 'Toyota Corolla paint colors' }, { brand: 'Toyota', model: 'Corolla' }), false);
});

test('a planned page on an already found host can fill one unused page slot', () => {
  const seen = 'http://archive.test/model-1978-brochure';
  const hint = 'http://archive.test/period-colors';
  const index = new Map([[seen, { url: seen, title: 'Period brochure' }]]);
  assert.deepEqual(plannedSourceHints(index, new Set(), [
    'https://unknown.test/period-colors', 'https://archive.test/period-colors',
    'https://archive.test/'
  ]).map(source => source.url), [hint]);
  assert.deepEqual(plannedSourceHints(index, new Set([hint]), ['https://archive.test/period-colors']), []);
});

test('saved Puma source pattern admits the historic color page without admitting Ford Puma', () => {
  const vehicle = { brand: 'Puma', model: 'Puma GTS', manufacturingYear: 1978 };
  const brochure = { url: 'http://www.pumaclassic.com.br/2009/10/catalogo-puma-gte-gts-1978.html',
    title: 'Catálogo Puma GTE GTS 1978', queries: ['Puma GTS 1978 cores'], rank: 0 };
  const ford = { url: 'https://www.carross.eu/en/paint-ford-puma-m3957',
    title: 'Ford Puma colour codes', queries: ['Puma colors'], rank: 1 };
  const index = new Map([brochure, ford].map(source => [source.url, source]));
  const attempted = new Set([brochure.url]);
  const preferred = ['https://www.pumaclassic.com.br/2008/09/pumacor.html'];
  const hints = plannedSourceHints(index, attempted, preferred);
  for (const hint of hints) index.set(hint.url, hint);

  const selected = selectComplementarySources({ index, attempted,
    pages: [{ ...brochure, status: 'ok', candidates: [] }] }, vehicle, 2, preferred);
  assert.deepEqual(selected.map(source => source.url),
    ['http://www.pumaclassic.com.br/2008/09/pumacor.html']);
});

test('labelled product cards preserve the complete name, code and fitment restriction', () => {
  const source = `Example Model paint colors\n${image}\n${card}\n### Ocean Blue\nMfr. Color Code: B2\n`;
  const rows = literalPaintRows(source);
  const row = rows.find(row => row.name === 'Moon Pearl Tricoat');
  assert.ok(row.evidence.some(passage => passage.includes('For hatchback models only.')));
  assert.ok(row.evidence.every(passage => source.includes(passage)));
  assert.ok(!row.evidence[0].includes('Ocean Blue'));
});

test('card compaction preserves conflicting swatch captions and unrelated prose', () => {
  const conflict = '![Image 2: Example Black Sand Pearl B2 swatch](https://image.test/b2.jpg)';
  const source = `Model paint colors\n${image}\n${card}${conflict}\n### Black\nMfr. Color Code: C3\n`;
  const result = structuredExtraction(source);
  assert.ok(result.text.includes(conflict));
  assert.ok(result.candidates.some(row => row.name === 'Moon Pearl Tricoat'));
  assert.ok(result.candidates.every(row => row.evidence.every(passage => source.includes(passage))));
});

test('repeated product cards cost less extraction text without losing named code rows', () => {
  const source = 'Model paint colors\n' + `${image}\n${card}\n`.repeat(50);
  const result = structuredExtraction(source);
  assert.equal(result.candidates.length, 1);
  assert.ok(result.text.length < source.length / 3);
  assert.ok(result.candidates[0].evidence.some(passage => passage.includes('A1')));
});

test('compacted matching swatches retain their unique fitment and finish qualifiers', () => {
  const qualified = '![Moon Pearl Tricoat A1 - sedan only, matte finish](https://image.test/a1.jpg)';
  const source = `Model paint colors\n${qualified}\n${card}`;
  const result = structuredExtraction(source);
  const paint = result.candidates.find(row => row.name === 'Moon Pearl Tricoat');

  assert.ok(paint.evidence.includes(qualified));
  assert.ok(paint.evidence.every(passage => source.includes(passage)));
});

test('paint identity references accept finish variants but not hue guesses, codes alone or another maker', () => {
  for (const name of ['Blizzard Pearl', 'Blizzard Pearl Tricoat', 'White Pearl Crystal Shine']) {
    assert.equal(matchesReference({ name, codes: ['070'] }, COROLLA_PEARL_070, 'Toyota'), true);
  }
  for (const color of [{ name: 'Arbitrary White', codes: ['070'] }, { name: 'TOY-070', codes: ['070'] },
    { name: 'Blizzard Pearl', codes: ['70'] }, { name: 'Blizzard Pearl', codes: ['089'] }]) {
    assert.equal(matchesReference(color, COROLLA_PEARL_070, 'Toyota'), false);
  }
  assert.equal(matchesReference({ name: 'Blizzard Pearl', codes: ['070'] }, COROLLA_PEARL_070, 'Other Maker'), false);
});

test('neighboring card codes and general instructions do not contaminate a paint identity', () => {
  const context = 'Use the color code to find paint.\n### Other Silver\nMfr. Color Code: B2\n'
    + '### Moon Pearl Tricoat\nMfr. Color Code: A1';
  assert.deepEqual(sourceCodes('Moon Pearl Tricoat', [context]), ['A1']);
  const source = `Example Model paint colors\n${context}`;
  const row = literalPaintRows(source).find(row => row.name === 'Moon Pearl Tricoat');
  assert.deepEqual(sourceCodes(row.name, row.evidence), ['A1']);
  assert.deepEqual(sourceCodes('Moon Pearl', ['### Moon Blue\nMfr. Color Code: B2\n'
    + '### Moon Pearl Tricoat\nMfr. Color Code: A1']), ['A1']);
});

test('opening context never truncates a standard paint code into a different code', () => {
  const prefix = 'Model paint colors\n' + 'x'.repeat(1160) + '\n';
  const source = prefix + '### Moon Pearl Tricoat\nMfr. Color Code: 070\n' + card.repeat(30);
  const parsed = structuredExtraction(source);
  assert.ok(parsed.candidates.flatMap(row => row.evidence).every(passage => source.includes(passage)));
  assert.ok(!parsed.text.includes('Mfr. Color Code: 07\n'));
});

test('clarification admits paint catalogs but avoids incidental mentions in broad archives', () => {
  const lead = { name: 'Moon', codes: ['A1'] };
  const vehicle = { model: 'Example', brand: 'Maker' };
  assert.equal(nameSourceMatches({ url: 'https://archive.test/1975', title: 'Daily newspaper',
    snippet: 'Example Moon A1 paint' }, lead, vehicle), false);
  assert.equal(nameSourceMatches({ url: 'https://catalog.test/paint', title: 'Donor paint codes',
    snippet: 'Moon Pearl A1' }, lead, vehicle), true);
});

test('code combinations use catalog proof while preserving named two-tone paints', () => {
  assert.equal(isPaintCodeCombination('3Cb + Yac', ['YAC']), true);
  assert.equal(isPaintCodeCombination('YFB + YAC', ['YFB', 'YAC']), true);
  assert.equal(isPaintCodeCombination('A1 + B2'), true);
  assert.equal(isPaintCodeCombination('ICE + INK'), false);
  assert.equal(isPaintCodeCombination('Silver 77 + Black'), false);
  assert.equal(isPaintCodeCombination('A1 + ICE'), false);

  const row = (description, universal_code, record_id, manufacturer = 'Example') => ({
    description, universal_code, record_id, manufacturer, model: 'Model', year: '2018',
  });
  const records = [row('Crystal Ice Met', 'YFB', 1), row('Dark Silver Met', 'YAC', 2),
    row('YFB + YAC', 'YXA', 3), row('Ice + Ink', 'A1', 4), row('YFB + YAC', 'B2', 5, 'Other')];
  const pages = modelEvidencePages(records, {});
  assert.deepEqual(pages.map(page => page.catalog_record.record_id), [1, 2, 4, 5]);
  assert.equal(records.length, 5); // Raw catalog provenance stays intact.
});

test('web code combinations also need named components instead of becoming output names', () => {
  const pages = [{ id: 'P1', url: 'https://paint.test/model',
    text: 'Crystal Ice - Color Code: YFB\nDark Silver - Color Code: YAC\nYFB + YAC',
    candidates: [{ name: 'Crystal Ice', evidence: ['Crystal Ice - Color Code: YFB'] },
      { name: 'Dark Silver', evidence: ['Dark Silver - Color Code: YAC'] },
      { name: 'YFB + YAC', evidence: ['YFB + YAC'] }] }];
  const candidates = candidateInventory(pages);
  assert.deepEqual(candidates.map(candidate => candidate.name), ['Crystal Ice', 'Dark Silver']);
});
