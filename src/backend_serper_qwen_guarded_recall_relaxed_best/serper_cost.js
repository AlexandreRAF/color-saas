'use strict';

// Each request sends one query with num: 10, estimated at one Serper credit.
// Track HTTP attempts so retries and final verification are included too.
class SerperCost {
  constructor(costPer1000CreditsUsd = process.env.SERPER_COST_PER_1000_CREDITS_USD ?? 1) {
    this.rate = Number(costPer1000CreditsUsd);

    if (String(costPer1000CreditsUsd).trim() === '' || !Number.isFinite(this.rate) || this.rate < 0) {
      throw new Error('SERPER_COST_PER_1000_CREDITS_USD must be a non-negative number');
    }

    this.requests = 0;
    this.successfulResponses = 0;
    this.failedResponses = 0;
  }

  trackRequest(request) {
    return async (url, init) => {
      init.signal?.throwIfAborted();
      this.requests++;

      // A timeout/network error leaves billing unknown. Do not assume it was free.
      const response = await request(url, init);

      if (response.ok) this.successfulResponses++;
      else this.failedResponses++;

      return response;
    };
  }

  summary() {
    const unconfirmedRequests = this.requests - this.successfulResponses - this.failedResponses;
    const estimatedCredits = this.successfulResponses + unconfirmedRequests;

    return {
      requests: this.requests,
      successfulResponses: this.successfulResponses,
      failedResponses: this.failedResponses,
      unconfirmedRequests,
      estimatedCredits,
      costPer1000CreditsUsd: this.rate,
      estimatedCostUsd: Number((estimatedCredits * this.rate / 1000).toFixed(6)),
    };
  }
}

module.exports = { SerperCost };
