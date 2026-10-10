'use strict';

const { createLimiter } = require('./runtime');
const { reviewedColors } = require('./candidate_inventory');
const { HueReviewQueue, retainUnsupportedHueExclusions } = require('./hue_review');
const { groupCatalogReviews, combinedCandidate, expandGroupDecision } = require('./review_groups');
const { repairDecision } = require('./completion_review');

// One main decision per candidate; invalid or conflicting decisions alone
// enter bounded repair paths. Matching begins only after this stage settles.
async function reviewInventory(run, vehicle, candidates) {
  const timing = run.timing;
  // Finalize individual reviews and resolve explicit hue conflicts.
  run.reviewPipeline.sealed = true;

  const reviewSignal = run.reviewSignal;
  // Transport batches and the shared scheduler bound paid requests. An extra
  // 96-candidate gate starves later batches behind slow earlier decisions and
  // forces tiny requests as individual slots reopen. Queue the stable inventory
  // together unless the caller explicitly requests a candidate admission limit.
  const admission = run.options.reviewConcurrency
    || (run.options.batchReviews !== false ? Math.max(1, candidates.length) : 96);
  const reviewLimit = createLimiter(admission);
  const batches = await groupCatalogReviews(candidates, run.catalogs, vehicle);
  const repairState = { repairsAttempted: new Set(), repairSummary: { attempted: 0, recovered: 0 } };
  // Early omission repairs consult the same per-candidate ledger.
  run.reviewState = repairState;
  const hueReviewer = new HueReviewQueue(run, vehicle);
  run.log('catalog_review_groups', { candidates: candidates.length, groups: batches.length });

  // Admission order favors requested/uncertain hues. Freed slots can review
  // other candidates while a slow peer finishes, avoiding a stage barrier.
  const reviews = await Promise.allSettled(batches.map((batch, index) => reviewLimit(async () => {
    let decisions;
    try {
      const reviewed = await run.reviewPipeline.finish(combinedCandidate(batch),
        batches.length === 1 ? 'research_review' : `research_review_${index + 1}`);
      decisions = expandGroupDecision(batch, reviewed);
    } catch (error) {
      // Budget rejection must wait for released funds. All other unfinished
      // decisions enter the same bounded repair queue immediately.
      if (error.code === 'AI_BUDGET_LIMIT' || !run.reviewCandidate) throw error;
      decisions = await repairDecision(run, vehicle, batch, repairState, { deferHue: true, failure: error });
    }
    retainUnsupportedHueExclusions(batch, decisions, vehicle,
      (candidate, original) => run.log('hue_exclusion_reclassified', {
        name: candidate.name, originalReason: original.reason }));
    const checked = await hueReviewer.check(batch, decisions);
    run.settledWork?.add(batch, checked);
    return checked;
  })));

  timing.signal.throwIfAborted();

  // Failed decisions go to one shared completion queue. Do not stack a
  // stage retry on top of batch repair and completion repair.
  const possibleColors = reviews.reduce((count, review) => count + (review.status === 'rejected'
    ? 1 : Object.values(review.value).filter(decision => !decision.exclude_reason && decision.action !== 'exclude').length), 0);
  run.routing.budget?.setVerificationWorkload?.(possibleColors);
  timing.signal.throwIfAborted();

  const decisions = {};
  const unreviewedCandidates = [];
  const failures = new Map();

  for (const [index, review] of reviews.entries()) {
    if (review.status === 'fulfilled') Object.assign(decisions, review.value);
    else {
      run.warn(review.reason.reviewStage === 'hue' ? 'hue_review' : 'review', review.reason);
      for (const candidate of batches[index]) failures.set(candidate.id, review.reason);
      unreviewedCandidates.push(...batches[index].map(({ id, name }) => ({ id, name })));
    }
  }

  timing.signal.throwIfAborted();

  const reviewedCandidates = candidates.filter((candidate) => Object.hasOwn(decisions, candidate.id));
  repairState.repairSummary.recovered = reviewedCandidates
    .filter(candidate => repairState.completionAttempted?.has(candidate.id)).length;
  const unresolvedNames = [];
  const colors = reviewedColors(reviewedCandidates, decisions, {
    onWarning: (message) => run.warn('review', message),
    onUnresolved: (candidate) => unresolvedNames.push(candidate),
  });

  if (unresolvedNames.length) run.warn('name_resolution', `${unresolvedNames.length} paint names still need clarification`);

  run.dump('candidate-decisions', { candidates, decisions, colors });

  return { colors, reviewedCandidates, unreviewedCandidates, unresolvedNames, decisions,
    failures, groups: batches, hueReviewer, ...repairState };
}

module.exports = { reviewInventory };
