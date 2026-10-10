const { capacityContext } = require('./capacity_context');

// One scheduler per Node process, shared by every agent and every run.
// Limits are conservative local ceilings; provider headers can lower them.
const DEFAULT_LIMITS = {
  'network:run': { tokensPerMinute: 1000000, requestsPerMinute: 1000000,
    reserveTokens: 0, concurrency: Number(process.env.RESEARCH_RUN_CONCURRENCY || 1) },
  'network:search': { tokensPerMinute: 1000000, requestsPerMinute: Number(process.env.SEARCH_RPM || 600),
    reserveTokens: 0, concurrency: Number(process.env.SEARCH_CONCURRENCY || 8) },
  'network:fetch': { tokensPerMinute: 1000000, requestsPerMinute: 1000000,
    reserveTokens: 0, concurrency: Number(process.env.PAGE_FETCH_CONCURRENCY || 40),
    scopeConcurrency: Number(process.env.PAGE_DOMAIN_CONCURRENCY || 2) },
  'network:reader': { tokensPerMinute: 1000000, requestsPerMinute: Number(process.env.PAGE_READER_RPM || 30),
    reserveTokens: 0, concurrency: Number(process.env.PAGE_READER_CONCURRENCY || 3) },
  'gemini:gemini-3.5-flash-lite': { tokensPerMinute: Number(process.env.GEMINI_PAGE_TPM || 200000),
    requestsPerMinute: Number(process.env.GEMINI_PAGE_RPM || 100), reserveTokens: 0,
    concurrency: Number(process.env.GEMINI_PAGE_CONCURRENCY || 10) },
  'openrouter:qwen/qwen3.5-flash-02-23': { tokensPerMinute: Number(process.env.QWEN_PAGE_TPM || 1000000),
    requestsPerMinute: Number(process.env.QWEN_PAGE_RPM || 300),
    reserveTokens: Number(process.env.QWEN_RESERVED_TOKENS || Math.min(100000, Number(process.env.QWEN_PAGE_TPM || 1000000) * 0.1)), reserveConcurrency: 2,
    concurrency: Number(process.env.QWEN_PAGE_CONCURRENCY || 8) },
  'gpt-6-luna': { tokensPerMinute: Number(process.env.OPENAI_LUNA6_TPM || 200000),
    requestsPerMinute: Number(process.env.OPENAI_LUNA6_RPM || 500),
    reserveTokens: Number(process.env.OPENAI_LUNA6_RESERVED_TOKENS || 60000), concurrency: 20 },
  'gpt-5.6-luna': { tokensPerMinute: Number(process.env.OPENAI_LUNA56_TPM || 500000),
    requestsPerMinute: Number(process.env.OPENAI_LUNA56_RPM || 500), reserveTokens: 0, concurrency: 20 },
  'openrouter:openai/gpt-6-luna': { tokensPerMinute: Number(process.env.OPENROUTER_LUNA6_TPM || 200000),
    requestsPerMinute: Number(process.env.OPENROUTER_LUNA6_RPM || 20), reserveTokens: 60000, concurrency: 20 },
  'openrouter:openai/gpt-5.6-luna': { tokensPerMinute: Number(process.env.OPENROUTER_LUNA56_TPM || 500000),
    requestsPerMinute: Number(process.env.OPENROUTER_LUNA56_RPM || 20), reserveTokens: 0, concurrency: 20 },
};

const PRIORITY = { reviewRepair: 3, databaseMatcher: 3, candidatePriority: 2.5,
  omissionAudit: 2.25,
  main: 2, candidateReview: 2, verification: 2, targetedExtraction: 2,
  fetch: 1, prefetch: 0, catalogResearch: 1, recovery: 1.5, pageAnalysis: 1.5 };
const ORDINARY_KINDS = new Set(['pageAnalysis', 'recovery', 'catalogResearch', 'candidateReview', 'candidatePriority']);

