const test = require('node:test');
const assert = require('node:assert/strict');
const { AgenticLoop } = require('../ai');
const { candidateInventory, reviewedColors, reviewSchema } = require('../candidate_inventory');
const { selectSources, seedQueries, sparseResearchQueries } = require('../research_plan');
const { createLimiter, requestJson } = require('../runtime');
const { ModelScheduler, DEFAULT_LIMITS } = require('../model_scheduler');
const { DEFAULT_TARGET_TIME_MS, DEFAULT_MAX_TIME_MS, pipelineDeadlines } = require('../research_deadlines');
const { RunTiming } = require('../run_timing');

test('the final page admission check rejects a conflicting make even outside normal discovery', async () => {
  const events = [];
  const loop = new AgenticLoop({ debugDirectory: false, onProgress: event => events.push(event) });
  await loop.readSources([{ url: 'https://paint.example/paint-ford-puma',
    title: 'Ford Puma paint colours', nameResearch: true }],
  { brand: 'Puma', model: 'Puma GTS' }, new AbortController().signal);

  assert.equal(loop.pages.length, 0);
  assert.ok(events.some(event => event.event === 'source_skip_conflicting_make'));
});

function modelResponse(value) {
  return { ok: true, json: async () => ({ status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }) };
}

function fixture(overrides = {}) {
  let searchRound = 0;
  const events = [];
  const loop = new AgenticLoop({ maxPageFetches: 35, batchReviews: false, earlyReviews: false, targetAiCostUsd: 1, catalogLookupFn: async () => ({ catalogs_queried: ['lazzumix', 'basf', 'basf_models'], candidates: [] }), verification: false, searchProvider: 'serper', debugDirectory: false, maxNameSearches: 0, outputFormat: 'expanded',
    modelRouting: { openrouterApiKey: 'router-test', capacityWaitMs: 1000, candidateReviewQwen: false },
    scheduler: new ModelScheduler({ limits: { 'gpt-6-luna': {
      tokensPerMinute: 10000000, requestsPerMinute: 10000,
    } } }),
    nameLookupFn: async () => [],
    onProgress: (event) => events.push(event),
    browseFn: async (queries, options) => queries.map((query) => {
      if (options.provider !== 'openserp') options.onEngineRequest?.(options.provider);
      return { query,
      results: Array.from({ length: 10 }, (_, i) => ({
        url: `https://source${i}.example/${searchRound++}/paint-chart`, title: `${query} paint chart`, snippet: 'Exterior paints',
      })) }; }),
    fetchFn: async ([url]) => [{ url, status: 'ok', text: 'Model paint chart: Shimmering Silver; Quicksilver; Silver' }],
    analyzePageFn: async () => ({ candidates: [
      { name: 'Shimmering Silver', evidence: ['Shimmering Silver'] },
      { name: 'Quicksilver', evidence: ['Quicksilver'] },
      { name: 'Silver', evidence: ['Silver'] },
    ] }),
    request: async (url, options) => {
      const body = JSON.parse(options.body);
      const input = JSON.parse(body.input);
      if (body.text.format.name === 'research_plan') {
        return modelResponse({ queries: ['independent factory catalog', 'regional generation paints'],
          preferred_urls: [], rationale: 'Cross sources' });
      }
      // Dynamic required IDs must exactly cover every extracted non-generic candidate.
      assert.deepEqual(body.text.format.schema.required, input.candidates.map((candidate) => candidate.id));
      return modelResponse(Object.fromEntries(input.candidates.map((candidate) => [candidate.id, {
        action: 'include', name: null, confidence: 'low',
        ...(candidate.name_check && { name_status: 'complete' }),
        source_ids: candidate.sources.map((source) => source.page_id), reason: 'Modelo documentado; mercado incerto.',
      }])));
    },
    databaseCodeAgentFn: async (response) => ({ ...response,
      colors: response.colors.map((color) => ({ ...color, universal_code: 'DB-ONLY' })) }),
    ...overrides,
  });
  return { loop, events };
}

test('model request counters count actual attempts and keep snapshots independent', () => {
  const { loop } = fixture();
  loop.log('model_route_start', { kind: 'pageAnalysis' });
  loop.log('model_route_skipped', { kind: 'pageAnalysis' });
  const first = loop.retrievalSummary();
  loop.log('model_route_start', { kind: 'candidateReview' });
  assert.equal(first.modelRequests.total, 1);
  assert.deepEqual(loop.retrievalSummary().modelRequests,
    { total: 2, byStage: { pageAnalysis: 1, candidateReview: 1 } });
});

test('concurrent or later instance reuse cannot cancel or clean up the original run', async () => {
  const { loop, events } = fixture();
  const first = loop.loop({ brand: 'Hyundai', model: 'ix35', country: 'Brazil' });
  const signal = loop.timing.signal;

  await assert.rejects(loop.loop({ model: 'Other vehicle' }), { code: 'AGENT_ALREADY_USED' });
  assert.equal(signal.aborted, false);
  assert.equal(events.some(event => event.event === 'run_error'), false);

  const result = await first;
  assert.equal(result.error, undefined);
  assert.equal(result.colors.length, 2);
  assert.equal(result.fallback, undefined);
  const eventCount = events.length;
  await assert.rejects(loop.loop({ model: 'Third vehicle' }), { code: 'AGENT_ALREADY_USED' });
  assert.equal(events.length, eventCount);
});

test('rejected asynchronous progress observers cannot crash a vehicle run', async () => {
  const { loop } = fixture({ onProgress: async () => { throw new Error('Logging unavailable'); } });
  const result = await loop.loop({ brand: 'Hyundai', model: 'ix35', country: 'Brazil' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.error, undefined);
  assert.equal(result.colors.length, 2);
});

test('seven simultaneous production requests admit one and spend nothing on rejected runs', async () => {
  const scheduler = new ModelScheduler({ limits: { ...DEFAULT_LIMITS,
    'network:run': { ...DEFAULT_LIMITS['network:run'], concurrency: 1 } } });
  const runs = Array.from({ length: 7 }, () => fixture({ production: true, scheduler, admissionTimeoutMs: 10 }));
  for (const { loop } of runs) {
    const browse = loop.browse;
    loop.browse = async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return browse(...args);
    };
  }
  const results = await Promise.all(runs.map(({ loop }) => loop.loop({ brand: 'Hyundai', model: 'ix35' })));
  assert.equal(results.filter(result => !result.error).length, 1);
  const rejected = results.filter(result => result.error);
  assert.equal(rejected.length, 6);
  for (const result of rejected) {
    assert.equal(result.errorDetails.code, 'RUN_CAPACITY_BUSY');
    assert.equal(result.errorDetails.retryable, true);
    assert.equal(result.browserUses.total, 0);
    assert.equal(result.modelRequests.total, 0);
    assert.equal(result.completion.status, 'failed');
  }
  assert.equal(scheduler.state('network:run').active, 0);
});

test('the default target is soft with a 100-second hard maximum and bounded stages', async () => {
  const { loop, events } = fixture();
  const result = await loop.loop({ brand: 'Hyundai', model: 'ix35', country: 'Brazil' });
  assert.equal(result.error, undefined);
  assert.equal(DEFAULT_TARGET_TIME_MS, 60000);
  assert.equal(result.timing.targetTimeMs, DEFAULT_TARGET_TIME_MS);
  assert.equal(result.timing.deadlineMode, 'soft');
  assert.equal(result.timing.maxTimeMs, DEFAULT_MAX_TIME_MS);
  assert.equal(events.find(event => event.event === 'run_start').maxTimeMs, DEFAULT_MAX_TIME_MS);
  assert.deepEqual(events.find(event => event.event === 'run_start').deadlines,
    pipelineDeadlines({ deadlineAt: at => at }, DEFAULT_TARGET_TIME_MS, DEFAULT_MAX_TIME_MS).cutoffs);
});

test('a passed soft target reports overtime without cancelling mandatory work', () => {
  let now = 0;
  const timing = new RunTiming({ targetTimeMs: DEFAULT_TARGET_TIME_MS, softDeadlines: true, now: () => now });
  try {
    const requiredWork = timing.deadline(DEFAULT_TARGET_TIME_MS);
    now = DEFAULT_TARGET_TIME_MS + 2000;
    assert.equal(timing.remainingTargetMs(requiredWork), 0);
    assert.equal(timing.remainingMs(requiredWork), Infinity);
    assert.equal(requiredWork.aborted, false);
    assert.equal(timing.signal.aborted, false);
    assert.equal(timing.summary().overTargetMs, 2000);
  } finally { timing.close(); }
});

