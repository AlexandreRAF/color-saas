const { AiCost, PRICES } = require('./ai_cost');
const qwen = require('./qwen_page');
const { reasoningPayload } = require('./request_envelope');

// A soft USD target with reservations for concurrent calls. Keep room for the
// final matcher; unknown failed-request usage is conservatively charged here.
class AiBudget {
  constructor(targetUsd = 0.06, prices = {}, { verificationFraction = 0, reviewFraction = 0,
    matchingFraction = 0, repairFraction = 0, omissionFraction = 0 } = {}) {
    if (!Number.isFinite(targetUsd) || targetUsd <= 0) throw new Error('targetAiCostUsd must be positive');

    if (!Number.isFinite(verificationFraction) || verificationFraction < 0 || verificationFraction > 0.2) {
      throw new Error('verificationFraction must be between 0 and 0.2');
    }

    if (!Number.isFinite(reviewFraction) || reviewFraction < 0 || reviewFraction > 0.5) {
      throw new Error('reviewFraction must be between 0 and 0.5');
    }

    this.targetUsd = targetUsd;
    for (const [name, value] of Object.entries({ matchingFraction, repairFraction, omissionFraction })) {
      if (!Number.isFinite(value) || value < 0 || value > 0.2) throw new Error(`${name} must be between 0 and 0.2`);
    }
    this.stageReserves = { matching: targetUsd * matchingFraction, repair: targetUsd * repairFraction, omission: targetUsd * omissionFraction };
    this.stageSpent = { matching: 0, repair: 0, omission: 0, verification: 0 };
    this.protectCompletion = matchingFraction > 0 || repairFraction > 0 || omissionFraction > 0;
    this.verificationFraction = verificationFraction;
    this.verificationReserve = targetUsd * verificationFraction;
    this.reviewFraction = reviewFraction;
    this.reviewSpent = 0;
    this.reviewsComplete = false;
    this.prices = { ...PRICES, ...prices };
    this.spent = 0;
    this.pageSpent = 0;
    this.pending = new Set();
    this.waiters = new Set();
  }

  async reserve(route, payload, kind, signal, { wait = true } = {}) {
    const page = kind === 'pageAnalysis' || kind === 'recovery';
    const review = ['candidateReview', 'targetedExtraction'].includes(kind);
    const omission = payload.text?.format?.name?.startsWith('final_verification_omissions_');
    const repairing = /research_review_(?:batch_)?(?:retry|repair|completion|omission)_/.test(payload.text?.format?.name || '');
    const phase = kind === 'databaseMatcher' ? 'matching'
      : omission ? 'omission' : (review && (this.reviewsComplete || repairing)) ? 'repair'
        : kind === 'verification' ? 'verification' : review ? 'review' : 'discovery';
    const rate = this.prices[`${route.provider}:${route.model}:${route.serviceTier}`];

    if (!rate) throw Object.assign(new Error('No price configured for AI budget admission'), { code: 'AI_BUDGET_LIMIT' });

    const routeRequest = route.chat ? qwen.pageRequest(payload) : reasoningPayload(route, payload);
    const inputTokens = Math.ceil(JSON.stringify(routeRequest).length / 3);
    const batchFields = Object.values(payload.text?.format?.schema?.properties || {});
    const compactVerdicts = batchFields.length > 0 && batchFields.every(field => field.type === 'string');
    const outputTokens = routeRequest.max_tokens || routeRequest.max_output_tokens || (kind === 'candidateReview' && payload.text?.format?.name?.startsWith('research_review_batch_')
      ? (compactVerdicts ? 32 : 180) * batchFields.length + 64
      : page ? 1000 : ['databaseMatcher', 'catalogResearch'].includes(kind) ? 300
      : ['verification', 'targetedExtraction', 'candidateReview'].includes(kind) ? 600 : 1400);
    const estimate = (inputTokens * rate.input + outputTokens * rate.output) / 1e6;
    const legacyLimit = kind === 'verification' ? this.targetUsd
      : kind === 'databaseMatcher' || (review && this.reviewFraction)
        ? this.targetUsd - this.verificationReserve : this.targetUsd * 0.8;
    const pageLimit = this.targetUsd * 0.4;

    while (true) {
      signal?.throwIfAborted();

      const pending = [...this.pending];
      const remaining = (stage, reserve) => Math.max(0, reserve - (this.stageSpent[stage] || 0)
        - pending.filter(row => row.phase === stage).reduce((sum, row) => sum + row.estimate, 0));
      const protectedCompletion = Object.entries({ ...this.stageReserves, verification: this.verificationReserve })
        .reduce((sum, [stage, reserve]) => sum + (stage === phase ? 0 : remaining(stage, reserve)), 0);
      const totalLimit = this.protectCompletion ? this.targetUsd - protectedCompletion : legacyLimit;
      const total = this.spent + pending.reduce((sum, row) => sum + row.estimate, 0);
      const pages = this.pageSpent + pending.filter(row => row.page).reduce((sum, row) => sum + row.estimate, 0);
      // Keep mandatory reviews funded while extraction and matching overlap.
      // Pending review reservations already appear in total; never count twice.
      const protectedReview = !review && !this.reviewsComplete
        ? Math.max(0, this.targetUsd * this.reviewFraction - this.reviewSpent
          - pending.filter(row => row.review).reduce((sum, row) => sum + row.estimate, 0)) : 0;

      if (total + estimate + protectedReview <= totalLimit && (!page || pages + estimate <= pageLimit)) break;

      if (!pending.length || this.spent + estimate > totalLimit || (page && this.pageSpent + estimate > pageLimit)) {
        throw Object.assign(new Error(`AI cost target reached; cannot admit ${kind} without using reserved mandatory-stage funds`),
          { code: 'AI_BUDGET_LIMIT', details: { kind, targetUsd: this.targetUsd,
            spentUsd: this.spent, estimatedRequestUsd: estimate, stageLimitUsd: totalLimit,
            protectedReviewUsd: protectedReview,
            ...(page && { pageSpentUsd: this.pageSpent, pageLimitUsd: pageLimit }) } });
      }

      // An immediate capacity choice must not hold a model slot while another
      // unfinished request owns the money needed for this route.
      if (!wait) return null;

      await new Promise((resolve, reject) => {
        const cleanup = () => { this.waiters.delete(wake); signal?.removeEventListener('abort', abort); };
        const wake = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(signal.reason); };

        this.waiters.add(wake);
        signal?.addEventListener('abort', abort, { once: true });
      });
    }

