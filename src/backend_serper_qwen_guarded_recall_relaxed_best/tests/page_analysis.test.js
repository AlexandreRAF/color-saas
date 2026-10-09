const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzePage: runAnalyzePage, pageAnalysisConfig, splitPageText, shouldAuditSegment } = require('../page_analysis');
const { evidenceUnits, restoreEvidence, referenceSegments, extractionUnitLimit } = require('../page_evidence');
const { ModelScheduler } = require('../model_scheduler');
const analyzePage = (page, vehicle, options) => runAnalyzePage(page, vehicle, {
  ...options, scheduler: options.scheduler || new ModelScheduler(),
  modelRouting: { openrouterApiKey: '', geminiApiKey: '', ...options.modelRouting },
});

const vehicle = { brand: 'Volkswagen', model: 'Gol', country: 'Brazil' };
const page = { url: 'https://example.test/gol', text: 'Volkswagen Gol 2014–2016\nLD7X - Cinza Platinum\nNot on all trims' };
function response(candidates, extra = {}) {
  return { ok: true, json: async () => ({ status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ candidates }) }] }],
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120,
      input_tokens_details: { cached_tokens: 50 } }, ...extra }) };
}

test('both page modes retain locally parsed gallery paints when residual extraction is empty', async () => {
  const names = ['Blue Moon', 'Silver Sky Metallic', 'White Sand'];
  const text = '# Example Model Colors\n\n' + names.map(name =>
    `## [${name} Example Color](https://example.test/#)\n\n${name} 1999 Model\n\n`).join('');
  for (const deferAudits of [false, true]) {
    const observed = [];
    const result = await analyzePage({ url: 'https://example.test/model', text },
      { brand: 'Example', model: 'Model' }, { provider: 'openai', apiKey: 'test', model: 'gpt-6-luna',
        structuredFirst: true, deferAudits, onCandidates: rows => observed.push(...rows),
        request: async () => response([]) });
    assert.deepEqual(result.candidates.map(row => row.name), names);
    assert.ok(names.every(name => observed.some(row => row.name === name)));
  }
});

test('OpenAI extraction restores literal name, code, year and limiting evidence from valid IDs', async () => {
  const usage = [];
  const result = await analyzePage(page, vehicle, { provider: 'openai', apiKey: 'test', model: 'gpt-6-luna',
    onUsage: (entry) => usage.push(entry), request: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(options.headers.Authorization, 'Bearer test');
      const body = JSON.parse(options.body);
      assert.equal(body.service_tier, 'fast');
      assert.equal(body.text.format.strict, true);
      assert.match(body.input, /2\| LD7X - Cinza Platinum/);
      return response([{ name: 'Cinza Platinum', evidence_ids: [1, 2, 3] },
        { name: 'Invented Silver', evidence_ids: [2] }, { name: 'Cinza Platinum', evidence_ids: [99] }]);
    } });
  assert.deepEqual(result.candidates, [{ name: 'Cinza Platinum', evidence: [page.text] }]);
  assert.equal(result.usage.cached_input_tokens, 50);
  assert.equal(usage[0].provider, 'openai');
});

test('long source units preserve every word and reconstruct adjacent evidence', () => {
  const text = 'A'.repeat(550) + ' Prata Lunar ' + 'qualifying context '.repeat(70);
  const units = evidenceUnits(text);
  assert.equal(units.join(' '), text.trim());
  assert.equal(restoreEvidence({ name: 'Prata Lunar', evidence_ids: [0] }, units), null);
  assert.equal(restoreEvidence({ name: 'Prata Lunar', evidence_ids: [1.5] }, units), null);
  const restored = restoreEvidence({ name: 'Prata Lunar', evidence_ids: units.map((_, i) => i + 1) }, units);
  assert.equal(restored.evidence.join(' ').replace(/\s+/g, ' '), text.trim());
});