test('only unfinished candidate reviews retry after the first wave settles', async () => {
  const { loop, events } = fixture();
  const original = loop.reviewCandidate.bind(loop);
  const calls = new Map();
  loop.reviewCandidate = async (candidate, ...args) => {
    const count = (calls.get(candidate.name) || 0) + 1;
    calls.set(candidate.name, count);
    if (candidate.name === 'Quicksilver' && count === 1) throw new Error('Temporary provider failure');
    return original(candidate, ...args);
  };

  const result = await loop.loop({ brand: 'Hyundai', model: 'ix35', country: 'Brazil' });

  assert.equal(result.error, undefined);
  assert.deepEqual(result.research.unreviewedCandidates, []);
  assert.equal(calls.get('Quicksilver'), 2);
  assert.equal(calls.get('Shimmering Silver'), 1);
  assert.equal(events.find(event => event.event === 'completion_review').attempted, 1);
  assert.ok(!events.some(event => event.event === 'candidate_review_retry'));
});

test('every individual review receives all three catalog lookups and can request an extractor follow-up', async () => {
  const lookedUp = new Set();
  let asked = false, answered = false;
  const { loop, events } = fixture({
    catalogLookupFn: async input => {
      if (input.operation === 'model_palette') return { catalogs_queried: ['basf_models'], records: [] };
      lookedUp.add(input.name);
      return { catalogs_queried: ['lazzumix', 'basf', 'basf_models'], candidates: [] };
    },
    extractDetailsFn: async (candidate, request) => {
      assert.equal(request.question, 'Confirm finish from the detailed row');
      answered = true;
      return { candidate: { ...candidate, sources: candidate.sources.map(source => ({ ...source,
        evidence: [...source.evidence, `${candidate.name}: acabamento metálico`] })) }, passages: 1 };
    },
  });
  const ordinary = loop.options.request;
  loop.options.request = async (url, options) => {
    const body = JSON.parse(options.body), input = JSON.parse(body.input);
    if (body.text.format.name.startsWith('research_review')) {
      assert.equal(input.candidates.length, 1);
      const candidate = input.candidates[0];
      assert.ok(lookedUp.has(candidate.name));
      assert.deepEqual(candidate.catalog_check.catalogs_queried, ['lazzumix', 'basf', 'basf_models']);
      if (!asked) {
        asked = true;
        return modelResponse({ [candidate.id]: {
          decision: { action: 'include', name: null, confidence: 'low', source_ids: [candidate.sources[0].page_id], reason: 'Modelo documentado' },
          request_details: { question: 'Confirm finish from the detailed row', page_ids: [candidate.sources[0].page_id] },
        } });
      }
      if (body.text.format.name.endsWith('_followup')) {
        assert.equal(input.extractor_reply.addedPassages, 1);
        assert.ok(Object.values(input.evidence).some(text => text.includes('acabamento metálico')));
      }
    }
    return ordinary(url, options);
  };
  const result = await loop.loop({ brand: 'Hyundai', model: 'ix35', country: 'Brazil' });
  assert.equal(result.error, undefined);
  assert.ok(asked && answered);
  assert.equal(result.colors.length, 2);
  assert.ok(events.some(event => event.event === 'extractor_detail_reply'));
});

test('batched transport retains separate grounded candidate decisions and mandatory catalogs', async () => {
  let batchCalls = 0;
  const { loop } = fixture({ batchReviews: true });
  const ordinary = loop.options.request;
  loop.options.request = async (url, options) => {
    const body = JSON.parse(options.body);
    if (!body.text.format.name.startsWith('research_review_batch_')) return ordinary(url, options);
    batchCalls++;
    const input = JSON.parse(body.input);
    return modelResponse(Object.fromEntries(input.requests.map(request => {
      const candidate = request.candidates[0];
      assert.deepEqual(candidate.catalog_check.catalogs_queried, ['lazzumix', 'basf', 'basf_models']);
      return [request.id, { decision: 'include', catalog_refs: [], name: null, confidence: 'low',
        source_ids: candidate.sources.map(source => source.page_id), reason: 'Cor documentada para o modelo.',
        name_status: 'complete', detail: null }];
    })));
  };
  const result = await loop.loop({ brand: 'Hyundai', model: 'ix35', country: 'Brazil' });
  assert.equal(result.error, undefined);
  assert.equal(result.colors.length, 2);
  assert.equal(batchCalls, 1);
  assert.equal(loop.reviewBatcher.concurrency, 5);
});

test('production Qwen chat reviews use individual flat decisions and an extractor reply', async () => {
  let requests = 0, followups = 0;
  const { loop } = fixture({ batchReviews: false, modelRouting: { openrouterApiKey: 'router-test', candidateReviewQwen: true },
    extractDetailsFn: async candidate => ({ candidate, passages: 0 }),
  });
  const ordinary = loop.options.request;
  loop.options.request = async (url, options) => {
    const body = JSON.parse(options.body);
    if (!body.messages) return ordinary(url, options);
    assert.equal(body.model, 'qwen/qwen3.5-flash-02-23');
    const input = JSON.parse(body.messages[1].content);
    const schema = body.response_format.json_schema;
    assert.ok(schema.schema.properties.action);
    assert.equal(input.candidates.length, 1);
    assert.deepEqual(input.candidates[0].catalog_check.catalogs_queried, ['lazzumix', 'basf', 'basf_models']);
    const followup = schema.name.endsWith('_followup');
    if (followup) { followups++; assert.equal(input.extractor_reply.addedPassages, 0); }
    const ask = requests++ === 0;
    const answer = { catalog_ids: [], action: 'include', name: null, confidence: 'low',
      source_ids: [input.candidates[0].sources[0].page_id], reason: 'Documented paint name',
      name_status: 'complete', exclusion: 'none', finish_status: 'unknown', finish_evidence_ids: [],
      detail_question: ask ? 'Confirm model heading' : '',
      detail_page_ids: ask ? [input.candidates[0].sources[0].page_id] : [] };
    return { ok: true, status: 200, json: async () => ({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }) };
  };
  const result = await loop.loop({ brand: 'Hyundai', model: 'ix35', country: 'Brazil' });
  assert.equal(result.error, undefined);
  assert.equal(result.colors.length, 2);
  assert.equal(requests, 3);
  assert.equal(followups, 1);
});

test('candidate reviews wait for stable evidence and never start speculative early calls', async () => {
  let reads = 0, complete = 0;
  const { loop, events } = fixture({ earlyReviews: true, maxPageFetches: 2,
    fetchFn: async ([url]) => [{ url, status: 'ok', text: `${url}: Shimmering Silver; Quicksilver` }],
    analyzePageFn: async () => {
      const first = reads++ === 0;
      await new Promise(resolve => setTimeout(resolve, first ? 1 : 20));
      complete++;
      const name = first ? 'Shimmering Silver' : 'Quicksilver';
      return { candidates: [{ name, evidence: [name] }] };
    },
  });
  const request = loop.options.request;
  loop.options.request = (url, options) => {
    if (JSON.parse(options.body).text.format.name.startsWith('research_review')) assert.equal(complete, 2);
    return request(url, options);
  };
  const result = await loop.loop({ brand: 'Hyundai', model: 'ix35', country: 'Brazil' });
  assert.equal(result.error, undefined);
  assert.ok(!events.some(event => event.stage?.startsWith('research_review_early_')));
  assert.equal(result.colors.length, 2);
});

test('semantic review errors use the existing fallback instead of silently losing the candidate', async () => {
  let invalidCalls = 0;
  const { loop, events } = fixture({ maxPageFetches: 1,
    modelRouting: { openrouterApiKey: 'router-test', candidateReviewQwen: true },
    analyzePageFn: async () => ({ candidates: [{ name: 'Shimmering Silver', evidence: ['Shimmering Silver'] }] }),
  });
  const ordinary = loop.options.request;
  loop.options.request = async (url, options) => {
    if (!url.includes('/chat/')) {
      const body = JSON.parse(options.body);
      if (body.text.format.name.startsWith('research_review')) {
        const input = JSON.parse(body.input);
        return modelResponse({ catalog_ids: [], action: 'include', name: null, confidence: 'low',
          source_ids: input.candidates[0].sources.map(source => source.page_id), reason: 'Documented',
          name_status: 'complete', exclusion: 'none', finish_status: 'unknown', finish_evidence_ids: [],
          detail_question: '', detail_page_ids: [] });
      }
      return ordinary(url, options);
    }
    invalidCalls++;
    return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: {
      content: JSON.stringify({ catalog_ids: [], action: 'exclude', name: null, confidence: 'low', source_ids: [],
        reason: 'Unsupported exclusion', name_status: 'complete', exclusion: 'none',
        finish_status: 'unknown', finish_evidence_ids: [], detail_question: '', detail_page_ids: [] }),
    } }] }) };
  };
  const result = await loop.loop({ brand: 'Hyundai', model: 'ix35', country: 'Brazil' });
  assert.equal(result.error, undefined);
  assert.equal(invalidCalls, 1);
  assert.equal(result.colors[0].name, 'Shimmering Silver');
  assert.ok(events.some(event => event.event === 'model_route_fallback' && /supported category/.test(event.reason)));
});

