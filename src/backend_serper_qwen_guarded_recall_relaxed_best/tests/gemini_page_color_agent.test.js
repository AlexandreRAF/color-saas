const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzePage } = require('../gemini_page_color_agent/index');

const vehicle = { brand: 'Toyota', model: 'Corolla', manufacturingYear: 2025, country: 'Brazil' };
const page = {
  url: 'https://example.org/paint-chart',
  text: 'Corolla 2025 exterior colors\nPrata Lunar Metálico | available on Corolla\nAzul Solar | available on Corolla',
};

function response(candidates, usage) {
  return {
    ok: true,
    json: async () => ({
      usageMetadata: usage,
      candidates: [{
        finishReason: 'STOP',
        content: { parts: [{ text: JSON.stringify({ candidates }) }] },
      }],
    }),
  };
}

test('sends the requested vehicle and full page to the secondary agent', async () => {
  const candidates = [{ name: 'Prata Lunar Metálico', evidence: [
    'Prata Lunar Metálico | available on Corolla',
    'Corolla 2025 exterior colors',
  ] }];
  const result = await analyzePage(page, vehicle, {
    apiKey: 'test-key', model: 'test-model',
    request: async (url, options) => {
      assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent');
      assert.equal(options.headers['x-goog-api-key'], 'test-key');
      const body = JSON.parse(options.body);
      assert.equal(body.generationConfig.responseFormat.text.mimeType, 'APPLICATION_JSON');
      assert.deepEqual(body.generationConfig.responseFormat.text.schema.required, ['candidates']);
      assert.match(body.systemInstruction.parts[0].text, /verbatim passages/);
      assert.match(body.contents[0].parts[0].text, /"manufacturingYear": 2025/);
      assert.match(body.contents[0].parts[0].text, /Prata Lunar Metálico/);
      assert.match(body.contents[0].parts[0].text, /https:\/\/example.org\/paint-chart/);
      return response(candidates, {
        promptTokenCount: 12, candidatesTokenCount: 4, thoughtsTokenCount: 2, totalTokenCount: 18,
      });
    },
  });
  assert.deepEqual(result, {
    candidates, segments: 1, requests: 1, failures: [], fallbackSegments: [], usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18, cached_input_tokens: 0 },
  });
});

test('filters invented names, missing passages, and evidence from another page', async () => {
  const candidates = [
    { name: 'Prata Lunar Metálico', evidence: ['Prata Lunar Metálico | available on Corolla'] },
    { name: 'Prata Inventado', evidence: ['Azul Solar | available on Corolla'] },
    { name: 'Azul Solar', evidence: ['Azul Solar | available on Corolla', 'not on this page'] },
    { name: 'Azul Solar', evidence: [] },
  ];
  const result = await analyzePage(page, vehicle, {
    apiKey: 'test-key', model: 'test-model',
    request: async () => response(candidates),
  });
  assert.deepEqual(result.candidates, [candidates[0]]);
});

test('preserves a different-year paint and its separate range context for main review', async () => {
  const contextualPage = {
    url: 'https://example.org/corolla-archive',
    text: 'Corolla exterior colors 2024–2026\n2024 Azul Horizonte\nNot available on hatchback',
  };
  const candidate = { name: 'Azul Horizonte', evidence: [
    '2024 Azul Horizonte', 'Corolla exterior colors 2024–2026', 'Not available on hatchback',
  ] };
  const result = await analyzePage(contextualPage, vehicle, {
    apiKey: 'test-key', model: 'test-model', request: async () => response([candidate]),
  });
  assert.deepEqual(result.candidates, [candidate]);
});

test('does not forward broad hues as complete paint candidates', async () => {
  const broadPage = { url: page.url,
    text: 'Exterior color descriptions: Prata, Branco, Dourada. Catalog paint: Prata Lunar Metálico.' };
  const complete = { name: 'Prata Lunar Metálico', evidence: ['Prata Lunar Metálico'] };
  const result = await analyzePage(broadPage, vehicle, {
    apiKey: 'test-key', model: 'test-model', request: async () => response([
      { name: 'Prata', evidence: ['Prata'] },
      { name: 'Branco', evidence: ['Branco'] },
      { name: 'Dourada', evidence: ['Dourada'] },
      complete,
    ]),
  });
  assert.deepEqual(result.candidates, [complete]);
});

test('accepts an empty candidate list without inventing results', async () => {
  const result = await analyzePage(page, vehicle, {
    apiKey: 'test-key', model: 'test-model',
    request: async () => response([]),
  });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.failures.length, 0);
});

