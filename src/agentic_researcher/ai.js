require('dotenv').config({ quiet: true });

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createHash } = require('node:crypto');

const { capacityContext } = require('./capacity_context');
const { browse, searchProvider } = require('./search_provider');
const { searchFailure } = require('./search_errors');
const { SearchBudget } = require('./search_budget');
const { fetchPages, PAGE_FETCH_BUDGET_MS } = require('./fetch_pages');
const { PagePool } = require('./page_pool');
const { SectionExtractionCache } = require('./section_extraction');
const { analyzePage, pageAnalysisConfig } = require('./page_analysis');
const { AiCost } = require('./ai_cost');
const { SerperCost } = require('./serper_cost');
const { AiBudget } = require('./ai_budget');
const { repairUnreviewed, paletteCoverage } = require('./completion_review');
const { addDatabaseCodes } = require('./database_code_agent');
const { validateVehicle, readFile } = require('./agentic_loop_helpers');
const { createLimiter } = require('./runtime');
const { requestMainAgent } = require('./research_model');
const { indexResults, selectSources, conflictingMakeModel } = require('./research_plan');
const { discover, prefetchSources, finalDiscoveryCoverage } = require('./discovery_pipeline');
const { recoverManufacturerPaints, hasModelLinkedPaint } = require('./manufacturer_paint_recovery');
const { reviewInventory } = require('./review_stage');
const { SettledReviewWork } = require('./settled_review_work');
const { candidateInventory, inventoryCodes, reviewedColors, object } = require('./candidate_inventory');
const { relatesToNameLead, printedNameKey } = require('./paint_evidence');
const { clarifyNameBatch, nameLeads, nameResearchVehicle } = require('./name_research');
const { webPortugueseName } = require('./portuguese_names');
const { researchPortugueseNames } = require('./portuguese_name_research');
const { finalOutput } = require('./final_output');
const { withCompletion } = require('./result_completion');
const { partitionPalette } = require('./palette_scope');
const { emptyPaletteFallback, canUseEmptyFallback } = require('./empty_palette_fallback');
const { observedColorFallback } = require('./observed_color_fallback');
const { admitRun } = require('./run_admission');
const { modelScheduler } = require('./model_scheduler');
const { RunTiming } = require('./run_timing');
const { applyMatchedFinish } = require('./lazzumix_finish');
const { pipelineDeadlines, DEFAULT_TARGET_TIME_MS, DEFAULT_MAX_TIME_MS, DISCOVERY_TARGET_MS } = require('./research_deadlines');
const { CodeMatchPipeline } = require('./code_match_pipeline');
const { VerificationResearch } = require('./verification_research');
const { verifyFinalColors, applicableFields } = require('./final_verification_agent');
const { CatalogResearch } = require('./catalog_research');
const { CandidateReviewPipeline, prioritizeCandidates } = require('./candidate_review_pipeline');
const { literalPaintRows } = require('./literal_paint_rows');
const { catalogYearLink } = require('./catalog_year_link');
const { reviewCandidate } = require('./candidate_review');
const { matchCandidateColors } = require('./research_code_matching');
const { summarizeRetrieval } = require('./research_reporting');

const RECOVERY_SCHEMA = object({ candidates: { type: 'array', items: object({
  name: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } },
}) } });

// One instance owns one vehicle run. Collaborators receive this shared context;
// the methods remain the entry points for callers and injected implementations.
class AgenticLoop {
  constructor(options = {}) {
    this.options = options;
    // Final color verification is opt-in. Candidate and omission reviews still run.
    this.finalReviewEnabled = options.verification === true
      || (options.verification !== false && Boolean(options.verifyFinalColorsFn));
    this.routing = { ...options.modelRouting,
      budget: options.modelRouting?.budget || new AiBudget(options.targetAiCostUsd ?? 0.065, options.tokenPrices,
        { verificationFraction: this.finalReviewEnabled ? 0.2 : 0, reviewFraction: 0.4,
          matchingFraction: 0.06, repairFraction: 0.06, omissionFraction: options.verification === false ? 0 : 0.1 }) };

    // Search queues, engine health and counters are scoped to this run.
    this.searchState = {};
    this.engineSearches = {};
    this.failedBrowserUses = 0;
    this.searchJobs = [];
    this.searchFailures = [];
    this.loggedSearchSources = new Set();

    // The scheduler may be shared across runs; network collaborators are injectable.
    this.scheduler = options.scheduler || modelScheduler;
    this.browse = options.browseFn || browse;
    this.searchProvider = searchProvider(options.searchProvider);
    this.serperCost = this.searchProvider === 'serper'
      ? new SerperCost(options.serperCostPer1000CreditsUsd) : null;
    this.fetchPages = options.fetchFn || fetchPages;
    this.analyzePage = options.analyzePageFn || analyzePage;
    this.databaseCodeAgent = options.databaseCodeAgentFn || addDatabaseCodes;

    // Evidence and work registries grow as search/extraction stream their results.
    this.pages = [];
    this.catalogPages = [];
    this.snippetPages = [];
    this.index = new Map();
    this.queries = new Set();
    this.nameQueries = new Set();
    this.paletteQueries = new Set();
    this.codeQueries = new Set();
    this.localizationQueries = new Set();
    this.verificationQueries = new Set();
    this.checkedNames = new Set();
    this.nameReads = new Set();
    this.attempted = new Set();
    this.warnings = [];
    this.modelCalls = { main: 0, pageAnalysis: 0, databaseMatcher: 0 };
    this.modelRequests = { total: 0, byStage: {} };
    this.tokenUsageByAgent = {};
    this.stageTimes = {};
    this.runId = randomUUID();
    this.used = false;
    this.extractionState = {};
    this.pageRecoveryBudgetExhausted = false;
    this.extractions = new Map();
    this.sectionCache = new SectionExtractionCache();
    this.cost = new AiCost(options.tokenPrices);
    this.searchBudget = new SearchBudget(options.maxBrowserUses ?? 20, this.log.bind(this),
      this.finalReviewEnabled ? undefined : 0);
  }

