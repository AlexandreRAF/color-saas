'use strict';

// A successful HTTP/model call does not mean the workflow finished. Derive this
// contract from coverage, not warning counts, so recovered failures can clear it.
// Completed processing never means that every paint fact has been confirmed.
function resultCompletion(result) {
  if (result.error) return { status: 'failed', issues: ['run_failed'] };
  const issues = [];
  const research = result.research || {};
  const coverage = research.reviewCoverage;
  const omissions = research.omissionReview;
  const matching = research.matchingCoverage;
  const verification = result.verification;
  const colors = result.colors || [];

  if (!colors.length) issues.push('no_colors');
  if (result.fallback) issues.push('fallback_used');
  if (result.paletteScope && result.paletteScope.modelCandidates === 0 && colors.length) {
    issues.push('no_model_linked_colors');
  }
  if (!coverage || !Number.isInteger(coverage.total) || coverage.total <= 0
    || coverage.reviewed !== coverage.total || coverage.unreviewed !== 0
    || research.unreviewedNames?.length || research.unreviewedCandidates?.length) {
    issues.push('candidate_reviews_incomplete');
  }
  if (!omissions || omissions.status === 'disabled' || !Number.isInteger(omissions.total)
    || omissions.checked !== omissions.total || omissions.incomplete !== 0 || omissions.repairFailures) {
    issues.push('omission_audit_incomplete');
  }
  if (verification && (verification.colorsChecked !== colors.length || verification.colorsUnchecked !== 0
    || verification.colorsTotal !== colors.length || colors.some(color => color.verification?.reviewed !== true))) {
    issues.push('final_reviews_incomplete');
  }
  if (!matching || !Number.isInteger(matching.total) || matching.total < 0
    || (!result.fallback && matching.total === 0)
    || matching.completed !== matching.total || matching.incomplete !== 0 || matching.incompleteNames?.length) {
    issues.push('code_matching_incomplete');
  }
  if (!research.discoveryCoverage || research.discoveryCoverage.needsExpansion) issues.push('discovery_incomplete');
  if (research.unresolvedNames?.length) issues.push('names_unresolved');
  return { status: issues.length ? 'partial' : 'complete', issues };
}

function billingStatus(result) {
  const usage = result.usage || result.cost || {};
  const knownAi = usage.knownCostUsd;
  const knownSearch = result.serperCost?.estimatedCostUsd || 0;
  const complete = (result.usage ? usage.costComplete : usage.complete) === true
    && !(result.serperCost?.unconfirmedRequests > 0);

  return { status: complete ? 'complete' : 'incomplete',
    missingUsageCalls: usage.missingUsageCalls || 0,
    admissionEstimateUsd: usage.admissionEstimateUsd ?? null,
    upperBoundUsd: result.totalUpperBoundUsd ?? null,
    knownCostUsd: Number.isFinite(knownAi) && Number.isFinite(knownSearch)
      ? Number((knownAi + knownSearch).toFixed(6)) : null };
}

function withCompletion(result) {
  const { fetchedPages, ...rest } = result;
  return { ...rest, completion: resultCompletion(result),
    billing: billingStatus(result), ...(fetchedPages && { fetchedPages }) };
}

module.exports = { resultCompletion, billingStatus, withCompletion };