test('requested hues receive the first review slot under constrained concurrency', async () => {
  let silverFinished = false;
  const { loop } = fixture({ reviewConcurrency: 1, maxPageFetches: 1, analyzePageFn: async () => ({ candidates: [
    { name: 'Blue Ocean', evidence: ['Blue Ocean'] },
    { name: 'Shimmering Silver', evidence: ['Shimmering Silver'] },
  ] }) });
  const ordinary = loop.options.request;
  loop.options.request = async (url, options) => {
    const body = JSON.parse(options.body);
    if (!body.text.format.name.startsWith('research_review')) return ordinary(url, options);
    const candidate = JSON.parse(body.input).candidates[0];
    if (candidate.name === 'Blue Ocean') {
      assert.ok(silverFinished);
      return modelResponse({ [candidate.id]: 'Cor azul documentada, incompatível com prata.' });
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    silverFinished = true;
    return ordinary(url, options);
  };
  const result = await loop.loop({ brand: 'Hyundai', model: 'ix35', country: 'Brazil', predominantColor: 'prata' });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.colors.map(color => color.name), ['Shimmering Silver']);
});

test('irrelevant search results report discovery failure without spending on a planner', async () => {
  const { loop } = fixture({ browseFn: async queries => queries.map(query => ({ query,
    results: [{ title: 'Chevrolet dealer financing', url: 'https://dealer.test/financing', snippet: 'Buy a car' }],
  })) });
  const result = await loop.loop({ brand: 'Chevrolet', model: 'Cruze', country: 'Brazil' });
  assert.equal(result.errorDetails.code, 'SEARCH_NO_RELEVANT_SOURCES');
  assert.equal(loop.modelCalls.main, 0);
  assert.equal(result.pageFetchAttempts, 0);
});

test('failed source fetches are distinguished from missing paint candidates', async () => {
  const { loop } = fixture({ fetchFn: async ([url]) => [{ url, status: 'error', text: '', error: 'Source unavailable' }] });
  const result = await loop.loop({ brand: 'Hyundai', model: 'ix35', country: 'Brazil' });
  assert.equal(result.errorDetails.code, 'RESEARCH_FETCH_FAILED');
  assert.equal(result.errorDetails.stage, 'fetch');
  assert.ok(result.fetchErrors > 0);
});

test('literal labelled rows survive failed primary extraction and failed model recovery', async () => {
  const row = 'COLOR CODE N3S - Shimmering Silver Metallic';
  const { loop, events } = fixture({ maxPageFetches: 1,
    fetchFn: async ([url]) => [{ url, status: 'ok', text: `Hyundai ix35 paint chart\n${row}` }],
    analyzePageFn: async () => ({ candidates: [], failures: [{ error: 'Timeout' }],
      fallbackSegments: [{ segment: 1, text: row }] }),
  });
  const ordinary = loop.options.request;
  loop.options.request = async (url, options) => {
    if (JSON.parse(options.body).text?.format?.name?.startsWith('recover_')) {
      return { ok: false, status: 400, json: async () => ({ error: { message: 'Recovery unavailable' } }) };
    }
    return ordinary(url, options);
  };
  const result = await loop.loop({ brand: 'Hyundai', model: 'ix35', country: 'Brazil' });
  assert.equal(result.error, undefined);
  assert.equal(result.colors[0].name, 'Shimmering Silver');
  assert.ok(events.some(event => event.event === 'page_literal_recovery'));
  assert.ok(events.some(event => event.event === 'catalog_candidate_checked'));
});

test('a page recovery budget failure leaves remaining segments without repeated paid attempts', async () => {
  const { loop, events } = fixture();
  const page = { id: 'P1', url: 'https://chart.test/', text: 'Vehicle colors unavailable',
    candidates: [], fallbackSegments: Array.from({ length: 12 }, (_, index) => ({
      segment: index + 1, text: `Unstructured section ${index + 1}`,
    })) };
  let attempts = 0;
  loop.recoveryLimit = createLimiter(2);
  loop.mainAgent = async () => {
    attempts++;
    throw Object.assign(new Error('AI cost target reached'), { code: 'AI_BUDGET_LIMIT',
      details: { pageSpentUsd: 0.024, pageLimitUsd: 0.024 } });
  };

  await loop.recoverPage(page, { brand: 'Hyundai', model: 'ix35' }, new AbortController().signal);
  assert.equal(attempts, 1);
  assert.equal(page.fallbackSegments.length, 12);
  assert.ok(events.some(event => event.event === 'page_recovery_budget_exhausted'));

  const second = { ...page, id: 'P2', candidates: [], fallbackSegments: [...page.fallbackSegments] };
  await loop.recoverPage(second, { brand: 'Hyundai', model: 'ix35' }, new AbortController().signal);
  assert.equal(attempts, 1);
});

test('smaller recovery segments are tried before an oversized budget rejection', async () => {
  const { loop } = fixture();
  const page = { id: 'P1', url: 'https://chart.test/', text: 'Hyundai ix35: Hyper Silver',
    candidates: [], fallbackSegments: [{ segment: 1, text: 'Large unreadable section '.repeat(20) },
      { segment: 2, text: 'Hyundai ix35: Hyper Silver' }] };
  loop.recoveryLimit = createLimiter(2);
  const stages = [];
  loop.mainAgent = async stage => {
    stages.push(stage);
    if (stage.endsWith('_1')) throw Object.assign(new Error('Large segment cannot fit'), {
      code: 'AI_BUDGET_LIMIT', details: { pageSpentUsd: 0.02, pageLimitUsd: 0.024,
        spentUsd: 0.04, stageLimitUsd: 0.06 },
    });
    return { candidates: [{ name: 'Hyper Silver', evidence: ['Hyundai ix35: Hyper Silver'] }] };
  };

  await loop.recoverPage(page, { brand: 'Hyundai', model: 'ix35' }, new AbortController().signal);
  assert.deepEqual(stages, ['recover_P1_2', 'recover_P1_1']);
  assert.ok(page.candidates.some(candidate => candidate.name === 'Hyper Silver'));
});

test('source-rich recovery attempts only its bounded number of segments', async () => {
  const { loop } = fixture();
  const page = { id: 'P1', url: 'https://chart.test/', text: 'Model paints', candidates: [],
    fallbackSegments: [1, 2, 3].map(segment => ({ segment, text: `Model paint ${segment}` })) };
  const stages = [];
  loop.recoveryLimit = createLimiter(2);
  loop.mainAgent = async stage => {
    stages.push(stage);
    return { candidates: [] };
  };

  await loop.recoverPage(page, { brand: 'Maker', model: 'Model' },
    new AbortController().signal, { maxSegments: 2 });
  assert.deepEqual(stages, ['recover_P1_1', 'recover_P1_2']);
  assert.equal(page.fallbackSegments.length, 1);
});

test('sparse catalog searches overlap planning and keep the initial search unchanged', async () => {
  const vehicle = { brand: 'Puma', model: 'Puma GTS', manufacturingYear: 1978, country: 'Brazil' };
  const queries = [];
  let checked = false;
  const { loop } = fixture({ analyzePageFn: async () => ({ candidates: [] }) });
  const browse = loop.browse, request = loop.options.request;
  loop.browse = (batch, options) => { queries.push(...batch); return browse(batch, options); };
  loop.options.request = (url, options) => {
    const body = JSON.parse(options.body);
    if (body.text.format.name === 'research_plan') {
      checked = true;
      assert.deepEqual(queries.slice(0, 4), seedQueries(vehicle));
      assert.ok(sparseResearchQueries(vehicle, []).every(query => queries.includes(query)));
    }
    return request(url, options);
  };
  await loop.loop(vehicle);
  assert.equal(checked, true);
});

test('Puma GTS 1978 retains source-linked Vermelho Monte Carlo from nearby years without inventing a donor code', async () => {
  const passage = 'Puma GTS: Tintas acrílicas Glasurit: Vermelho Monte Carlo (1981).';
  let reviewed = false;
  const { loop } = fixture({
    fetchFn: async ([url]) => [{ url, status: 'ok', text: passage }],
    analyzePageFn: async () => ({ candidates: [{ name: 'Vermelho Monte Carlo', evidence: [passage] }] }),
    databaseCodeAgentFn: async palette => ({ ...palette, colors: palette.colors.map(color => ({ ...color, universal_code: '', code_candidates: [] })) }),
    request: async (_url, options) => {
      const body = JSON.parse(options.body), input = JSON.parse(body.input);
      if (body.text.format.name === 'research_plan') return modelResponse({ queries: [], preferred_urls: [], rationale: '' });
      reviewed = true;
      assert.match(body.instructions, /donor|another brand/);
      assert.match(body.instructions, /Nearby-year/);
      assert.ok(Object.values(input.evidence).some(text => text.includes('Monte Carlo (1981)')));
      const candidate = input.candidates[0];
      assert.deepEqual(candidate.catalog_check.catalogs_queried, ['lazzumix', 'basf', 'basf_models']);
      return modelResponse({ [candidate.id]: { action: 'include', name: null, confidence: 'low',
        source_ids: [candidate.sources[0].page_id], reason: 'Puma documentado em ano próximo; código não estabelecido.' } });
    },
  });
  const result = await loop.loop({ brand: 'Puma', model: 'Puma GTS', manufacturingYear: 1978,
    country: 'Brazil', predominantColor: 'vermelho' });
  assert.equal(result.error, undefined);
  assert.ok(reviewed);
  assert.equal(result.colors[0].name, 'Vermelho Monte Carlo');
  assert.equal(result.colors[0].universal_code, '');
  assert.equal(result.make, 'Puma');
});

