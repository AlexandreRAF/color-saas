'use strict';

const { requestModel } = require('./model_router');
const { structuredRequest } = require('./request_envelope');
const { ReviewBatcher, ReviewSlots } = require('./review_batcher');
const { DEFAULT_LIMITS } = require('./model_scheduler');
const { MODEL: QWEN_MODEL } = require('./qwen_page');
const { hueFamilies } = require('./hue_review');
const { verificationRequest } = require('./verification_request');

// Shared structured request envelope, routing, usage and debug reporting.
async function requestMainAgent(run, stage, schema, input, instructions, signal, validateOutput, recovery = {}) {
  if (stage.startsWith('research_review') && !stage.startsWith('research_review_repair_')
    && schema.properties?.action && run.options.batchReviews !== false) {
    const wanted = hueFamilies(input.vehicle?.predominantColor);
    const named = hueFamilies(input.candidates?.[0]?.name);
    const outside = wanted.size > 0 && ![...named].some(hue => wanted.has(hue));
    // This changes batching only. The reviewer must still decide every paint
    // using its evidence, including marketing names whose hue is unknown.
    // Uncertainty enters full review; absence of a hue word proves nothing.
    const retry = /research_review_(?:completion|omission)_/.test(stage);
    const key = retry ? (outside ? 'retryBroadReviewBatcher' : 'retryReviewBatcher')
      : outside ? 'broadReviewBatcher' : 'reviewBatcher';
    const qwenLimits = DEFAULT_LIMITS[`openrouter:${QWEN_MODEL}`];
    run.reviewSlots ||= new ReviewSlots(Math.max(1, Math.min(
      qwenLimits.concurrency - (qwenLimits.reserveConcurrency || 0),
      Number(process.env.MODEL_CONCURRENCY || 16) - Number(process.env.MODEL_COMPLETION_SLOTS || 4))));
    run[key] ||= new ReviewBatcher((...args) => requestMainAgent(run, ...args),
      { repairInvalid: false, splitTimeouts: false, ...(!retry && { slots: run.reviewSlots }),
        ...(retry && outside ? { size: 12, maxChars: 50000, concurrency: 2,
        stagePrefix: 'research_review_batch_retry_other' }
      : retry ? { size: 8, maxChars: 45000, concurrency: 4, stagePrefix: 'research_review_batch_retry' }
      : outside ? { size: 12, maxChars: 50000, concurrency: 2, triage: true,
        stagePrefix: 'research_review_batch_other' } : { size: 10, maxChars: 55000, concurrency: 5 }) });
    const item = { stage, schema, input, instructions, signal, validate: validateOutput, recovery };
    try {
      return await run[key].add(item);
    } catch (error) {
      if (!outside || retry || error.code !== 'REVIEW_REQUIRED') throw error;
      // Triage has made no paint decision. Its full review is first-pass work,
      // so it must not consume the one correction/omission-repair allowance.
      run.reviewBatcher ||= new ReviewBatcher((...args) => requestMainAgent(run, ...args),
        { repairInvalid: false, splitTimeouts: false, size: 10, maxChars: 55000, concurrency: 5, slots: run.reviewSlots });
      return run.reviewBatcher.add({ ...item, input: { ...input, review_issue: error.message } });
    }
  }

  if (stage.startsWith('final_verification_') && !recovery.managed && (input.colors || input.candidates)) {
    const result = await verificationRequest((name, childSchema, childInput, prompt, childRecovery) =>
      requestMainAgent(run, name, childSchema, childInput, prompt, signal, undefined, childRecovery),
    stage, schema, input, instructions, recovery);
    validateOutput?.(result);
    return result;
  }

  const started = performance.now();
  const agent = stage.startsWith('final_verification_') ? 'verification'
    : stage.startsWith('catalog_check_') ? 'catalogResearch'
    : stage.startsWith('extract_details_') ? 'targetedExtraction' : 'main';

  run.modelCalls[agent] = (run.modelCalls[agent] || 0) + 1;

  const body = structuredRequest(stage, schema, input, instructions);

  run.dump(`${stage}-request`, body);
  run.log('model_request_start', { stage });

  try {
    const response = await requestModel('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { 'Content-Type': 'application/json',
        Authorization: `Bearer ${run.options.apiKey || process.env.OPENAI_API_KEY}` },
      body: JSON.stringify(body),
    }, { request: run.options.request || fetch,
      routing: { ...run.routing, ...recovery },
      splitOnTimeout: recovery.splitOnTimeout,
      validateOutput,
      allowPartialBatch: stage.startsWith('research_review_batch_'),
      onUsage: details => { run.usage(agent, details.usage); run.cost.record(agent, details); },
      onInvalidOutput: details => run.dump(`${stage}-invalid-${details.provider}-${details.model.replaceAll('/', '_')}`, details),
      scheduler: run.scheduler, timing: run.timing,
      schedule: { capacityKind: stage.startsWith('final_verification_omissions') ? 'omissionAudit'
        : /research_review_(?:batch_)?(?:retry|repair|omission)/.test(stage)
          ? 'reviewRepair' : stage.startsWith('research_review') && input.triage !== true
          ? 'candidatePriority' : undefined, kind: agent !== 'main' ? agent : stage.startsWith('recover_') ? 'recovery'
        : stage.startsWith('research_review') ? 'candidateReview' : 'main' },
      onWait: ({ event, ...detail }) => run.log(event, { stage, ...detail }),
      timeoutMs: stage.startsWith('research_review') ? (run.options.reviewRequestTimeoutMs ?? 16000) : 16000, signal });

    if (response.status !== 'completed') throw new Error(`Main agent did not complete: ${response.status}`);

    const text = response.output?.findLast((item) => item.type === 'message')?.content
      ?.find((item) => item.type === 'output_text')?.text;

    if (!text) throw new Error('Main agent returned no structured output');

    const result = JSON.parse(text);
    Object.defineProperty(result, '_routeId', { value: response._requestProvider === 'openai'
      ? response._requestModel : `${response._requestProvider}:${response._requestModel}` });

    run.dump(`${stage}-response`, result);

    return result;
  } finally {
    run.stageTimes[stage] = (run.stageTimes[stage] || 0) + performance.now() - started;
    run.log('model_request_complete', { stage, durationMs: performance.now() - started });
  }
}

module.exports = { requestMainAgent };
