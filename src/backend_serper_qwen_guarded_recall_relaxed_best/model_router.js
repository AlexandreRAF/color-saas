const { modelScheduler, estimateTokens } = require('./model_scheduler');
const qwen = require('./qwen_page');
const gemini = require('./gemini_page');
const { requestWorkload, reasoningPayload } = require('./request_envelope');
const { awaitWithSignal, completeMembers, readModelStream } = require('./model_stream');

const OPENAI_URL = 'https://api.openai.com/v1/responses';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/responses';
const circuits = new WeakMap();
const notify = (callback, value) => { try { callback?.(value); } catch { /* Diagnostics only. */ } };

function routeTimeouts(kind, timeoutMs, routing, env = process.env, payload) {
  const workload = payload ? requestWorkload(payload) : { inputChars: 0, totalChars: 0 };
  const requestMs = Math.min(timeoutMs, routing.timeoutMs ?? Number(env.MODEL_ROUTE_TIMEOUT_MS
    || (kind === 'candidateReview' ? 14000 : 12000)));
  const limits = {
    capacityMs: routing.capacityWaitMs ?? Number(env.MODEL_ROUTE_CAPACITY_WAIT_MS || 200),
    qwenCapacityMs: routing.qwenCapacityWaitMs ?? routing.capacityWaitMs
      ?? Number(env.QWEN_CAPACITY_WAIT_MS || (kind === 'verification' ? 3500 : 500)),
    requestMs,
    qwenMs: Math.min(requestMs, routing.qwenTimeoutMs ?? Number(env.QWEN_PAGE_TIMEOUT_MS
      || Math.min(12000, (kind === 'candidateReview' ? 8000 : 6000) + 2000 * Math.floor(workload.totalChars / 30000)))),
    geminiMs: Math.min(requestMs, routing.geminiTimeoutMs ?? Number(env.GEMINI_PAGE_TIMEOUT_MS || 8000)),
    firstContentMs: routing.firstContentMs ?? Number(env.MODEL_FIRST_CONTENT_MS
      || Math.min(6000, 4000 + 1000 * Math.floor(workload.inputChars / 30000))),
    idleMs: routing.idleMs ?? Number(env.MODEL_STREAM_IDLE_MS || 2500),
  };

  if (!Object.values(limits).every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('Invalid model route timeouts');
  }
  return limits;
}

// Leave a usable fallback window inside the caller's existing deadline.
// Recompute after capacity admission, since queuing also consumes that window.
function attemptBudget(limitMs, remainingMs, hasFallback, minimumWindowMs = 750) {
  if (!Number.isFinite(remainingMs)) return limitMs;
  const fallbackWindow = hasFallback ? Math.min(2500, remainingMs * 0.4) : 0;
  // Do not cancel the last useful attempt to reserve a fallback that admission
  // would reject as too short. One viable final attempt beats tiny retry bursts.
  const reserve = fallbackWindow >= minimumWindowMs ? fallbackWindow : 0;
  return Math.max(1, Math.min(limitMs, Math.floor(remainingMs - reserve)));
}

function firstContentBudget(route, kind, routing, limits, env = process.env) {
  // Repeated four-second GPT cutoffs caused fallback cascades for structured
  // reviews, matching and final checks. The caller still caps this allowance.
  return !route.chat && ['candidateReview', 'databaseMatcher', 'verification'].includes(kind)
    && routing.firstContentMs === undefined && !env.MODEL_FIRST_CONTENT_MS
    ? Math.max(kind === 'candidateReview' && limits.firstContentMs >= 5000 ? 10000 : 6000,
      limits.firstContentMs) : limits.firstContentMs;
}