test('final verification runs after output generation and refreshes reporting before returning', async () => {
  let snapshot;
  const { loop } = fixture({ verification: true, onInitialResponse: response => { snapshot = response; },
    verifyFinalColorsFn: async (response, _vehicle, options) => {
      assert.deepEqual(response, snapshot);
      assert.ok(response.colors[0].paintFinish);
      options.onQuery('final color verification');
      options.onEngineRequest('google');
      options.onFetchedPage({ url: 'https://verified.test', status: 'ok', text: 'Shimmering Silver' });
      return { colors: response.colors.map(color => ({ ...color, sources: [...color.sources, 'https://verified.test'],
        verification: { status: 'partial', confirmed: ['name'], conflicting: [] } })),
      summary: { status: 'partial', colorsChecked: response.colors.length, colorsTotal: response.colors.length } };
    },
  });
  const result = await loop.loop({ brand: 'Hyundai', model: 'ix35', country: 'Brazil' });
  assert.equal(result.error, undefined);
  assert.ok(!snapshot.colors[0].sources.includes('https://verified.test'));
  assert.ok(result.colors[0].sources.includes('https://verified.test'));
  assert.equal(result.colors[0].verification.status, 'partial');
  assert.equal(result.browserUses.finalVerification, 1);
  assert.equal(result.pagesFetched, 36);
  assert.equal(Object.keys(result).at(-1), 'fetchedPages');
});

test('matching starts for settled reviews before slow peers and never repeats unchanged identities', { timeout: 2000 }, async () => {
  const reviewed = new Set(), matched = [];
  let releaseSlow;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  const names = Array.from({ length: 10 }, (_, i) => `Silver Variant ${i + 1}`);
  const { loop } = fixture({
    fetchFn: async ([url]) => [{ url, status: 'ok', text: names.join('; ') }],
    analyzePageFn: async () => ({ candidates: names.map(name => ({ name, evidence: [name] })) }),
    databaseCodeAgentFn: async palette => {
      assert.ok(palette.colors.every(color => reviewed.has(color.name)));
      if (!matched.length) assert.equal(reviewed.size, 6);
      matched.push(...palette.colors.map(color => color.name));
      releaseSlow();
      return { ...palette, colors: palette.colors.map(color => ({ ...color, universal_code: 'DB-ONLY' })) };
    },
  });
  const review = loop.reviewCandidate.bind(loop);
  loop.reviewCandidate = async (...args) => {
    if (names.indexOf(args[0].name) >= 6) await slow;
    const answer = await review(...args);
    reviewed.add(args[0].name);
    return answer;
  };
  const result = await loop.loop({ brand: 'Hyundai', model: 'ix35', predominantColor: 'prata', country: 'Brazil' });
  assert.equal(result.error, undefined);
  assert.equal(result.colors.length, 10);
  assert.deepEqual([...matched].sort(), [...names].sort());
  const fetched = loop.pages.filter(page => page.status === 'ok').map(page => page.url).sort();
  assert.ok(fetched.length >= 3);
  for (const color of result.colors) {
    assert.equal(color.universal_code, 'DB-ONLY');
    assert.deepEqual([...color.sources].sort(), fetched);
  }
});

test('queued capacity consumes the hard maximum and incomplete reviews stay explicit', async () => {
  const scheduler = new ModelScheduler({ limits: { 'gpt-6-luna': {
    tokensPerMinute: 1000000, requestsPerMinute: 1000, concurrency: 1,
  } } });
  const occupied = await scheduler.acquire({ choices: [{ model: 'gpt-6-luna' }], tokens: 1 });
  const { loop, events } = fixture({ scheduler, targetTimeMs: 1000, pauseForCapacity: true,
    modelRouting: { minimumAttemptWindowMs: 0 } });
  const analyze = loop.analyzePage;
  loop.analyzePage = (page, vehicle, options) => {
    assert.equal(options.scheduler, scheduler);
    assert.equal(options.timing, loop.timing);
    return analyze(page, vehicle, options);
  };
  const match = loop.databaseCodeAgent;
  loop.databaseCodeAgent = (palette, options) => {
    assert.equal(options.scheduler, scheduler);
    assert.equal(options.timing, loop.timing);
    return match(palette, options);
  };
  const log = loop.options.onProgress;
  let releasing = false;
  loop.options.onProgress = event => {
    log(event);
    if (event.event === 'capacity_wait_start' && !releasing) {
      releasing = true;
      setTimeout(() => occupied.complete({ ok: true }), 900);
    }
  };
  const result = await loop.loop({ brand: 'Volkswagen', model: 'Gol', country: 'Brazil' });
  assert.equal(result.error, undefined);
  assert.equal(result.research.candidatesReviewed, 0);
  assert.equal(result.research.unreviewedCandidates.length, 2);
  assert.ok(result.timing.capacityWaitMs > 0);
  assert.ok(result.totalTimeMs < 2000);
  assert.ok(result.timing.processingMs < 500);
  assert.ok(events.some(({ event }) => event === 'capacity_wait_start'));
  assert.equal(scheduler.queue.length, 0);
});

test('caller cancellation returns an explicit error with timing and releases queued requests', async () => {
  const models = ['gpt-6-luna', 'openrouter:openai/gpt-6-luna',
    'gpt-5.6-luna', 'openrouter:openai/gpt-5.6-luna'];
  const scheduler = new ModelScheduler({ limits: Object.fromEntries(models.map(model => [model, { concurrency: 1 }])) });
  const occupied = await Promise.all(models.map(model => scheduler.acquire({ choices: [{ model }], tokens: 1 })));
  const controller = new AbortController();
  const { loop } = fixture({ scheduler, signal: controller.signal });
  const log = loop.options.onProgress;
  const cancel = () => controller.abort(new Error('Caller cancelled'));
  const watchdog = setTimeout(cancel, 2000);
  loop.options.onProgress = event => {
    log(event);
    if (event.event === 'capacity_wait_start') setTimeout(cancel, 5);
  };
  try {
    const result = await loop.loop({ brand: 'Fiat', model: 'Uno', country: 'Brazil' });
    assert.equal(result.error, 'Caller cancelled');
    assert.ok(result.timing.capacityWaitMs > 0);
    assert.equal(scheduler.queue.length, 0);
  } finally { clearTimeout(watchdog); occupied.forEach(ticket => ticket.complete({ ok: true })); }
});

for (const vehicle of [
  { automobileType: 'car', brand: 'Hyundai', model: 'ix 35', country: 'Brazil', predominantColor: 'prata' },
  { automobileType: 'motorcycle', brand: 'Honda', model: 'CB 500', manufacturingYear: 2020 },
  { automobileType: 'truck', brand: 'Volvo', model: 'FH', country: 'Sweden' },
  { automobileType: 'tractor', brand: 'Massey Ferguson', model: '275', manufacturingYear: 1980 },
]) {
  test(`research preserves every reviewed candidate and crosses sources for ${vehicle.automobileType}`, async () => {
    const { loop } = fixture();
    const result = await loop.loop(vehicle);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.colors.map((color) => color.name), ['Shimmering Silver', 'Quicksilver']);
    assert.equal(result.pagesFetched, 35);
    assert.ok(result.browserUses.serper >= 8 && result.browserUses.serper <= 20);
    assert.ok([...loop.queries].some(query => /nomes?.*cor.*Brasil/.test(query)));
    assert.deepEqual(result.modelCalls, { main: 3, pageAnalysis: 1, databaseMatcher: 1 });
    assert.ok(result.colors.every((color) => color.sources.length === 35 && color.universal_code === 'DB-ONLY'));
    assert.equal(result.research.candidatesReviewed, 2);
  });
}

test('an omitted candidate cannot silently disappear from the final palette', async () => {
  const { loop } = fixture({ request: async (url, options) => {
    const body = JSON.parse(options.body);
    return modelResponse(body.text.format.name === 'research_plan'
      ? { queries: [], preferred_urls: [], rationale: '' } : {});
  } });
  const result = await loop.loop({ model: 'Model' });
  assert.equal(result.error, undefined);
  assert.equal(result.research.status, 'partial');
  assert.equal(result.research.reviewCoverage.reviewed, 0);
  assert.equal(result.research.reviewCoverage.unreviewed, 2);
  assert.deepEqual(result.colors, []);
});

