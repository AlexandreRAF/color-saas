const test = require('node:test');
const assert = require('node:assert/strict');
const { outputColors, finalOutput } = require('../final_output');

test('catalog descriptors supply finish even when no finish was requested', () => {
  const colors = outputColors([{ name: 'Ice White', code_candidates: [{ universal_code: 'WW7',
    description: 'ICE WHITE', finish_evidence: [{ description: 'BRANCO PEROL' }] }] }]);
  assert.deepEqual(colors[0].paintFinish, ['perolizado']);
  assert.equal(colors[0].finishMatch, undefined);
});

test('multiple optical effects and sheen coexist independently of coat count', () => {
  const [color] = outputColors([{ name: 'Moon White Tricoat', source_evidence: [{
    source_name: 'Moon White Tricoat', passages: ['Moon White Tricoat. Finish: metallic pearl matte.'],
  }] }]);
  assert.equal(color.name, 'Moon White');
  assert.deepEqual(color.paintFinish, ['metálico', 'perolizado', 'fosco', 'tricamada']);
  assert.equal(color.finishMatch, undefined);
});

test('suffix labels do not upgrade unknown finish compatibility', () => {
  const [color] = outputColors([{ name: 'Pure White', finishMatch: 'unknown', source_evidence: [{
    source_name: 'Pure White Pearl', passages: ['Pure White Pearl'],
  }] }]);
  assert.deepEqual(color.paintFinish, ['perolizado']);
  assert.equal(color.finishMatch, 'unknown');
});

test('missing evidence stays unknown rather than copying the requested finish', () => {
  const result = finalOutput({ paintFinish: 'perolizado', colors: [{ name: 'Ice White' }], research: {} });
  assert.deepEqual(result.colors[0].paintFinish, ['desconhecido']);
});

test('merged contradictory evidence stays visible without filtering the candidate', () => {
  const [color] = outputColors([
    { name: 'Moon White', finishMatch: 'confirmed', code_candidates: [{ description: 'BRANCO LISO' }] },
    { name: 'Moon White', code_candidates: [{ description: 'BRANCO PEROL' }] },
  ]);
  assert.deepEqual(color.paintFinish, ['conflitante']);
  assert.equal(color.finishMatch, 'unknown');
});

test('database layer annotations do not establish solid finish for a pearl base', () => {
  const [color] = outputColors([{ name: 'Moon White', code_candidates: [{ description: 'BRANCO LISO (BASE)/CL' }] }]);
  assert.deepEqual(color.paintFinish, ['desconhecido']);
});

test('standard finish fields exist in both output formats with no internal metadata', () => {
  const input = { colors: [{ name: 'Night Black Matte', sources: ['https://catalog.test'] }], research: {} };
  for (const format of ['compact', 'expanded']) {
    const result = finalOutput(input, { format });
    assert.equal(result.colors[0].name, 'Night Black');
    assert.deepEqual(result.colors[0].paintFinish, ['fosco']);
    assert.equal(result.colors[0]._finishInputs, undefined);
    assert.deepEqual(result.colors[0].sources, ['https://catalog.test']);
  }
});
