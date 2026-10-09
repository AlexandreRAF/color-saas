const { createLimiter } = require('./runtime');
const { searchRequest, sharedSearch } = require('./search_request');
const { searchLocale: serperLocale } = require('./browse');
const { searchFailure } = require('./search_errors');
const { resolveSearchUrl } = require('./search_urls');
const { sourceUrl } = require('./source_index');
const { trackSearch } = require('./search_usage');

const ENGINES = ['google', 'bing', 'duckduckgo'];

function searchEndpoint(host, engine = 'google') {
  try {
    if (typeof host !== 'string' || !host.trim()) throw new Error('Missing host');

    const value = host.trim();
    const url = new URL(value.includes('://') ? value : `http://${value}`);

    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash) throw new Error('Invalid host');
    if (!ENGINES.includes(engine)) throw new Error('Invalid engine');

    url.pathname = `${url.pathname.replace(/\/$/, '')}/${engine}/search`;

    return url.href;
  } catch {
    throw searchFailure('OPENSERP_HOST must be a host:port or an HTTP(S) base URL', undefined, 'openserp');
  }
}

function searchLocale(country) {
  const { gl } = serperLocale(country);
  // OpenSERP maps lang to Google's strict lr filter, not just its UI language.
  // Keep the market hint; the query language can then find international sources.
  return { ...(gl && { region: gl.toUpperCase() }) };
}

async function searchOne(query, { endpoint, engine, request, locale, signal, onQueryComplete, resolve,
  state, remainingMs, onEvent, onSource }) {
  const started = performance.now();

  try {
    const url = new URL(endpoint);

    url.search = new URLSearchParams({ text: query, limit: '10', format: 'json',
      extract: '0', features: 'false', ...locale }).toString();

    const data = await searchRequest(url.href, { request, engine, state, signal, remainingMs, onEvent });

    if (data?.error || data?.meta?.engines_failed?.includes(engine)) {
      const error = new Error(`OpenSERP ${engine} search failed: ${data?.error || 'engine unavailable'}`);
      error.status = Number.isInteger(data?.code) ? data.code : 502;
      throw error;
    }

    // The local v2 service returns an envelope; older OpenSERP servers return an array.
    const results = Array.isArray(data) ? data : data?.results;

    if (!Array.isArray(results)) throw new SyntaxError('Invalid OpenSERP search results');

    let unresolved = 0;
    const rows = await Promise.all(results.filter(item => !item?.type || item.type === 'organic')
      .map(async (item, rank) => {
        try {
          if (typeof item?.url !== 'string' || !item.url.trim()) throw new Error('Missing result URL');

          const destination = await resolve(item.url, signal);
          const row = { title: typeof item.title === 'string' ? item.title : '', url: sourceUrl(destination), engines: [engine], rank,
            snippet: typeof item.snippet === 'string' ? item.snippet : '',
            date: typeof item.date === 'string' ? item.date : '' };

          onSource?.(row);

          return row;
        } catch {
          signal?.throwIfAborted();
          unresolved++;
          onEvent?.('search_url_unresolved', { engine, query, url: item.url });

          return null;
        }
      }));

    const seen = new Set();
    const normalized = rows.filter(row => row && !seen.has(row.url) && seen.add(row.url));
    const error = unresolved ? searchFailure(Object.assign(new Error('Unresolved Google result URLs'),
      { code: 'SEARCH_UNRESOLVED_URLS' }), undefined, 'openserp') : null;

    return { query, results: normalized, ...(error && { error: error.message,
      errorDetails: { ...error.details, engine, unresolvedResults: unresolved } }) };
  } finally { onQueryComplete?.(performance.now() - started, engine); }
}

