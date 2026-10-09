const test = require('node:test');
const assert = require('node:assert/strict');
const { cases, acceptance } = require('../evaluate_vehicles');

function completedResult(colors) {
  return {
    colors, timeMs: 39000, usage: { estimatedCostUsd: 0.04, costComplete: true }, totalEstimatedCostUsd: 0.05,
    completion: { status: 'complete', issues: [] },
    research: { reviewCoverage: { total: colors.length, reviewed: colors.length, unreviewed: 0 },
      matchingCoverage: { total: colors.length, completed: colors.length, incomplete: 0 },
      omissionReview: { total: 0, checked: 0, incomplete: 0, repairFailures: 0 } },
    verification: { colorsChecked: colors.length, colorsUnchecked: 0, colorsTotal: colors.length },
  };
}

for (const [label, name, code] of [
  ['ix35', 'Shimmering Silver', 'N3S'],
  ['azera', 'Ice White', 'WW7'],
  ['corolla', 'White Crystal Shine', '070'],
  ['gol', 'Cinza Platinum', 'LD7X'],
  ['puma', 'Vermelho Mont Carlo', ''],
  ['cruze', 'Prata Switchblade', 'WA636R'],
  ['s10', 'Prata Shark', 'GR2'],
]) {
  test(`${label} enforces its reference, all catalogs, final review, time and cost`, () => {
    const color = { name, codes: code ? [code] : [], paintFinish: ['perolizado'], verification: { reviewed: true } };
    const hyper = { name: 'Hyper Metallic', codes: ['WJX'], paintFinish: ['metálico'], verification: { reviewed: true } };
    const result = completedResult(label === 'ix35' ? [color, hyper] : [color]);
    const events = [{ event: 'catalog_candidate_checked', name, catalogs: ['lazzumix', 'basf', 'basf_models'] }];
    const check = value => acceptance(label, value, events, [{ name }]);

    assert.equal(check(result).passed, true);
    if (label === 'ix35') assert.equal(check({ ...result, colors: [color] }).checks.hyperWjxFound, false);
    if (label === 'corolla') {
      assert.equal(check({ ...result, colors: [{ ...color, name: 'Branco Lunar', codes: ['089'] }] })
        .checks.referenceFound, false);
    }
    assert.equal(check({ ...result, completion: undefined }).checks.processingComplete, false);
    for (const issue of ['names_unresolved', 'discovery_incomplete']) {
      assert.equal(check({ ...result, completion: { status: 'partial', issues: [issue] } }).passed, false);
    }
    assert.equal(check({ ...result, colors: [] }).passed, false);
    assert.equal(check({ ...result, timeMs: 50000 }).checks.deadline, true);
    assert.equal(check({ ...result, timeMs: 50500 }).targetMet, true);
    assert.equal(check({ ...result, timeMs: 60501 }).targetMet, false);
    assert.equal(check({ ...result, timeMs: 80000 }).checks.deadline, true);
    assert.equal(check({ ...result, timeMs: 100500 }).checks.deadline, true);
    assert.equal(check({ ...result, timeMs: 100501 }).checks.deadline, false);
    assert.equal(check({ ...result, usage: { estimatedCostUsd: 0.061 } }).checks.cost, false);
    assert.equal(check({ ...result, totalEstimatedCostUsd: 0.081 }).checks.cost, false);
    assert.equal(check({ ...result, totalEstimatedCostUsd: null }).checks.cost, false);
    assert.equal(check({ ...result, usage: { estimatedCostUsd: 0.04, costComplete: false } }).checks.cost, false);
    assert.equal(check({ ...result, research: undefined }).checks.everyCandidateReviewed, false);
    assert.equal(check({ ...result, research: undefined }).checks.omissionReviewComplete, false);
    assert.equal(check({ ...result, research: undefined }).checks.everyCodeMatchCompleted, false);
    assert.equal(check({ ...result, research: { ...result.research,
      matchingCoverage: { total: 2, completed: 1, incomplete: 1 } } }).checks.everyCodeMatchCompleted, false);
    assert.equal(check({ ...result, research: { ...result.research,
      omissionReview: { status: 'disabled' } } }).checks.omissionReviewComplete, false);
    assert.equal(check({ ...result, verification: undefined }).checks.everyFinalColorReviewed, false);
    assert.equal(check({ ...result, research: { unreviewedNames: ['Unchecked Paint'] } }).checks.everyCandidateReviewed, false);
    assert.equal(check({ ...result, research: { reviewCoverage: { total: 2, reviewed: 1, unreviewed: 1 } } })
      .checks.everyCandidateReviewed, false);
    assert.equal(check({ ...result, research: { reviewCoverage: { total: 2, reviewed: 1, unreviewed: 0 } } })
      .checks.everyCandidateReviewed, false);
    assert.equal(check({ ...result, research: { reviewCoverage: { total: 2, reviewed: 2, unreviewed: 0 } } })
      .checks.everyCandidateReviewed, true);
    assert.equal(acceptance(label, result, [...events, { event: 'warning',
      details: { code: 'SEARCH_CREDITS_EXHAUSTED' } }]).checks.searchCreditsAvailable, false);
    assert.equal(check({ ...result, colors: [{ ...color, verification: { reviewed: false } }] }).checks.everyFinalColorReviewed, false);
    assert.equal(acceptance(label, result, [{ ...events[0], catalogs: ['lazzumix', 'basf'] }]).checks.allCatalogsQueried, false);
    assert.equal(acceptance(label, result, events, [{ name: 'Unchecked Paint' }]).checks.allCatalogsQueried, false);

    if (['ix35', 'corolla', 'gol'].includes(label)) {
      assert.equal(check({ ...result, colors: [{ ...color, codes: ['WRONG'] }] }).checks.referenceFound, false);
    }
    if (cases[label].paintFinish === 'perolizado') {
      assert.equal(check({ ...result, colors: [{ ...color, paintFinish: ['sólido'] }] }).checks.noConfirmedSolidForPearl, false);
    }
  });
}

