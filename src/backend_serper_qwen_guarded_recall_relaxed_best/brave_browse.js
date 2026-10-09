const { createLimiter, requestJson } = require('./runtime');
const { searchLocale: serperLocale } = require('./browse');
const { searchFailure } = require('./search_errors');
const { trackSearch } = require('./search_usage');

const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';
const COUNTRIES = new Set('AR AU AT BE BR CA CL DK FI FR DE HK IN ID IT JP KR MY MX NL NZ NO CN PL PT PH RU SA ZA ES SE CH TW TR GB US ALL'.split(' '));

function searchLocale(country) {
  const { gl, hl } = serperLocale(country);
  const region = gl?.toUpperCase();
  const language = hl === 'pt' ? (gl === 'pt' ? 'pt-pt' : 'pt-br') : hl === 'zh' ? 'zh-hans' : hl;

  return { country: COUNTRIES.has(region) ? region : 'ALL',
    ...(language && { search_lang: language }) };
}

async function searchOne(query, { request, apiKey, locale, signal, onQueryComplete }) {
  const started = performance.now();

  try {
    const url = new URL(BRAVE_URL);

    url.search = new URLSearchParams({ q: query, count: '10', result_filter: 'web',
      text_decorations: 'false', spellcheck: 'false', ...locale }).toString();

    const data = await requestJson(url.href, { method: 'GET',
      headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
    }, { request, timeoutMs: 5000, signal, schedule: { kind: 'search' } });

    if (data?.error || data?.type === 'ErrorResponse') {
      throw Object.assign(new Error(data.error?.detail || data.error?.message || 'Brave API error'), {
        status: data.error?.status, providerCode: data.error?.code,
      });
    }

    if (!data || typeof data !== 'object' || (data.web && !Array.isArray(data.web.results))) {
      throw new SyntaxError('Invalid Brave search results');
    }

    return { query, results: (data.web?.results || [])
      .filter(item => typeof item?.url === 'string' && item.url)
      .map(item => ({ title: item.title || '', url: item.url,
        snippet: item.description || '', date: item.page_age || item.age || '' })) };
  } finally { onQueryComplete?.(performance.now() - started); }
}

async function browse(queries, { request = fetch, apiKey = process.env.BRAVE_API_KEY,
  country, concurrency = 3, signal, onQueryComplete, onEngineRequest, onEngineComplete, international = false,
  searchBudget, searchPhase } = {}) {
  signal?.throwIfAborted();

  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw searchFailure('BRAVE_API_KEY is required to browse', undefined, 'brave');
  }

  if (!Array.isArray(queries) || queries.some(query => typeof query !== 'string' || !query.trim())) {
    throw new Error('browse expects an array of non-empty search queries');
  }

  const limit = createLimiter(concurrency);
  const locale = international ? { country: 'ALL' } : searchLocale(country);
  let blocked;

  return Promise.all(queries.map(query => limit(async () => {
    signal?.throwIfAborted();

    if (blocked) return { query, results: [], error: blocked.message, errorDetails: blocked.details, skipped: true };

    try {
      return await trackSearch('brave', lease => searchOne(query,
        { request: lease ? lease.wrap(request) : request, apiKey, locale, signal, onQueryComplete }),
        { signal, onEngineRequest, onEngineComplete, searchBudget, searchPhase });
    }
    catch (cause) {
      signal?.throwIfAborted();
      if (cause.code === 'BROWSER_BUDGET_EXHAUSTED') return { query, results: [], skipped: true, budgetExhausted: true };

      const error = searchFailure(cause, undefined, 'brave');

      if (error.blocksSearch) blocked = error;

      return { query, results: [], error: error.message, errorDetails: error.details };
    }
  })));
}

module.exports = { browse, searchLocale };
