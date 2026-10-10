// USD per million tokens, verified 2026-10-01. Prefer reported OpenRouter inference cost.
// https://openrouter.ai/openai/gpt-6-luna
// https://developers.openai.com/api/docs/pricing
// https://ai.google.dev/gemini-api/docs/pricing
const PRICES = {
  'openrouter:qwen/qwen3.5-flash-02-23:default': { input: 0.065, cached: 0.065, output: 0.26 },
  'openrouter:openai/gpt-6-luna:default': { input: 0.10, cached: 0.01, cacheWrite: 0.125, output: 0.50 },
  'openrouter:openai/gpt-5.6-luna:default': { input: 0.20, cached: 0.02, cacheWrite: 0.25, output: 1.20 },
  'openai:gpt-6-luna:default': { input: 0.10, cached: 0.01, cacheWrite: 0.125, output: 0.50 },
  'openai:gpt-6-luna:fast': { input: 0.20, cached: 0.02, cacheWrite: 0.25, output: 1.00 },
  'openai:gpt-5.6-luna:default': { input: 0.20, cached: 0.02, cacheWrite: 0.25, output: 1.20 },
  'gemini:gemini-3.5-flash-lite:default': { input: 0.30, cached: 0.03, output: 2.50 },
};

class AiCost {
  constructor(prices = {}) {
    this.prices = { ...PRICES, ...prices };
    this.entries = new Map();
  }

  record(stage, { provider, model, serviceTier = 'default', usage, requestBytes, maxOutputTokens } = {}) {
    const tier = provider === 'gemini' ? 'default' : serviceTier === 'priority' ? 'fast' : serviceTier;
    const key = `${provider}:${model}:${tier}`;
    const entry = this.entries.get(`${stage}:${key}`) || { stage, provider, model, serviceTier: tier,
      estimatedCostUsd: 0, upperBoundUsd: 0, knownCostUsd: 0, calls: 0, inputTokens: 0,
      cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, missingUsage: 0 };

    entry.calls++;

    if (!usage) entry.missingUsage++;

    entry.inputTokens += usage?.input_tokens || 0;
    entry.cachedInputTokens += usage?.cached_input_tokens || usage?.input_tokens_details?.cached_tokens || 0;

    const writes = usage?.input_tokens_details?.cache_write_tokens || 0;

    entry.cacheWriteInputTokens += writes;
    entry.outputTokens += usage?.output_tokens || 0;

    const rate = this.prices[key];
    const reported = provider === 'openrouter' && Number.isFinite(usage?.reported_cost_usd)
      && usage.reported_cost_usd >= 0 ? usage.reported_cost_usd : null;
    const cached = usage?.cached_input_tokens || usage?.input_tokens_details?.cached_tokens || 0;
    const callCost = reported ?? (rate && usage ? (
      Math.max(0, (usage.input_tokens || 0) - cached - writes) * rate.input + cached * rate.cached
      + writes * (rate.cacheWrite ?? rate.input)
      + (usage.output_tokens || 0) * rate.output) / 1e6 : null);

    entry.knownCostUsd += callCost || 0;
    entry.estimatedCostUsd = entry.estimatedCostUsd === null || callCost === null ? null
      : entry.estimatedCostUsd + callCost;
    // A timeout can hide provider usage. UTF-8 request bytes exceed its token
    // count, and the request's explicit output cap bounds generation. Keep
    // exact cost unknown while exposing a conservative per-attempt ceiling.
    const ceiling = callCost ?? (rate && Number.isFinite(requestBytes)
      && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
      ? ((requestBytes + 1024) * rate.input + maxOutputTokens * rate.output) / 1e6 : null);
    entry.upperBoundUsd = entry.upperBoundUsd === null || ceiling === null ? null
      : entry.upperBoundUsd + ceiling;

    if (reported !== null) {
      entry.providerReportedCostUsd = (entry.providerReportedCostUsd || 0) + reported;
      entry.providerReportedCalls = (entry.providerReportedCalls || 0) + 1;
    }

    entry.uncachedCostUsd = rate && !entry.missingUsage
      ? (entry.inputTokens * rate.input + entry.outputTokens * rate.output) / 1e6 : null;
    this.entries.set(`${stage}:${key}`, entry);
  }

  summary(targetUsd = 0.10) {
    const entries = [...this.entries.values()];
    const priced = entries.length > 0 && entries.every((entry) => entry.estimatedCostUsd !== null);
    const total = entries.reduce((sum, entry) => sum + (entry.estimatedCostUsd || 0), 0);
    const bounded = entries.length > 0 && entries.every(entry => Number.isFinite(entry.upperBoundUsd));

    return { knownCostUsd: Number(entries.reduce((sum, entry) => sum + entry.knownCostUsd, 0).toFixed(6)),
      missingUsageCalls: entries.reduce((sum, entry) => sum + entry.missingUsage, 0),
      complete: priced,
      estimatedCostUsd: priced ? Number(total.toFixed(6)) : null,
      upperBoundUsd: bounded ? Number(entries.reduce((sum, entry) => sum + entry.upperBoundUsd, 0).toFixed(6)) : null,
      uncachedCostUsd: entries.length && entries.every(entry => entry.uncachedCostUsd !== null)
        ? Number(entries.reduce((sum, entry) => sum + entry.uncachedCostUsd, 0).toFixed(6)) : null,
      targetUsd, overTarget: priced ? total > targetUsd : null,
      basis: 'Reported OpenRouter inference cost when available; otherwise token-price estimates. Excludes credit-purchase fees, SERP, hosting and unreported failed-request usage.',
      pricesCheckedAt: '2026-10-01', entries };
  }
}

module.exports = { AiCost, PRICES };
