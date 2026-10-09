'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { snippetLeads, weakYearCandidates, yearPalettePages, paletteSources,
  paletteSearchQuery, researchPaletteGaps } = require('../palette_gap_research');
const { literalPaintRows } = require('../literal_paint_rows');
const { catalogNameExpansion } = require('../candidate_review');
const { retainUnsupportedHueExclusions } = require('../hue_review');
const { vettedPreferredUrls } = require('../discovery_pipeline');

const vehicle = { brand: 'Volkswagen', model: 'Saveiro', manufacturingYear: 2015,
  predominantColor: 'vermelho', country: 'Brazil', automobileType: 'car' };

test('a nearby-year indexed palette contributes search leads, not output evidence', () => {
  const source = { url: 'https://example.com/cores-saveiro-2014', title: 'Cores Saveiro 2014',
    snippet: 'Cores Saveiro 2014 1. Vermelho Flash liso 2. Vermelho Ópera perol 3. Azul Night metálico' };
  const existing = [{ name: 'Flashrot', aliases: [], sources: [{ evidence: ['Flashrot / Vermelho Flash LP3G'] }] }];
  const leads = snippetLeads(new Map([[source.url, source]]), vehicle, existing);

  assert.deepEqual(leads.map(lead => lead.name), ['Vermelho Ópera']);
  assert.equal(leads[0].yearRelation, -1);
});

test('an already extracted nearby-year paint still gets a targeted year check', async () => {
  const source = { url: 'https://example.com/cores-saveiro-2014', title: 'Cores Saveiro 2014',
    snippet: 'Vermelho Flash liso; Vermelho Ópera perol', rank: 1 };
  const candidates = ['Vermelho Flash', 'Vermelho Ópera perol'].map(name => ({ name,
    sources: [{ url: source.url, evidence: [name] }] }));
  const searches = [];
  const run = { index: new Map([[source.url, source]]), pages: [], attempted: new Set(),
    pagePool: { unavailableHost: () => false },
    discoverySignal: new AbortController().signal, searchBlocked: false, maxPages: 24,
    queries: new Set(), searchJobs: [], candidates: () => candidates,
    search: async (queries, _vehicle, _signal, options) => {
      searches.push({ query: queries[0], palette: options.forPalette });
      run.queries.add(queries[0]);
    },
    readSources: async () => {}, log: () => {} };

  assert.deepEqual(new Set(weakYearCandidates(run, vehicle)),
    new Set(['Vermelho Flash', 'Vermelho Ópera perol']));
  await researchPaletteGaps(run, vehicle);
  assert.equal(searches.length, 2);
  assert.match(searches[1].query, /"Vermelho Flash" OR "Vermelho Ópera"/);
  assert.ok(searches.every(item => item.palette));
});

test('indexed paint leads share one query and prose fragments do not become names', async () => {
  const source = { url: 'https://example.com/saveiro-cores-2014',
    title: 'Saveiro 2014 cores',
    snippet: 'Volkswagen Saveiro cores: Vermelho Coral; Vermelho Flash; Vermelho Ópera; red that' };
  const run = { index: new Map([[source.url, source]]), pages: [], attempted: new Set(),
    pagePool: { unavailableHost: () => false },
    discoverySignal: new AbortController().signal, searchBlocked: false, maxPages: 24,
    queries: new Set(), searchJobs: [], candidates: () => [], log: () => {},
    search: async (queries) => { run.queries.add(queries[0]); },
    readSources: async () => {} };

  assert.deepEqual(snippetLeads(run.index, vehicle).map(lead => lead.name),
    ['Vermelho Coral', 'Vermelho Flash', 'Vermelho Ópera']);
  await researchPaletteGaps(run, vehicle);
  assert.equal(run.queries.size, 2);
  assert.ok([...run.queries].some(query =>
    query.includes('"Vermelho Coral" OR "Vermelho Flash" OR "Vermelho Ópera"')));
});

test('an exact-year manufacturer brochure outranks an owner manual and a social post', () => {
  const entries = [
    { url: 'https://vw.example/manual-saveiro-2015.pdf', title: 'Saveiro 2015 owner manual',
      snippet: '2015 Saveiro manual', rank: 1 },
    { url: 'https://archive.example/folheto-saveiro-2015.pdf', title: 'Saveiro Cross 2015 Cores',
      snippet: 'Cores da Saveiro 2015', rank: 4 },
    { url: 'https://facebook.com/colors/saveiro-2015', title: 'Saveiro 2015 cores',
      snippet: 'Vermelho', rank: 2 },
  ].map(source => ({ ...source, queries: ['palette query'] }));
  const run = { index: new Map(entries.map(source => [source.url, source])),
    attempted: new Set(), pagePool: { unavailableHost: () => false } };

  assert.equal(paletteSources(run, vehicle, ['palette query'], 1)[0].url,
    'https://archive.example/folheto-saveiro-2015.pdf');
});