  // Diagnostics and reporting. Observer failures must not stop research.
  log(event, details = {}) {
    if (event === 'model_route_start') {
      const stage = details.kind || 'unknown';
      this.modelRequests.total++;
      this.modelRequests.byStage[stage] = (this.modelRequests.byStage[stage] || 0) + 1;
    }
    try {
      const pending = this.options.onProgress?.({ timestamp: new Date().toISOString(), runId: this.runId, event, ...details });
      // Async observers have the same isolation as synchronous ones. Do not
      // await logging or report its failure through the same observer again.
      if (pending?.catch) pending.catch(() => {});
    }
    catch { /* Logging must not interrupt research. */ }
  }

  warn(stage, error, details) {
    const message = error instanceof Error ? error.message : String(error);

    if (!details && /AI cost target reached/.test(message)) details = {
      code: 'AI_BUDGET_LIMIT', targetUsd: this.routing.budget.targetUsd,
    };

    const warning = { stage, message, ...(details && { details }) };

    this.warnings.push(warning);
    this.log('warning', warning);
  }

  usage(agent, usage) {
    if (!usage) return;

    const entry = this.tokenUsageByAgent[agent] ||= { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    entry.inputTokens += usage.input_tokens || 0;
    entry.outputTokens += usage.output_tokens || 0;
    entry.totalTokens += usage.total_tokens || (usage.input_tokens || 0) + (usage.output_tokens || 0);
  }

  costSummary() {
    const summary = this.cost.summary(this.options.targetAiCostUsd ?? 0.065);
    const admissionEstimateUsd = this.routing?.budget?.spent;

    return { ...summary, admissionEstimateUsd: Number.isFinite(admissionEstimateUsd)
      ? Number(admissionEstimateUsd.toFixed(6)) : null };
  }

  dump(name, data) {
    if (this.options.debugDirectory === false) return;

    const directory = this.options.debugDirectory || path.resolve(__dirname, '..', 'tmp', 'serper-qwen-guarded', this.runId);

    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(data, null, 2), { mode: 0o600 });
    } catch (error) { this.log('debug_write_error', { error: error.message }); }
  }

  retrievalSummary() {
    return summarizeRetrieval(this);
  }

  getPagePool() {
    this.pagePool ||= new PagePool({
      fetchPages: this.fetchPages.bind(this), signal: this.workSignal || this.timing?.signal || this.options.signal,
      scheduler: this.scheduler, concurrency: this.options.fetchConcurrency ?? 20,
      prefetchConcurrency: this.options.prefetchConcurrency ?? 2,
      prefetchBuffer: this.options.prefetchBuffer ?? 4,
      maxPrefetchPages: this.options.maxPrefetchPages ?? 8,
      // Discovery has alternative indexed pages; a 5-second timeout should
      // give its slot to another source rather than restart the same URL.
      retryTimedOutPages: false,
      log: this.log.bind(this),
    });
    return this.pagePool;
  }

  evidencePages() {
    return [...this.pages, ...this.catalogPages, ...this.snippetPages];
  }

  candidates() {
    this.identityArtifacts ||= new Map();
    return candidateInventory(this.evidencePages(), { manufacturer: this.vehicle?.brand,
      vehicle: this.vehicle,
      onArtifact: artifact => {
        const previous = this.identityArtifacts.get(artifact.name);
        this.identityArtifacts.set(artifact.name, { ...artifact,
          sources: [...new Set([...(previous?.sources || []), ...artifact.sources])] });
      } });
  }

  async matchColors(colors, vehicle, signal, batch) {
    return matchCandidateColors(this, colors, vehicle, signal, batch);
  }

  async mainAgent(stage, schema, input, instructions, signal, validateOutput, recovery) {
    return requestMainAgent(this, stage, schema, input, instructions, signal, validateOutput, recovery);
  }

  // Discovery: publish usable sources before every engine has finished.
  async search(queries, vehicle, signal, { forNames = false, forCodes = false,
    forPalette = false, forLocalization = false, onSources } = {}) {
    if (this.searchBlocked || !this.searchBudget.remaining('research')) return;

    const fresh = queries.filter((query) => typeof query === 'string' && query.trim())
      .map((query) => query.trim()).filter((query) => !this.queries.has(query));
    const remaining = forPalette ? this.maxPaletteSearches - this.paletteQueries.size
      : forNames ? this.maxNameSearches - this.nameQueries.size
      : forCodes ? (this.options.maxCodeSearches ?? 1) - this.codeQueries.size
        : forLocalization ? 2 - this.localizationQueries.size
        : this.maxSearches - (this.queries.size - this.nameQueries.size
          - this.codeQueries.size - this.paletteQueries.size - this.localizationQueries.size);
    const batch = [...new Set(fresh)].slice(0, Math.max(0, remaining));

    if (!batch.length || signal.aborted) return;

    batch.forEach((query) => this.queries.add(query));

    if (forNames) batch.forEach((query) => this.nameQueries.add(query));
    if (forCodes) batch.forEach((query) => this.codeQueries.add(query));
    if (forPalette) batch.forEach((query) => this.paletteQueries.add(query));
    if (forLocalization) batch.forEach((query) => this.localizationQueries.add(query));

    const started = performance.now();

    this.log('search_start', { queries: batch });

    let releaseEarly, earlyTimer;
    const earlyResults = new Promise(resolve => { releaseEarly = resolve; });

    // Deterministic recovery can start while slow engines are still working.
    // The search jobs continue contributing until their (extendable) cutoff.
    const progressTimer = setTimeout(releaseEarly, this.options.searchProgressMs ?? 4000);
    const accept = result => {
      indexResults([result], this.index);

      for (const source of this.index.values()) {
        if (this.loggedSearchSources.has(source.url)) continue;

        this.loggedSearchSources.add(source.url);

        if (!selectSources(new Map([[source.url, source]]), new Set(), vehicle, 1).length) {
          this.log('search_source_rejected', { url: source.url, engines: source.engines,
            reason: 'Missing model or paint context for the initial source filter' });
        }
      }

      if (result.error) {
        const error = searchFailure(result.error, result.errorDetails, this.searchProvider);
        this.searchFailures.push(error);
        this.warn('search_engine', `${result.query}: ${error.message}`, error.details);
      }

      onSources?.();
      prefetchSources(this, vehicle);

      const relevant = selectSources(this.index, new Set(), vehicle, this.maxPages || 35).length;

      this.log('search_sources', { query: result.query, received: result.results?.length || 0,
        indexed: this.index.size, relevant });

      if (relevant && !earlyTimer) earlyTimer = setTimeout(releaseEarly, 100);
    };

    const work = (async () => {
      let failedBatch;

      try {
        const results = await this.browse(batch, { country: vehicle.country,
          provider: this.searchProvider, concurrency: this.searchProvider === 'serper' ? 6 : this.searchProvider === 'openserp' ? 2 : 3, signal,
          state: this.searchState,
          searchBudget: this.searchBudget, searchPhase: 'research',
          remainingMs: () => this.timing?.remainingMs(signal) ?? Infinity,
          onEvent: (event, detail) => this.log(event, detail),
          onEngineRequest: engine => { this.engineSearches[engine] = (this.engineSearches[engine] || 0) + 1; },
          onEngineComplete: (engine, { failed }) => { if (failed) this.failedBrowserUses++; },
          serperCost: this.serperCost,
          onSource: accept, onResults: accept });

        for (const result of results) for (const warning of result.warnings || []) {
          this.warn('search_engine', `${result.query}: ${warning.message}`, warning.details);
        }

        for (const result of results) if (result.error) {
          const error = searchFailure(result.error, result.errorDetails, this.searchProvider);
          this.warn('search', `${result.query}: ${error.message}`, error.details);
          if (error.blocksSearch) this.searchBlocked = error;
        }

        indexResults(results, this.index);

        if (results.length && results.every(result => result.error)) failedBatch = searchFailure(results[0].error, results[0].errorDetails, this.searchProvider);

        this.log('search_complete', { queries: batch.length, indexedSources: this.index.size });
      } catch (error) {
        if (signal.aborted && this.index.size) {
          this.timing?.signal.throwIfAborted();
          this.warn('search', 'Search deadline reached; keeping results already received from the engines',
            { code: 'SEARCH_DEADLINE', provider: this.searchProvider, retryable: true });
          this.stageTimes.search = (this.stageTimes.search || 0) + performance.now() - started;

          return;
        }

        if (signal.aborted) {
          const failure = searchFailure(signal.reason, undefined, this.searchProvider);

          this.searchFailures.push(failure);
          this.warn('search', failure, failure.details);

          return;
        }

        failedBatch = searchFailure(error, undefined, this.searchProvider);
        this.searchFailures.push(failedBatch);
        this.warn('search', failedBatch, failedBatch.details);

        if (failedBatch.blocksSearch) this.searchBlocked = failedBatch;
      }

      this.stageTimes.search = (this.stageTimes.search || 0) + performance.now() - started;

      if (signal.aborted && this.index.size) return;

      signal.throwIfAborted();

      // Do not spend on planning when the search service produced no usable sources.
      // Successful results in a partially failed batch remain available for research.
      if (!this.index.size && (this.searchBlocked || failedBatch)) throw this.searchBlocked || failedBatch;
    })();

    this.searchJobs.push(work);

    try { await Promise.race([work, earlyResults]); }
    finally { clearTimeout(earlyTimer); clearTimeout(progressTimer); }
  }

  async clarifyNames(vehicle, signal, selectedNames) {
    return clarifyNameBatch(this, vehicle, signal, selectedNames);
  }

  async readSources(sources, vehicle, signal, onComplete = () => {}, { useProvidedSignal = false } = {}) {
    // Name clarification follows the initial extraction wave. Its own bounded
    // window must cover search, fetch and analysis of the selected page.
    const nameResearch = sources.length > 0 && sources.every(source => source.nameResearch);
    const fetchSignal = nameResearch || useProvidedSignal ? signal : this.fetchSignal || signal;
    const cancellationSignal = nameResearch || useProvidedSignal ? signal
      : this.extractionSignal || this.timing?.signal || fetchSignal;

    signal = nameResearch || useProvidedSignal ? signal : this.extractionSignal || signal;

    // Fetch and extraction have separate limits. A slow site cannot delay analysis of its peers.
    await Promise.all(sources.map(async (source) => {
      if (conflictingMakeModel(source, vehicle)) {
        this.log('source_skip_conflicting_make', { url: source.url });
        return;
      }
      const leads = nameLeads(source);
      const relevant = candidate => !leads.length || leads.some(lead =>
        relatesToNameLead(candidate, lead.name, lead.codes));
      const scopedKey = JSON.stringify([source.url, leads]);
      if (fetchSignal.aborted || (leads.length ? this.nameReads.has(scopedKey) : this.attempted.has(source.url))) return;

      if (leads.length) this.nameReads.add(scopedKey);
      this.attempted.add(source.url);

      const page = { ...source, id: `P${this.pages.length + 1}`, status: 'pending', fetchStarted: false, candidates: [] };

      this.pages.push(page);

      try {
        const fetched = await this.fetchLimit(async () => {
          // Admission closes before extraction. The parent cutoff also bounds
          // active downloads, including retries and reader fallback.
          const budget = PAGE_FETCH_BUDGET_MS;

          if (fetchSignal.aborted || cancellationSignal.aborted) return { status: 'skipped', text: '',
            fetchStarted: false, errorCode: 'PAGE_BUDGET_EXHAUSTED',
            error: 'Not started: page fetch admission has closed' };

          page.fetchStarted = true;
          const results = await this.getPagePool().fetchPages([source.url], { concurrency: 1,
            timeoutMs: budget, totalTimeoutMs: budget, signal: cancellationSignal });

          if (!results?.[0]) throw new Error('Page fetch returned no result');

          return results[0];
        });

        Object.assign(page, fetched, { url: source.url });

        if (page.status !== 'ok' || !page.text?.trim()) return;

        // A fetched model archive may publish a dedicated page for the exact
        // requested year. Read that page first so decades of unrelated rows
        // do not become candidate reviews. If it fails, analyze this archive.
        const scopedUrl = !nameResearch && catalogYearLink(page, vehicle);
        if (scopedUrl && this.pages.filter(item => !item.nameResearch).length < this.maxPages) {
          await this.readSources([{ ...source, url: scopedUrl,
            title: `${source.title || vehicle.model} ${vehicle.manufacturingYear}` }], vehicle, signal);
          const scopedPage = this.pages.find(item => item.url === scopedUrl);
          if (scopedPage?.status === 'ok' && scopedPage.candidates.length) {
            this.log('catalog_year_scope', { archiveUrl: source.url, url: scopedUrl,
              candidates: scopedPage.candidates.length });
            return;
          }
        }

        const continuations = [...page.text.matchAll(/^Catalog continuation: (https?:\/\/\S+)/gm)];

        indexResults([{ query: `Linked by ${source.url}`, results: continuations.map((match) => ({
          url: match[1], title: `${source.title} catalog continuation`, snippet: `Linked by ${source.url}`,
        })) }], this.index);

        const extractionVehicle = nameResearchVehicle(source, vehicle);
        const key = createHash('sha256').update(JSON.stringify([extractionVehicle, page.text])).digest('hex');
        const cached = this.extractions.get(key);
        const extraction = cached || this.analyzePage(page, extractionVehicle, {
          request: this.options.request, apiKey: this.options.apiKey,
          batchPages: true, structuredFirst: true, ...this.options.pageAnalysis, provider: 'openai', signal,
          deferAudits: true, sectionCache: this.sectionCache, providerState: this.extractionState,
          modelRouting: this.routing,
          scheduler: this.scheduler, timing: this.timing,
          onWait: ({ event, ...detail }) => this.log(event, { url: page.url, ...detail }),
          onUsage: (details) => this.cost.record('pageAnalysis', details),
          onCandidates: (candidates) => {
            page.candidates.push(...candidates.filter(relevant));
            if (!source.sharedPaintDonor) this.catalogs?.start(candidateInventory([page],
              { manufacturer: vehicle.brand, vehicle }));
          },
        });

        if (!cached) {
          this.extractions.set(key, extraction);
          extraction.catch(() => this.extractions.delete(key));
        }

        let result = await extraction;
        if (result.skippedReason) this.log('page_analysis_skipped', { url: page.url, reason: result.skippedReason });
        if (result.skippedSegments) this.log('page_analysis_scoped', {
          url: page.url, skippedSegments: result.skippedSegments, reason: 'name_lead_absent_from_segments',
        });

        if (cached) {
          result = { ...result, requests: 0, usage: undefined };
          this.log('page_analysis_reused', { url: page.url });
        }

        // Do not reuse incomplete results on future pages; another fetch may succeed.
        if (result.failures?.length) this.extractions.delete(key);

        page.candidates = (result.candidates || []).filter(relevant);
        if (!source.sharedPaintDonor) this.catalogs?.start(candidateInventory([page],
          { manufacturer: vehicle.brand, vehicle }));
        page.failures = [...(result.failures || [])];
        page.fallbackSegments = result.fallbackSegments || [];
        this.modelCalls.pageAnalysis += result.requests ?? 1;
        this.usage('pageAnalysis', result.usage);

        if (page.failures.length) this.warn('extraction',
          `${page.url}: ${page.failures.length} incomplete passes; ${page.failures[0].error}`);
        this.log('page_complete', { url: page.url, candidates: page.candidates.length,
          segments: result.segments || 1, requests: result.requests ?? 1 });
      } catch (error) {
        page.error = error.message;

        if (page.status === 'ok') {
          page.fallbackSegments = [{ segment: 1, text: page.text }];
          this.warn('extraction', `${page.url}: ${error.message}`);
        } else {
          page.status = cancellationSignal.aborted ? (page.fetchStarted ? 'cancelled' : 'skipped') : 'error';
          page.errorCode = cancellationSignal.aborted ? 'PAGE_CANCELLED' : error.code || 'PAGE_FETCH_FAILED';
        }
      } finally {
        if (leads.length) page.candidates = page.candidates.filter(candidate =>
          leads.some(lead => relatesToNameLead(candidate, lead.name, lead.codes)));
        onComplete(page);
      }
    }));
  }

  async reviewCandidate(candidate, vehicle, reviewSignal, stage, recovery) {
    return reviewCandidate(this, candidate, vehicle, reviewSignal, stage, recovery);
  }

  async recoverPage(page, vehicle, signal, { maxSegments = Infinity } = {}) {
    const leads = nameLeads(page);
    const relevant = candidate => !leads.length || leads.some(lead =>
      relatesToNameLead(candidate, lead.name, lead.codes));
    const literal = literalPaintRows(page.fallbackSegments.map(segment => segment.text).join('\n'), vehicle)
      .filter(relevant);

    if (literal.length) {
      page.candidates.push(...literal);
      this.catalogs?.start(candidateInventory([page], { manufacturer: vehicle.brand, vehicle }));
      this.log('page_literal_recovery', { url: page.url, candidates: literal.length });
    }

    // Recovery segments are independent. Try the cheapest text first, so a
    // budget rejection cannot hide a smaller segment that still fits.
    const segments = [...page.fallbackSegments].sort((a, b) => a.text.length - b.text.length);
    let attempted = 0;
    for (const segment of segments) {
      if (signal.aborted || this.pageRecoveryBudgetExhausted || attempted >= maxSegments) break;
      attempted++;

      try {
        const result = await this.recoveryLimit(() => this.pageRecoveryBudgetExhausted ? null : this.mainAgent(
          `recover_${page.id}_${segment.segment}`, RECOVERY_SCHEMA,
          { vehicle, url: page.url, opening: page.text.slice(0, 1200), text: segment.text },
          readFile('gemini_page_color_agent/prompts/system.md'), signal));

        if (result === null) break;

        if (!Array.isArray(result.candidates)) throw new Error('Recovery returned no candidate array');

        const normalize = (text) => text.replace(/\s+/g, ' ').trim().toLowerCase();
        const source = normalize(page.text);
        const accepted = result.candidates.filter(candidate =>
          typeof candidate.name === 'string' && candidate.name.trim() && Array.isArray(candidate.evidence)
          && candidate.evidence.length && candidate.evidence.every((text) => typeof text === 'string'
            && text.trim() && source.includes(normalize(text)))
          && candidate.evidence.some((text) => normalize(text).includes(normalize(candidate.name))));

        if (accepted.length !== result.candidates.length) throw new Error('Recovery returned unsupported candidate evidence');

        page.candidates.push(...accepted.filter(relevant));
        this.catalogs?.start(candidateInventory([page], { manufacturer: vehicle.brand, vehicle }));
        page.fallbackSegments = page.fallbackSegments.filter(item => item.segment !== segment.segment);
        this.log('page_recovery_complete', { url: page.url, segment: segment.segment, candidates: page.candidates.length });
      } catch (error) {
        this.warn('extraction_recovery', `${page.url}: ${error.message}`);

        // After the shortest remaining segment fails admission, larger ones
        // need at least as much input budget. Retain them for diagnostics.
        const pageExhausted = error.details?.pageSpentUsd >= error.details?.pageLimitUsd;
        if (error.code === 'AI_BUDGET_LIMIT') {
          if (pageExhausted) this.pageRecoveryBudgetExhausted = true;
          this.log('page_recovery_budget_exhausted', { url: page.url,
            remainingSegments: page.fallbackSegments.length });
          break;
        }
      }
    }
  }

  // Run lifecycle: collect stable evidence, review, match, then verify.
  // Network work overlaps within stages; stage results have explicit ownership.
  loop(inputVehicle) {
    return capacityContext.run({ runId: this.runId }, () => this.runLoop(inputVehicle));
  }

  async runLoop(inputVehicle) {
    // Reject reuse before entering cleanup: another invocation may still own
    // these queues, timers and catalog processes.
    if (this.used) {
      throw Object.assign(new Error('Create a new AgenticLoop for each vehicle'), {
        code: 'AGENT_ALREADY_USED',
      });
    }
    this.used = true;

    const started = performance.now();
    let timing, admission;

    try {
      // 1. Validate input and allocate deadlines, catalogs and overlapping queues.
      const targetTimeMs = this.options.targetTimeMs ?? DEFAULT_TARGET_TIME_MS;
      const maxTimeMs = this.options.maxTimeMs ?? Math.min(DEFAULT_MAX_TIME_MS, targetTimeMs * 2);

      if (!Number.isInteger(targetTimeMs) || targetTimeMs < 1000 || targetTimeMs > DEFAULT_MAX_TIME_MS
        || !Number.isInteger(maxTimeMs) || maxTimeMs < targetTimeMs || maxTimeMs > DEFAULT_MAX_TIME_MS) {
        throw new Error('Time target and maximum must be integers with 1000 <= target <= maximum <= 100000 ms');
      }

      timing = this.timing = new RunTiming({ maxCapacityWaitMs: this.options.maxCapacityWaitMs, signal: this.options.signal,
        pauseForCapacity: false, softDeadlines: true, targetTimeMs, hardLimitMs: maxTimeMs });

      const vehicle = validateVehicle(inputVehicle);
      this.vehicle = vehicle;

      admission = await admitRun(this.options, this.scheduler, timing, this.log.bind(this));

      if (!this.options.request && !(this.options.apiKey || process.env.OPENAI_API_KEY
        || this.options.modelRouting?.openrouterApiKey || process.env.OPENROUTER_API_KEY)) {
        throw new Error('OPENAI_API_KEY or OPENROUTER_API_KEY is required for research');
      }

      if (this.analyzePage === analyzePage) {
        const config = pageAnalysisConfig({ apiKey: this.options.apiKey, ...this.options.pageAnalysis, provider: 'openai' });
        if ((!config.apiKey && !(this.options.modelRouting?.openrouterApiKey || process.env.OPENROUTER_API_KEY))
          || !config.model) throw new Error(`Missing API key or model for ${config.provider} extraction`);
      }

      this.maxSearches = this.options.maxSearches ?? 10;
      this.maxNameSearches = this.options.maxNameSearches ?? 6;
      this.maxPaletteSearches = this.options.maxPaletteSearches ?? 2;
      this.maxPages = this.options.maxPageFetches ?? 24;

      for (const [name, value, min] of [['maxSearches', this.maxSearches, 4],
        ['maxNameSearches', this.maxNameSearches, 0],
        ['maxPaletteSearches', this.maxPaletteSearches, 0],
        ['maxPageFetches', this.maxPages, 1]]) {
        if (!Number.isInteger(value) || value < min) throw new Error(`${name} must be an integer >= ${min}`);
      }

      this.researchBudget = pipelineDeadlines(timing, targetTimeMs, maxTimeMs);
      const { cutoffs: deadlines, signals } = this.researchBudget;
      this.workSignal = signals.verification;
      this.reviewSignal = signals.review;
      this.repairSignal = signals.repair;
      this.omissionSignal = signals.matching;
      this.verificationSignal = signals.verification;

      this.fetchLimit = createLimiter(this.options.fetchConcurrency || 20);
      this.getPagePool();
      this.recoveryLimit = createLimiter(2);
      const researchSignal = this.searchSignal = signals.search;

      this.fetchSignal = signals.fetch;
      this.extractionSignal = signals.extraction;
      this.discoverySignal = timing.deadlineAt(Math.min(DISCOVERY_TARGET_MS, maxTimeMs * 0.4));
      this.discoveryFetchSignal = timing.deadlineAt(Math.min(DISCOVERY_TARGET_MS - 4000, maxTimeMs * 0.36));
      this.recoverySignal = signals.recovery;
      this.nameClarificationSignal = signals.nameClarification;


      this.catalogs = new CatalogResearch(vehicle, {
        deferIdentity: true,
        databasePath: this.options.databasePath, basfDatabasePath: this.options.basfDatabasePath,
        modelDatabasePath: this.options.modelDatabasePath,
        lookup: this.options.catalogLookupFn,
        signal: this.repairSignal, identitySignal: this.extractionSignal,
        review: this.mainAgent.bind(this), warn: this.warn.bind(this), log: this.log.bind(this),
      });

      this.log('run_start', { vehicle, targetTimeMs, maxTimeMs,
        deadlineMode: 'soft_target_hard_maximum', deadlines,
        maxSearches: this.maxSearches, maxPages: this.maxPages, maxBrowserUses: this.searchBudget.limit });
      const matchingSignal = signals.matching;
      let matchingBatch = 0;

      this.codeMatches = new CodeMatchPipeline(colors =>
        this.matchColors(colors, vehicle, matchingSignal, ++matchingBatch));
      this.reviewPipeline = new CandidateReviewPipeline((candidate, stage) =>
        this.reviewCandidate(candidate, vehicle, this.reviewSignal, stage), {
        pages: () => this.evidencePages(), signal: this.reviewSignal, onEvent: this.log.bind(this),
      });


      // 2. Build a stable shared evidence inventory before any review or match.
      await discover(this, vehicle, researchSignal);
      // No speculative downloads survive collection. Completed text remains
      // available to clarification/verification without becoming extra AI work.
      await this.pagePool.stopPrefetch();

      // A body maker may publish a named refinish shade without a public
      // model palette. Unlinked extracted names must not suppress recovery;
      // the usual review and verification still apply to every lead.
      if (!hasModelLinkedPaint(this, vehicle)) {
        await recoverManufacturerPaints(this, vehicle, this.reviewSignal);
        this.discoveryCoverage = finalDiscoveryCoverage(this);
      }

      timing.signal.throwIfAborted();

      this.stageTimes.research = performance.now() - started;

      // Order only, never exclude by name: give likely requested-family paints
      // first access to the shared budget, then review uncertain and other hues.
      const candidates = prioritizeCandidates(this.candidates(), this.evidencePages(), vehicle);

      const inventoryBudget = this.routing.budget?.planInventory?.(candidates.length);
      if (inventoryBudget) this.log('inventory_budget', inventoryBudget);

      this.catalogs.start(candidates);
      this.dump('evidence', { vehicle, pages: this.pages, catalogPages: this.catalogPages,
        snippetPages: this.snippetPages, candidates });

      if (!candidates.length && !observedColorFallback(this.pages, vehicle)) {
        if (this.searchBlocked) throw this.searchBlocked;

        if (!this.pages.some(page => page.status === 'ok')) {
          const code = this.pages.some(page => page.fetchStarted) ? 'RESEARCH_FETCH_FAILED'
            : researchSignal.aborted ? 'SEARCH_TIMEOUT' : 'SEARCH_NO_RELEVANT_SOURCES';
          const failedPages = this.pagePool.records.filter(page => page.status === 'error');
          const failedHosts = [...new Set(failedPages.map(page => new URL(page.url).hostname))];

          throw Object.assign(new Error(code === 'RESEARCH_FETCH_FAILED'
            ? 'Research pages could not be fetched within the available budget'
            : 'Search produced no fetchable vehicle paint sources within the available budget'),
          { details: { code, stage: code === 'RESEARCH_FETCH_FAILED' ? 'fetch' : 'search',
            provider: this.searchProvider, retryable: true,
            action: 'Try accessible paint sources on other domains; for an individually painted bus, obtain its operator or body paint label.',
            indexedSources: this.index.size, searchFailures: this.searchFailures.length,
            failedHosts, timedOutPages: failedPages.filter(page => page.errorCode === 'PAGE_TIMEOUT').length,
            blockedPages: failedPages.filter(page => /HTTP (?:401|403|451)\b/i.test(page.error || '')).length } });
        }

        throw new Error('No source-grounded named paint candidates found');
      }

      const readablePages = this.pages.filter((page) => page.status === 'ok').length;

      if (this.discoveryCoverage?.needsExpansion) this.warn('depth',
        `Read ${readablePages} pages; independent paint-source coverage remains insufficient`);

      if (this.finalReviewEnabled && !this.options.verifyFinalColorsFn) {
        this.verificationResearch = new VerificationResearch(vehicle, {
          timing, signal: this.verificationSignal, searchSignal: signals.verificationSearch, browse: this.browse,
          fetchPages: this.pagePool.fetchPages.bind(this.pagePool),
          provider: this.searchProvider, searchState: this.searchState,
          searchBudget: this.searchBudget,
          primeDuringReview: true,
          getExistingPages: () => [...this.pages, ...[...this.pagePool.entries.values()]
            .map(entry => entry.page).filter(page => page?.status === 'ok')],
          reuseEvidence: true, serperCost: this.serperCost,
          onQuery: query => { this.queries.add(query); this.verificationQueries.add(query); },
          onEngineRequest: engine => { this.engineSearches[engine] = (this.engineSearches[engine] || 0) + 1; },
          onEngineComplete: (_engine, { failed }) => { if (failed) this.failedBrowserUses++; },
          onFetchedPage: page => this.pages.push({ ...page, id: `VFP${this.pages.length + 1}` }),
          warn: this.warn.bind(this), log: this.log.bind(this),
        });
      }

      // 3. Review the stable inventory and repair only flagged decisions.
      this.settledWork = new SettledReviewWork(this, vehicle);
      const reviewState = await reviewInventory(this, vehicle, candidates);
      this.reviewState = reviewState;
      this.routing.budget?.finishReviews?.();
      const completionReview = await repairUnreviewed(this, vehicle, candidates, reviewState);
      const { colors, reviewedCandidates, unreviewedCandidates, unresolvedNames, decisions } = reviewState;

      const palette = { automobileType: vehicle.automobileType, make: vehicle.brand || 'unknown', model: vehicle.model,
        year: vehicle.manufacturingYear, market: vehicle.country || 'unknown', version: 'unknown', colors,
        ...(vehicle.paintFinish && { paintFinish: vehicle.paintFinish }) };

      if (this.finalReviewEnabled) this.routing.budget?.setVerificationWorkload?.(Math.max(1, colors.length));
      this.routing.budget?.finishReviews?.();

      // 4. Match the stable approved palette; failed attempts may retry once.
      // Omitted candidates are disjoint from the approved palette: audit them
      // while matching approved colors. Both use the same capacity/budget gates.
      const [matched, omissionReview] = await Promise.all([
        this.codeMatches.finish(colors),
        this.settledWork.finish(reviewedCandidates, decisions, unresolvedNames),
      ]);
      const coded = { ...palette, colors: matched };

      // 5. Apply one omission repair wave before final formatting.
      if (omissionReview.flagged) {
        unresolvedNames.length = 0;
        const repaired = reviewedColors(reviewedCandidates, decisions, {
          onWarning: message => this.warn('review', message),
          onUnresolved: candidate => unresolvedNames.push(candidate),
        });
        coded.colors = await this.codeMatches.finish(repaired);
        colors.splice(0, colors.length, ...repaired);
        this.dump('candidate-decisions', { candidates, decisions, colors: repaired });
      }
      const completion = paletteCoverage(colors, coded.colors, this.matchingExclusions,
        this.discoveryCoverage, unreviewedCandidates);
      coded.colors = completion.colors;
      this.dump('completion-review', { ...completion.summary, ...completionReview });
      this.routing.budget?.finishCompletionRepairs?.();

      // Also enforce the rule if the matcher fails: unknown/conflicting colors
      // survive, and only a grounded mismatch is excluded. Internal evidence
      // markers are removed before either public output format is produced.
      const finishExcluded = [];
      if (vehicle.paintFinish) coded.colors = coded.colors.map(color => {
        const checked = applyMatchedFinish(color, color.code_candidates || [], vehicle.paintFinish,
          detail => { finishExcluded.push(detail); this.log('finish_exclusions', { colors: [detail] }); });

        if (!checked) return null;

        const { _finishRelations, ...publicColor } = checked;

        return { ...publicColor, universal_code: checked.code_candidates.length === 1
          ? checked.code_candidates[0].universal_code : '' };
      }).filter(Boolean);

      timing.signal.throwIfAborted();
      await this.reviewPipeline.drain();
      await this.catalogs.drain();

      // Spend at most two remaining browser slots on final foreign-language
      // names. This downloads text only; the settled code matcher is not rerun.
      await researchPortugueseNames(this, coded.colors, vehicle);

      // Localize only after review and code matching have settled. Keep the
      // foreign identity and any unresolved code unchanged.
      for (const color of coded.colors) {
        const local = webPortugueseName(color, this.pages, vehicle);
        if (!local) continue;
        color._webName = local;
        color.aliases = [...new Set([...(color.aliases || []), color.name])];
        color.sources = [...new Set([...(color.sources || []), ...local.sources.map(source => source.url)])];
        (color.source_evidence ||= []).push(...local.sources.map(source => ({ url: source.url,
          passages: [source.passage], source_name: local.name, paint_codes: [source.code] })));
        this.log('web_name_localized', { original: color.name, name: local.name,
          code: local.sources[0].code, sources: local.sources.map(source => source.url) });
      }

      const tokenUsage = Object.values(this.tokenUsageByAgent).reduce((sum, usage) => ({
        inputTokens: sum.inputTokens + usage.inputTokens, outputTokens: sum.outputTokens + usage.outputTokens,
        totalTokens: sum.totalTokens + usage.totalTokens,
      }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });

      const cost = this.costSummary();

      if (cost.overTarget) this.warn('cost', `Estimated AI cost $${cost.estimatedCostUsd} exceeds target $${cost.targetUsd}`);

      const timingSummary = timing.summary();
      const result = { ...coded, runId: this.runId, tokenUsage, tokenUsageByAgent: this.tokenUsageByAgent, cost,
        modelCalls: this.modelCalls, ...this.retrievalSummary(),
        totalTimeByStageMs: this.stageTimes, totalTimeMs: timingSummary.totalMs, timing: timingSummary,
        identityCodes: [...inventoryCodes(this.evidencePages())],
        reviewAliasGroups: reviewState.groups.filter(group => group.length > 1).map(group => group.map(candidate => candidate.name)),
        research: { status: this.warnings.length ? 'partial' : 'complete',
          matchingCoverage: this.codeMatches.coverage(colors),
          identityArtifacts: [...(this.identityArtifacts?.values() || [])],
          completionReview: { ...completion.summary, ...completionReview },
          discoveryCoverage: this.discoveryCoverage,
          candidatesReviewed: reviewedCandidates.length, unreviewedCandidates, unresolvedNames, omissionReview, sourceDomains: new Set(this.pages
            .filter((page) => page.status === 'ok').map((page) => new URL(page.url).hostname)).size,
          candidateSourceDomains: new Set(coded.colors.flatMap((color) => color.sources)
            .map((url) => new URL(url).hostname)).size,
          warnings: this.warnings },
      };

      let response = withCompletion(finalOutput(result, { format: this.options.outputFormat }));
      let fallback = null;

      // The exception is decided only after review, matching, finish filtering
      // and final formatting have left the normal palette empty. It reuses a
      // paint name actually observed in this run and never assigns a new code.
      if (!response.colors.length && canUseEmptyFallback({ candidates, reviewedCandidates,
        unreviewedCandidates, unresolvedNames, omissionReview,
        verificationEnabled: this.options.verification !== false })) {
        fallback = emptyPaletteFallback(candidates, decisions, this.evidencePages(),
          vehicle, result.identityCodes);
        if (fallback) {
          const excluded = [...finishExcluded, ...(this.matchingExclusions || [])]
            .find(row => row.reason === 'incompatible_finish'
              && printedNameKey(row.name) === printedNameKey(fallback.color.name));
          if (excluded) {
            fallback.color.finishMatch = 'incompatible';
            fallback.report.normalFilter = 'incompatible_finish';
          }
          result.colors = [fallback.color];
          result.research.status = 'partial';
          this.log('empty_palette_fallback', fallback.report);
          response = withCompletion(finalOutput(result, { format: this.options.outputFormat }));
        }
      }

      // When no complete paint name survived, an explicit color field on a
      // fetched model listing can still give the shop an appearance lead.
      // It is marked as a generic hue and never receives an inferred code.
      if (!response.colors.length && (!candidates.length || canUseEmptyFallback({
        candidates, reviewedCandidates, unreviewedCandidates, unresolvedNames, omissionReview,
        verificationEnabled: this.options.verification !== false,
      }))) {
        fallback = observedColorFallback(this.pages, vehicle);
        if (fallback) {
          result.colors = [fallback.color];
          result.research.status = 'partial';
          this.log('observed_hue_fallback', fallback.report);
          response = withCompletion(finalOutput(result, { format: this.options.outputFormat }));
        }
      }

      this.dump('result', result);

      // An explicit opt-in can still run the separate final verifier.
      if (this.finalReviewEnabled && response.colors.length) {
        this.dump('initial-response', response);
        this.log('initial_response_ready', { colors: response.colors.length, durationMs: timing.summary().totalMs });

        // Optional streaming hook: a caller can publish this immutable snapshot
        // now, then replace it with the enriched response returned by loop().
        try {
          const published = this.options.onInitialResponse?.(structuredClone(response));
          if (published?.catch) published.catch(error => this.log('initial_response_callback_error', { error: error.message }));
        }
        catch (error) { this.warn('initial_response_callback', error); }

        const verificationStarted = performance.now();
        let verified;

        try {
          verified = await (this.options.verifyFinalColorsFn || verifyFinalColors)(response, vehicle, {
            timing, signal: this.verificationSignal,
            browse: this.browse, fetchPages: this.pagePool.fetchPages.bind(this.pagePool), review: this.mainAgent.bind(this),
            provider: this.searchProvider, searchState: this.searchState, existingPages: this.pages,
            searchBudget: this.searchBudget,
            reuseEvidence: true, research: this.verificationResearch,
            retryUnchecked: true, budget: this.routing.budget,
            catalogColors: coded.colors,
            modelCatalogPages: this.catalogPages,
            onQuery: query => { this.queries.add(query); this.verificationQueries.add(query); },
            onEngineRequest: engine => { this.engineSearches[engine] = (this.engineSearches[engine] || 0) + 1; },
            onEngineComplete: (engine, { failed }) => { if (failed) this.failedBrowserUses++; },
            serperCost: this.serperCost,
            onFetchedPage: page => this.pages.push({ ...page, id: `VFP${this.pages.length + 1}` }),
            warn: this.warn.bind(this), log: this.log.bind(this),
          });
        } catch (error) {
          this.warn('verification', error);
          verified = { colors: response.colors.map(color => ({ ...color,
            verification: { reviewed: false, status: 'unverified', confirmed: [], conflicting: [],
              unknown: applicableFields(color, vehicle) } })),
          summary: { status: 'partial', coverage: 'incomplete', colorsChecked: 0,
            colorsUnchecked: response.colors.length, colorsConfirmed: 0, colorsTotal: response.colors.length } };
        }

        timing.signal.throwIfAborted();
        await this.verificationResearch?.drain();
        this.stageTimes.verification = performance.now() - verificationStarted;

        if (verified.summary.status !== 'complete') this.warn('verification',
          'Some final color data remains unverified or conflicting; see each color verification field');

        Object.assign(result, this.retrievalSummary(), {
          tokenUsage: Object.values(this.tokenUsageByAgent).reduce((sum, usage) => ({
            inputTokens: sum.inputTokens + usage.inputTokens, outputTokens: sum.outputTokens + usage.outputTokens,
            totalTokens: sum.totalTokens + usage.totalTokens,
          }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
          cost: this.costSummary(),
          totalTimeMs: timing.summary().totalMs, timing: timing.summary(),
        });

        if (result.cost.overTarget && !cost.overTarget) this.warn('cost',
          `Estimated AI cost $${result.cost.estimatedCostUsd} exceeds target $${result.cost.targetUsd}`);

        result.research.status = fallback || this.warnings.length ? 'partial' : 'complete';

        const { fetchedPages, ...enriched } = finalOutput(result, { format: this.options.outputFormat });

        response = { ...enriched, colors: verified.colors, verification: verified.summary, fetchedPages };
        this.dump('verification', verified);
        this.dump('result', { ...result, verification: verified });
      }

      const scoped = partitionPalette(response.colors, vehicle, this.pages, this.catalogPages);
      const fallbackColors = fallback && scoped.colors.length
        ? scoped.colors.map(color => ({ ...color,
          sourceApplicabilityScope: color.identityType === 'observed_hue'
            ? 'appearance_only' : color.applicabilityScope,
          applicabilityScope: 'fallback', isFallback: true })) : null;
      response = withCompletion({ ...response, ...scoped,
        ...(fallbackColors && { fallback: fallback.report, colors: fallbackColors,
          paletteScope: { modelCandidates: 0, manufacturerLeads: 0,
            fallbackCandidates: fallbackColors.length } }) });
      this.log('run_complete', { durationMs: result.totalTimeMs, colors: result.colors.length,
        pages: this.retrievalSummary().pagesFetched, modelCalls: this.modelCalls, timing: result.timing });
      this.dump('response', response);

      return response;
    } catch (error) {
      // Drain overlapping matches before reporting usage or closing their timers.
      timing?.abort(error);
      await this.settledWork?.drain();
      await this.reviewPipeline?.drain();
      await this.catalogs?.drain();
      await this.codeMatches?.drain();
      await this.verificationResearch?.drain();
      await this.pagePool?.drain();
      this.log('run_error', { error: error.message, durationMs: performance.now() - started });

      const result = { error: error.message, ...(error.details && { errorDetails: error.details }),
        runId: this.runId, warnings: this.warnings, ...this.retrievalSummary(),
        tokenUsageByAgent: this.tokenUsageByAgent, cost: this.costSummary(), totalTimeMs: performance.now() - started,
        ...(timing && { timing: timing.summary() }) };

      this.dump('result', result);

      const response = withCompletion(finalOutput(result, { format: this.options.outputFormat }));

      this.dump('response', response);

      return response;
    } finally {
      // Close only after dependent jobs have been observed; usage may arrive late.
      this.researchBudget?.close();
      clearTimeout(this.earlyReviewTimer);
      timing?.abort(new Error('Run finished'));
      await this.reviewPipeline?.drain();
      await this.catalogs?.drain();
      await this.verificationResearch?.drain();
      await this.pagePool?.drain();
      this.catalogs?.close();
      timing?.close();
      admission?.cancel();
    }
  }
}

module.exports = { AgenticLoop, browse, fetchPages };

if (require.main === module) {
  const sample = { automobileType: 'car', brand: 'Hyundai', model: 'Azera',
    manufacturingYear: 2017, predominantColor: 'branco', paintFinish: 'perolizado', country: 'Brazil' };

  try {
    const vehicle = process.argv[2] ? JSON.parse(process.argv[2]) : sample;
    new AgenticLoop({ onProgress: (event) => console.error(`[research] ${JSON.stringify(event)}`) })
      .loop(vehicle).then((result) => { console.log(JSON.stringify(result, null, 2));
        if (result.error) process.exitCode = 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