    const reservation = { estimate, page, review, phase };

    this.pending.add(reservation);

    let done = false;

    return { cancel: () => {
      if (done) return;
      done = true;
      this.pending.delete(reservation);
      for (const wake of [...this.waiters]) wake();
    }, complete: details => {
      if (done) return;

      done = true;

      const meter = new AiCost(this.prices);

      if (details?.usage) meter.record(kind, details);

      // A documented in-flight 402 rejects before generation. Keep an input
      // allowance rather than refunding a sent request or reserving output
      // tokens that could not have been generated.
      const charged = details?.preflightRejected && !details.usage
        ? Math.min(estimate, inputTokens * rate.input / 1e6)
        : meter.summary().estimatedCostUsd ?? estimate;

      this.spent += charged;

      if (page) this.pageSpent += charged;
      if (review) this.reviewSpent += charged;
      if (Object.hasOwn(this.stageSpent, phase)) this.stageSpent[phase] += charged;

      this.pending.delete(reservation);

      for (const wake of [...this.waiters]) wake();
    } };
  }

  finishReviews() {
    this.reviewsComplete = true;
    for (const wake of [...this.waiters]) wake();
  }

  planInventory(candidateCount) {
    if (!Number.isInteger(candidateCount) || candidateCount < 0) {
      throw new Error('Candidate workload must be a nonnegative integer');
    }

    // The omission audit has one independent decision per excluded candidate.
    // Reserve more for a large stable inventory before review calls compete for
    // the same dollars. This remains inside the request's unchanged AI ceiling.
    const auditReserve = Math.min(this.targetUsd * 0.2, 0.001 + candidateCount * 0.000025);
    this.stageReserves.omission = Math.max(this.stageReserves.omission, auditReserve);
    for (const wake of [...this.waiters]) wake();

    const pendingUsd = [...this.pending].reduce((sum, row) => sum + row.estimate, 0);
    return { candidates: candidateCount, spentUsd: this.spent,
      pendingUsd,
      omissionReserveUsd: this.stageReserves.omission,
      availableUsd: Math.max(0, this.targetUsd - this.spent - pendingUsd) };
  }

  canRetryReview(error) {
    const estimate = error.details?.estimatedRequestUsd;
    if (!Number.isFinite(estimate)) return false;
    const protectedFunds = this.verificationReserve
      + Math.max(0, this.stageReserves.matching - this.stageSpent.matching)
      + Math.max(0, this.stageReserves.omission - this.stageSpent.omission);
    const available = this.targetUsd - protectedFunds - this.spent
      - [...this.pending].reduce((sum, row) => sum + row.estimate, 0);
    return this.reviewsComplete && available >= estimate;
  }

  finishOmissionAudit() {
    this.stageReserves.omission = 0;
    for (const wake of [...this.waiters]) wake();
  }

  finishCompletionRepairs() {
    this.stageReserves.matching = 0;
    this.stageReserves.repair = 0;
    for (const wake of [...this.waiters]) wake();
  }

  // Reforecast only after a settled review wave. Count every unresolved lead as
  // a possible output color; exclusions alone may release verification funds.
  // This is a conservative workload allowance, not a promised provider charge.
  setVerificationWorkload(colors) {
    if (!Number.isInteger(colors) || colors < 0) throw new Error('Verification workload must be a nonnegative integer');
    const allowance = Math.max(this.targetUsd * 0.05, 0.001 + colors * 0.00015);
    this.verificationReserve = Math.min(this.targetUsd * this.verificationFraction, allowance);
    for (const wake of [...this.waiters]) wake();
  }
}

module.exports = { AiBudget };
