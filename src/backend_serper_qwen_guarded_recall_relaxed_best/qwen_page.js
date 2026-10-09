const MODEL = 'qwen/qwen3.5-flash-02-23';
const API_URL = 'https://openrouter.ai/api/v1/chat/completions';

const { isGenericPaintName } = require('./paint_name');

// Adapt the existing full-evidence request to Qwen's chat interface.
function pageRequest(payload) {
  const schema = payload.text.format.schema;
  const extraction = schema.properties?.candidates?.items?.properties?.evidence_ids;
  const reviewMembers = payload.text.format.name.startsWith('research_review_batch_')
    ? Object.keys(schema.properties || {}).filter(key => /^R\d+$/.test(key)).length : 0;
  let triage = false;
  if (reviewMembers) {
    try { triage = JSON.parse(payload.input).triage === true; } catch { /* Keep the full review allowance. */ }
  }
  // Qwen has reasoning disabled. Its answer needs less output room than the
  // GPT envelope, whose allowance also covers reasoning tokens. OpenRouter
  // reserves credit for the full requested output of every in-flight call.
  const requestedOutput = payload.max_output_tokens || 8192;
  const outputLimit = reviewMembers > 4
    ? Math.min(requestedOutput, 64 + reviewMembers * (triage ? 32 : 280))
    : extraction ? Math.min(requestedOutput, Math.max(3072, Math.ceil(payload.input.length / 2)))
      : requestedOutput;

  return {
    model: MODEL,
    messages: [{ role: 'system', content: payload.instructions + (extraction ? `

Name boundaries: extract a formal name inside parentheses separately from a generic local hue/finish.
Keep the entire printed name, including distinctive words and version qualifiers. A finish-qualified display label is eligible only in an explicit model/year exterior color list; include its palette heading as evidence.
Cite the applicable model/year heading and limiting statements as well as the name/code row.
Return only {"candidates":[{"name":"Full Printed Name","evidence_ids":[1,2]}]}.
IDs must be JSON integers. Return {"candidates":[]} when no named paints or eligible model/year display labels are present.
` : '') + `\nRequired JSON schema: ${JSON.stringify(schema)}` }, { role: 'user', content: payload.input }],
    stream: false, temperature: 0, max_tokens: outputLimit,
    reasoning: { enabled: false },
    response_format: { type: 'json_schema', json_schema: {
      name: payload.text.format.name, strict: true, schema,
    } },
    provider: { require_parameters: true, allow_fallbacks: true },
    transforms: [], // Never shorten source evidence to make a route fit.
  };
}

function normalizeResponse(body) {
  if (!body) return body;

  const choice = body.choices?.[0];
  const usage = body.usage;

  return {
    ...(body.error && { error: body.error }),
    status: choice?.message?.refusal ? 'refused'
      : choice?.finish_reason === 'stop' ? 'completed' : choice?.finish_reason || 'missing choice',
    output: [{ type: 'message', content: [{ type: 'output_text', text: choice?.message?.content }] }],
    ...(usage && { usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens ?? (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
      cached_input_tokens: usage.prompt_tokens_details?.cached_tokens || 0,
      ...(Number.isFinite(usage.cost) && { cost: usage.cost }),
    } }),
  };
}

// Some sources print "Vermelho Metálico (Pearl Royalty Red)". Keep the
// literal formal name, without turning a generic descriptor into a new paint.
function formalName(name) {
  const pair = name.match(/^([^()]+)\(([^()]+)\)$/u)
    || name.match(/^(.+?)\s+[-–—]\s+(.+)$/u);

  if (!pair || !isGenericPaintName(pair[1].trim())) return name;

  const inner = pair[2].trim();

  if (isGenericPaintName(inner)) return inner; // The normal generic-name filter handles it.

  const words = inner.match(/[\p{L}\p{N}]+/gu) || [];

  return words.length >= 2 && words.some(isGenericPaintName) ? inner : name;
}

module.exports = { MODEL, API_URL, pageRequest, normalizeResponse, formalName };
