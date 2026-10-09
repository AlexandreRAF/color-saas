const fs = require('node:fs');
const path = require('node:path');

const { isGenericPaintName } = require('./paint_name');
const { createLimiter, requestJson } = require('./runtime');
const { requestModel } = require('./model_router');
const { restoreEvidence, referenceSchema, referenceSegments, extractionUnitLimit } = require('./page_evidence');
const { MODEL } = require('./model_config');
const { MODEL: QWEN_MODEL, formalName } = require('./qwen_page');
const { MODEL: GEMINI_MODEL } = require('./gemini_page');
const { PageBatcher } = require('./page_batcher');
const { hasNameLeadEvidence } = require('./paint_evidence');
const { withoutNavigationLinks } = require('./section_extraction');
const { structuredExtraction } = require('./structured_extraction');
const { isSupportedDisplayColor } = require('./display_color');

const promptDirectory = path.join(__dirname, 'gemini_page_color_agent');
const systemPrompt = fs.readFileSync(path.join(promptDirectory, 'prompts/system.md'), 'utf8');
const pagePrompt = fs.readFileSync(path.join(promptDirectory, 'prompts/page.md'), 'utf8');
const referencePrompt = fs.readFileSync(path.join(promptDirectory, 'prompts/references.md'), 'utf8');
const outputSchema = JSON.parse(fs.readFileSync(path.join(promptDirectory, 'schemas/candidates.jsonc'), 'utf8')).schema;
const MAX_CHUNK_CHARS = 8000;
const CHUNK_OVERLAP_CHARS = 1000;
const PAGE_CONTEXT_CHARS = 1200;
const withGeminiRequestSlot = createLimiter(Number(process.env.GEMINI_CONCURRENCY || 20));

function pageAnalysisConfig(options = {}) {
  const selected = options.provider || process.env.PAGE_ANALYSIS_PROVIDER || 'openai';

  // Legacy auto mode uses the shared router, including its final Google fallback.
  const provider = selected === 'auto' ? 'openai' : selected;

  if (!['auto', 'openai', 'gemini'].includes(provider)) throw new Error('PAGE_ANALYSIS_PROVIDER must be auto, openai or gemini');

  return { provider,
    apiKey: options.apiKey || (provider !== 'gemini' ? process.env.OPENAI_API_KEY : process.env.GEMINI_API_KEY),
    model: provider === 'gemini' ? options.model || process.env.GEMINI_LLM_MODEL : MODEL,
    serviceTier: options.serviceTier || process.env.PAGE_ANALYSIS_SERVICE_TIER || 'fast',
  };
}

function normalizeUsage(metadata) {
  if (!metadata) return undefined;

  const input = Number.isFinite(metadata.promptTokenCount) ? metadata.promptTokenCount : 0;
  const output = (Number.isFinite(metadata.candidatesTokenCount) ? metadata.candidatesTokenCount : 0)
    + (Number.isFinite(metadata.thoughtsTokenCount) ? metadata.thoughtsTokenCount : 0);

  return {
    input_tokens: input,
    cached_input_tokens: metadata.cachedContentTokenCount || 0,
    output_tokens: output,
    total_tokens: Number.isFinite(metadata.totalTokenCount) ? metadata.totalTokenCount : input + output,
  };
}

function inPage(passage, text) {
  const normalize = (value) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  return normalize(text).includes(normalize(passage));
}

function splitPageText(text, maxChars = MAX_CHUNK_CHARS) {
  if (text.length <= maxChars) return [text];

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);

    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end);
      if (newline > start + maxChars * 0.65) end = newline;
    }

    chunks.push(text.slice(start, end));

    if (end >= text.length) break;

    let nextStart = Math.max(start + 1, end - CHUNK_OVERLAP_CHARS);
    const nextLine = text.indexOf('\n', nextStart);

    if (nextLine !== -1 && nextLine < end) nextStart = nextLine + 1;

    start = nextStart;
  }

  return chunks;
}

function mergeUsage(left, right) {
  if (!left) return right;
  if (!right) return left;

  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    total_tokens: left.total_tokens + right.total_tokens,
    cached_input_tokens: (left.cached_input_tokens || 0) + (right.cached_input_tokens || 0),
  };
}

function candidateKey(name) {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)?.join(' ') || '';
}

