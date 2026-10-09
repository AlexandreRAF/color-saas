const MODEL = 'gemini-3.5-flash-lite';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// Keep the same prompt, full source evidence and schema on the final route.
function pageRequest(payload) {
  return {
    systemInstruction: { parts: [{ text: payload.instructions }] },
    contents: [{ role: 'user', parts: [{ text: payload.input }] }],
    generationConfig: {
      maxOutputTokens: payload.max_output_tokens || 8192,
      thinkingConfig: { thinkingLevel: 'minimal' },
      responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: payload.text.format.schema } },
    },
  };
}

// Present Google output to the shared validator, scheduler and usage ledger.
function normalizeResponse(body) {
  if (!body) return body;

  const candidate = body.candidates?.[0];
  const usage = body.usageMetadata;
  const input = usage?.promptTokenCount || 0;
  const output = (usage?.candidatesTokenCount || 0) + (usage?.thoughtsTokenCount || 0);

  return {
    ...(body.error && { error: body.error }),
    status: candidate?.finishReason === 'STOP' ? 'completed'
      : candidate?.finishReason || body.promptFeedback?.blockReason || 'missing candidate',
    output: [{ type: 'message', content: [{ type: 'output_text', text: candidate?.content?.parts
      ?.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('') }] }],
    ...(usage && { usage: { input_tokens: input, output_tokens: output,
      total_tokens: usage.totalTokenCount ?? input + output,
      cached_input_tokens: usage.cachedContentTokenCount || 0 } }),
  };
}

module.exports = { MODEL, API_URL, pageRequest, normalizeResponse };