test('an indexed trim does not narrow the model-wide brochure query', () => {
  const source = { url: 'https://example.com/2015-saveiro-cross',
    title: '2015 Volkswagen Saveiro Cross', snippet: 'Cores exteriores' };
  const index = new Map([[source.url, source]]);

  assert.match(paletteSearchQuery(vehicle, index), /Saveiro 2015 cores catálogo PDF/);
  assert.doesNotMatch(paletteSearchQuery(vehicle, index), /Cross/);
});

test('planner preferences cannot force an unrelated maker-wide PDF', () => {
  const broad = { url: 'https://paint.example/downloads/2024.pdf', title: 'Volkswagen color catalog',
    snippet: 'All Volkswagen colors, including Saveiro' };
  const exact = { url: 'https://archive.example/saveiro-cross-2015.pdf',
    title: 'Saveiro Cross 2015 cores', snippet: 'Cores da Saveiro 2015' };
  const index = new Map([broad, exact].map(source => [source.url, source]));

  assert.deepEqual(vettedPreferredUrls(index, [broad.url, exact.url], vehicle), [exact.url]);
});

test('brochure code and paint rows survive deterministic extraction', () => {
  const text = `Saveiro Cross\n2015 Volkswagen\n\nCORES\nSÓLIDAS\nD8D8 – Vermelho Flash\nB4B4 – Branco Cristal\nA1A1 – Preto Ninja\nMETÁLICAS\nS0S0 – Vermelho Ópera\n7Z7Z – Prata Sirius`;
  const names = literalPaintRows(text, vehicle).map(candidate => candidate.name);

  assert.ok(names.includes('Vermelho Flash'));
  assert.ok(names.includes('Vermelho Ópera'));
  assert.equal(literalPaintRows(text, { ...vehicle, model: 'Gol' }).length, 0);
  assert.equal(yearPalettePages([{ url: 'https://example.com/saveiro-2015.pdf', title: 'Saveiro 2015 cores',
    status: 'ok', candidates: names.map(name => ({ name })) }], vehicle).length, 1);
});

test('one short paint name cannot expand into another hue through neighboring codes', () => {
  const candidate = { name: 'Tornadorot', name_check: { required: true },
    sources: [{ page_id: 'P1', url: 'https://example.com/saveiro/2024',
      evidence: ['Tornadorot\n5K, K5K5, B7W, LB7W, K5'] }] };
  const rows = [{ catalog: 'basf', manufacturer: 'VOLKSWAGEN',
    description: 'TUNGSTEN SILVER MET', universal_code: 'LB7W' }];

  assert.equal(catalogNameExpansion(candidate, rows, vehicle), null);
});

test('a candidate-owned red category defeats an unsupported hue rejection', () => {
  const candidate = { id: 'C1', name: 'Muranorot Perleffekt',
    sources: [{ page_id: 'P1', evidence: ['Muranorot Perleffekt 1997–2015 · Metallic · Red'] }] };
  const decisions = { C1: { exclude_reason: 'unrelated_hue', reason: 'unrelated_hue' } };

  retainUnsupportedHueExclusions([candidate], decisions, vehicle);
  assert.equal(decisions.C1.action, 'include');
});

test('targeted brochure and missing-name searches use bounded existing quotas', async () => {
  const indexed = { url: 'https://example.com/cores-saveiro-2014', title: 'Cores Saveiro 2014',
    snippet: 'Cores Saveiro 2014 1. Vermelho Flash 2. Vermelho Ópera 3. Azul Night' };
  const searches = [], reads = [];
  const run = { index: new Map([[indexed.url, indexed]]), pages: [
    { url: 'https://example.com/saveiro', status: 'ok', candidates: [{ name: 'Flashrot' },
      { name: 'Blue' }, { name: 'Silver' }] },
    { url: 'https://example.net/saveiro', status: 'ok', candidates: [{ name: 'Flashrot' },
      { name: 'Black' }, { name: 'White' }] },
  ], attempted: new Set(), pagePool: { unavailableHost: () => false },
    discoverySignal: new AbortController().signal, searchBlocked: false, maxPages: 24,
    maxSearches: 10, maxPaletteSearches: 2, queries: new Set(), searchJobs: [],
    candidates: () => [{ name: 'Flashrot', sources: [{ evidence: ['Vermelho Flash LP3G'] }] }],
    search: async (queries, _vehicle, _signal, options) => {
      searches.push({ query: queries[0], forPalette: !!options?.forPalette });
      run.queries.add(queries[0]);
      const page = { url: `https://paint.example/${searches.length}/saveiro-2015.pdf`,
        title: 'Saveiro 2015 cores catálogo', snippet: 'Vermelho Ópera',
        rank: 1, queries };
      run.index.set(page.url, page);
    },
    readSources: async sources => { reads.push(...sources); },
    log: () => {},
  };

  await researchPaletteGaps(run, vehicle);
  assert.equal(searches.length, 2);
  assert.ok(searches.some(row => row.query.includes('Vermelho Ópera') && row.forPalette));
  assert.ok(reads.length > 0 && reads.length <= 2);
});
