'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { vehicleProfile } = require('../vehicle_profiles');
const { seedQueries, selectSources } = require('../research_plan');
const { displayColorCandidates } = require('../display_color');
const { candidateInventory, reviewedColors } = require('../candidate_inventory');
const { clearlyHistoricalLead, clearlyOtherModelLead } = require('../candidate_year_scope');
const { crossCheckedWebCodes } = require('../web_code_evidence');
const { formalName } = require('../qwen_page');
const { coverage } = require('../discovery_pipeline');
const { CatalogResearch } = require('../catalog_research');
const { addDatabaseCodes } = require('../database_code_agent');

test('vehicle vocabulary covers road, agricultural and construction equipment', () => {
  const cases = [
    ['car', 'car'], ['moto', 'motorcycle'], ['caminhão', 'truck'], ['ônibus', 'bus'],
    ['combine harvester', 'agricultural'], ['wheel loader', 'construction'],
    ['specialist vehicle', 'general'],
  ];
  for (const [input, expected] of cases) assert.equal(vehicleProfile(input).kind, expected);

  const vehicle = { automobileType: 'excavator', brand: 'Maker', model: 'ZX 200',
    manufacturingYear: 2020, country: 'Brazil', predominantColor: 'amarelo' };
  const queries = seedQueries(vehicle).join('\n');
  assert.match(queries, /escavadeira|excavator|construção/iu);
  assert.doesNotMatch(queries, /site:paintscratch\.com/iu);
});

test('equipment source selection saves page slots for paint evidence', () => {
  const vehicle = { automobileType: 'tractor', brand: 'Massey Ferguson', model: '275',
    manufacturingYear: 1980 };
  const social = { url: 'https://www.instagram.com/reel/sample',
    title: 'Massey Ferguson 275 pintura original', snippet: 'Trator 275 cores' };
  const supplier = { url: 'https://supplier.test/massey-ferguson-275-paint',
    title: 'Massey Ferguson 275 paint code', snippet: 'Original tractor paint' };
  const index = new Map([[social.url, social], [supplier.url, supplier]]);
  assert.deepEqual(selectSources(index, new Set(), vehicle, 2).map(row => row.url), [supplier.url]);
});

test('a model/year palette can retain a qualified display color without making up a code', () => {
  const vehicle = { automobileType: 'motorcycle', brand: 'Honda', model: 'CG 160',
    manufacturingYear: 2020, predominantColor: 'vermelho' };
  const sentence = 'Honda CG 160 2020 disponível nas cores azul metálico e vermelho perolizado.';
  const page = { id: 'P1', url: 'https://example.test/cg-160-2020',
    title: 'Honda CG 160 2020 cores', text: sentence };
  const display = displayColorCandidates(page, vehicle);
  assert.ok(display.some(row => row.name.toLowerCase() === 'vermelho perolizado'));

  const inventory = candidateInventory([{ ...page, candidates: display }],
    { manufacturer: vehicle.brand, vehicle });
  const red = inventory.find(row => row.name.toLowerCase() === 'vermelho perolizado');
  assert.equal(red.identityType, 'vehicle_display_color');
  const result = reviewedColors([red], { [red.id]: { action: 'include', name: null,
    confidence: 'low', source_ids: ['P1'], reason: 'Paleta publicada para o modelo.' } });
  assert.equal(result[0].identityType, 'vehicle_display_color');

  const unrelated = { ...page, title: 'Honda CG 160 2021 cores', text: sentence.replace('2020', '2021') };
  assert.deepEqual(displayColorCandidates(unrelated, vehicle), []);
});

test('trim names stay out of the palette and generic-to-formal labels keep the formal name', () => {
  const vehicle = { brand: 'Honda', model: 'CG 160', manufacturingYear: 2020 };
  const page = { id: 'P1', url: 'https://dealer.test/cg-160-2020',
    title: 'Honda CG 160 Titan S 2020',
    candidates: [{ name: 'Titan S', evidence: [
      'A nova versão Titan S traz cores e design exclusivo.',
      'A versão Titan S 2020 tem vermelho e preto no tanque.',
    ] }] };
  assert.deepEqual(candidateInventory([page], { vehicle, manufacturer: vehicle.brand }), []);
  assert.equal(formalName('Vermelho Perolizado - Pearl Marrakesh Red'), 'Pearl Marrakesh Red');
});

