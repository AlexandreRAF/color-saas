const test = require('node:test');
const assert = require('node:assert/strict');
const { compactCatalogRows } = require('../candidate_review');

test('catalog compaction preserves years and original row IDs without merging different codes or finishes', () => {
  const base = { catalog: 'basf', manufacturer: 'Hyundai', description: 'ICE WHITE PEARL',
    universal_code: 'WW9', paintFinish: ['perolizado'] };
  const { rows, identities } = compactCatalogRows([
    { ...base, candidate_id: 1, year: '2014-2017' },
    { ...base, candidate_id: 2, year: '2015-2018' },
    { ...base, candidate_id: 3, year: '2014', universal_code: 'OTHER' },
    { ...base, candidate_id: 4, year: '2014', paintFinish: ['sólido'] },
  ]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].years, ['2014-2017', '2015-2018']);
  assert.deepEqual(identities.get(1), [1, 2]);
  assert.deepEqual(identities.get(3), [3]);
});