test('exhausted search credits report the cause before any model call or follow-up search', async () => {
  let batches = 0;
  const { loop } = fixture({ browseFn: async queries => {
    batches++;
    return queries.map(query => ({ query, results: [], error: 'HTTP 400: Not enough credits' }));
  } });
  const result = await loop.loop({ brand: 'Hyundai', model: 'Azera', predominantColor: 'branco', country: 'Brazil' });
  assert.match(result.error, /Serper search credits are exhausted/);
  assert.equal(result.errorDetails.code, 'SEARCH_CREDITS_EXHAUSTED');
  assert.equal(result.errorDetails.retryable, false);
  assert.equal(loop.modelCalls.main, 0);
  assert.equal(loop.pages.length, 0);
  assert.equal(batches, 1);
});

test('failed initial searches preserve the service error, while missing credentials are actionable', async () => {
  for (const message of ['HTTP 503: Service unavailable', 'SERPER_API_KEY is required to browse']) {
    const { loop } = fixture({ browseFn: async () => { throw new Error(message); } });
    const result = await loop.loop({ model: 'Model' });
    assert.match(result.error, /Serper search (failed|authentication failed)/);
    assert.equal(loop.modelCalls.main, 0);
  }
});

test('a credit failure does not erase sources already returned in the same batch', async () => {
  let batches = 0;
  const { loop } = fixture({ browseFn: async queries => {
    batches++;
    return queries.map((query, index) => index ? { query, results: [], error: 'HTTP 400: Not enough credits' }
      : { query, results: [{ url: 'https://source.test/model-paint-chart', title: 'Model paint catalog' }] });
  } });
  const result = await loop.loop({ model: 'Model' });
  assert.equal(result.error, undefined);
  assert.equal(result.colors.length, 2);
  assert.equal(batches, 1);
  assert.equal(loop.modelCalls.main, 2, 'Each candidate is reviewed; no planning against the blocked search service');
  assert.equal(result.research.status, 'partial');
  assert.ok(result.research.warnings.some(warning => warning.code === 'SEARCH_CREDITS_EXHAUSTED'
    && warning.retryable === false && warning.action));
});

for (const failHueCheck of [false, true]) {
  test(`white research preserves Ice White and withholds silver before matching (check failure: ${failHueCheck})`, async () => {
    const { loop } = fixture({ analyzePageFn: async () => ({ candidates:
      ['Ice White', 'Sleek Silver', 'Ion Silver'].map(name => ({ name, evidence: [`${name} for Model`] })) }),
      databaseCodeAgentFn: async palette => {
        assert.deepEqual(palette.colors.map(c => c.name), ['Ice White']);
        return palette;
      },
    });
    const original = loop.mainAgent.bind(loop);
    loop.mainAgent = async (stage, schema, input, instructions, signal) => {
      if (!stage.startsWith('research_review_hue_')) return original(stage, schema, input, instructions, signal);
      assert.deepEqual(input.candidates.map(c => c.name), ['Sleek Silver', 'Ion Silver']);
      if (failHueCheck) throw new Error('Hue review deadline');
      return { checks: input.candidates.map(c => ({ id: c.id, compatible: false, reason: 'Prata não é branco.' })) };
    };
    const result = await loop.loop({ brand: 'Hyundai', model: 'Model', predominantColor: 'branco', country: 'Brazil' });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.colors.map(c => c.name), ['Ice White']);
    assert.deepEqual(result.research.unreviewedCandidates.map(c => c.name),
      failHueCheck ? ['Sleek Silver', 'Ion Silver'] : []);
    assert.equal(result.research.warnings.some(w => w.stage === 'hue_review'), failHueCheck);
  });
}

test('code-matcher failure retains the complete source-backed palette with empty codes', async () => {
  const { loop } = fixture({ databaseCodeAgentFn: async () => { throw new Error('database unavailable'); } });
  const result = await loop.loop({ model: 'Model' });
  assert.equal(result.colors.length, 2);
  assert.ok(result.colors.every((color) => color.universal_code === ''));
  assert.ok(result.research.warnings.some((warning) => warning.stage === 'code_matching'));
});

test('only an empty completed palette uses a visibly unverified found color', async () => {
  const { loop } = fixture({ analyzePageFn: async () => ({ candidates: [
    { name: 'Ice White', evidence: ['Ice White for Model'] },
  ] }) });
  loop.reviewCandidate = async candidate => ({ [candidate.id]: 'Model applicability was not established.' });
  const result = await loop.loop({ brand: 'Hyundai', model: 'Model', predominantColor: 'branco', country: 'Brazil' });
  assert.equal(result.error, undefined);
  assert.equal(result.colors.length, 1);
  assert.equal(result.colors[0].name, 'Ice White');
  assert.equal(result.colors[0].isFallback, true);
  assert.equal(result.colors[0].applicabilityScope, 'fallback');
  assert.equal(result.colors[0].universal_code, '');
  assert.ok(result.colors[0].sources.length);
  assert.equal(result.fallback.reason, 'no_valid_colors');
  assert.equal(result.paletteScope.fallbackCandidates, 1);
  assert.ok(result.completion.issues.includes('fallback_used'));
});

test('an exceptional color still receives the separate final verification', async () => {
  let verifiedNames = [];
  const { loop } = fixture({ verification: true,
    analyzePageFn: async () => ({ candidates: [
      { name: 'Ice White', evidence: ['Ice White for Model'] },
    ] }),
    verifyFinalColorsFn: async response => {
      verifiedNames = response.colors.map(color => color.name);
      return { colors: response.colors.map(color => ({ ...color, verification: {
        reviewed: true, status: 'unverified', confirmed: [], conflicting: [],
        unknown: ['name', 'vehicle'],
      } })), summary: { status: 'partial', coverage: 'complete',
        colorsChecked: response.colors.length, colorsUnchecked: 0,
        colorsConfirmed: 0, colorsTotal: response.colors.length } };
    },
  });
  loop.reviewCandidate = async candidate => ({ [candidate.id]: 'No supported model paint.' });
  const original = loop.mainAgent.bind(loop);
  loop.mainAgent = async (stage, ...args) => stage.startsWith('final_verification_omissions')
    ? { reconsiderations: [] } : original(stage, ...args);
  const result = await loop.loop({ brand: 'Hyundai', model: 'Model', predominantColor: 'branco', country: 'Brazil' });
  assert.deepEqual(verifiedNames, ['Ice White']);
  assert.equal(result.colors[0].verification.reviewed, true);
  assert.equal(result.colors[0].isFallback, true);
  assert.equal(result.research.status, 'partial');
  assert.ok(result.completion.issues.includes('fallback_used'));
});

test('trims only after the final agent finishes and the full debug result is saved', async () => {
  const steps = [];
  const snapshots = new Map();
  const { loop } = fixture({ databaseCodeAgentFn: async (palette) => {
    assert.ok(palette.colors.every((color) => color.evidence && color.source_evidence.length));
    steps.push('matcher_finished');
    return { ...palette, colors: palette.colors.map((color) => ({ ...color, name: color.name.toUpperCase(), universal_code: 'A1',
      code_candidates: [{ universal_code: 'A1', description: 'Full database row', year: 2020 }],
    })) };
  } });
  loop.dump = (name, data) => {
    steps.push(name);
    snapshots.set(name, structuredClone(data));
  };
  const response = await loop.loop({ brand: 'Hyundai', model: 'ix35', country: 'Brazil' });
  assert.equal(response.error, undefined);
  assert.ok(steps.indexOf('matcher_finished') < steps.indexOf('result'));
  assert.ok(steps.indexOf('result') < steps.indexOf('response'));
  assert.ok(snapshots.get('result').colors[0].source_evidence.length);
  assert.equal(snapshots.get('result').colors[0].code_candidates[0].description, 'Full database row');
  assert.equal(snapshots.get('result').colors[0].name, 'SHIMMERING SILVER');
  assert.equal(response.colors[0].name, 'Shimmering Silver');
  assert.equal(response.colors[0].source_evidence, undefined);
  assert.equal(response.colors[0].evidence, undefined);
  assert.deepEqual(response.colors[0].code_candidates, [{ universal_code: 'A1' }]);
  assert.deepEqual(snapshots.get('response'), response);
});