test('keeps a complete paint name from a replacement-parts listing with verbatim fitment evidence', async () => {
  const listing = {
    url: 'https://parts.example.org/corolla-mirror',
    text: 'Painted replacement mirror: Prata Lunar Metálico. Fits Toyota Corolla 2025. Aftermarket part.',
  };
  const candidate = {
    name: 'Prata Lunar Metálico',
    evidence: ['Painted replacement mirror: Prata Lunar Metálico.', 'Fits Toyota Corolla 2025.'],
  };
  const result = await analyzePage(listing, vehicle, {
    apiKey: 'test-key', model: 'test-model',
    request: async () => response([candidate]),
  });
  assert.deepEqual(result.candidates, [candidate]);
});

test('reports failed segments without discarding usable results', async () => {
  await assert.rejects(analyzePage({ url: page.url, text: ' ' }, vehicle), /nonempty extracted text/);
  const failed = await analyzePage(page, vehicle, {
    apiKey: 'test-key', model: 'test-model',
    request: async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'Rate limited' } }) }),
  });
  assert.match(failed.failures[0].error, /HTTP 429/);
  assert.equal(failed.fallbackSegments[0].text, page.text);
  const truncated = await analyzePage(page, vehicle, {
    apiKey: 'test-key', model: 'test-model', request: async () => ({ ok: true,
      json: async () => ({ candidates: [{ finishReason: 'MAX_TOKENS' }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 1, totalTokenCount: 9 } }),
    }),
  });
  assert.equal(truncated.usage.total_tokens, 9);
  assert.match(truncated.failures[0].error, /did not complete/);
});

test('a failed independent audit retains the successful candidate and its evidence', async () => {
  const dense = { url: page.url, text: `${page.text}\n${'Catalog context for target vehicle; inspect the entire published paint table.\n'.repeat(45)}` };
  const candidate = { name: 'Azul Solar', evidence: ['Azul Solar | available on Corolla'] };
  const result = await analyzePage(dense, vehicle, {
    apiKey: 'test-key', model: 'test-model', request: async (url, options) => {
      const prompt = JSON.parse(options.body).contents[0].parts[0].text;
      if (prompt.includes('Independent completeness audit')) {
        return { ok: false, status: 400, json: async () => ({ error: { message: 'Audit failure' } }) };
      }
      return response([candidate]);
    },
  });
  assert.deepEqual(result.candidates, [candidate]);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.fallbackSegments, []);
});

test('prioritizes the target model section deep inside a long catalog without dropping other segments', async () => {
  const longPage = { url: page.url, text: 'Unrelated equipment archive\n'.repeat(1400)
    + '\nHonda CB500X exterior colors\nCosmic Silver\n' + 'Other archived equipment\n'.repeat(500) };
  const prompts = [];
  const result = await analyzePage(longPage, { brand: 'Honda', model: 'CB500X' }, {
    apiKey: 'test-key', model: 'test-model', request: async (url, options) => {
      const text = JSON.parse(options.body).contents[0].parts[0].text;
      prompts.push(text);
      return response(text.includes('Cosmic Silver')
        ? [{ name: 'Cosmic Silver', evidence: ['Honda CB500X exterior colors', 'Cosmic Silver'] }] : []);
    },
  });
  assert.match(prompts[0], /Cosmic Silver/);
  assert.equal(result.candidates[0].name, 'Cosmic Silver');
  assert.ok(result.segments > 4);
  assert.equal(result.failures.length, 0);
});

test('a billing failure opens only the current run circuit and stops queued provider calls', async () => {
  const providerState = {};
  let requests = 0;
  const options = { apiKey: 'test', model: 'test', providerState, request: async () => {
    requests++;
    return { ok: false, status: 402, json: async () => ({ error: { message: 'Prepayment credits depleted' } }) };
  } };
  const first = await analyzePage(page, vehicle, options);
  const second = await analyzePage(page, vehicle, options);
  assert.equal(requests, 1);
  assert.equal(first.requests, 1);
  assert.equal(second.requests, 0);
  assert.match(second.failures[0].error, /credits depleted/);
});

test('successful segment candidates are delivered before a slow audit completes', async () => {
  const dense = { url: page.url, text: `${page.text}\n${'Paint catalog context for target vehicle.\n'.repeat(80)}` };
  const candidate = { name: 'Azul Solar', evidence: ['Azul Solar | available on Corolla'] };
  const delivered = [];
  let releaseAudit;
  const audit = new Promise((resolve) => { releaseAudit = resolve; });
  const pending = analyzePage(dense, vehicle, { apiKey: 'test', model: 'test',
    onCandidates: (candidates) => delivered.push(...candidates),
    request: async (url, options) => {
      if (JSON.parse(options.body).contents[0].parts[0].text.includes('Independent completeness audit')) await audit;
      return response([candidate]);
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, [candidate]);
  releaseAudit();
  assert.deepEqual((await pending).candidates, [candidate]);
});