// The subset of JSON Schema used by this backend's structured responses.
function matchesSchema(value, schema) {
  if (!schema) return true;
  if (schema.anyOf) return schema.anyOf.some(branch => matchesSchema(value, branch));
  if (schema.enum && !schema.enum.includes(value)) return false;

  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const types = [].concat(schema.type || type);

  if (!types.includes(type) && !(type === 'number' && Number.isInteger(value) && types.includes('integer'))) return false;

  if (type === 'object') {
    if ((schema.required || []).some(key => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties || {}, key))) return false;
    return Object.entries(schema.properties || {}).every(([key, child]) => !Object.hasOwn(value, key) || matchesSchema(value[key], child));
  }

  return type !== 'array' || (schema.maxItems === undefined || value.length <= schema.maxItems)
    && (schema.minItems === undefined || value.length >= schema.minItems)
    && value.every(item => matchesSchema(item, schema.items));
}

// Omitted optional extractor work means no follow-up question. This is transport
// metadata only; never default a paint fact, evidence ID or approval decision.
function normalizeBatchMember(value, schema) {
  // Some structured providers wrap a categorical verdict in an object whose
  // sole key repeats that same verdict. Accept only an exact schema enum, never
  // a guessed key, contradictory value or object containing additional facts.
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1) {
    const [key, verdict] = Object.entries(value)[0];
    if (key === verdict && (schema?.anyOf || [schema]).some(item =>
      item?.type === 'string' && item.enum?.includes(verdict))) return verdict;
  }
  if (value?.decision !== 'include' || Object.hasOwn(value, 'detail')) return value;
  const branch = (schema?.anyOf || [schema]).find(item => item?.properties?.detail
    && item.properties.decision?.enum?.includes('include'));
  return branch && matchesSchema(null, branch.properties.detail) ? { ...value, detail: null } : value;
}

function normalizeBatch(value, schema) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    /^R\d+$/.test(key) ? normalizeBatchMember(child, schema?.properties?.[key]) : child]));
}

function hasUsableBatchMember(value, schema) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const properties = Object.entries(schema?.properties || {});
  return properties.length > 0 && properties.every(([key]) => /^R\d+$/.test(key))
    && properties.some(([key, child]) => Object.hasOwn(value, key)
      && (matchesSchema(value[key], child)
        || typeof value[key]?.decision === 'string' && matchesSchema(value[key].decision, child)));
}

function validateResponse(body, payload, allowPartialBatch = false) {
  if (body?.status !== 'completed') throw new Error(`Model response did not complete: ${body?.status || 'unknown'}`);

  const content = body.output?.findLast(item => item.type === 'message')?.content;

  if (content?.some(item => item.type === 'refusal')) throw new Error('Model refused structured response');

  const text = content?.find(item => item.type === 'output_text')?.text;

  if (!text) throw new Error('Model returned no structured output');

  let value = JSON.parse(text);

  const schema = payload.text?.format?.schema;
  const properties = Object.entries(schema?.properties || {});
  if (allowPartialBatch) {
    value = normalizeBatch(value, schema);
    content.find(item => item.type === 'output_text').text = JSON.stringify(value);
  }
  // A one-candidate transport occasionally returns the correctly typed child
  // without its R key. Restore only that unambiguous wrapper; multi-candidate
  // answers, missing fields and invalid citations still require validation.
  if (allowPartialBatch && properties.length === 1 && /^R\d+$/.test(properties[0][0])
    && !matchesSchema(value, schema) && matchesSchema(value, properties[0][1])) {
    value = { [properties[0][0]]: value };
    content.find(item => item.type === 'output_text').text = JSON.stringify(value);
  }
  // ReviewBatcher validates and repairs every child before releasing it. Keep
  // valid siblings rather than paying to regenerate an entire batch because
  // one decision has a bad citation or an extra field. Other callers stay strict.
  const partial = allowPartialBatch && hasUsableBatchMember(value, schema);
  if (!matchesSchema(value, schema) && !partial) throw new Error('Model output does not match the required JSON schema');

  return value;
}

