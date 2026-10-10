const test = require('node:test');
const assert = require('node:assert/strict');
const { numberedEvidence, restoreChecks } = require('../verification_evidence');

test('verification references restore exact source bytes across adjacent units', () => {
  const text = '  Ice White WW9\n\n Finish: pearl.\nOther paint';
  const { pages, ranges } = numberedEvidence([{ id: 'S1', text }]);
  assert.equal(pages[0].text, '1| Ice White WW9\n2| Finish: pearl.\n3| Other paint');
  const [check] = restoreChecks([{ source_id: 'S1', evidence_ids: [1, 2] }], ranges);
  assert.equal(check.quote, 'Ice White WW9\n\n Finish: pearl.');
  assert.ok(text.includes(check.quote));
});

test('verification references reject missing pages, invalid IDs and excerpt gaps', () => {
  const { ranges } = numberedEvidence([{ id: 'S1', text: 'Ice White\n[…]\nFinish: pearl.' }]);
  for (const check of [
    { source_id: 'other', evidence_ids: [1] },
    { source_id: 'S1', evidence_ids: [0] },
    { source_id: 'S1', evidence_ids: [1, 3] },
    { source_id: 'S1', evidence_ids: [1, 2, 3] },
    { source_id: 'S1', evidence_ids: {} },
  ]) assert.equal(restoreChecks([check], ranges)[0].quote, '');
});