for (const [label, model, year, expected] of [
  ['cruze', 'Cruze', 2018, 'Prata Switchblade'],
  ['s10', 'S10', 2025, 'Prata Shark'],
]) {
  test(`${model} ${year} leaves color/finish undefined and requires ${expected} among other colors`, () => {
    assert.deepEqual(cases[label], { brand: 'Chevrolet', model, manufacturingYear: year });
    assert.equal(cases[label].predominantColor, undefined);
    assert.equal(cases[label].paintFinish, undefined);
    const color = name => ({ name, codes: [], verification: { reviewed: true } });
    const result = completedResult([color('Branco Summit'), color(expected), color('Preto Ouro Negro')]);
    const candidates = result.colors.map(({ name }) => ({ name }));
    const events = candidates.map(candidate => ({ event: 'catalog_candidate_checked',
      name: candidate.name, catalogs: ['lazzumix', 'basf', 'basf_models'] }));
    assert.equal(acceptance(label, result, events, candidates).passed, true);
    assert.equal(acceptance(label, { ...result, colors: result.colors.filter(c => c.name !== expected) }, events).checks.referenceFound, false);
    assert.equal(acceptance(label, { ...result, colors: [color(expected.replace('Prata ', 'Silver '))] }, events).checks.referenceFound, false);
  });
}

test('Brazilian Versa 2017 gray pearl retains the Titanium reference', () => {
  assert.deepEqual(cases.versa, { brand: 'Nissan', model: 'Versa', manufacturingYear: 2017,
    predominantColor: 'cinza', paintFinish: 'perolizado' });
  const colors = ['Cinza Titanium'].map(name => ({
    name, codes: [], paintFinish: ['metálico'], verification: { reviewed: true } }));
  const result = completedResult(colors);
  const candidates = colors.map(({ name }) => ({ name }));
  const events = candidates.map(({ name }) => ({ event: 'catalog_candidate_checked', name,
    catalogs: ['lazzumix', 'basf', 'basf_models'] }));
  assert.equal(acceptance('versa', result, events, candidates).passed, true);
  assert.equal(acceptance('versa', { ...result, colors: [] }, events, candidates).checks.referenceFound, false);
});
