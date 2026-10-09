'use strict';

const { sourceUrl } = require('./source_index');

// Public retrieval counters derived from one run; no fetching or model calls.
function summarizeRetrieval(run) {
  // Reporting only. Extraction failures do not turn a successful fetch into
  // a fetch error, and reader fallback attempts count as the same page URL.
  const recorded = new Set(run.pagePool?.records.map(page => sourceUrl(page.url)));
  // Preserve pages skipped before entering the pool, while counting reused
  // downloads only once. Retries intentionally retain their separate records.
  const pages = run.pagePool ? [...run.pagePool.records,
    ...run.pages.filter(page => !recorded.has(sourceUrl(page.url)))] : run.pages;
  const fetchedPages = pages.map(page => ({ url: page.url, status: page.status,
    ...(page.prefetched && { prefetched: true }),
    ...(page.attempt > 1 && { attempt: page.attempt }),
    ...(['error', 'cancelled', 'skipped'].includes(page.status) && { error: page.error || 'Page fetch did not complete' }),
    ...(page.errorCode && page.status !== 'ok' && { errorCode: page.errorCode }) }));

  const count = status => fetchedPages.filter(page => page.status === status).length;
  const engineUses = Object.values(run.engineSearches).reduce((sum, n) => sum + n, 0);
  const totalUses = run.searchBudget ? engineUses : engineUses || run.queries.size;

  return {
    ...(run.modelRequests && { modelRequests: structuredClone(run.modelRequests) }),
    ...(run.serperCost && { serperCost: run.serperCost.summary() }),
    ...(run.pagePool && { pagePool: run.pagePool.summary() }),
    ...(run.searchBudget && { searchBudget: run.searchBudget.summary() }),
    browserUses: { total: totalUses,
      failed: run.failedBrowserUses,
      serper: 0, brave: 0,
      [run.searchProvider]: totalUses,
      nameClarification: run.nameQueries.size,
      ...(run.localizationQueries?.size && { nameLocalization: run.localizationQueries.size }),
      ...(run.paletteQueries?.size && { paletteResearch: run.paletteQueries.size }),
      ...(run.codeQueries?.size && { codeClarification: run.codeQueries.size }),
      ...(run.verificationQueries.size && { finalVerification: run.verificationQueries.size }),
      ...(Object.keys(run.engineSearches).length && { uniqueQueries: run.queries.size, engines: { ...run.engineSearches } }) },
    pageFetchAttempts: pages.filter(page => page.fetchStarted !== false).length,
    pagesFetched: count('ok'), fetchErrors: count('error'),
    pagesCancelled: count('cancelled'), pagesSkipped: count('skipped'),
    pagesWithoutText: count('no_text'), pagesPending: count('pending'),
    fetchedPages,
  };
}

module.exports = { summarizeRetrieval };