function shouldAuditSegment(text, provider = 'gemini') {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const paintRows = lines.filter((line) => (provider === 'openai'
    ? /\b(?:silver|prata|gr[ae]y|cinza|white|branc[oa]|black|pret[oa]|red|vermelh[oa]|blue|azul|green|verde|yellow|amarel[oa]|gold|dourad[oa]|beige|bege|brown|marrom|metallic|pearlescent|perolizad[oa])\b/i
    : /\b(?:silver|prata|gray|grey|cinza|white|branco|black|preto|red|vermelho|blue|azul|green|verde|metallic|pearlescent|paint|colou?r|cores)\b/i).test(line));

  return text.length >= 2500 && lines.length >= 18 && paintRows.length >= 6;
}

async function analyzeChunk(page, vehicle, text, segment, segmentCount, {
  request, apiKey, model, provider, serviceTier, signal, providerState, onUsage, onDebug, references,
  auditPass = false, known = [], scheduler, timing, onWait, modelRouting, batchPages,
} = {}) {
  const sourceText = references?.sourceText || (segmentCount > 1 ? `${page.text.slice(0, PAGE_CONTEXT_CHARS)}\n${text}` : text);
  const units = references?.units;
  const segmentContext = segmentCount > 1
    ? `Document segment ${segment + 1} of ${segmentCount}. The page opening is repeated for context; extract candidates from the segment text below.\n\nPage opening context:\n${page.text.slice(0, PAGE_CONTEXT_CHARS)}\n\nSegment text:\n${text}`
    : text;

  const prompt = pagePrompt
    .replace('{{vehicle}}', JSON.stringify(vehicle, null, 2))
    .replace('{{url}}', page.url)
    .replace('{{text}}', references?.text || segmentContext)
    + (vehicle.paintFinish ? '\nPreserve candidate-specific finish descriptions and their source IDs/passages, including conflicts. Extract the full palette even when finish is missing or different; the main reviewer applies paintFinish. Never infer finish from the requested input.' : '')
    + (auditPass ? '\n\nIndependent completeness audit: inspect EVERY row and list item again. Return every missed complete paint name and any missing code, fitment or limiting evidence. Never stop at the already found names.' : '')
    + (auditPass && references ? `\nAlready found (name and evidence IDs): ${JSON.stringify(known)}. After inspecting all units, omit only candidates whose name AND all relevant evidence IDs are already present above. Return additions only, using the same schema.` : '');

  const state = providerState[provider] ||= {};
  const apiUrl = provider === 'openai' ? 'https://api.openai.com/v1/responses'
    : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = provider === 'openai' ? {
    model, service_tier: serviceTier, store: false, reasoning: { effort: 'low' }, max_output_tokens: 8192,
    instructions: referencePrompt,
    input: prompt,
    text: { verbosity: 'low', format: { type: 'json_schema', name: 'page_paint_references',
      strict: true, schema: referenceSchema } },
  } : {
    systemInstruction: { parts: [{ text: references ? referencePrompt : systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 8192,
      responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: references ? referenceSchema : outputSchema } } },
  };

  let requestCount = 0;
  let routeUsage;
  const withSlot = provider === 'openai' ? (operation) => operation() : withGeminiRequestSlot;
  const result = await withSlot(() => {
    if (provider !== 'openai' && state.error) throw new Error(state.error);

    const routedRequest = provider !== 'openai' ? requestJson : batchPages
      ? (...args) => (providerState.batcher ||= new PageBatcher()).add(...args) : requestModel;
    return routedRequest(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(provider === 'openai' ? { Authorization: `Bearer ${apiKey}` } : { 'x-goog-api-key': apiKey }),
    },
    body: JSON.stringify(body),
    }, { request, timeoutMs: provider === 'openai' ? 12000 : 8000, signal,
      routing: modelRouting,
      validateOutput: (value, route) => {
        if (![QWEN_MODEL, GEMINI_MODEL].includes(route.model) || !units) return;

        const supported = value.candidates.filter(entry => {
          const restored = restoreEvidence(entry, units, references.breakBefore);
          return entry.name.trim() && restored && restored.evidence.some(passage => inPage(entry.name, passage));
        });
        if (value.candidates.length && !supported.length) {
          throw new Error(`${route.model} returned no grounded paint names`);
        }
      },
      onUsage: details => { routeUsage = mergeUsage(routeUsage, details.usage); onUsage?.(details); },
      scheduler, timing, onWait, schedule: { kind: 'pageAnalysis' },
      onAttempt: () => requestCount++ }).catch((error) => {
      if (provider !== 'openai' && providerState && ([401, 402, 403].includes(error.status) || /quota|billing|prepayment/i.test(error.message))) {
        state.error = error.message;
      }
      throw error;
    });
  })
    .catch((cause) => {
      const error = new Error(cause.message, { cause });

      error.analysisCalls = requestCount;
      error.usage = routeUsage;
      error.code = cause.code;

      throw error;
    });

  const usage = provider === 'openai' ? routeUsage : normalizeUsage(result.usageMetadata);

  model = result._requestModel || model;
  serviceTier = result._requestServiceTier || serviceTier;

  try { if (provider !== 'openai') onUsage?.({ provider, model, serviceTier: result.service_tier || serviceTier, usage }); }
  catch { /* Diagnostics cannot discard successful extraction. */ }

  const candidate = result.candidates?.[0];

  if (provider === 'openai' ? result.status !== 'completed' : candidate?.finishReason !== 'STOP') {
    const error = new Error(`${provider} page analysis did not complete for ${page.url}: ${result.status || candidate?.finishReason || 'no candidate'}`);

    error.usage = usage;
    error.analysisCalls = requestCount;

    throw error;
  }

  const content = provider === 'openai' ? result.output?.findLast((item) => item.type === 'message')
    ?.content?.find((part) => part.type === 'output_text')
    : candidate.content?.parts?.find((part) => typeof part.text === 'string' && !part.thought);

  if (!content?.text) {
    const error = new Error(`Page analysis returned no structured output for ${page.url}`);
    error.usage = usage;
    throw error;
  }

  let parsed;

  try {
    parsed = JSON.parse(content.text);
  } catch (error) {
    error.usage = usage;
    throw error;
  }

  if (!Array.isArray(parsed.candidates)) {
    const error = new Error(`Page analysis returned invalid candidates for ${page.url}`);
    error.usage = usage;
    throw error;
  }

  if ([QWEN_MODEL, GEMINI_MODEL].includes(model)) {
    parsed.candidates = parsed.candidates.map(entry => ({ ...entry, name: formalName(entry.name) }));
  }

  try { onDebug?.({ url: page.url, segment, auditPass, provider: result._requestProvider || provider, model,
    serviceTier: result.service_tier || serviceTier, parsed }); } catch { /* Diagnostics only. */ }

  const restored = units ? parsed.candidates.map((entry) => restoreEvidence(entry, units, references.breakBefore)).filter(Boolean) : parsed.candidates;
  const candidates = restored.filter((entry) =>
    typeof entry?.name === 'string' && entry.name.trim()
    && (!isGenericPaintName(entry.name)
      || isSupportedDisplayColor(entry.name, entry.evidence, page, vehicle))
    && Array.isArray(entry.evidence) && entry.evidence.length > 0
    && entry.evidence.some((passage) =>
      typeof passage === 'string' && inPage(entry.name, passage))
    && entry.evidence.every((passage) =>
      typeof passage === 'string' && passage.trim()
      && inPage(passage, page.originalText || (units ? page.text : sourceText))));

  const validNames = new Set(candidates.map((entry) => entry.name));

  return { candidates, requests: requestCount, ...(references && {
    found: parsed.candidates.filter((entry) => validNames.has(entry.name)) }), ...(usage && { usage }) };
}

