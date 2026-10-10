const test = require('node:test');
const assert = require('node:assert/strict');
const { resultCompletion, billingStatus, withCompletion } = require('../result_completion');

const complete = () => ({ colors: [{ name: 'Example White', verification: { reviewed: true, status: 'partial' } }],
  research: { reviewCoverage: { total: 3, reviewed: 3, unreviewed: 0 },
    matchingCoverage: { total: 1, completed: 1, incomplete: 0 },
    omissionReview: { total: 2, checked: 2, incomplete: 0, repairFailures: 0 },
    discoveryCoverage: { needsExpansion: false } },
  verification: { colorsTotal: 1, colorsChecked: 1, colorsUnchecked: 0 }, usage: { costComplete: true } });

test('workflow completion does not assert that unknown paint facts are confirmed', () => {
  const result = complete();
  assert.deepEqual(resultCompletion(result), { status: 'complete', issues: [] });
  assert.equal(result.colors[0].verification.status, 'partial');
});

test('missing or contradictory coverage fails closed without discarding the palette', () => {
  for (const mutate of [r => delete r.research.reviewCoverage, r => r.research.reviewCoverage.unreviewed++,
    r => r.research.omissionReview.checked--, r => r.research.omissionReview.repairFailures++,
    r => delete r.verification, r => r.colors[0].verification.reviewed = false,
    r => delete r.research.matchingCoverage, r => r.research.matchingCoverage.incomplete++,
    r => r.research.discoveryCoverage.needsExpansion = true,
    r => r.research.unresolvedNames = [{ name: 'Hyper' }]]) {
    const result = complete();
    mutate(result);
    assert.equal(resultCompletion(result).status, 'partial');
    assert.equal(result.colors.length, 1);
  }
  assert.deepEqual(resultCompletion({ error: 'Cancelled' }), { status: 'failed', issues: ['run_failed'] });
});

test('incomplete billing stays visible without marking finished research partial', () => {
  const result = complete();
  result.usage = { costComplete: false, missingUsageCalls: 2, knownCostUsd: 0.019 };
  result.serperCost = { estimatedCostUsd: 0.011 };
  assert.deepEqual(resultCompletion(result), { status: 'complete', issues: [] });
  assert.deepEqual(billingStatus(result), { status: 'incomplete', missingUsageCalls: 2,
    admissionEstimateUsd: null, upperBoundUsd: null, knownCostUsd: 0.03 });
  assert.equal(withCompletion(result).billing.status, 'incomplete');
});

test('recovered warnings do not override current complete coverage', () => {
  const result = complete();
  result.research.warnings = [{ stage: 'review', count: 1 }];
  assert.equal(resultCompletion(result).status, 'complete');
  delete result.usage;
  result.cost = { complete: true };
  assert.equal(resultCompletion(result).status, 'complete');
});

test('maker-wide leads receive final review but do not satisfy model palette coverage', () => {
  const result = complete();
  result.paletteScope = { modelCandidates: 0, manufacturerLeads: 1 };
  result.colors[0].applicabilityScope = 'manufacturer_only';
  assert.deepEqual(resultCompletion(result), {
    status: 'partial', issues: ['no_model_linked_colors'],
  });
  result.colors[0].verification.reviewed = false;
  assert.deepEqual(resultCompletion(result).issues,
    ['no_model_linked_colors', 'final_reviews_incomplete']);
});

test('exceptional fallback remains visibly partial even when its final review completed', () => {
  const result = complete();
  result.fallback = { reason: 'no_valid_colors', sourceQuality: 'fetched' };
  result.research.matchingCoverage = { total: 0, completed: 0, incomplete: 0 };
  assert.deepEqual(resultCompletion(result), { status: 'partial', issues: ['fallback_used'] });
});
