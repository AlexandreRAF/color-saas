const test = require('node:test');
const assert = require('node:assert/strict');
const { printedNameKey, sourceCodes, sourceEvidence, relatesToNameLead, nameResearchQueries } = require('../paint_evidence');

test('linked catalog card codes belong to the full named paint, not neighboring cards', () => {
  const row = '[`N2` ### Pure White Pearl 2005–2015 · White](https://catalog.test/paint)';
  assert.deepEqual(sourceCodes('Pure White Pearl', [row]), ['N2']);
  assert.deepEqual(sourceCodes('Pure White', [row]), ['N2']);
  assert.deepEqual(sourceCodes('Other White', [row]), []);
  assert.deepEqual(sourceCodes('Pure White Pearl', [row.replace('N2', '2015')]), []);
});
const { candidateInventory } = require('../candidate_inventory');

test('Gray and Grey share evidence while distinct versions and translated names remain separate', () => {
  assert.equal(printedNameKey('PEPPER-GREY'), printedNameKey('Pepper Gray'));
  assert.notEqual(printedNameKey('Steel Grey'), printedNameKey('Steel Gray II'));
  assert.notEqual(printedNameKey('Cinza Titanium'), printedNameKey('Gray Titanium'));
  const inventory = candidateInventory([
    { id: 'P1', url: 'https://a.test', candidates: [{ name: 'Pepper Gray', evidence: ['Pepper Gray'] }] },
    { id: 'P2', url: 'https://b.test', candidates: [{ name: 'Pepper Grey', evidence: ['Pepper Grey'] }] },
  ]);
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].sources.length, 2);
  assert.deepEqual(inventory[0].aliases, ['Pepper Gray', 'Pepper Grey']);
});

test('paint codes come from table cells and labels, not arbitrary prose or model years', () => {
  assert.deepEqual(sourceCodes('Shimmering Silver', ['2010', 'N3S\nShimmering Silver', 'N3S - Shimmering Silver']), ['N3S']);
  assert.deepEqual(sourceCodes('Cinza Titanium', ['Y6G - Metálica', 'Fits IX35 from 2013']), ['Y6G']);
  assert.deepEqual(sourceCodes('Steel Gray', ['paint code: ZAR', 'A year 2024 and model F150']), ['ZAR']);
});

test('a source keeps its printed short name when the reviewed identity is expanded', () => {
  const source = { page_id: 'P1', url: 'https://paint.example/model', evidence: ['Hyper\n\nHYWJX/WJX'] };
  const candidate = { name: 'Hyper', aliases: ['Hyper', 'Hyper Metallic'], sources: [source] };
  const [linked] = sourceEvidence(candidate, [source]);

  assert.equal(linked.source_name, 'Hyper');
  assert.deepEqual(linked.paint_codes, ['WJX']);
  assert.deepEqual(sourceCodes(linked.source_name, linked.passages), ['WJX']);
  assert.deepEqual(sourceCodes('Hyper Metallic', linked.passages), []);
});

test('name clarification accepts full names and code-linked aliases, not unrelated palettes', () => {
  assert.equal(relatesToNameLead({ name: 'Hyper Silver', evidence: ['P2S - Hyper Silver'] }, 'Hyper', ['P2S']), true);
  assert.equal(relatesToNameLead({ name: 'Graphite Gray', evidence: ['WJX - Graphite Gray'] }, 'Hyper', ['WJX']), true);
  assert.equal(relatesToNameLead({ name: 'Flame Red', evidence: ['R7 - Flame Red'] }, 'Hyper', ['WJX']), false);
  assert.equal(relatesToNameLead({ name: 'Hyperion Blue', evidence: ['Hyperion Blue'] }, 'Hyper', []), false);
});

test('single names remain research leads even when one related longer form is known', () => {
  const leads = nameResearchQueries([
    { name: 'Sirius', sources: [], name_check: { longer_names: ['Sirius Silver'] } },
    { name: 'Hyper', sources: [{ evidence: ['P2S - Hyper', 'WJX - Hyper'] }] },
    { name: 'Hyundai', sources: [] },
    { name: 'WB4', sources: [] },
  ], { brand: 'Hyundai', model: 'ix35' });
  assert.deepEqual(leads.map(lead => lead.name), ['Hyper', 'Sirius']);
  assert.match(leads[0].query, /P2S WJX/);
});
