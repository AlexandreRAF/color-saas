const test = require('node:test');
const assert = require('node:assert/strict');

const { candidateInventory } = require('../candidate_inventory');
const { sourceCodes, sourceEvidence } = require('../paint_evidence');

test('a separate code row inside multiline evidence removes a duplicated name prefix', () => {
  const evidence = ['040 Super White Solid\nTOYOTA COROLLA\n040 - Super White Solid'];
  const colors = candidateInventory([{ id: 'P1', url: 'https://example.com/paints',
    candidates: [{ name: '040 Super White Solid', evidence }] }]);
  assert.equal(colors[0].name, 'Super White');
  assert.deepEqual(sourceCodes(colors[0].name, evidence), ['040']);
});

test('numbers remain part of a name without a separately printed matching code row', () => {
  const colors = candidateInventory([{ id: 'P1', url: 'https://example.com/paints',
    candidates: [{ name: '77 Silver', evidence: ['77 Silver is the published paint name.'] }] }]);
  assert.equal(colors[0].name, '77 Silver');
});

test('a code row outside the extractor quote preserves the complete name and code evidence', () => {
  const colors = candidateInventory([{ id: 'P1', url: 'https://example.com/paints',
    text: '040 Super White Solid\nTOYOTA COROLLA\n040 - Super White Solid\n041 - White Solid',
    candidates: [{ name: '040 Super White Solid', evidence: ['040 Super White Solid'] }] }]);
  assert.equal(colors[0].name, 'Super White');
  const [source] = sourceEvidence(colors[0], colors[0].sources);
  assert.equal(source.source_name, 'Super White Solid');
  assert.deepEqual(source.paint_codes, ['040']);
  assert.ok(source.passages.includes('040 - Super White Solid'));
});

test('another color with the same prefix cannot strip a numbered marketing name', () => {
  const colors = candidateInventory([{ id: 'P1', url: 'https://example.com/paints',
    text: '77 - Silver Moon',
    candidates: [{ name: '77 Silver', evidence: ['77 Silver is the published paint name.'] }] }]);
  assert.equal(colors[0].name, '77 Silver');
});
