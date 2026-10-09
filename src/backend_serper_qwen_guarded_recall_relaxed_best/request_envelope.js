'use strict';

const { MODEL } = require('./model_config');
const qwen = require('./qwen_page');

// Use the same envelope for sizing and sending. Schemas (including Qwen's
// repeated schema), instructions and output allowance all consume capacity.
function structuredRequest(stage, schema, input, instructions) {
  return {
    model: MODEL, service_tier: 'fast', instructions, input: JSON.stringify(input),
    text: { format: { type: 'json_schema', name: stage, strict: true, schema }, verbosity: 'low' },
    reasoning: { effort: 'low' }, store: false,
    ...(stage.startsWith('research_review') && { max_output_tokens: stage.startsWith('research_review_batch_')
      ? (input.triage ? 32 : 180) * Object.keys(schema.properties).length + 64 : 1000 }),
    ...(stage.startsWith('research_review_omission_') && stage.endsWith('_retry')
      && { max_output_tokens: 2048 }),
    ...(stage.startsWith('recover_') && { max_output_tokens: 4096 }),
    ...((stage.startsWith('catalog_check_') || stage.startsWith('extract_details_'))
      && { max_output_tokens: 2048 }),
    ...(stage.startsWith('final_verification_') && { max_output_tokens: stage.startsWith('final_verification_omissions_')
      ? 64 + 45 * input.candidates.length : 500 * (input.colors?.length || 1) }),
  };
}

function requestWorkload(payload) {
  const inputChars = Math.max(JSON.stringify(payload).length, JSON.stringify(qwen.pageRequest(payload)).length);
  const outputTokens = payload.max_output_tokens || 2048;
  return { inputChars, outputTokens, totalChars: inputChars + outputTokens * 4 };
}

// The compact schemas size visible answers. Responses limits also include
// reasoning tokens; a small one-color answer otherwise exhausts its entire
// limit before producing valid JSON. Qwen disables thinking and needs no reserve.
function reasoningPayload(route, payload) {
  if (route.chat || route.provider === 'gemini' || !payload.max_output_tokens
    || !payload.reasoning?.effort || payload.reasoning.effort === 'none') return payload;
  return { ...payload, max_output_tokens: Math.max(2048, payload.max_output_tokens + 1024) };
}

module.exports = { structuredRequest, requestWorkload, reasoningPayload };
