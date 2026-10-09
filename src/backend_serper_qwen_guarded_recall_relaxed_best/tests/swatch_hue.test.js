'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withoutClearlyDifferentSwatches } = require('../swatch_hue');
const { swatchCards } = require('../swatch_evidence');
const { candidateInventory } = require('../candidate_inventory');

const card = (name, code, rgb) => `* ![Image: ${name} ${code} swatch](https://example.test/b_rgb:${rgb}/swatch.jpg)\n\n`
  + `### ${name}\n\nMfr. Color Code: ${code}\n`;

test('printed hue and approximate swatch together remove clearly unrelated cards', () => {
  const source = 'Toyota Corolla colors\n' + card('Blizzard Pearl Tricoat', '070', 'fcfcf0')
    + card('Barcelona Red Pearl', '3R3', '7c1010')
    + card('Black Sand Pearl', '209', '0a1a10')
    + card('Mystery Shade', 'XYZ', 'cc9090')
    + card('Ruby Flare', 'ABC', '831100')
    + card('Silver Mist', '1F7', 'd7d7cb');
  const result = withoutClearlyDifferentSwatches(source, 'branco');

  assert.ok(result.includes('Blizzard Pearl Tricoat'));
  assert.ok(result.includes('Mystery Shade'));
  assert.ok(result.includes('Silver Mist'));
  assert.ok(!result.includes('Barcelona Red Pearl'));
  assert.ok(!result.includes('Black Sand Pearl'));
  assert.ok(!result.includes('Ruby Flare'));
  assert.equal(withoutClearlyDifferentSwatches(source, undefined), source);
});

test('silver and gray stay together and contradictory swatches stay for agent review', () => {
  const source = card('Shimmering Silver', 'N3S', '9e9982')
    + card('Titanium Gray', 'KAD', '909090')
    + card('Shark Silver', 'GXA', 'cc2020')
    + card('Pure White', '040', 'ffffff');
  const result = withoutClearlyDifferentSwatches(source, 'cinza');

  assert.ok(result.includes('Shimmering Silver'));
  assert.ok(result.includes('Titanium Gray'));
  assert.ok(result.includes('Shark Silver'));
  assert.ok(!result.includes('Pure White'));
});

test('a filtered swatch remains evidence for an independently printed name and code', () => {
  const supplier = card('Ruby Flare Pearl', '3T3', '831100')
    + card('Ruby Flare Pearl', '3T4', '831100')
    + card('Blue Flare Pearl', '3T3', '1010c0');
  const chartRow = '3T3 | RUBY FLARE PRL.';
  const pages = [{ id: 'P1', url: 'https://chart.test/2018', text: chartRow,
    candidates: [{ name: 'RUBY FLARE PRL.', evidence: [chartRow] }] },
  { id: 'P2', url: 'https://supplier.test/corolla', text: supplier, candidates: [] }];
  const inventory = candidateInventory(pages, { manufacturer: 'Toyota' });

  assert.equal(inventory.length, 1);
  assert.deepEqual(inventory[0].visual_swatches, [{ page_id: 'P2', rgb: '831100', approximate_family: 'red' }]);
  assert.equal(inventory[0].sources.length, 2);
  assert.ok(inventory[0].sources[1].evidence[0].includes('Mfr. Color Code: 3T3'));
  assert.ok(inventory[0].sources[1].evidence.every(passage => supplier.includes(passage)));
  assert.equal(swatchCards(supplier).length, 3);
});

test('a supplier swatch alone or a shared code cannot create cross-source evidence', () => {
  const supplier = card('Ruby Flare Pearl', '3T3', '831100');
  const row = '3T3 | BLUE FLARE PRL.';
  const pages = [{ id: 'P1', url: 'https://chart.test/2018', text: row,
    candidates: [{ name: 'BLUE FLARE PRL.', evidence: [row] }] },
  { id: 'P2', url: 'https://supplier.test/corolla', text: supplier, candidates: [] }];
  const inventory = candidateInventory(pages, { manufacturer: 'Toyota' });

  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].sources.length, 1);
  assert.equal(inventory[0].visual_swatches, undefined);
});