test('explicit model-history years and sibling model pages cannot establish the target edition', () => {
  const vehicle = { brand: 'Honda', model: 'CB 500F', manufacturingYear: 2020 };
  const dated = { name: 'Candy Ruby Red', evidence: ['2013–2014 | Candy Ruby Red'] };
  const page = { url: 'https://example.test/honda-cb500f-history', title: 'Honda CB500F 2020 history' };
  assert.equal(clearlyHistoricalLead(dated, page, vehicle), true);
  assert.equal(clearlyHistoricalLead({ name: 'Grand Prix Red',
    evidence: ['2019–2022 | Grand Prix Red'] }, page, vehicle), false);

  const sibling = { url: 'https://example.test/honda-cb500x', title: 'Honda CB500X paint colors' };
  assert.equal(clearlyOtherModelLead(dated, sibling, vehicle), true);
  assert.equal(clearlyOtherModelLead({ ...dated, evidence: ['Honda CB500F Candy Ruby Red'] },
    sibling, vehicle), false);
});

test('web-only codes need paint-owned evidence from two fetched domains', () => {
  const source = url => ({ url, source_name: 'Grand Prix Red',
    passages: ['Grand Prix Red - Paint Code: R380'] });
  const color = { name: 'Grand Prix Red', source_evidence: [
    source('https://first.test/red'), source('https://second.test/red') ] };
  assert.deepEqual(crossCheckedWebCodes(color).map(row => row.universal_code), ['R380']);
  assert.deepEqual(crossCheckedWebCodes({ ...color, source_evidence: [color.source_evidence[0]] }), []);
  assert.deepEqual(crossCheckedWebCodes({ ...color, identityType: 'vehicle_display_color' }), []);
  assert.deepEqual(crossCheckedWebCodes({ ...color, source_evidence: [
    color.source_evidence[0], { ...color.source_evidence[1], retrievalMethod: 'search_snippet' },
  ] }), []);
});

test('fleet paint needs an explicit all-equipment claim and a separate model-period source', () => {
  const vehicle = { automobileType: 'excavator', brand: 'Example Heavy', model: 'EX 320',
    manufacturingYear: 2020 };
  const standard = { id: 'P1', url: 'https://paint.example/standard', status: 'ok',
    title: 'Example Heavy original paint',
    text: 'Example Heavy: Signal Yellow is the standard factory paint for all Example Heavy machines.',
    candidates: [{ name: 'Signal Yellow', evidence: [
      'Signal Yellow is the standard factory paint for all Example Heavy machines.'] }] };
  const model = { id: 'P2', url: 'https://dealer.example/ex-320-2020', status: 'ok',
    title: 'Example Heavy EX 320 2020 excavator',
    text: 'Example Heavy EX 320 2020 excavator model specifications.', candidates: [] };

  const colors = candidateInventory([standard, model], { manufacturer: vehicle.brand, vehicle });
  assert.equal(colors.length, 1);
  assert.equal(colors[0].identityType, 'fleet_standard_paint');
  assert.deepEqual(colors[0].sources.map(source => source.claimScope),
    ['fleet_standard_paint', 'model_period_context']);
  assert.equal(coverage([standard, model], colors, { vehicle, afterRecovery: true }).needsExpansion, false);

  const vague = { ...standard, text: 'Example Heavy offers Signal Yellow paint.',
    candidates: [{ name: 'Signal Yellow',
      evidence: ['Example Heavy offers Signal Yellow paint.'] }] };
  assert.equal(candidateInventory([vague, model], { manufacturer: vehicle.brand, vehicle })[0].identityType,
    undefined);
  assert.equal(candidateInventory([standard], { manufacturer: vehicle.brand, vehicle })[0].identityType,
    undefined);
  assert.equal(candidateInventory([standard, { ...model,
    url: 'https://dealer.paint.example/ex-320-2020' }],
    { manufacturer: vehicle.brand, vehicle })[0].identityType, undefined);
  assert.equal(candidateInventory([standard, { ...model, url: 'https://dealer.example/ex-320-2012',
    title: 'Example Heavy EX 320 2012 excavator',
    text: 'Example Heavy EX 320 2012 excavator model specifications.' }],
    { manufacturer: vehicle.brand, vehicle })[0].identityType, undefined);
  assert.equal(candidateInventory([standard, { ...model,
    title: 'Example Heavy EX 320 excavator',
    text: 'Published: 2020\nExample Heavy EX 320 2012 excavator.' }],
    { manufacturer: vehicle.brand, vehicle })[0].identityType, undefined);
  assert.equal(candidateInventory([standard, model], { manufacturer: vehicle.brand,
    vehicle: { ...vehicle, automobileType: 'bus' } })[0].identityType, undefined);
});