async function requestModel(url, init, {
  request = fetch, timeoutMs = 10000, signal, scheduler = modelScheduler, schedule = {}, timing,
  onWait, onAttempt, onUsage, onInvalidOutput, validateOutput, allowPartialBatch = false, splitOnTimeout = false, routing = {},
} = {}) {
  if (url !== OPENAI_URL) throw new Error('Model router requires an OpenAI Responses request');

  const payload = JSON.parse(init.body);
  const openaiKey = String(new Headers(init.headers).get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const openrouterKey = routing.openrouterApiKey ?? process.env.OPENROUTER_API_KEY;
  const geminiKey = routing.geminiApiKey ?? process.env.GEMINI_API_KEY;
  const routes = [
    ...((['pageAnalysis', 'recovery', 'verification', 'catalogResearch', 'targetedExtraction'].includes(schedule.kind)
      || (schedule.kind === 'databaseMatcher' && routing.matcherQwen === true)
      || (schedule.kind === 'candidateReview' && routing.candidateReviewQwen !== false)) ? [{ provider: 'openrouter', model: qwen.MODEL,
      key: openrouterKey, serviceTier: 'default', chat: true }] : []),
    { provider: 'openai', model: 'gpt-6-luna', key: openaiKey,
      serviceTier: schedule.kind === 'candidateReview' || schedule.kind === 'databaseMatcher' && routing.matcherFast === false
        ? 'default' : 'fast' },
    { provider: 'openrouter', model: 'openai/gpt-6-luna', key: openrouterKey, serviceTier: 'default' },
    { provider: 'openai', model: 'gpt-5.6-luna', key: openaiKey, serviceTier: 'default' },
    { provider: 'openrouter', model: 'openai/gpt-5.6-luna', key: openrouterKey, serviceTier: 'default' },
    ...(schedule.kind === 'pageAnalysis' ? [{ provider: 'gemini', model: gemini.MODEL,
      key: geminiKey, serviceTier: 'default' }] : []),
  ].map(route => ({ ...route, id: route.provider === 'openai' ? route.model : `${route.provider}:${route.model}` }));

  const parent = signal && timing ? AbortSignal.any([signal, timing.signal]) : signal || timing?.signal;
  const limits = routeTimeouts(schedule.kind, timeoutMs, routing, process.env, payload);
  const capacityKind = routing.startAfter && schedule.capacityKind !== 'omissionAudit'
    ? 'reviewRepair' : schedule.capacityKind || schedule.kind;
  const minimumWindow = routing.minimumAttemptWindowMs ?? 1500;
  if (!Number.isFinite(minimumWindow) || minimumWindow < 0) throw new Error('Invalid minimum model attempt window');
  const checkWindow = () => {
    parent?.throwIfAborted();
    const remaining = timing?.remainingMs?.(signal) ?? Infinity;
    if (remaining < minimumWindow) throw Object.assign(
      new Error('Insufficient stage time to start another model attempt'),
      { code: 'MODEL_DEADLINE_INSUFFICIENT', deadlineExceeded: true });
  };
  if (!circuits.has(scheduler)) circuits.set(scheduler, new Map());

  const disabled = circuits.get(scheduler);
  const circuitKey = route => `${route.provider}:${route.key}:${route.model}`;
  const accountHoldKey = route => `openrouter:${route.key}:inflight`;
  const timeoutKey = route => `${circuitKey(route)}:${schedule.kind || 'main'}:${capacityKind || 'main'}:timeout`;
  const available = route => route.key && !['undefined', 'null'].includes(route.key)
    && (disabled.get(circuitKey(route)) || 0) <= Date.now()
    && (route.provider !== 'openrouter' || (disabled.get(accountHoldKey(route)) || 0) <= Date.now())
    && (disabled.get(timeoutKey(route)) || 0) <= Date.now();
  const emit = (event, route, detail = {}) => notify(onWait, {
    event, provider: route.provider, model: route.model, kind: schedule.kind, ...detail,
  });

  const errors = [], deferred = [], budgetPending = [], budgetFailures = [];
  const routePayloads = new Map(routes.map(route => [route, reasoningPayload(route, payload)]));
  const reservedTokens = route => estimateTokens(route.chat ? qwen.pageRequest(payload) : routePayloads.get(route));
  let attempts = 0;

  async function execute(route, ticket, budgetTicket) {
    const controller = new AbortController();
    const attemptSignal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
    const limitMs = route.chat ? limits.qwenMs : route.provider === 'gemini' ? limits.geminiMs : limits.requestMs;
    const hasFallback = routes.slice(routes.indexOf(route) + 1).some(available);
    const attemptMs = attemptBudget(limitMs, timing?.remainingMs?.(signal) ?? Infinity, hasFallback, minimumWindow);
    const progressingMs = Math.min(limitMs, timing?.remainingMs?.(signal) ?? Infinity);
    let response, body, started, budgetUsage, timer, progressTimer, requestCeiling;
    const streamState = {};
    let usageReported = false, firstContentMs, capacityHold = false, firstContentStall = false;
    let phase = 'request';

    try {
      parent?.throwIfAborted();
      checkWindow();
      if (attemptMs < Math.min(minimumWindow, limitMs)) throw Object.assign(
        new Error('Insufficient time for a usable model attempt and fallback'),
        { code: 'MODEL_DEADLINE_INSUFFICIENT', deadlineExceeded: true });

      // Another concurrent call may have disabled this route during admission.
      if (!available(route)) {
        emit('model_route_skipped', route, { reason: 'Route entered cooldown during admission' });
        return null;
      }

      const adapter = route.chat ? qwen : route.provider === 'gemini' ? gemini : null;
      const bodyToSend = adapter ? adapter.pageRequest(payload)
        : { ...routePayloads.get(route), model: route.model, store: false };

      if (route.provider === 'openai') bodyToSend.service_tier = route.serviceTier;
      else delete bodyToSend.service_tier;

      const streaming = route.provider !== 'gemini' && routing.streaming !== false;
      if (streaming) {
        bodyToSend.stream = true;
        if (route.chat) bodyToSend.stream_options = { include_usage: true };
      }
      requestCeiling = { requestBytes: Buffer.byteLength(JSON.stringify(bodyToSend)),
        maxOutputTokens: bodyToSend.max_tokens || bodyToSend.max_output_tokens || null };
      const armProgress = (ms, phaseName) => {
        clearTimeout(progressTimer);
        progressTimer = setTimeout(() => controller.abort(Object.assign(
          new Error(`Model ${phaseName} timeout after ${ms} ms`),
          { code: 'MODEL_ROUTE_TIMEOUT', timeoutPhase: phaseName },
        )), ms);
      };
      const progress = () => {
        if (firstContentMs === undefined) {
          firstContentMs = performance.now() - started;
          emit('model_first_content', route, { durationMs: firstContentMs });
          // Reserve fallback time while waiting for a response. Once meaningful
          // generation starts, let it finish within the original stage/attempt
          // deadline; repeatedly cancelling productive streams loses reviews.
          clearTimeout(timer);
          timer = setTimeout(() => controller.abort(Object.assign(
            new Error(`Model attempt timed out after ${progressingMs} ms (${phase})`),
            { code: 'MODEL_ROUTE_TIMEOUT' },
          )), Math.max(1, progressingMs - firstContentMs));
        }
        armProgress(limits.idleMs, 'idle');
      };

      timer = setTimeout(() => controller.abort(Object.assign(
        new Error(`Model attempt timed out after ${attemptMs} ms (${phase})`),
        { code: 'MODEL_ROUTE_TIMEOUT' },
      )), attemptMs);

      attempts++;
      notify(onAttempt, { provider: route.provider, model: route.model });
      emit('model_route_start', route, { timeoutMs: attemptMs });
      started = performance.now();
      const firstContentLimit = firstContentBudget(route, schedule.kind, routing, limits);
      if (streaming) armProgress(Math.min(attemptMs, firstContentLimit), 'first_content');
      response = await awaitWithSignal(() => request(adapter?.API_URL || (route.provider === 'openai' ? OPENAI_URL : OPENROUTER_URL), {
        method: 'POST', headers: { 'Content-Type': 'application/json',
          ...(route.provider === 'gemini' ? { 'x-goog-api-key': route.key } : { Authorization: `Bearer ${route.key}` }) },
        body: JSON.stringify(bodyToSend), signal: attemptSignal,
      }), attemptSignal);

      phase = 'response_body';

      // A failed status already justifies fallback. Allow a small grace period
      // for error details/usage, never the entire generation timeout.
      const bodySignal = response.ok ? attemptSignal
        : AbortSignal.any([attemptSignal, AbortSignal.timeout(200)]);

      try {
        if (response.ok && response.headers?.get?.('content-type')?.includes('text/event-stream')) {
          body = await readModelStream(response, { chat: route.chat, signal: bodySignal, progress, state: streamState });
        } else {
          clearTimeout(progressTimer); // JSON clients expose no intermediate generation progress.
          body = await awaitWithSignal(() => response.json(), bodySignal);
        }
      } catch (error) {
        parent?.throwIfAborted();
        if (response.ok) throw error;
        const failure = new Error(`HTTP ${response.status}: model request failed (unreadable error body)`);
        failure.status = response.status;
        throw failure;
      }

      if (adapter) body = adapter.normalizeResponse(body);

      if (body?.usage) {
        body.usage.cached_input_tokens = body.usage.cached_input_tokens || body.usage.input_tokens_details?.cached_tokens || 0;

        const cost = body.usage.cost;

        if (route.provider === 'openrouter' && typeof cost === 'number' && cost >= 0) {
          body.usage.reported_cost_usd = cost;
        }

        budgetUsage = { provider: route.provider, model: route.model,
          serviceTier: route.provider === 'openrouter' ? 'default' : body.service_tier || route.serviceTier,
          usage: body.usage };

        notify(onUsage, budgetUsage);
        usageReported = true;
      }

      if (!response.ok || body?.error) {
        let providerMessage;
        try {
          const raw = body?.error?.metadata?.raw;
          const detail = typeof raw === 'string' ? JSON.parse(raw) : raw;
          providerMessage = detail?.error?.message || detail?.message;
        } catch { /* Keep the public provider error when its detail is not JSON. */ }
        const detail = typeof providerMessage === 'string' ? ` (${providerMessage.slice(0, 500)})` : '';
        const error = new Error(`HTTP ${response.status}: ${body?.error?.message || 'model request failed'}${detail}`);
        error.status = Number(body?.error?.code) || response.status;
        throw error;
      }

      try {
        const parsed = validateResponse(body, payload, allowPartialBatch);
        validateOutput?.(parsed, route);
      } catch (error) {
        notify(onInvalidOutput, { provider: route.provider, model: route.model,
          error: error.message, output: body?.output });
        throw error;
      }

      Object.defineProperties(body, {
        _requestModel: { value: route.model }, _requestProvider: { value: route.provider },
        _requestServiceTier: { value: route.serviceTier },
      });

      emit('model_route_complete', route, { durationMs: performance.now() - started, firstContentMs });

      return body;
    } catch (error) {
      if (parent?.aborted) {
        // A shared deadline reason must not be mutated with one batch's data.
        // Preserve completed streamed members for candidate-local validation.
        throw Object.assign(new Error(parent.reason?.message || 'Request cancelled'), {
          name: parent.reason?.name || 'AbortError', code: parent.reason?.code,
          deadlineExceeded: parent.reason?.deadlineExceeded,
          routeId: route.id,
          partialOutput: completeMembers(streamState.text || ''),
        });
      }

      if (error.code === 'MODEL_DEADLINE_INSUFFICIENT') throw error;

      firstContentStall = error.code === 'MODEL_ROUTE_TIMEOUT' && error.timeoutPhase === 'first_content'
        && attemptMs >= firstContentBudget(route, schedule.kind, routing, limits);

      if (error.code === 'AI_BUDGET_LIMIT') {
        if (error.details) budgetFailures.push(error.details);
        errors.push(`${route.id}: ${error.message}`);
        emit('model_route_skipped', route, { reason: error.message });
        return null; // A later, cheaper fallback may still fit the reserved budget.
      }

      // OpenRouter can return 402 while concurrent requests temporarily hold
      // credit reservations. That is short-lived capacity pressure, not proof
      // that the entire account is unfunded. Keep genuine billing failures on
      // the provider-wide circuit and let the next route start immediately.
      const inFlightCredits = route.provider === 'openrouter' && error.status === 402
        && /(?:current\s+)?in[-\s]?flight requests/i.test(error.message);
      capacityHold = inFlightCredits;
      const accountFailure = !inFlightCredits && ([401, 402].includes(error.status)
        || /quota|billing|prepayment/i.test(error.message));

      if (response?.ok && error.status >= 400) response = { ok: false, status: error.status, headers: response.headers };

      if (inFlightCredits) {
        // The provider's message describes one account-wide credit hold.
        // Trying another OpenRouter model immediately repeats the same 402.
        disabled.set(accountHoldKey(route), Date.now() + 1500);
      } else if (accountFailure || [403, 404].includes(error.status)) {
        for (const affected of routes.filter(item => accountFailure ? item.provider === route.provider : item.id === route.id)) {
          // A genuine billing failure will not recover during this vehicle's
          // hard deadline. Give the funded fallbacks the whole run; retry the
          // account on a later request after a bounded recovery interval.
          disabled.set(circuitKey(affected), Date.now() + (accountFailure ? 120000 : 30000));
        }
      }

      if (error.code === 'MODEL_ROUTE_TIMEOUT') {
        // An absolute limit on an actively generating response is a workload
        // limit, not evidence that the provider is stalled. Cooling down that
        // route sends unrelated small reviews into unnecessary fallbacks.
        const stalled = firstContentMs === undefined || error.timeoutPhase === 'idle';
        if (stalled && attemptMs >= limitMs) disabled.set(timeoutKey(route), Date.now() + 3000);
      } else if (!response || [500, 502, 503, 504].includes(error.status)) {
        disabled.set(circuitKey(route), Date.now() + 1000);
      }

      let message = error.message;

      for (const key of [openaiKey, openrouterKey, geminiKey].filter(Boolean)) message = message.replaceAll(key, '[redacted]');

      errors.push(`${route.id}: ${message}`);
      emit('model_route_fallback', route, { reason: message, phase: error.timeoutPhase || phase, timeoutMs: attemptMs, firstContentMs,
        durationMs: started === undefined ? 0 : performance.now() - started,
        ...(error.code === 'MODEL_ROUTE_TIMEOUT' ? { code: error.code } : {}) });

      const completed = normalizeBatch(completeMembers(streamState.text || ''), payload.text?.format?.schema);
      if (error.code === 'MODEL_ROUTE_TIMEOUT' && splitOnTimeout
        || allowPartialBatch && hasUsableBatchMember(completed, payload.text?.format?.schema)) {
        // Length limits and interrupted transports can contain usable children
        // too. The batch owner validates each child and repairs only unfinished
        // decisions; regenerating all siblings wastes the remaining stage time.
        error.code ||= 'MODEL_PARTIAL_OUTPUT';
        error.routeId = route.id;
        error.route = { model: route.model, provider: route.provider, serviceTier: route.serviceTier };
        error.partialOutput = completed;
        throw error;
      }
      return null;
    } finally {
      clearTimeout(timer);
      clearTimeout(progressTimer);
      controller.abort();
      if (started !== undefined && !usageReported) {
        const usage = streamState.usage && (route.chat ? qwen.normalizeResponse({ usage: streamState.usage }).usage : streamState.usage);
        if (usage && route.provider === 'openrouter' && Number.isFinite(usage.cost)) usage.reported_cost_usd = usage.cost;
        budgetUsage = { provider: route.provider, model: route.model, serviceTier: route.serviceTier, usage,
          ...(!usage && requestCeiling),
          ...(capacityHold && !usage && { preflightRejected: true }) };
        notify(onUsage, budgetUsage);
      }
      if (started === undefined) budgetTicket?.cancel?.();
      else budgetTicket?.complete(budgetUsage);
      if (timing && started !== undefined) timing.modelRequestMs += performance.now() - started;
      if (started === undefined && ticket.cancel) ticket.cancel();
      else ticket.complete(response, capacityHold || firstContentStall
        ? { ...body, ...(capacityHold && { capacityHold: true }),
          ...(firstContentStall && { firstContentStall: true }) } : body);
    }
  }

  // Split children continue AFTER the stalled provider instead of restarting it.
  const startIndex = routing.startAfter ? routes.findIndex(route => route.id === routing.startAfter) + 1 : 0;
  const pendingRoutes = routes.slice(startIndex);
  const choices = list => list.map(route => ({ model: route.id, tokens: reservedTokens(route) }));
  const ready = pendingRoutes.filter(route => {
    if (available(route)) return true;
    emit('model_route_skipped', route, { reason: 'Missing credential or temporary circuit cooldown' });
    return false;
  });

  // Reviews and final verification are cheaper and faster on Qwen. A short
  // wait for its shared slot avoids sending many simultaneous verification
  // fallbacks to a GPT route that is already slow under four-worker load.
  if (['candidateReview', 'verification'].includes(schedule.kind)
    && ready[0]?.chat && ready.length > 1) {
    checkWindow();
    const preferred = ready[0];
    let ticket;
    try {
      ticket = await scheduler.acquire({ choices: choices([preferred]), immediate: true,
        kind: capacityKind, signal: parent, timing, onWait });
    } catch (error) {
      // A single route can exceed a caller-configured TPM ceiling while the
      // other providers still fit. Coordinator failures remain fatal.
      if (!/exceeds (?:the configured |provider )?token capacity/i.test(error.message)) throw error;
      ready.shift();
    }
    const waitMs = Math.min(limits.qwenCapacityMs,
      Math.max(0, (timing?.remainingMs?.(signal) ?? Infinity) - minimumWindow));
    if (!ticket && ready[0] === preferred && available(preferred) && waitMs >= 1) {
      const timeoutSignal = AbortSignal.timeout(waitMs);
      const waitSignal = parent ? AbortSignal.any([parent, timeoutSignal]) : timeoutSignal;
      try {
        ticket = await scheduler.acquire({ choices: choices([preferred]),
          kind: capacityKind, signal: waitSignal, timing, onWait });
      } catch (error) {
        parent?.throwIfAborted();
        if (error.name !== 'TimeoutError') throw error;
      }
    }
    if (ticket) {
      ready.shift();
      let budgetTicket;
      try {
        budgetTicket = await routing.budget?.reserve(preferred, payload, schedule.kind,
          parent, { wait: false });
        if (routing.budget && !budgetTicket) {
          ticket.cancel();
          budgetPending.push(preferred);
        } else {
          const result = await execute(preferred, ticket, budgetTicket);
          if (result) return result;
        }
      } catch (error) {
        ticket.cancel();
        parent?.throwIfAborted();
        if (error.code !== 'AI_BUDGET_LIMIT') throw error;
        if (error.details) budgetFailures.push(error.details);
        errors.push(`${preferred.id}: ${error.message}`);
        emit('model_route_skipped', preferred, { reason: error.message });
      }
    }
  }

  // The scheduler grants the first free route atomically. This avoids a short
  // Qwen wait on every concurrent request when another affordable pool is free.
  while (ready.length) {
    checkWindow();
    for (const route of ready.filter(route => !available(route))) {
      emit('model_route_skipped', route, { reason: 'Route entered cooldown during admission' });
      ready.splice(ready.indexOf(route), 1);
    }
    if (!ready.length) break;
    const eligible = [...ready];
    const ticket = await scheduler.acquire({ choices: choices(eligible), immediate: true,
      kind: capacityKind, signal: parent, timing, onWait });
    if (!ticket) {
      deferred.push(...eligible);
      break;
    }

    const route = eligible.find(item => item.id === ticket.model);
    ready.splice(ready.indexOf(route), 1);
    if (route !== eligible[0]) emit('model_route_capacity_bypass', eligible[0], {
      selectedProvider: route.provider, selectedModel: route.model });

    let budgetTicket;
    try {
      budgetTicket = await routing.budget?.reserve(route, payload, schedule.kind,
        parent, { wait: false });
      if (routing.budget && !budgetTicket) {
        ticket.cancel();
        budgetPending.push(route);
        continue;
      }
    } catch (error) {
      ticket.cancel();
      parent?.throwIfAborted();
      if (error.code === 'AI_BUDGET_LIMIT' && error.details) budgetFailures.push(error.details);
      errors.push(`${route.id}: ${error.message}`);
      emit('model_route_skipped', route, { reason: error.message });
      continue;
    }

    const result = await execute(route, ticket, budgetTicket);

    if (result) return result;
  }

  // Only an all-busy capacity check enters the shared queue. Each choice uses
  // its own token estimate, so a large Qwen payload cannot block a smaller GPT
  // route. The scheduler still enforces priorities, cooldowns and cancellation.
  while (deferred.some(available)) {
    checkWindow();
    const eligible = deferred.filter(available);
    const ticket = await scheduler.acquire({ choices: choices(eligible),
      kind: capacityKind, signal: parent, timing, onWait });
    const route = eligible.find(item => item.id === ticket.model);

    deferred.splice(deferred.indexOf(route), 1);

    let budgetTicket;
    try {
      budgetTicket = await routing.budget?.reserve(route, payload, schedule.kind,
        parent, { wait: false });
      if (routing.budget && !budgetTicket) {
        ticket.cancel();
        budgetPending.push(route);
        continue;
      }
    }
    catch (error) {
      ticket.cancel?.();
      if (error.code === 'AI_BUDGET_LIMIT' && error.details) budgetFailures.push(error.details);
      errors.push(`${route.id}: ${error.message}`);
      continue;
    }
    const result = await execute(route, ticket, budgetTicket);

    if (result) return result;
  }

  // Pending cost reservations are revisited without holding a model slot.
  // This preserves the original wait for funds released by concurrent calls.
  for (const route of budgetPending.filter(available)) {
    checkWindow();
    let budgetTicket;
    try { budgetTicket = await routing.budget.reserve(route, payload, schedule.kind, parent); }
    catch (error) {
      if (error.code === 'AI_BUDGET_LIMIT' && error.details) budgetFailures.push(error.details);
      errors.push(`${route.id}: ${error.message}`);
      continue;
    }

    let ticket;
    try { ticket = await scheduler.acquire({ choices: choices([route]),
      kind: capacityKind, signal: parent, timing, onWait }); }
    catch (error) { budgetTicket.cancel(); throw error; }
    const result = await execute(route, ticket, budgetTicket);
    if (result) return result;
  }

  const error = new Error(`All model routes failed: ${errors.join('; ') || 'No usable API credentials'}`);

  error.attempts = attempts;
  if (errors.length && errors.every(message => /AI cost target reached/.test(message))) {
    error.code = 'AI_BUDGET_LIMIT';
    error.details = budgetFailures.filter(details => Number.isFinite(details.estimatedRequestUsd))
      .sort((a, b) => a.estimatedRequestUsd - b.estimatedRequestUsd)[0];
  }

  throw error;
}

module.exports = { requestModel, matchesSchema, normalizeBatchMember, routeTimeouts, attemptBudget, firstContentBudget };