async function analyzePage(page, vehicle, options = {}) {
  const { request = fetch, signal, providerState = {}, onCandidates, onUsage, onDebug } = options;
  const config = pageAnalysisConfig(options);
  const { apiKey, model } = config;

  if (typeof page?.url !== 'string' || !page.url || typeof page.text !== 'string' || !page.text.trim()) {
    throw new Error('analyzePage requires a page URL and nonempty extracted text');
  }

  if ((!apiKey && !(config.provider === 'openai'
    && ((options.modelRouting?.openrouterApiKey ?? process.env.OPENROUTER_API_KEY)
      || (options.modelRouting?.geminiApiKey ?? process.env.GEMINI_API_KEY)))) || !model) {
    throw new Error(`Missing API key or model for ${config.provider} page analysis`);
  }

  signal?.throwIfAborted();
  if (!hasNameLeadEvidence(page.text, vehicle.paintNameLeads || vehicle.paintNameLead, vehicle.paintCodeLeads)) {
    return { candidates: [], segments: 0, requests: 0, failures: [], fallbackSegments: [],
      skippedReason: 'name_lead_absent' };
  }

  const originalPage = page;
  const structured = structuredExtraction(page.text, vehicle, page);
  const ownerManual = /\b(?:manual(?:\s+de\s+instru[cç][oõ]es|\s+d[oe]\s+propriet[aá]rio)?|owner'?s?\s+manual|user\s+manual)\b/iu
    .test(`${page.title || ''} ${page.url}`);
  const paintPalette = /\b(?:cores externas|cores dispon[ií]veis|c[oó]digos? de cores|tabela de cores|paint\s+(?:codes?|colou?rs?)|exterior\s+colou?rs?|body\s+colou?rs?|colou?r\s+chart|pinturas? dispon[ií]veis)\b/iu
    .test(page.text);
  if (options.structuredFirst === true && (!vehicle.automobileType || vehicle.automobileType === 'car')
    && page.text.length > 120000 && ownerManual
    && !paintPalette && !structured.candidates.length) {
    return { candidates: [], segments: 0, requests: 0, failures: [], fallbackSegments: [],
      skippedReason: 'owner_manual_without_paint_palette' };
  }
  if (structured.complete && options.structuredFirst === true) {
    onCandidates?.(structured.candidates);
    return { candidates: structured.candidates, segments: 0, requests: 0, failures: [], fallbackSegments: [],
      skippedReason: 'explicit_paint_rows' };
  }
  if (options.structuredFirst === true && structured.text.length < page.text.length) {
    page = { ...page, text: structured.text, originalText: originalPage.text };
    try { onCandidates?.(structured.candidates); }
    catch { /* A progress hook must not discard locally recovered evidence. */ }
  }

  if (options.sectionCache) page = { ...page, text: withoutNavigationLinks(page.text),
    originalText: originalPage.text };

  const references = config.provider !== 'gemini'
    ? referenceSegments(page.text, options.segmentChars ?? 24000,
      options.segmentUnits ?? extractionUnitLimit(page.text)) : null;
  const chunks = references ? references.map((segment) => segment.text) : splitPageText(page.text);

  // All segments are scheduled together; the shared limiter also covers concurrent runs.
  const pageLimit = createLimiter(4);
  const normalize = (value) => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
  const modelWords = normalize(vehicle.model).trim().split(/\s+/).filter(Boolean);
  const brand = normalize(vehicle.brand);
  const priority = (text) => {
    const normalized = ` ${normalize(text)} `;
    const model = modelWords.length && modelWords.every((word) => normalized.includes(` ${word} `));
    return (model ? 30 : 0) + (brand && normalized.includes(brand) ? 10 : 0)
      + (/paint|colou?r|cores|tinta/i.test(text) ? 2 : 0);
  };

  // A target model's section can be deep inside a multi-manufacturer PDF.
  // Process it first without removing or truncating any of the other sections.
  const ordered = chunks.map((chunk, index) => ({ chunk, index }))
    // Clarification already accepts only this lead or its code-linked aliases.
    // Do not send unrelated manual sections to AI. General research still
    // processes every segment, and short/uncertain fragments retain all sections.
    .filter(({ chunk, index }) => hasNameLeadEvidence(references?.[index].sourceText || chunk,
      vehicle.paintNameLeads || vehicle.paintNameLead, vehicle.paintCodeLeads))
    .sort((left, right) => priority(right.chunk) - priority(left.chunk));
  const skippedSegments = chunks.length - ordered.length;
  const extract = async (chunk, index, auditPass, known = [], passSignal = signal) => {
      try {
        if (passSignal?.aborted) throw Object.assign(new Error(passSignal.reason?.message || 'Extraction cancelled'), { analysisCalls: 0 });

        const execute = () => analyzeChunk(page, vehicle, chunk, index, chunks.length,
          { request, ...config, signal: passSignal, providerState, onUsage, onDebug,
            scheduler: options.scheduler, timing: options.timing, onWait: options.onWait,
            modelRouting: options.modelRouting, batchPages: options.batchPages,
            references: references?.[index], auditPass, known });
        const result = options.sectionCache && !auditPass
          ? await options.sectionCache.extract(vehicle, references?.[index], originalPage.text, execute,
            () => options.onWait?.({ event: 'page_section_reused', segment: index + 1 }))
          : await execute();

        try { if (!(options.deferAudits && auditPass)) onCandidates?.(result.candidates); }
        catch { /* A progress hook must not discard successful extraction. */ }

        return { ...result, index };
      } catch (error) {
        return { error, index, auditPass };
      }
  };

  if (options.deferAudits) {
    const primary = await Promise.all(ordered.map(({ chunk, index }) =>
      pageLimit(() => extract(chunk, index, false))));
    const result = summarizeResults(primary, chunks, references);
    if (skippedSegments) result.skippedSegments = skippedSegments;
    // Literal code/name rows are a cheap independent completeness check, even
    // when the primary model call succeeded but skipped a row.
    const literal = structured.candidates;
    const found = new Map(result.candidates.map(candidate => [candidateKey(candidate.name), candidate]));
    for (const candidate of literal) {
      const existing = found.get(candidateKey(candidate.name));
      if (existing) {
        existing.evidence = [...new Set([...existing.evidence, ...candidate.evidence])];
        if (candidate.nearbyYearLead) existing.nearbyYearLead = true;
      }
      else {
        result.candidates.push(candidate);
        found.set(candidateKey(candidate.name), candidate);
      }
    }
    const auditSegments = ordered.filter(({ chunk, index }) =>
      shouldAuditSegment(chunk, references ? 'openai' : 'gemini')
      && primary.some(pass => pass.index === index && !pass.error));

    if (auditSegments.length && options.auditPasses === true) {
      // Memoize so identical pages share the audit just as they share extraction.
      let pending;

      result.runAudits = auditSignal => pending ||= Promise.all(auditSegments.map(({ chunk, index }) =>
        pageLimit(() => extract(chunk, index, true,
          primary.find(pass => pass.index === index).found || [], auditSignal))))
        .then(passes => ({ ...summarizeResults(passes, chunks, references), fallbackSegments: [] }));
    }

    return result;
  }

  const work = ordered.flatMap(({ chunk, index }) => {
    const audit = shouldAuditSegment(chunk, references ? 'openai' : 'gemini');

    if (!references) return (audit ? [false, true] : [false]).map((pass) =>
      pageLimit(() => extract(chunk, index, pass)));

    return [pageLimit(async () => {
      const first = await extract(chunk, index, false);

      if (!audit) return [first];

      // Emit primary candidates immediately; audit reads the entire same segment
      // but generates only missing names/evidence instead of paying for duplicates.
      return [first, await extract(chunk, index, true, first.found || [])];
    })];
  });

  const results = (await Promise.all(work)).flat();

  const summary = summarizeResults(results, chunks, references);
  // Structured-first removes rows from model input; both orchestration modes
  // must return those preserved rows even if all residual model attempts fail.
  if (options.structuredFirst === true) {
    const found = new Map(summary.candidates.map(candidate => [candidateKey(candidate.name), candidate]));
    for (const candidate of structured.candidates) {
      const existing = found.get(candidateKey(candidate.name));
      if (existing) {
        existing.evidence = [...new Set([...existing.evidence, ...candidate.evidence])];
        if (candidate.nearbyYearLead) existing.nearbyYearLead = true;
      }
      else { summary.candidates.push(candidate); found.set(candidateKey(candidate.name), candidate); }
    }
  }
  return { ...summary, ...(skippedSegments && { skippedSegments }) };
}

function summarizeResults(results, chunks, references) {
  const mergedCandidates = new Map();
  let usage;
  let analysisCalls = 0;
  const failures = [];

  for (const result of results) {
    analysisCalls += result.requests ?? result.error?.analysisCalls ?? 1;
    usage = mergeUsage(usage, result.usage || result.error?.usage);

    if (result.error) {
      failures.push({ segment: result.index + 1, audit: result.auditPass,
        error: result.error.message, ...(result.error.code && { code: result.error.code }) });
      continue;
    }

    for (const candidate of result.candidates) {
      const key = candidateKey(candidate.name);

      if (!key) continue;

      const existing = mergedCandidates.get(key) || { name: candidate.name, evidence: [] };

      existing.evidence = [...new Set([...existing.evidence, ...candidate.evidence])];
      mergedCandidates.set(key, existing);
    }
  }

  // Preserve successful passes when another segment or its audit failed.
  const successfulSegments = new Set(results.filter((result) => !result.error).map((result) => result.index + 1));
  const fallbackSegments = [...new Set(failures.filter(failure => failure.code !== 'AI_BUDGET_LIMIT').map((failure) => failure.segment))]
    .filter((segment) => !successfulSegments.has(segment))
    .map((segment) => ({ segment, text: references?.[segment - 1].sourceText || chunks[segment - 1] }));

  return { candidates: [...mergedCandidates.values()], segments: chunks.length,
    requests: analysisCalls, failures, fallbackSegments, ...(usage && { usage }) };
}

module.exports = { analyzePage, pageAnalysisConfig, splitPageText, shouldAuditSegment };