function durationMs(value) {
  if (!value) return 0;
  const parts = [...String(value).matchAll(/([\d.]+)(ms|s|m|h)/g)];
  return parts.reduce((sum, [, number, unit]) => sum + Number(number)
    * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[unit]), 0);
}

function retryAfterMs(headers, body, now = Date.now()) {
  const get = (name) => headers?.get?.(name);
  const ms = Number(get('retry-after-ms'));

  if (ms > 0) return ms;

  const value = get('retry-after');

  if (value) {
    const delay = Number(value) * 1000;

    if (Number.isFinite(delay)) return Math.max(0, delay);

    const date = Date.parse(value);

    if (Number.isFinite(date)) return Math.max(0, date - now);
  }

  const googleRetry = body?.error?.details?.find(detail => detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');

  return durationMs(googleRetry?.retryDelay)
    || durationMs(body?.error?.message?.match(/try again in ([\d.]+(?:ms|s|m|h))/i)?.[1]);
}

function estimateTokens(body) {
  return Math.ceil(JSON.stringify(body).length / 3) + (body.max_output_tokens || body.max_tokens || 2048);
}

class ModelScheduler {
  constructor({ limits = DEFAULT_LIMITS, windowMs = 60000, maxQueue = 2000,
    maxWaitMs = 120000, now = Date.now, modelConcurrency = Number(process.env.MODEL_CONCURRENCY || 16),
    completionSlots = Number(process.env.MODEL_COMPLETION_SLOTS || 4) } = {}) {
    if (!Number.isFinite(windowMs) || windowMs <= 0 || !Number.isInteger(maxQueue) || maxQueue < 1
      || !Number.isFinite(maxWaitMs) || maxWaitMs < 0) throw new Error('Invalid scheduler limits');

    if (!Number.isInteger(modelConcurrency) || modelConcurrency < 1 || !Number.isInteger(completionSlots)
      || completionSlots < 0 || completionSlots >= modelConcurrency) throw new Error('Invalid shared model concurrency');
    this.modelConcurrency = modelConcurrency;
    this.completionSlots = completionSlots;
    this.limits = limits;
    this.windowMs = windowMs;
    this.maxQueue = maxQueue;
    this.maxWaitMs = maxWaitMs;
    this.now = now;
    this.models = new Map();
    this.queue = [];
    this.sequence = 0;
    this.served = new Map();
    this.admissions = 0;
    this.ordinaryActive = 0;
    this.scopes = new Map();
  }

  state(model) {
    if (!this.models.has(model)) {
      const settings = { tokensPerMinute: 200000, requestsPerMinute: 500,
        reserveTokens: 0, concurrency: 20, ...this.limits[model] };

      for (const key of ['tokensPerMinute', 'requestsPerMinute', 'concurrency']) {
        if (!Number.isFinite(settings[key]) || settings[key] <= 0) throw new Error(`Invalid ${model} ${key}`);
      }

      if (!Number.isInteger(settings.concurrency)) throw new Error('Concurrency must be an integer');
      if (settings.scopeConcurrency !== undefined && (!Number.isInteger(settings.scopeConcurrency)
        || settings.scopeConcurrency < 1)) throw new Error('Domain concurrency must be a positive integer');
      if (!Number.isFinite(settings.reserveTokens) || settings.reserveTokens < 0
        || settings.reserveTokens >= settings.tokensPerMinute) throw new Error(`Invalid ${model} reserveTokens`);

      this.models.set(model, { ...settings, tokens: settings.tokensPerMinute,
        requests: settings.requestsPerMinute, active: 0, updated: this.now(),
        concurrencyLimit: settings.concurrency, blockedUntil: 0, successes: 0 });
    }

    const state = this.models.get(model);
    const elapsed = Math.max(0, this.now() - state.updated);

    state.tokens = Math.min(state.tokensPerMinute, state.tokens + elapsed * state.tokensPerMinute / this.windowMs);
    state.requests = Math.min(state.requestsPerMinute, state.requests + elapsed * state.requestsPerMinute / this.windowMs);
    state.updated = this.now();

    return state;
  }

  reserveFor(state, kind) {
    return ['pageAnalysis', 'recovery'].includes(kind) ? state.reserveTokens : 0;
  }

  acquire({ choices, tokens, immediate = false, kind = 'main', scope, signal, timing, onWait,
    runId = capacityContext.getStore()?.runId || 'default' } = {}) {
    const tokensFor = choice => choice.tokens ?? tokens;
    try {
      signal?.throwIfAborted();
      timing?.signal.throwIfAborted();

      if (!Array.isArray(choices) || !choices.length
        || choices.some(choice => !Number.isFinite(tokensFor(choice)) || tokensFor(choice) <= 0)) {
        throw new Error('Model scheduling requires model choices and a positive token estimate');
      }

      if (!choices.some(choice => {
        const state = this.state(choice.model);
        return tokensFor(choice) <= state.tokensPerMinute - this.reserveFor(state, kind);
      })) throw new Error('Model request exceeds the configured token capacity; split the input or raise the limit');

      if (this.queue.length >= this.maxQueue) throw new Error('Model scheduler queue is full');
    } catch (error) { return Promise.reject(error); }

    return new Promise((resolve, reject) => {
      const combinedSignal = signal && timing ? AbortSignal.any([signal, timing.signal]) : signal || timing?.signal;
      const job = { choices, tokens, immediate, kind, scope, runId, signal: combinedSignal, timing, onWait,
        resolve, reject, sequence: this.sequence++, queuedAt: this.now() };

      job.cancel = () => this.remove(job, combinedSignal.reason);
      combinedSignal?.addEventListener('abort', job.cancel, { once: true });
      job.expiry = setTimeout(() => this.remove(job, new Error(
        `Model capacity wait exceeded ${this.maxWaitMs} ms`)), this.maxWaitMs);
      this.queue.push(job);
      this.drain();
      if (immediate && this.queue.includes(job)) {
        this.queue.splice(this.queue.indexOf(job), 1);
        this.cleanup(job);
        resolve(null);
        this.drain();
      }
    });
  }

  cleanup(job) {
    clearTimeout(job.expiry);
    job.signal?.removeEventListener('abort', job.cancel);
    job.endWait?.();

    if (job.endWait) {
      try { job.onWait?.({ event: 'capacity_wait_end', kind: job.kind,
        waitMs: this.now() - job.queuedAt }); } catch { /* Diagnostics only. */ }
    }
  }

  remove(job, error) {
    const index = this.queue.indexOf(job);

    if (index === -1) return;

    this.queue.splice(index, 1);
    this.cleanup(job);
    job.reject(error);
    this.drain();
  }

  drain() {
    if (this.draining) { this.drainAgain = true; return; }

    this.draining = true;

    try {
      clearTimeout(this.timer);
      const priority = job => Math.min(3, (PRIORITY[job.kind] || 0) + Math.floor((this.now() - job.queuedAt) / 10000));
      this.queue.sort((a, b) => priority(b) - priority(a)
        || (this.served.get(a.runId) || 0) - (this.served.get(b.runId) || 0) || a.sequence - b.sequence);

      let nextWake = Infinity;

      for (const job of [...this.queue]) {
        if (!this.queue.includes(job)) continue;

        if (job.signal?.aborted) { this.remove(job, job.signal.reason); continue; }

        if (!job.choices.some(choice => {
          const state = this.state(choice.model);
          return (choice.tokens ?? job.tokens) + this.reserveFor(state, job.kind) <= state.tokensPerMinute;
        })) { this.remove(job, new Error('Model request exceeds provider token capacity')); continue; }

        let chosen;

        for (const choice of job.choices) {
          const state = this.state(choice.model);
          const required = (choice.tokens ?? job.tokens) + this.reserveFor(state, job.kind);
          const scopeKey = job.scope && state.scopeConcurrency ? `${choice.model}:${job.scope}` : null;

          if (!choice.model.startsWith('network:')) {
            const active = [...this.models].reduce((sum, [model, pool]) => sum + (model.startsWith('network:') ? 0 : pool.active), 0);
            // Reserve slots against ordinary work, not against all work. Once
            // repairs/matching occupy the reserve, counting it again would keep
            // real free slots idle and force needless provider fallbacks.
            if (active >= this.modelConcurrency
              || ORDINARY_KINDS.has(job.kind) && this.ordinaryActive >= this.modelConcurrency - this.completionSlots) continue;
          }
          if (required > state.tokensPerMinute) continue;
          if (scopeKey && (this.scopes.get(scopeKey) || 0) >= state.scopeConcurrency) continue;
          if (state.active >= Math.max(1, state.concurrencyLimit
            - (['pageAnalysis', 'recovery'].includes(job.kind) ? (state.reserveConcurrency || 0) : 0))) continue; // Completion wakes the queue.

          const delay = Math.max(state.blockedUntil - this.now(),
            (required - state.tokens) * this.windowMs / state.tokensPerMinute,
            (1 - state.requests) * this.windowMs / state.requestsPerMinute, 0);

          if (delay <= 0) { chosen = { choice, state }; break; }

          nextWake = Math.min(nextWake, delay);
        }

        if (!chosen) {
          if (!job.immediate && !job.endWait) {
            try {
              job.endWait = job.timing?.beginWait() || (() => {});
              try { job.onWait?.({ event: 'capacity_wait_start', kind: job.kind,
                models: job.choices.map(({ model }) => model) }); } catch { /* Diagnostics only. */ }
            } catch (error) { this.remove(job, error); }
          }

          continue;
        }

        this.queue.splice(this.queue.indexOf(job), 1);
        this.cleanup(job);

        const { choice, state } = chosen;
        const reservedTokens = choice.tokens ?? job.tokens;

        state.tokens -= reservedTokens;
        state.requests--;
        state.active++;
        const ordinary = !choice.model.startsWith('network:') && ORDINARY_KINDS.has(job.kind);
        if (ordinary) this.ordinaryActive++;
        const scopeKey = job.scope && state.scopeConcurrency ? `${choice.model}:${job.scope}` : null;
        if (scopeKey) this.scopes.set(scopeKey, (this.scopes.get(scopeKey) || 0) + 1);
        const releaseScope = () => {
          if (!scopeKey) return;
          const remaining = (this.scopes.get(scopeKey) || 1) - 1;
          if (remaining) this.scopes.set(scopeKey, remaining);
          else this.scopes.delete(scopeKey);
        };
        this.served.delete(job.runId);
        this.served.set(job.runId, ++this.admissions);
        if (this.served.size > this.maxQueue) this.served.delete(this.served.keys().next().value);

        let completed = false;

        job.resolve({ ...choice, cancel: () => {
          if (completed) return;
          completed = true;
          if (ordinary) this.ordinaryActive--;
          releaseScope();
          state.active--;
          state.tokens = Math.min(state.tokensPerMinute, state.tokens + reservedTokens);
          state.requests = Math.min(state.requestsPerMinute, state.requests + 1);
          this.drain();
        }, complete: (response, body) => {
          if (completed) return;
          completed = true;
          if (ordinary) this.ordinaryActive--;
          releaseScope();
          this.finish(choice.model, reservedTokens, response, body);
        } });
        // Re-sort after each admission so one ready vehicle cannot monopolize
        // all newly available slots. Aging also prevents extraction starvation.
        this.drainAgain = this.queue.length > 0;
        break;
      }

      if (this.queue.length && Number.isFinite(nextWake)) {
        this.timer = setTimeout(() => this.drain(), Math.max(1, Math.ceil(nextWake)));
      }
    } finally {
      this.draining = false;
      if (this.drainAgain) { this.drainAgain = false; this.drain(); }
    }
  }

  finish(model, reserved, response, body) {
    const state = this.state(model);

    state.active--;

    // A failed attempt without usage retains its reservation. Successful usage
    // releases unused output allowance; cached input still consumes capacity.
    if (body?.usage) {
      const actual = (body.usage.input_tokens || 0) + (body.usage.output_tokens || 0);
      state.tokens = Math.min(state.tokensPerMinute, state.tokens + reserved - actual);
    }

    const number = (name) => {
      const value = response?.headers?.get?.(name);
      return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
    };

    for (const [key, header] of [['tokensPerMinute', 'tokens'], ['requestsPerMinute', 'requests']]) {
      const limits = [number(`x-ratelimit-limit-${header}`),
        ...(header === 'tokens' ? [number('x-ratelimit-limit-project-tokens')] : [])].filter((n) => n > 0);

      if (limits.length) state[key] = Math.min(state[key], ...limits);

      const remaining = [number(`x-ratelimit-remaining-${header}`),
        ...(header === 'tokens' ? [number('x-ratelimit-remaining-project-tokens')] : [])].filter((n) => n !== null);

      if (remaining.length) state[header] = Math.min(state[header], ...remaining);

      state[header] = Math.min(state[header], state[key]);

      if (remaining.length && Math.min(...remaining) <= 0) {
        const reset = Math.max(durationMs(response.headers.get(`x-ratelimit-reset-${header}`)),
          header === 'tokens' ? durationMs(response.headers.get('x-ratelimit-reset-project-tokens')) : 0);
        state.blockedUntil = Math.max(state.blockedUntil, this.now() + reset);
      }
    }

    // If the provider lowers its limit, retain at most 30% for final agents.
    state.reserveTokens = Math.min(state.reserveTokens, state.tokensPerMinute * 0.3);

    if (response?.status === 402 && body?.capacityHold) {
      // OpenRouter's in-flight credit reservation is transient account-wide
      // capacity pressure. Reduce admission briefly across all workers.
      state.blockedUntil = Math.max(state.blockedUntil, this.now() + 1500);
      state.concurrencyLimit = Math.max(1, Math.floor(state.concurrencyLimit / 2));
      state.successes = 0;
    } else if (body?.firstContentStall) {
      // A full first-content timeout without caller-deadline shortening is a
      // signal that this pool is overloaded. Back off admission briefly;
      // productive streams reaching their absolute limit do not affect it.
      state.blockedUntil = Math.max(state.blockedUntil, this.now() + 500);
      state.concurrencyLimit = Math.max(1, Math.floor(state.concurrencyLimit / 2));
      state.successes = 0;
    } else if ([429, 503].includes(response?.status)) {
      const fallbackDelay = model.startsWith('openrouter:') && response.status === 429 ? this.windowMs : 1000;

      state.blockedUntil = Math.max(state.blockedUntil, this.now() + (retryAfterMs(response.headers, body) || fallbackDelay));
      state.concurrencyLimit = Math.max(1, Math.floor(state.concurrencyLimit / 2));
      state.successes = 0;
    } else if (response?.ok && ++state.successes >= 8) {
      state.concurrencyLimit = Math.min(state.concurrency, state.concurrencyLimit + 1);
      state.successes = 0;
    }

    this.drain();
  }
}

const localScheduler = new ModelScheduler();
let remote;
const modelScheduler = {
  acquire(options) {
    if (!process.env.CAPACITY_SOCKET) return localScheduler.acquire(options);
    const { CapacityClient } = require('./capacity_client');
    remote ||= new CapacityClient(process.env.CAPACITY_SOCKET);
    return remote.acquire(options);
  },
};

module.exports = { DEFAULT_LIMITS, ModelScheduler, modelScheduler, estimateTokens, retryAfterMs, durationMs };