test('OpenAI audits real dense paint tables without doubling navigation-only reads', () => {
  assert.equal(shouldAuditSegment('Paint color catalog navigation\n'.repeat(120), 'openai'), false);
  const table = 'Volkswagen Gol paint chart\n' + Array.from({ length: 60 }, (_, i) =>
    `Named Silver ${i} - published factory paint for Gol`).join('\n');
  assert.equal(shouldAuditSegment(table, 'openai'), true);
  const chunks = splitPageText(table.repeat(10), 12000);
  assert.ok(chunks.length > 1);
  for (const line of table.split('\n')) assert.ok(chunks.some((chunk) => chunk.includes(line)));
});

test('source display removes URL repetition while retaining original quotations and every source unit', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `Prata Exemplo ${i} (https://example.test/${'path/'.repeat(40)}${i})`);
  const segments = referenceSegments(lines.join('\n'), 1000);
  assert.ok(segments.length > 1);
  assert.ok(segments.every((segment) => !segment.text.includes('https://')));
  const allUnits = segments.flatMap((segment) => segment.units);
  for (const line of lines) assert.ok(allUnits.includes(line));
  const later = segments[1];
  const ids = [later.breakBefore - 1, later.breakBefore];
  const restored = restoreEvidence({ name: 'Prata Exemplo', evidence_ids: ids }, later.units, later.breakBefore);
  assert.equal(restored.evidence.length, 2, 'Opening context must not be joined to a distant section as one quotation');
});

test('dense catalog segments bound source-unit count without losing rows', () => {
  const rows = Array.from({ length: 600 }, (_, i) => `Paint ${i}`);
  const segments = referenceSegments(rows.join('\n'), 24000, 96);
  assert.ok(segments.length > 1);
  assert.ok(segments.every(segment => segment.units.length <= 128));
  const retained = new Set(segments.flatMap(segment => segment.units));
  assert.ok(rows.every(row => retained.has(row)));
});

test('navigation-heavy pages do not receive the dense-palette split limit', () => {
  const navigation = Array.from({ length: 400 }, (_, i) => `Model ${i}`).join('\n');
  assert.equal(extractionUnitLimit(navigation + '\nShimmering Silver'), Infinity);
  assert.equal(extractionUnitLimit('Paint code\nPrata Example\n'.repeat(100)), 96);
});

test('a failed audit keeps primary extraction, and incomplete responses retain billed usage', async () => {
  const dense = { ...page, text: page.text + '\n' + 'Prata Lunar factory paint context for Volkswagen Gol\n'.repeat(70) };
  const result = await analyzePage(dense, vehicle, { provider: 'openai', apiKey: 'test', model: 'gpt-6-luna',
    request: async (url, options) => response([{ name: 'Cinza Platinum', evidence_ids: [1, 2, 3] }],
      JSON.parse(options.body).input.includes('Independent completeness audit') ? { status: 'incomplete' } : {}) });
  assert.equal(result.candidates[0].name, 'Cinza Platinum');
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.fallbackSegments, []);
  assert.equal(result.usage.total_tokens, 360, 'Primary plus both failed direct-provider routes are billed');
});

test('the second full-text pass adds missed names and evidence without regenerating the first palette', async () => {
  const dense = { ...page, text: page.text + '\nPrata Lunar\n' + 'Prata Example factory paint context for Volkswagen Gol\n'.repeat(70) };
  const result = await analyzePage(dense, vehicle, { provider: 'openai', apiKey: 'test', model: 'gpt-6-luna',
    request: async (url, options) => {
      const input = JSON.parse(options.body).input;
      if (input.includes('Independent completeness audit')) {
        assert.match(input, /Already found.*Cinza Platinum/);
        assert.match(input, /Return additions only/);
        assert.match(input, /4\| Prata Lunar/);
        return response([{ name: 'Prata Lunar', evidence_ids: [1, 4] },
          { name: 'Cinza Platinum', evidence_ids: [2, 3] }]);
      }
      return response([{ name: 'Cinza Platinum', evidence_ids: [1, 2] }]);
    } });
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates[0].evidence.some((passage) => passage.includes('Not on all trims')));
  assert.equal(result.candidates[1].name, 'Prata Lunar');
});