test('Portuguese naming keeps its reserved query when the planner fails without exceeding the budget', async () => {
  const { loop } = fixture({ maxSearches: 5 });
  const mainAgent = loop.mainAgent.bind(loop);
  loop.mainAgent = (stage, ...args) => {
    if (stage === 'research_plan') throw new Error('Planner unavailable');
    return mainAgent(stage, ...args);
  };
  const result = await loop.loop({ brand: 'Volkswagen', model: 'Gol', country: 'Brazil' });
  assert.equal(result.error, undefined);
  assert.equal(result.browserUses.serper, 5);
  assert.match([...loop.queries].at(-1), /nomes?.*cor.*Brasil/);
  assert.ok(result.research.warnings.some(({ stage }) => stage === 'planning'));
});

test('default compact output is created only after the matcher and retains every reused source', async () => {
  let matcherFinished = false;
  const { loop } = fixture({ outputFormat: undefined,
    databaseCodeAgentFn: async (palette) => {
      assert.ok(palette.colors[0].source_evidence.length);
      matcherFinished = true;
      return { ...palette, colors: palette.colors.map((color) => ({ ...color, universal_code: 'A1' })) };
    } });
  const result = await loop.loop({ brand: 'Volkswagen', model: 'Gol', country: 'Brazil' });
  assert.equal(matcherFinished, true);
  assert.equal(result.formatVersion, 3);
  assert.deepEqual(result.colors[0].codes, ['A1']);
  assert.equal(result.colors[0].sources.length, 35);
  assert.ok(result.colors[0].sources.every((url) => typeof url === 'string'));
  assert.equal(result.colors[0].source_evidence, undefined);
  assert.ok(result.timeMs >= 0);
});

test('a stalled review attempt retries while there is still time to preserve its candidate batch', async () => {
  const { loop } = fixture({ reviewRequestTimeoutMs: 10 });
  const request = loop.options.request;
  let reviews = 0;
  loop.options.request = async (url, options) => {
    if (JSON.parse(options.body).text.format.name.startsWith('research_review') && ++reviews === 1) {
      return new Promise((resolve, reject) => options.signal.addEventListener('abort',
        () => reject(options.signal.reason), { once: true }));
    }
    return request(url, options);
  };
  // Keep the mocked event loop alive while AbortSignal.timeout triggers.
  const timer = setInterval(() => {}, 20);
  try {
    const result = await loop.loop({ brand: 'Volkswagen', model: 'Gol', country: 'Brazil' });
    assert.equal(result.error, undefined);
    assert.equal(reviews, 3);
    assert.deepEqual(result.research.unreviewedCandidates, []);
    assert.equal(result.colors.length, 2);
  } finally { clearInterval(timer); }
});

test('explicit exclusions are recorded and unrelated citations cannot ground a color', () => {
  const candidates = candidateInventory([{ id: 'P1', url: 'https://a.test', candidates: [
    { name: 'Shimmering Silver', evidence: ['Shimmering Silver for Model A'] },
    { name: 'Signal Red', evidence: ['Signal Red for unrelated Model B'] },
  ] }]);
  const decisions = {
    C1: { confidence: 'low', source_ids: ['P1'], reason: 'Model A' },
    C2: 'Unrelated Model B',
  };
  assert.deepEqual(reviewedColors(candidates, decisions).map((color) => color.name), ['Shimmering Silver']);
  decisions.C1.source_ids = ['P2'];
  assert.throws(() => reviewedColors(candidates, decisions), /No grounded source/);
});

test('inclusion objects explicitly declare inclusion, separate from exclusion reasons', () => {
  const schema = reviewSchema([{ id: 'C1', name: 'Prata Lunar', sources: [{ page_id: 'P1' }] }]);
  const choices = schema.properties.C1.anyOf;
  const inclusion = choices.find((choice) => choice.properties?.confidence);
  assert.deepEqual(inclusion.properties.action.enum, ['include']);
  assert.ok(inclusion.required.includes('action'));
  assert.ok(choices.some((choice) => choice.type === 'string'));
});

test('source selection favors useful independent domains while keeping explicit priorities', () => {
  const index = new Map([
    ['a', { url: 'https://a.test/1', title: 'Model paint chart', rank: 0 }],
    ['b', { url: 'https://a.test/2', title: 'Model paint chart', rank: 0 }],
    ['c', { url: 'https://b.test/1', title: 'Model paint chart', rank: 1 }],
  ]);
  const selected = selectSources(index, new Set(), { model: 'Model' }, 2);
  assert.deepEqual(selected.map((source) => new URL(source.url).hostname), ['a.test', 'b.test']);
  assert.equal(seedQueries({ model: 'Tractor', country: 'Brazil' }).length, 5);
});

test('HTTP retries are bounded, honor transient status, and do not retry billing failures', async () => {
  let calls = 0;
  const result = await requestJson('https://api.test', {}, { request: async () => {
    calls++;
    return calls === 1 ? { ok: false, status: 503, json: async () => ({}) }
      : { ok: true, json: async () => ({ success: true }) };
  } });
  assert.deepEqual(result, { success: true });
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(requestJson('https://api.test', {}, { request: async () => {
    calls++;
    return { ok: false, status: 429, json: async () => ({ error: { code: 'insufficient_quota' } }) };
  } }), /HTTP 429/);
  assert.equal(calls, 1);
});

test('limiter releases its slot after failure and bounds simultaneous work', async () => {
  const limit = createLimiter(2);
  let active = 0;
  let maximum = 0;
  await Promise.allSettled(Array.from({ length: 8 }, (_, i) => limit(async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    if (i === 0) throw new Error('expected');
  })));
  assert.equal(maximum, 2);
});

test('code-prefixed names merge only when the page explicitly labels the prefix as a code', () => {
  const candidates = candidateInventory([{ id: 'P1', url: 'https://paint.example/chart', candidates: [
    { name: 'Rah Sleek Silver Metallic', evidence: ['Colour Code RAH Rah Sleek Silver Metallic'] },
    { name: 'Sleek Silver', evidence: ['Sleek Silver for Model'] },
    { name: 'New Sleek Silver', evidence: ['New Sleek Silver is a different paint'] },
  ] }]);
  assert.deepEqual(candidates.map((candidate) => candidate.name), ['Sleek Silver', 'New Sleek Silver']);
  assert.equal(candidates[0].sources.length, 1);
  assert.equal(candidates[0].sources[0].evidence.length, 2);
});

test('named code suffixes can be removed while invented output names are rejected', () => {
  const candidates = candidateInventory([{ id: 'P1', url: 'https://a.test', candidates: [
    { name: 'MF Red M1041', evidence: ['MF 275: MF Red M1041'] },
  ] }]);
  const decision = { C1: { name: 'MF Red', confidence: 'low', source_ids: ['P1'], reason: 'MF 275' } };
  assert.equal(reviewedColors(candidates, decision)[0].name, 'MF Red');
  decision.C1.name = 'Invented Red';
  const warnings = [];
  assert.equal(reviewedColors(candidates, decision, {
    onWarning: (warning) => warnings.push(warning),
  })[0].name, 'MF Red M1041');
  assert.match(warnings[0], /Ungrounded output name/);
});

test('a failed review batch preserves other reviewed colors and reports every unresolved name', async () => {
  const { loop } = fixture({
    analyzePageFn: async () => ({ candidates: Array.from({ length: 22 }, (_, index) => ({
      name: `Named Paint ${index}`, evidence: [`Named Paint ${index} for Model`],
    })) }),
    request: async (url, options) => {
      const body = JSON.parse(options.body);
      if (body.text.format.name === 'research_plan') return modelResponse({ queries: [], preferred_urls: [], rationale: '' });
      if (['research_review_2', 'research_review_retry_2', 'research_review_completion_C2'].includes(body.text.format.name)) {
        return { ok: false, status: 400, json: async () => ({ error: { message: 'Review unavailable' } }) };
      }
      return modelResponse(Object.fromEntries(JSON.parse(body.input).candidates.map((candidate) => [candidate.id, {
        action: 'include', name: null, confidence: 'low', source_ids: [candidate.sources[0].page_id], reason: 'Model linked',
      }])));
    },
  });
  const result = await loop.loop({ model: 'Model' });
  assert.equal(result.colors.length, 21);
  assert.equal(result.research.status, 'partial');
  assert.equal(result.research.candidatesReviewed, 21);
  assert.deepEqual(result.research.unreviewedCandidates.map((candidate) => candidate.name),
    ['Named Paint 1']);
});

test('an unresolved alias keeps its grounded candidate instead of dropping its review batch', () => {
  const candidates = candidateInventory([{ id: 'P1', url: 'https://a.test', candidates: [
    { name: 'Continental Silver', evidence: ['Continental Silver for Model'] },
    { name: 'Other Silver', evidence: ['Other Silver for Model'] },
  ] }]);
  const warnings = [];
  const colors = reviewedColors(candidates, {
    C1: { alias_of: 'C99', source_ids: ['P1'], reason: 'Proposed alias' },
    C2: { name: null, confidence: 'low', source_ids: ['P1'], reason: 'Model linked' },
  }, { onWarning: (warning) => warnings.push(warning) });
  assert.equal(colors.length, 2);
  assert.equal(warnings.length, 1);
});

