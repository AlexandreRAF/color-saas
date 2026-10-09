const test = require('node:test');
const assert = require('node:assert/strict');

const { MatcherBatcher } = require('../matcher_batcher');

test('matcher transport retains every catalog fact, conflict and original identity', () => {
  const { matcherInput } = require('../database_code_agent');
  const rows = [1, 2].map(candidate_id => ({ candidate_id, description: 'Example Silver',
    manufacturer: 'Example', year: '2010-2020', universal_code: `A${candidate_id}`,
    paintFinish: [candidate_id === 1 ? 'metálico' : 'sólido'],
    source_code_match: false, finish_relation: 'unknown', finish_evidence: [{ description: 'Full quoted suffix' }],
    year_evidence: { start: 2010, end: 2020, vehicleYearConfirmed: false } }));
  const payload = { vehicle: { brand: 'Example' }, colors: [{ index: 0, color: 'Example Silver',
    source_evidence: [{ passages: ['Every source qualification.'] }], db_candidates: rows }] };
  const original = structuredClone(payload);
  const input = matcherInput(payload);
  const restored = input.colors[0].db_candidates.map(({ values, ...row }) => ({ ...row,
    ...Object.fromEntries(input.catalogColumns.map((column, index) => [column, values[index]])),
  }));
  assert.deepEqual(restored, rows);
  assert.deepEqual(input.colors[0].source_evidence, payload.colors[0].source_evidence);
  assert.deepEqual(payload, original);
});
const { addDatabaseCodes, validateMatches, validMatches } = require('../database_code_agent');

const payload = (name, index = 0) => ({ vehicle: { brand: 'Example' }, colors: [
  { index, color: name, source_evidence: [{ passages: [`${name} original evidence`] }],
    db_candidates: [{ candidate_id: name.length, universal_code: `C${name.length}` }] },
] });

test('settled requests coalesce with bounded concurrency and original indices restored', async () => {
  let calls = 0, active = 0, peak = 0;
  const batcher = new MatcherBatcher(async input => {
    calls++;
    peak = Math.max(peak, ++active);
    assert.ok(input.colors.length <= 8);
    assert.equal(new Set(input.colors.map(row => row.index)).size, input.colors.length);
    for (const row of input.colors) assert.deepEqual(row.source_evidence[0].passages, [`${row.color} original evidence`]);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return { result: { matches: input.colors.map(row => ({ index: row.index,
      candidate_ids: [row.db_candidates[0].candidate_id] })) }, usage: { total_tokens: 100 } };
  }, { concurrency: 2 });
  const outputs = await Promise.all(Array.from({ length: 25 }, (_, i) => batcher.add(payload(`Paint ${i}`, i), {})));
  assert.equal(calls, 4);
  assert.equal(peak, 2);
  outputs.forEach((out, i) => {
    assert.deepEqual(out.result.matches, [{ index: i, candidate_ids: [`Paint ${i}`.length] }]);
    assert.deepEqual(out.usage, {});
  });
});

test('different run signals do not share matching evidence and cancellation sends nothing', async () => {
  let calls = 0;
  const batcher = new MatcherBatcher(async input => {
    calls++;
    assert.equal(input.colors.length, 1);
    return { result: { matches: [{ index: 0, candidate_ids: [] }] } };
  });
  const a = new AbortController(), b = new AbortController();
  const first = batcher.add(payload('First'), { signal: a.signal });
  const cancelled = batcher.add(payload('Cancelled'), { signal: b.signal });
  b.abort(new Error('Caller cancelled'));
  const results = await Promise.allSettled([first, cancelled]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(calls, 1);
});

test('no catalog candidates needs no model call and is a completed no-match', async () => {
  const result = await addDatabaseCodes({ colors: [{ name: 'Unknown Paint', sources: [] }] }, {
    loadCandidatesFn: async () => [{ index: 0, candidates: [] }],
    request: async () => assert.fail('Empty candidates must not use paid matching'),
  });
  assert.equal(result.colors[0].universal_code, '');
  assert.deepEqual(result._databaseCodeAgentIncompleteNames, []);
});

test('matcher rejects missing, repeated, foreign and invented selections', () => {
  const input = { colors: [...payload('Alpha', 0).colors, ...payload('Beta', 1).colors] };
  for (const matches of [[], [{ index: 0, candidate_ids: [] }, { index: 0, candidate_ids: [] }],
    [{ index: 0, candidate_ids: [4] }, { index: 1, candidate_ids: [] }],
    [{ index: 0, candidate_ids: [] }, { index: 1, candidate_ids: [999] }]]) {
    assert.throws(() => validateMatches({ matches }, input));
  }
  assert.doesNotThrow(() => validateMatches({ matches: [
    { index: 0, candidate_ids: [5] }, { index: 1, candidate_ids: [4] },
  ] }, input));
});

test('matching cannot add or erase a catalog version without a source-printed code', () => {
  const input = payload('Moon Silver');
  const row = input.colors[0].db_candidates[0];
  row.description = 'Moon Silver II MET';
  const answer = { matches: [{ index: 0, candidate_ids: [row.candidate_id] }] };
  assert.throws(() => validateMatches(answer, input), /changed a paint version/);
  input.colors[0].color = 'Moon Silver III';
  assert.throws(() => validateMatches(answer, input), /changed a paint version/);
  input.colors[0].source_evidence = [{ source_name: 'Moon Silver', passages: [`Moon Silver paint code ${row.universal_code}`] }];
  assert.doesNotThrow(() => validateMatches(answer, input));
});

test('invalid matcher children retain validated siblings as completed work', async () => {
  const a = payload('Alpha', 0).colors[0], b = payload('Beta', 1).colors[0];
  const value = { matches: [{ index: 0, candidate_ids: [5] }, { index: 1, candidate_ids: [999] }] };
  assert.deepEqual(validMatches(value, { colors: [a, b] }), [value.matches[0]]);
  const batcher = new MatcherBatcher(async () => ({ result: { matches: [value.matches[0]] } }));
  const result = await batcher.add({ colors: [a, b], vehicle: {} }, {});
  assert.deepEqual(result.result.matches, [value.matches[0]]);
  assert.deepEqual(result.incompleteIndices, [1]);
});