test('specialist coverage accepts two independently agreeing one-paint sources after recovery', () => {
  const vehicle = { automobileType: 'tractor' };
  const pages = ['one.example', 'two.example'].map((host, index) => ({
    id: `P${index + 1}`, url: `https://${host}/palette`, status: 'ok',
    candidates: [{ name: 'Massey Ferguson Red' }],
  }));
  assert.equal(coverage(pages, [{ name: 'Massey Ferguson Red' }], { vehicle }).needsExpansion, true);
  assert.equal(coverage(pages, [{ name: 'Massey Ferguson Red' }],
    { vehicle, afterRecovery: true }).needsExpansion, false);
  assert.equal(coverage(pages, [], { vehicle, afterRecovery: true }).needsExpansion, true);
  assert.equal(coverage(pages.slice(0, 1), [{ name: 'Massey Ferguson Red' }],
    { vehicle, afterRecovery: true }).needsExpansion, true);
  assert.equal(coverage(pages.map((page, index) => ({ ...page,
    url: `https://${index ? 'docs' : 'shop'}.one.example/palette` })),
    [{ name: 'Massey Ferguson Red' }], { vehicle, afterRecovery: true }).needsExpansion, true);
  const local = { id: 'BM1', url: 'catalog:basf_models:1', status: 'ok',
    candidates: [{ name: 'Massey Ferguson Red' }] };
  assert.equal(coverage([pages[0], local], [{ name: 'Massey Ferguson Red' }],
    { vehicle, afterRecovery: true }).needsExpansion, true);
});

test('qualified display labels perform an exact mandatory lookup without code identity review', async () => {
  const requests = [];
  const signal = new AbortController().signal;
  const catalogs = new CatalogResearch({ brand: 'Honda', model: 'CG 160', manufacturingYear: 2020 }, {
    signal,
    lookup: async request => {
      requests.push(request);
      return { catalogs_queried: ['lazzumix', 'basf', 'basf_models'], candidates: [] };
    },
    review: () => { throw new Error('Generic display labels cannot request identity AI'); },
  });
  const candidate = { name: 'Vermelho Perolizado', identityType: 'vehicle_display_color',
    sources: [{ page_id: 'P1', url: 'https://example.test/palette',
      evidence: ['Honda CG 160 2020 cores: Vermelho Perolizado.'] }] };
  const checked = await catalogs.get(candidate);
  assert.equal(checked.status, 'no_match');
  assert.equal(requests[0].exact_name_only, true);
  assert.deepEqual(requests[0].source_codes, []);

  const result = await addDatabaseCodes({ make: 'Honda', colors: [{ name: candidate.name,
    identityType: candidate.identityType, source_evidence: [{ url: candidate.sources[0].url,
      passages: candidate.sources[0].evidence }] }] }, {
    brand: 'Honda', loadCandidatesFn: async () => [{ index: 0, candidates: [{ candidate_id: 1,
      catalog: 'lazzumix', description: 'Vermelho Perolizado', manufacturer: 'Honda',
      universal_code: 'R999', complete_name_match: true, source_code_match: true }] }],
    request: async () => { throw new Error('Display label must not call the matcher'); },
  });
  assert.deepEqual(result.colors[0].code_candidates, []);
});
