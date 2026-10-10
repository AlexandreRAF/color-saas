const { createLimiter, requestJson } = require('./runtime');

const SERPER_URL = 'https://google.serper.dev/search';

const { searchFailure } = require('./search_errors');
const { trackSearch } = require('./search_usage');

function searchLocale(country) {
  if (country == null || (typeof country === 'string' && !country.trim())) return {};

  const name = typeof country === 'string' ? country.trim() : '';
  const regions = new Intl.DisplayNames(['en'], { type: 'region' });
  let countryCode = null;

  if (/^[a-z]{2}$/i.test(name)) {
    const code = name.toUpperCase();
    const displayName = regions.of(code);
    if (displayName !== code && displayName !== 'Unknown Region') countryCode = code.toLowerCase();
  }

  if (!countryCode) {
    for (let first = 65; first <= 90 && !countryCode; first++) {
      for (let second = 65; second <= 90; second++) {
        const code = String.fromCharCode(first, second);
        const displayName = regions.of(code);

        if (displayName !== code && displayName !== 'Unknown Region'
          && displayName.toLowerCase() === name.toLowerCase()) {
          countryCode = code.toLowerCase();
          break;
        }
      }
    }
  }

  const languages = {
    br: 'pt', pt: 'pt', es: 'es', mx: 'es', ar: 'es', cl: 'es', co: 'es',
    fr: 'fr', de: 'de', it: 'it', jp: 'ja', kr: 'ko', cn: 'zh',
  };

  if (!countryCode) return { location: name };

  return {
    location: regions.of(countryCode.toUpperCase()),
    ...(countryCode && { gl: countryCode }),
    ...(languages[countryCode] && { hl: languages[countryCode] }),
  };
}

async function searchOne(query, { request, apiKey, locale, onQueryComplete, onEvent, signal }) {
  const startedAt = performance.now();

  try {
    const data = await requestJson(SERPER_URL, {
      method: 'POST', headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 10, ...locale }),
    }, { request, timeoutMs: 5000, signal, onRetry: detail => {
      // Diagnostics must not prevent the existing bounded retry from running.
      try { onEvent?.('search_engine_retry', { engine: 'serper', query, ...detail }); }
      catch { /* Observer only. */ }
    } });

    if (data?.error || data?.message) throw new Error(data.error?.message || data.message || String(data.error));
    if (!Array.isArray(data?.organic)) throw new SyntaxError('Missing organic search results');

    return { query, results: data.organic
      .filter((item) => typeof item?.link === 'string' && item.link)
      .map((item) => ({ title: item.title || '', url: item.link,
        snippet: item.snippet || '', date: item.date || '' })) };
  } finally { onQueryComplete?.(performance.now() - startedAt); }
}

async function browse(queries, { request = fetch, apiKey = process.env.SERPER_API_KEY,
  country, concurrency = 6, onQueryComplete, onEvent, onResults, signal, onEngineRequest, onEngineComplete, serperCost,
  searchBudget, searchPhase } = {}) {
  signal?.throwIfAborted();

  if (!apiKey) throw searchFailure('SERPER_API_KEY is required to browse');

  if (!Array.isArray(queries) || queries.some((query) => typeof query !== 'string' || !query.trim())) {
    throw new Error('browse expects an array of non-empty search queries');
  }

  const limit = createLimiter(concurrency);
  const locale = searchLocale(country);
  const trackedRequest = serperCost ? serperCost.trackRequest(request) : request;
  let blocked;

  return Promise.all(queries.map((query) => limit(async () => {
    signal?.throwIfAborted();

    if (blocked) return { query, results: [], error: blocked.message, errorDetails: blocked.details, skipped: true };

    try {
      const result = await trackSearch('serper', lease => searchOne(query, {
        request: lease ? lease.wrap(trackedRequest) : trackedRequest, apiKey, locale, onQueryComplete, onEvent, signal,
      }),
        { signal, onEngineRequest, onEngineComplete, searchBudget, searchPhase });
      onResults?.(result);
      return result;
    }
    catch (cause) {
      signal?.throwIfAborted();
      if (cause.code === 'BROWSER_BUDGET_EXHAUSTED') return { query, results: [], skipped: true, budgetExhausted: true };

      const error = searchFailure(cause);

      if (error.blocksSearch) blocked = error;

      return { query, results: [], error: error.message, errorDetails: error.details };
    }
  })));
}

module.exports = { browse, searchLocale, searchFailure };