async function browse(queries, { request = fetch, host = process.env.OPENSERP_HOST,
  country, concurrency = 2, signal, onQueryComplete, onEngineRequest, onEngineComplete, onResults,
  onSource, onEvent = () => {}, remainingMs = () => Infinity,
  international = false, engines = ENGINES, state = {}, searchBudget, searchPhase } = {}) {
  signal?.throwIfAborted();

  if (!Array.isArray(queries) || queries.some(query => typeof query !== 'string' || !query.trim())) {
    throw new Error('browse expects an array of non-empty search queries');
  }

  if (!engines.length || engines.some(engine => !ENGINES.includes(engine))) throw new Error('Invalid OpenSERP engines');

  const endpoints = new Map(engines.map(engine => [engine, searchEndpoint(host, engine)]));
  const locale = international ? {} : searchLocale(country);

  // Independent queues keep a blocked engine from consuming its peers' slots.
  const limits = state.limits ||= new Map();

  for (const engine of engines) if (!limits.has(engine)) limits.set(engine, createLimiter(concurrency));

  const blocked = state.blocked ||= new Map();
  const redirectLimit = state.redirectLimit ||= createLimiter(8);
  const resolve = (url, jobSignal) => sharedSearch(state, `redirect:${url}`, ({ signal }) =>
    redirectLimit(() => resolveSearchUrl(url, { request, signal })), { signal: jobSignal });
  const publish = (query, result) => {
    onResults?.(result);
    onEvent('search_engine_complete', { query, engine: result.engine || result.results?.[0]?.engines?.[0],
      results: result.results.length, error: result.error, details: result.errorDetails });
    return result;
  };

  return Promise.all(queries.map(async query => {
    const responses = await Promise.all(engines.map(engine => sharedSearch(state,
      JSON.stringify([endpoints.get(engine), engine, locale, query]),
      job => limits.get(engine)(async () => {
      const { signal } = job;

      signal.throwIfAborted();

      if (blocked.has(engine)) return { query, engine, results: [], error: blocked.get(engine).message,
        errorDetails: { ...blocked.get(engine).details, engine }, skipped: true };

      let result;

      try {
        result = await trackSearch(engine, lease => searchOne(query, { endpoint: endpoints.get(engine), engine,
          request: lease ? lease.wrap(request) : request, locale,
          signal, onQueryComplete, resolve, state, remainingMs: job.remainingMs,
          onSource: job.onSource, onEvent: (event, detail) => onEvent(event, { query, ...detail }) }),
        { signal, onEngineRequest, onEngineComplete, searchBudget, searchPhase });
      } catch (cause) {
        signal?.throwIfAborted();
        if (cause.code === 'BROWSER_BUDGET_EXHAUSTED') return { query, engine, results: [], skipped: true, budgetExhausted: true };

        const error = searchFailure(cause, undefined, 'openserp');

        if (error.blocksSearch) blocked.set(engine, error);

        result = { query, results: [], error: error.message, errorDetails: { ...error.details, engine } };
      }

      // Expose completed engines immediately, even if another is slow or aborted later.
      return { ...result, engine };
    }), { signal, remainingMs, onSource: row => onSource?.({ query, results: [row] }) })
      .then(result => publish(query, result))));

    const merged = new Map();

    // Interleave by rank so the first engine cannot crowd out the others.
    for (let rank = 0; rank < Math.max(0, ...responses.map(row => row.results.length)); rank++) {
      for (const response of responses) {
        const row = response.results[rank];

        if (!row) continue;

        const previous = merged.get(row.url);

        if (previous) previous.engines = [...new Set([...previous.engines, ...row.engines])];
        else merged.set(row.url, { ...row });
      }
    }

    const warnings = responses.filter(row => row.error).map(row => ({ message: row.error, details: row.errorDetails }));
    const allFailed = responses.every(row => row.error && !row.results.length);
    const failure = allFailed ? searchFailure(Object.assign(new Error('All OpenSERP engines failed'), { status: 503 }), undefined, 'openserp') : null;

    return { query, results: [...merged.values()], ...(warnings.length && { warnings }),
      ...(failure && { error: failure.message, errorDetails: failure.details }) };
  }));
}

module.exports = { browse, searchEndpoint, searchLocale, ENGINES };
