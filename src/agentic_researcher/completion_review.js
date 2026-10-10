'use strict';

const { createLimiter } = require('./runtime');
const { reviewedColors } = require('./candidate_inventory');
const { hueConflicts } = require('./hue_review');
const { printedNameKey } = require('./paint_evidence');
const { combinedCandidate, expandGroupDecision } = require('./review_groups');

// One ledger owns early and final repair admission. A malformed child can use
// completion headroom while independent first-pass batches are still running.
async function repairDecision(run, vehicle, group, state, { deferHue = false, failure } = {}) {
  const signal = run.repairSignal || run.reviewSignal;
  signal.throwIfAborted();
  state.repairsAttempted ||= new Set();
  state.completionAttempted ||= new Set();
  state.repairSummary ||= { attempted: 0, recovered: 0 };
  if (group.some(candidate => state.repairsAttempted.has(candidate.id))) {
    throw new Error('Candidate repair already attempted');
  }
  for (const candidate of group) {
    state.repairsAttempted.add(candidate.id);
    state.completionAttempted.add(candidate.id);
  }
  state.repairSummary.attempted += group.length;
  // A completed main decision is not repeated just because its hue check failed.
  if (failure?.reviewStage === 'hue' && state.hueReviewer) {
    const decisions = await state.hueReviewer.check(group, { ...failure.decisions });
    state.repairSummary.recovered += group.length;
    return decisions;
  }
  const candidate = combinedCandidate(group);
  // A stalled provider is skipped. A malformed child from an otherwise healthy
  // batch gets the one focused correction on the normal route; skipping it
  // needlessly sends small, cheap corrections to slower provider pools.
  const stalled = failure?.code === 'MODEL_ROUTE_TIMEOUT' || failure?.deadlineExceeded;
  const recovery = { ...(stalled && failure?.routeId && { startAfter: failure.routeId }),
    ...(failure && { issue: failure.message }) };
  const decisions = expandGroupDecision(group, await run.reviewCandidate(candidate, vehicle, signal,
    `research_review_completion_${candidate.id}`, recovery));
  if (!deferHue && hueConflicts(group, decisions, vehicle.predominantColor).length) {
    if (state.hueReviewer) await state.hueReviewer.check(group, decisions);
    else throw new Error('Candidate repair still has an unresolved hue conflict');
  }
  state.repairSummary.recovered += group.length;
  return decisions;
}

// One final attempt for decisions missing after normal review. This uses the
// protected repair allowance, not another discovery/review loop.
async function repairUnreviewed(run, vehicle, candidates, state) {
  const missing = candidates.filter(candidate => !Object.hasOwn(state.decisions, candidate.id));
  if (!missing.length) {
    const summary = state.repairSummary || { attempted: 0, recovered: 0 };
    run.log('completion_review', { ...summary, remaining: 0 });
    return summary;
  }
  const signal = run.repairSignal || run.reviewSignal;
  const ids = new Set(missing.map(candidate => candidate.id));
  const groups = (state.groups || candidates.map(candidate => [candidate]))
    .map(group => group.filter(candidate => ids.has(candidate.id))).filter(group => group.length);
  // Queue together so the transport can build full batches; the API scheduler
  // still limits simultaneous requests. Each original ID gets one repair only.
  const limit = createLimiter(Math.max(1, groups.length));
  state.repairsAttempted ||= new Set();
  let exhausted = false;
  await Promise.all(groups.map(group => limit(async () => {
    if (exhausted || signal.aborted || group.some(candidate => state.repairsAttempted.has(candidate.id))) return;
    const failure = state.failures?.get(group[0].id);
    if (failure?.code === 'AI_BUDGET_LIMIT' && run.routing?.budget?.canRetryReview
      && !run.routing.budget.canRetryReview(failure)) return;
    try {
      const decisions = await repairDecision(run, vehicle, group, state, { failure });
      Object.assign(state.decisions, decisions);
    } catch (error) {
      if (error.code === 'AI_BUDGET_LIMIT') exhausted = true;
      for (const candidate of group) state.failures?.set(candidate.id, error);
      run.warn('completion_review', error);
    }
  })));
  state.reviewedCandidates.splice(0, state.reviewedCandidates.length,
    ...candidates.filter(candidate => Object.hasOwn(state.decisions, candidate.id)));
  state.unreviewedCandidates.splice(0, state.unreviewedCandidates.length,
    ...candidates.filter(candidate => !Object.hasOwn(state.decisions, candidate.id)).map(({ id, name }) => ({ id, name })));
  state.unresolvedNames.length = 0;
  const colors = reviewedColors(state.reviewedCandidates, state.decisions, {
    onWarning: message => run.warn('review', message),
    onUnresolved: candidate => state.unresolvedNames.push(candidate),
  });
  state.colors.splice(0, state.colors.length, ...colors);
  const summary = state.repairSummary || { attempted: 0, recovered: 0 };
  summary.recovered = state.reviewedCandidates.filter(candidate => state.completionAttempted?.has(candidate.id)).length;
  run.log('completion_review', { ...summary, remaining: state.unreviewedCandidates.length });
  return summary;
}

function paletteCoverage(approved, matched, exclusions = [], discovery = {}, unreviewed = []) {
  const present = new Set(matched.map(color => printedNameKey(color.name)));
  const excluded = new Set(exclusions.filter(row => row.reason === 'incompatible_finish')
    .map(row => printedNameKey(row.name)));
  const missing = approved.filter(color => !present.has(printedNameKey(color.name))
    && !excluded.has(printedNameKey(color.name)));
  // Losing a supported color during a failed stage must not become an implicit
  // exclusion. Retain it with unknown codes and send it through final verification.
  const colors = [...matched, ...missing.map(color => ({ ...color, universal_code: '', code_candidates: [] }))];
  return { colors, summary: {
    restoredAfterMatching: missing.map(color => color.name),
    unresolvedCodes: colors.filter(color => !color.universal_code && !color.code_candidates?.length).map(color => color.name),
    unreviewedCandidates: unreviewed.length,
    discoveryIncomplete: !!discovery.needsExpansion,
  } };
}

module.exports = { repairUnreviewed, repairDecision, paletteCoverage };
