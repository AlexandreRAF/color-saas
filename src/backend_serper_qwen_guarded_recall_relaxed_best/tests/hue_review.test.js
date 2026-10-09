const test = require('node:test');
const assert = require('node:assert/strict');
const { hueFamilies, hueConflicts, applyHueChecks, HueReviewQueue } = require('../hue_review');

function inventory(names) {
  return names.map((name, index) => ({ id: `C${index}`, name }));
}

test('ready hue checks batch without waiting for unrelated main reviews', async () => {
  const candidates = inventory(['Silver Moon', 'Blue Moon']).map(candidate => ({ ...candidate, sources: [] }));
  const seen = [];
  const queue = new HueReviewQueue({ reviewSignal: new AbortController().signal,
    evidencePages: () => [], mainAgent: async (_stage, _schema, input) => {
      seen.push(input.candidates.map(candidate => candidate.id));
      return { checks: input.candidates.map(candidate => ({ id: candidate.id,
        compatible: true, reason: 'Appearance remains unknown; name is not visual proof.' })) };
    } }, { predominantColor: 'white' });
  const first = { C0: { action: 'include' } }, second = { C1: { action: 'include' } };
  await Promise.all([queue.check([candidates[0]], first), queue.check([candidates[1]], second)]);
  assert.deepEqual(seen, [['C0', 'C1']]);
  assert.equal(first.C0.action, 'include');
  assert.equal(second.C1.action, 'include');
});

test('silver and gray paint names share a comparison family without changing identity', () => {
  const names = ['Prata Shark', 'Cinza Platinum', 'Steel Grey', 'Machine Silver'];
  const candidates = inventory(names);
  const decisions = Object.fromEntries(candidates.map(c => [c.id, { action: 'include' }]));

  for (const requested of ['prata', 'cinza', 'silver', 'gray', 'grey', 'gris']) {
    assert.deepEqual([...hueFamilies(requested)], ['silver-gray']);
    assert.deepEqual(hueConflicts(candidates, decisions, requested), []);
  }

  assert.deepEqual(candidates.map(candidate => candidate.name), names);
});

test('Portuguese ouro and English golden receive an evidence review against red requests', () => {
  const candidates = inventory(['Ouro Amaralina', 'Golden Sand', 'Vermelho Monte Carlo']);
  const decisions = Object.fromEntries(candidates.map(c => [c.id, { action: 'include' }]));
  assert.deepEqual(hueConflicts(candidates, decisions, 'vermelho').map(c => c.name), ['Ouro Amaralina', 'Golden Sand']);
});

test('white does not inherit silver/gray neighbors; complete white and ambiguous names survive', () => {
  const candidates = inventory(['Ice White', 'Sleek Silver', 'Ion Silver', 'Cinza Titanium', 'Pure Pearl', 'Ivory Pearl']);
  const decisions = Object.fromEntries(candidates.map(c => [c.id, { action: 'include' }]));
  assert.deepEqual(hueConflicts(candidates, decisions, 'branco').map(c => c.name),
    ['Sleek Silver', 'Ion Silver', 'Cinza Titanium']);
  assert.deepEqual(hueConflicts(candidates, decisions, '').map(c => c.name), []);
});

test('a same-name same-code supplier swatch sends an ambiguous marketing name to hue review', () => {
  const candidates = inventory(['Ruby Flare', 'Shark Silver', 'Blizzard Pearl']);
  candidates[0].visual_swatches = [{ page_id: 'P2', rgb: '831100', approximate_family: 'red' }];
  candidates[1].visual_swatches = [{ page_id: 'P2', rgb: '909090', approximate_family: 'silver-gray' }];
  const decisions = Object.fromEntries(candidates.map(candidate => [candidate.id, { action: 'include' }]));

  assert.deepEqual(hueConflicts(candidates, decisions, 'branco').map(candidate => candidate.name),
    ['Ruby Flare', 'Shark Silver']);
  assert.deepEqual(hueConflicts(candidates, decisions, 'cinza').map(candidate => candidate.name),
    ['Ruby Flare']);
});

test('silver and gray remain neighbors across languages and aliases are checked too', () => {
  const candidates = inventory(['Cinza Titanium', 'Steel Grey', 'Prata Lunar', 'Silver Blue', 'Branco Polar', 'Vermelho Solar']);
  const decisions = Object.fromEntries(candidates.map(c => [c.id, { alias_of: 'C0' }]));
  assert.deepEqual(hueConflicts(candidates, decisions, 'prata').map(c => c.name), ['Branco Polar', 'Vermelho Solar']);
  decisions.C4 = 'Família incompatível';
  decisions.C5 = { exclude_reason: 'unrelated_hue' };
  assert.deepEqual(hueConflicts(candidates, decisions, 'prata'), []);
});

test('hue checks require complete valid coverage before mutating any decision', () => {
  const candidates = inventory(['Ion Silver', 'Silver Pearl']);
  const decisions = { C0: { action: 'include' }, C1: { action: 'include' } };
  for (const checks of [[], [null, null],
    [{ id: 'C0', compatible: false, reason: 'Prata' }, { id: 'C0', compatible: true, reason: 'Branco' }]]) {
    assert.throws(() => applyHueChecks({ checks }, candidates, decisions), /coverage/);
    assert.equal(decisions.C0.action, 'include');
  }
  applyHueChecks({ checks: [
    { id: 'C0', compatible: false, reason: 'Fonte identifica prata.' },
    { id: 'C1', compatible: true, reason: 'Fonte descreve branco apesar do nome.' },
  ] }, candidates, decisions);
  assert.equal(decisions.C0.exclude_reason, 'unrelated_hue');
  assert.equal(decisions.C1.action, 'include');
});
