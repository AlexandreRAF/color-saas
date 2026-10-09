'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clearlyHistoricalLead } = require('../candidate_year_scope');
const { candidateInventory } = require('../candidate_inventory');

const vehicle = { brand: 'Chevrolet', model: 'S10', manufacturingYear: 2025 };
const archive = { id: 'P1', url: 'https://gallery.test/colors/Chevrolet/All/S10/',
  title: 'All Chevrolet S10 Colors', status: 'ok' };
const old = { name: 'Apple Red', evidence: [
  '## Apple Red Chevrolet Color\nApple Red 1989 S10\nApple Red 1992 S10',
  '[Apple Red 1996 S10](https://gallery.test/colors/Chevrolet/S10/1996/Apple+Red/)',
] };

test('an all-year gallery lead with only remote dated appearances is not a 2025 candidate', () => {
  assert.equal(clearlyHistoricalLead(old, archive, vehicle), true);
  const artifacts = [];
  assert.deepEqual(candidateInventory([{ ...archive, candidates: [old] }], {
    vehicle, manufacturer: vehicle.brand, onArtifact: row => artifacts.push(row),
  }), []);
  assert.equal(artifacts[0].reason, 'documented_other_year');
});

test('nearby dates, explicit reuse, target-year pages and undated paint rows remain candidates', () => {
  const variants = [
    { ...old, evidence: ['Apple Red 2023 S10'] },
    { ...old, evidence: [...old.evidence, 'Also used on 2025 Chevrolet S10.'] },
    { ...old, evidence: [...old.evidence, 'Apple Red | WA1234'] },
    { ...old, evidence: ['Apple Red | WA1234'] },
  ];
  for (const candidate of variants) {
    assert.equal(clearlyHistoricalLead(candidate, archive, vehicle), false);
  }
  assert.equal(clearlyHistoricalLead(old, { ...archive,
    url: 'https://gallery.test/colors/Chevrolet/S10/2025/' }, vehicle), false);
});

test('a historical sighting can support a paint already found on a current-year source', () => {
  const current = { id: 'P2', url: 'https://maker.test/chevrolet/s10/2025-colors',
    title: '2025 Chevrolet S10 colors', candidates: [{ name: 'Apple Red', evidence: ['Apple Red - WA1234'] }] };
  const found = candidateInventory([{ ...archive, candidates: [old] }, current], {
    vehicle, manufacturer: vehicle.brand,
  });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].sources.map(source => source.url), [current.url]);
});