test('short model names require make context instead of matching unrelated paint words', () => {
  const index = new Map([
    ['a', { url: 'https://a.test/matte-paint', title: 'Matte paint chart', rank: 0 }],
    ['b', { url: 'https://b.test/audi-tt-colors', title: 'Audi TT paint chart', rank: 1 }],
  ]);
  assert.deepEqual(selectSources(index, new Set(), { brand: 'Audi', model: 'TT' }, 5)
    .map((source) => source.url), ['https://b.test/audi-tt-colors']);
});

test('uses explicit page-level code headings omitted from the extractor passages', () => {
  const candidates = candidateInventory([{ id: 'P1', url: 'https://a.test',
    text: 'Colour Code RAH\nRah Sleek Silver Metallic\nSleek Silver', candidates: [
      { name: 'Rah Sleek Silver Metallic', evidence: ['Rah Sleek Silver Metallic'] },
      { name: 'Sleek Silver', evidence: ['Sleek Silver'] },
    ] }]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].name, 'Sleek Silver');
});

test('short model names do not import a different same-make model with a shared prefix', () => {
  const index = new Map([
    ['a', { url: 'https://a.test/volkswagen-golf', title: 'Volkswagen Golf paint chart', rank: 0 }],
    ['b', { url: 'https://b.test/volkswagen-gol', title: 'Volkswagen Gol paint chart', rank: 1 }],
  ]);
  assert.deepEqual(selectSources(index, new Set(), { brand: 'Volkswagen', model: 'Gol' }, 5)
    .map((source) => source.url), ['https://b.test/volkswagen-gol']);
});

test('repeated catalog code columns merge names without stripping meaningful prefixes', () => {
  const candidates = candidateInventory([{ id: 'P1', url: 'https://a.test',
    text: 'Paint Codes\nRAH - Rah Sleek Silver Metallic\nNEW - Different Silver', candidates: [
      { name: 'Rah Sleek Silver Metallic', evidence: ['RAH - Rah Sleek Silver Metallic'] },
      { name: 'Sleek Silver', evidence: ['Sleek Silver'] },
      { name: 'New Sleek Silver', evidence: ['New Sleek Silver'] },
    ] }]);
  assert.deepEqual(candidates.map((candidate) => candidate.name), ['Sleek Silver', 'New Sleek Silver']);
});

test('a short name with conflicting codes is retained as an unresolved lead, not a final color', () => {
  const candidates = candidateInventory([{ id: 'P1', url: 'https://a.test', candidates: [
    { name: 'Hyper', evidence: ['P2S - Hyper', 'WJX - Hyper'] },
    { name: 'Hyper Silver', evidence: ['P2S - Hyper Silver'] },
    { name: 'Quicksilver', evidence: ['Q7 - Quicksilver'] },
  ] }]);
  const unresolved = [];
  const decisions = Object.fromEntries(candidates.map((candidate) => [candidate.id, {
    name: null, confidence: 'low', name_status: 'complete', source_ids: ['P1'], reason: 'Nome publicado.',
  }]));
  const colors = reviewedColors(candidates, decisions, { onUnresolved: (value) => unresolved.push(value) });
  assert.deepEqual(colors.map((color) => color.name), ['Hyper Silver', 'Quicksilver']);
  assert.equal(unresolved[0].name, 'Hyper');
  assert.deepEqual(colors[0].source_evidence[0].paint_codes, ['P2S']);
});

test('translated and reordered paint names with conflicting evidence remain separate', () => {
  const candidates = candidateInventory([{ id: 'P1', url: 'https://a.test', candidates: [
    { name: 'Cinza Titanium', evidence: ['Y6G - Cinza Titanium'] },
    { name: 'Gray Titanium', evidence: ['TAK - Gray Titanium'] },
  ] }]);
  assert.equal(candidates.length, 2);
  const colors = reviewedColors(candidates, {
    C1: { confidence: 'low', source_ids: ['P1'], reason: 'Brasil' },
    C2: { confidence: 'low', source_ids: ['P1'], reason: 'Outra cor' },
  });
  assert.equal(colors.length, 2);
  assert.deepEqual(colors.map((color) => color.source_evidence[0].paint_codes), [['Y6G'], ['TAK']]);
});

test('name clarification has a separate browser quota and can discover a full name', async () => {
  const { loop } = fixture({ maxNameSearches: 2,
    analyzePageFn: async (page) => ({ candidates: page.queries?.some((query) => query.includes('full paint'))
      ? [{ name: 'Hyper Silver', evidence: ['P2S - Hyper Silver for Model'] }]
      : [{ name: 'Hyper', evidence: ['P2S - Hyper for Model'] }] }),
  });
  const result = await loop.loop({ model: 'Model', brand: 'Brand' });
  assert.equal(result.error, undefined);
  assert.ok(result.browserUses.serper <= loop.maxSearches + result.browserUses.nameClarification);
  assert.equal(result.browserUses.nameClarification, 1);
  assert.ok(result.colors.some((color) => color.name === 'Hyper Silver'));
  assert.ok(!result.colors.some((color) => color.name === 'Hyper'));
  assert.equal(result.research.unresolvedNames?.length || 0, 0);
});

test('a printed code/name row removes an accidental code prefix without a page heading', () => {
  const candidates = candidateInventory([{ id: 'P1', url: 'https://a.test', candidates: [
    { name: 'TAK Gray Titanium', evidence: ['TAK - Gray Titanium'] },
    { name: 'New Gray Titanium', evidence: ['NEW - Different Gray'] },
  ] }]);
  assert.deepEqual(candidates.map((candidate) => candidate.name), ['Gray Titanium', 'New Gray Titanium']);
});

test('a verified complete one-word name may have several code aliases', () => {
  const candidates = candidateInventory([{ id: 'P1', url: 'https://a.test', candidates: [
    { name: 'Quicksilver', evidence: ['Q1, Q2', 'Quicksilver'] },
    { name: 'Quicksilver-MET.', evidence: ['Q1 - Quicksilver-MET.'] },
  ] }]);
  assert.equal(candidates.length, 1);
  assert.equal(reviewedColors(candidates, { C1: { name_status: 'complete', confidence: 'low',
    source_ids: ['P1'], reason: 'Nome completo da tabela.' } })[0].name, 'Quicksilver');
});


test('fetching overlaps slow searches but planning judges their completed source inventory', async () => {
  const { loop } = fixture();
  const browse = loop.browse, request = loop.options.request;
  let release, first = true, planningStarted = false;
  const pending = new Promise(resolve => { release = resolve; });
  loop.browse = async (queries, options) => {
    const rows = await browse(queries, options);
    if (first) {
      first = false;
      options.onResults(rows[0]);
      setTimeout(() => {
        assert.equal(planningStarted, false);
        release();
      }, 25);
      await pending;
    }
    return rows;
  };
  loop.options.request = (url, options) => {
    if (JSON.parse(options.body).text.format.name === 'research_plan') {
      planningStarted = true;
    }
    return request(url, options);
  };
  const result = await loop.loop({ brand: 'Hyundai', model: 'Azera', country: 'Brazil' });
  assert.equal(result.error, undefined);
  assert.equal(planningStarted, true);
  assert.equal(result.pagesFetched, 35);
});

test('OpenSERP reporting separates submitted engine searches from logical query quotas', async () => {
  const { loop } = fixture({ searchProvider: 'openserp' });
  const browse = loop.browse;
  loop.browse = (queries, options) => {
    for (const query of queries) for (const engine of ['google', 'bing', 'duckduckgo']) options.onEngineRequest(engine);
    return browse(queries, options);
  };
  const result = await loop.loop({ brand: 'Volkswagen', model: 'Gol', country: 'Brazil' });
  assert.equal(result.error, undefined);
  assert.equal(result.browserUses.total, result.browserUses.uniqueQueries * 3);
  assert.deepEqual(result.browserUses.engines, Object.fromEntries(['google', 'bing', 'duckduckgo']
    .map(engine => [engine, result.browserUses.uniqueQueries])));
});

test('Brave research reports the selected provider and preserves the research budget', async () => {
  let searches = 0;
  const { loop } = fixture({ searchProvider: 'brave' });
  const browse = loop.browse;
  loop.browse = (queries, options) => {
    assert.equal(options.provider, 'brave');
    assert.equal(options.concurrency, 3);
    searches += queries.length;
    return browse(queries, options);
  };
  const result = await loop.loop({ brand: 'Volkswagen', model: 'Gol', country: 'Brazil' });
  assert.equal(result.error, undefined);
  assert.equal(result.browserUses.brave, searches);
  assert.equal(result.browserUses.serper, 0);
  assert.equal(result.pagesFetched, 35);
  assert.equal(result.colors.length, 2);
});