test('deferred audits wait for the caller, reuse their result and bill only audit additions', async () => {
  const dense = { ...page, text: page.text + '\nPrata Lunar\n' + 'Prata Example factory paint context for Volkswagen Gol\n'.repeat(70) };
  const controller = new AbortController();
  let calls = 0;
  const result = await analyzePage(dense, vehicle, { provider: 'openai', apiKey: 'test', deferAudits: true, auditPasses: true,
    signal: controller.signal, request: async (_url, options) => {
      calls++;
      const audit = JSON.parse(options.body).input.includes('Independent completeness audit');
      return response(audit ? [{ name: 'Prata Lunar', evidence_ids: [1, 4] }]
        : [{ name: 'Cinza Platinum', evidence_ids: [1, 2, 3] }]);
    } });
  assert.equal(calls, 1);
  assert.equal(result.requests, 1);
  assert.deepEqual(result.candidates.map(candidate => candidate.name), ['Cinza Platinum']);
  controller.abort(new Error('Primary phase ended'));
  const auditSignal = new AbortController().signal;
  const [audit, same] = await Promise.all([result.runAudits(auditSignal), result.runAudits(auditSignal)]);
  assert.equal(calls, 2);
  assert.equal(audit, same);
  assert.equal(audit.requests, 1);
  assert.equal(audit.usage.total_tokens, 120);
  assert.deepEqual(audit.candidates.map(candidate => candidate.name), ['Prata Lunar']);
});

test('failed primary segments are reserved for recovery instead of competing with audits', async () => {
  const dense = { ...page, text: page.text + '\n' + 'Prata Example factory paint context for Volkswagen Gol\n'.repeat(70) };
  const result = await analyzePage(dense, vehicle, { provider: 'openai', apiKey: 'test', deferAudits: true,
    request: async () => ({ ok: false, status: 400, json: async () => ({ error: 'Bad request' }) }) });
  assert.equal(result.runAudits, undefined);
  assert.equal(result.failures.length, 1);
  assert.equal(result.fallbackSegments.length, 1);
});

test('legacy auto mode uses only OpenAI even when Gemini credentials are present', async () => {
  const ledger = [];
  const result = await analyzePage(page, vehicle, { provider: 'auto', apiKey: 'openai-test',
    geminiApiKey: 'gemini-test', geminiModel: 'gemini-3.5-flash-lite',
    onUsage: (entry) => ledger.push(entry), request: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(options.headers.Authorization, 'Bearer openai-test');
      const body = JSON.parse(options.body);
      assert.match(body.instructions, /evidence_ids/);
      assert.match(body.input, /2\| LD7X - Cinza Platinum/);
      return response([{ name: 'Cinza Platinum', evidence_ids: [1, 2, 3] }]);
    } });
  assert.deepEqual(result.candidates, [{ name: 'Cinza Platinum', evidence: [page.text] }]);
  assert.equal(ledger[0].provider, 'openai');
});

test('default page extraction selects OpenAI and validates provider overrides', () => {
  const original = process.env.PAGE_ANALYSIS_PROVIDER;
  try {
    delete process.env.PAGE_ANALYSIS_PROVIDER;
    assert.equal(pageAnalysisConfig().provider, 'openai');
    assert.equal(pageAnalysisConfig().model, 'gpt-6-luna');
    assert.throws(() => pageAnalysisConfig({ provider: 'invalid' }), /PAGE_ANALYSIS_PROVIDER/);
  } finally {
    if (original === undefined) delete process.env.PAGE_ANALYSIS_PROVIDER;
    else process.env.PAGE_ANALYSIS_PROVIDER = original;
  }
});

