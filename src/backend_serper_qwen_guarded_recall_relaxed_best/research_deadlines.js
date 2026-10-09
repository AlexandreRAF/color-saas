const DEFAULT_TARGET_TIME_MS = 60000;
const DEFAULT_MAX_TIME_MS = 100000;
const DISCOVERY_TARGET_MS = 32000;

function pipelineDeadlines(timing, targetMs = DEFAULT_TARGET_TIME_MS, maxMs = targetMs * 2) {
  // Search and extraction keep the fast path. Difficult review, matching and
  // verification work may continue after the target within the hard ceiling.
  const cutoffs = {
    // A softer target must not make the early search/fetch wave slower. Keep
    // the existing fast-path cutoffs while allowing harder paints more time
    // in review, matching and final verification up to the hard maximum.
    search: Math.round(Math.min(targetMs * 0.22, 11000)),
    fetch: Math.round(Math.min(targetMs * 0.24, 12000)),
    extraction: Math.round(Math.min(targetMs * 0.34, 17000)),
    recovery: Math.round(Math.min(targetMs * 0.70, 35000)),
    nameClarification: Math.round(Math.min(targetMs * 0.70, maxMs * 0.50, 35000)),
    review: Math.round(maxMs * 0.60), repair: Math.round(maxMs * 0.68),
    matching: Math.round(maxMs * 0.82), verificationSearch: Math.round(maxMs * 0.88),
    verification: Math.round(maxMs * 0.98),
  };
  return { cutoffs, signals: Object.fromEntries(Object.entries(cutoffs)
    .map(([stage, at]) => [stage, timing.deadlineAt(at)])), close() {} };
}

// Stage targets reserve time for extraction, review and matching. In soft mode
// they guide optional work; mandatory work keeps its caller-cancellation signal.
function researchDeadlines(targetTimeMs = 38000) {
  const scale = targetTimeMs / 38000;
  return Object.fromEntries(Object.entries({ search: 15000, fetch: 19000,
    extraction: 23000, recovery: 25000 }).map(([stage, milliseconds]) =>
    [stage, Math.max(1, Math.round(milliseconds * scale))]));
}

// Extend only while discovery is starved, preserving the review/matching and
// verification reserves. Existing consumers keep the same AbortSignals.
function researchBudget(timing, targetTimeMs, needsRecovery, log = () => {}) {
  const cutoffs = researchDeadlines(targetTimeMs);
  const started = timing.deadlineElapsedMs();
  const signals = Object.fromEntries(Object.entries(cutoffs).map(([stage, ms]) => [stage, timing.deadline(ms)]));

  if (timing.softDeadlines) return { cutoffs, signals, close: () => {} };

  const extra = Math.min(4000, targetTimeMs / 9);
  const timer = setTimeout(() => {
    if (timing.signal.aborted || !needsRecovery()) return;
    for (const [stage, at] of Object.entries(cutoffs)) timing.extendDeadline(signals[stage], started + at + extra);
    log('research_budget_extended', { extraMs: Math.round(extra),
      deadlines: Object.fromEntries(Object.entries(cutoffs).map(([stage, at]) => [stage, Math.round(at + extra)])) });
  }, Math.max(1, cutoffs.search - Math.min(1000, targetTimeMs / 36)));

  return { cutoffs, signals, close: () => clearTimeout(timer) };
}

module.exports = { DEFAULT_TARGET_TIME_MS, DEFAULT_MAX_TIME_MS,
  DISCOVERY_TARGET_MS, researchDeadlines, researchBudget, pipelineDeadlines };