test('retrieval reporting counts searches once and separates fetch errors from extraction failures', () => {
  const { loop } = fixture({ searchProvider: 'brave' });
  loop.queries = new Set(['initial', 'follow-up', 'name clarification']);
  loop.nameQueries = new Set(['name clarification']);
  loop.engineSearches.brave = 3;
  loop.pages = [
    { url: 'https://ok.test', status: 'ok', text: 'Page text', error: 'Extraction failed' },
    { url: 'https://failed.test', status: 'error', error: 'HTTP 403' },
    { url: 'https://scan.test', status: 'no_text', text: '' },
    { url: 'https://queued.test', status: 'pending' },
  ];
  loop.attempted = new Set(loop.pages.map(page => page.url));
  const summary = loop.retrievalSummary();
  assert.deepEqual(summary.browserUses, { total: 3, failed: 0, brave: 3, serper: 0,
    nameClarification: 1, uniqueQueries: 3, engines: { brave: 3 } });
  assert.equal(summary.pageFetchAttempts, 4);
  assert.equal(summary.pagesFetched, 1);
  assert.equal(summary.fetchErrors, 1);
  assert.equal(summary.pagesWithoutText, 1);
  assert.equal(summary.pagesPending, 1);
  assert.deepEqual(summary.fetchedPages, [
    { url: 'https://ok.test', status: 'ok' },
    { url: 'https://failed.test', status: 'error', error: 'HTTP 403' },
    { url: 'https://scan.test', status: 'no_text' },
    { url: 'https://queued.test', status: 'pending' },
  ]);
});

test('caller cancellation skips queued URLs without a network attempt or site error', async () => {
  let calls = 0;
  const controller = new AbortController();
  const { loop } = fixture({ fetchFn: async ([url], options) => {
    calls++;
    assert.equal(options.totalTimeoutMs, 5000);
    controller.abort();
    return [{ url, status: 'no_text', text: '' }];
  } });
  loop.timing = { signal: controller.signal };
  loop.fetchLimit = createLimiter(1);
  await loop.readSources(['https://first.test', 'https://queued.test'].map(url => ({ url })), {}, new AbortController().signal);
  const result = loop.retrievalSummary();
  assert.equal(calls, 1);
  assert.equal(result.pageFetchAttempts, 1);
  assert.equal(result.fetchErrors, 0);
  assert.equal(result.pagesSkipped, 1);
  assert.equal(result.fetchedPages[1].errorCode, 'PAGE_BUDGET_EXHAUSTED');
});

test('completed fetches can still be analyzed after the fetch cutoff', async () => {
  const fetchController = new AbortController(), extractionController = new AbortController();
  let analyzed = false;
  const { loop } = fixture({ fetchFn: async ([url]) => {
    fetchController.abort(new Error('Fetch phase ended'));
    return [{ url, status: 'ok', text: 'Shimmering Silver' }];
  }, analyzePageFn: async (_page, _vehicle, options) => {
    assert.equal(options.signal, extractionController.signal);
    assert.equal(options.signal.aborted, false);
    assert.equal(options.deferAudits, true);
    analyzed = true;
    return { candidates: [{ name: 'Shimmering Silver', evidence: ['Shimmering Silver'] }] };
  } });
  loop.fetchSignal = fetchController.signal;
  loop.extractionSignal = extractionController.signal;
  loop.fetchLimit = createLimiter(1);
  await loop.readSources([{ url: 'https://late.test' }], {}, fetchController.signal);
  assert.equal(analyzed, true);
  assert.equal(loop.pages[0].candidates[0].name, 'Shimmering Silver');
});

test('late name clarification uses its own signal for fetch and extraction', async () => {
  const expiredFetch = new AbortController(), expiredExtraction = new AbortController();
  const nameWindow = new AbortController();
  expiredFetch.abort();
  expiredExtraction.abort();
  let fetched = false, analyzed = false;
  const { loop } = fixture({ fetchFn: async ([url], options) => {
    assert.equal(options.signal.aborted, false);
    fetched = true;
    return [{ url, status: 'ok', text: 'Hyper Silver' }];
  }, analyzePageFn: async (_page, _vehicle, options) => {
    assert.equal(options.signal, nameWindow.signal);
    analyzed = true;
    return { candidates: [{ name: 'Hyper Silver', evidence: ['Hyper Silver'] }] };
  } });
  loop.fetchSignal = expiredFetch.signal;
  loop.extractionSignal = expiredExtraction.signal;
  loop.fetchLimit = createLimiter(1);
  await loop.readSources([{ url: 'https://late.test', nameResearch: true,
    nameLeads: [{ name: 'Hyper', codes: [] }] }], { model: 'ix35' }, nameWindow.signal);
  assert.equal(fetched, true, JSON.stringify(loop.pages));
  assert.equal(analyzed, true);
  assert.equal(loop.pages[0].candidates[0].name, 'Hyper Silver');
});

test('recovery repairs failed extraction without auditing successful pages', async () => {
  const order = [];
  const { loop } = fixture({ maxPageFetches: 2, fetchFn: async ([url]) => [{ url, status: 'ok',
    text: url.includes('source0.') ? 'Primary paint: Shimmering Silver' : 'Primary paint: Quicksilver' }],
    analyzePageFn: async (page) => {
      order.push('primary');
      if (page.text.includes('Shimmering')) return { candidates: [], failures: [{ error: 'Primary timed out' }],
        fallbackSegments: [{ segment: 1, text: page.text }] };
      return { candidates: [{ name: 'Quicksilver', evidence: [page.text] }], runAudits: async () => {
        order.push('audit');
        assert.ok(order.includes('recovery'));
        return { candidates: [], failures: [], requests: 1 };
      } };
    } });
  const request = loop.options.request;
  loop.options.request = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.text.format.name.startsWith('recover_')) {
      order.push('recovery');
      return modelResponse({ candidates: [{ name: 'Shimmering Silver', evidence: ['Primary paint: Shimmering Silver'] }] });
    }
    return request(url, options);
  };
  const result = await loop.loop({ brand: 'Hyundai', model: 'ix35', country: 'Brazil' });
  assert.equal(result.error, undefined);
  assert.ok(result.colors.some(color => color.name === 'Shimmering Silver'));
  assert.deepEqual(order, ['primary', 'primary', 'recovery']);
});

test('bounded early fetching overlaps slow searches and leaves room for later results', async () => {
  let release, first = true, fetched = 0, earlyFetched = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const rows = Array.from({ length: 20 }, (_, i) => ({ url: `https://site${i}.test/azera`, title: 'Azera paint chart', snippet: '' }));
  const { loop } = fixture({ browseFn: async (queries, options) => {
    const result = queries.map(query => ({ query, results: rows }));
    if (first) {
      first = false;
      options.onResults(result[0]);
      await pending;
      earlyFetched = fetched;
    }
    return result;
  }, fetchFn: async ([url]) => {
    if (++fetched === 1) release();
    return [{ url, status: 'ok', text: 'Shimmering Silver; Quicksilver' }];
  } });
  // Avoid hanging a broken implementation while still detecting the old barrier.
  let stalled = false;
  const guard = setTimeout(() => { stalled = true; release(); }, 5000);
  try {
    const result = await loop.loop({ brand: 'Hyundai', model: 'Azera', country: 'Brazil' });
    assert.equal(stalled, false);
    assert.ok(earlyFetched > 0 && earlyFetched < 20);
    assert.equal(result.error, undefined);
    assert.equal(result.pagesFetched, 20);
  } finally { clearTimeout(guard); }
});

test('compact success and error responses expose fetch outcomes as their final array', async () => {
  for (const allFailed of [false, true]) {
    let calls = 0;
    const { loop } = fixture({ outputFormat: 'compact', fetchFn: async ([url]) => {
      calls++;
      if (allFailed || calls === 1) throw new Error('HTTP 403');
      if (calls === 2) return [{ url, status: 'no_text', text: '' }];
      return [{ url, status: 'ok', text: 'Shimmering Silver; Quicksilver' }];
    } });
    const result = await loop.loop({ brand: 'Hyundai', model: 'ix35', country: 'Brazil' });
    assert.equal(!!result.error, allFailed);
    assert.equal(result.browserUses.total, loop.queries.size);
    assert.equal(result.pageFetchAttempts, loop.attempted.size);
    assert.equal(result.fetchedPages.length, result.pageFetchAttempts);
    assert.equal(result.fetchErrors, result.fetchedPages.filter(page => page.status === 'error').length);
    assert.equal(result.pagesFetched, result.fetchedPages.filter(page => page.status === 'ok').length);
    assert.equal(result.pagesWithoutText, result.fetchedPages.filter(page => page.status === 'no_text').length);
    assert.ok(result.fetchedPages.some(page => page.error === 'HTTP 403'));
    assert.equal(Object.keys(result).at(-1), 'fetchedPages');
  }
});