test('explicitly disabled Gemini fallback stays disabled in legacy auto mode', async () => {
  let calls = 0;
  const result = await analyzePage(page, vehicle, { provider: 'auto', apiKey: 'test',
    geminiApiKey: 'gemini-test', geminiModel: 'gemini-3.5-flash-lite',
    request: async (url) => {
      calls++;
      assert.equal(url, 'https://api.openai.com/v1/responses');
      return { ok: false, status: 402, json: async () => ({ error: { message: 'Credits depleted' } }) };
    } });
  assert.equal(calls, 1);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.fallbackSegments, [{ segment: 1, text: page.text }]);
});

test('dense tables and their audits prefer GPT-6 Luna', async () => {
  const dense = { ...page, text: page.text + '\n' + 'Prata Lunar factory paint for Volkswagen Gol\n'.repeat(80) };
    const ledger = [];
    const result = await analyzePage(dense, vehicle, { provider: 'openai', apiKey: 'test',
      model: 'gpt-6-luna', secondaryModel: 'gpt-5.6-luna',
      onUsage: (entry) => ledger.push(entry), request: async (url, options) => {
        assert.equal(url, 'https://api.openai.com/v1/responses');
        const body = JSON.parse(options.body);
        assert.equal(body.model, 'gpt-6-luna');
        assert.equal(body.service_tier, 'fast');
        assert.match(body.input, /2\| LD7X - Cinza Platinum/);
        return response([{ name: 'Cinza Platinum', evidence_ids: [1, 2, 3] }]);
      } });
    assert.deepEqual(result.candidates, [{ name: 'Cinza Platinum', evidence: [page.text] }]);
    assert.equal(result.requests, 2, 'Retains the independent completeness audit');
    assert.ok(ledger.every((entry) => entry.provider === 'openai' && entry.model === 'gpt-6-luna'));
});

test('simple pages also start with GPT-6 Luna Fast', async () => {
  const result = await analyzePage(page, vehicle, { provider: 'openai', apiKey: 'test',
    model: 'gpt-6-luna', secondaryModel: 'gpt-5.6-luna',
    request: async (url, options) => {
      assert.equal(JSON.parse(options.body).model, 'gpt-6-luna');
      assert.equal(JSON.parse(options.body).service_tier, 'fast');
      return response([]);
    } });
  assert.equal(result.failures.length, 0);
});

test('dense overflow preserves audits and attributes usage to the actual secondary model', async () => {
  const scheduler = new ModelScheduler({ limits: {
    'gpt-6-luna': { tokensPerMinute: 100000, concurrency: 1 },
    'gpt-5.6-luna': { tokensPerMinute: 100000, concurrency: 2 },
  } });
  const busy = await scheduler.acquire({ choices: [{ model: 'gpt-6-luna' }], tokens: 1 });
  const ledger = [];
  try {
    const result = await analyzePage({ ...page, text: page.text + '\n'
      + 'Prata Lunar factory paint for Volkswagen Gol\n'.repeat(80) }, vehicle, {
      provider: 'openai', apiKey: 'test', scheduler, onUsage: (entry) => ledger.push(entry),
      request: async (url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(body.model, 'gpt-5.6-luna');
        assert.equal(body.service_tier, 'default');
        return response([{ name: 'Cinza Platinum', evidence_ids: [1, 2, 3] }]);
      },
    });
    assert.equal(result.failures.length, 0);
    assert.equal(result.requests, 2);
    assert.equal(result.candidates[0].name, 'Cinza Platinum');
    assert.ok(ledger.every((entry) => entry.model === 'gpt-5.6-luna' && entry.serviceTier === 'default'));
  } finally { busy.complete({ ok: true }); }
});

test('old model environment overrides cannot select GPT-5.6 Luna', () => {
  const original = process.env.PAGE_ANALYSIS_MODEL;
  try {
    process.env.PAGE_ANALYSIS_MODEL = 'gpt-5.6-luna';
    assert.equal(pageAnalysisConfig({ provider: 'openai' }).model, 'gpt-6-luna');
  } finally {
    if (original === undefined) delete process.env.PAGE_ANALYSIS_MODEL;
    else process.env.PAGE_ANALYSIS_MODEL = original;
  }
});
