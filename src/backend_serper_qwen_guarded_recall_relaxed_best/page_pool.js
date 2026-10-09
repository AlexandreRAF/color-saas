'use strict';

const { sourceUrl } = require('./source_index');
const { PAGE_FETCH_BUDGET_MS } = require('./fetch_pages');

function waitForPage(work, signal) {
  if (!signal) return work;
  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function retryable(page) {
  return page?.status === 'cancelled' || page?.status === 'skipped'
    || page?.status === 'error' && (page.errorCode === 'PAGE_TIMEOUT'
      || /timeout|timed out|fetch failed|network error|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|HTTP (?:408|425|429|5\d\d)/i.test(page.error || ''));
}

// One vehicle run owns this pool. Downloaded text is not an extraction job:
// only a research consumer can promote it into the evidence/model pipeline.
class PagePool {
  constructor({ fetchPages, signal, scheduler, concurrency = 20,
    prefetchConcurrency = 2, prefetchBuffer = 4, maxPrefetchPages = 8,
    retryTimedOutPages = true, log = () => {} }) {
    for (const [name, value, minimum] of [['concurrency', concurrency, 1],
      ['prefetchConcurrency', prefetchConcurrency, 0], ['prefetchBuffer', prefetchBuffer, 0],
      ['maxPrefetchPages', maxPrefetchPages, 0]]) {
      if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
    }

    this.fetch = fetchPages;
    this.signal = signal;
    this.scheduler = scheduler;
    this.concurrency = concurrency;
    this.prefetchConcurrency = Math.min(prefetchConcurrency, concurrency - 1);
    this.prefetchBuffer = prefetchBuffer;
    this.maxPrefetchPages = maxPrefetchPages;
    this.retryTimedOutPages = retryTimedOutPages;
    this.log = log;
    this.entries = new Map();
    this.records = [];
    this.queue = [];
    this.active = 0;
    this.activePrefetch = 0;
    this.prefetchClosed = false;
    this.stats = { hits: 0, inFlightHits: 0, prefetchScheduled: 0, prefetchUsed: 0, retries: 0 };
  }

  prefetchRoom() {
    if (this.prefetchClosed || this.signal?.aborted || !this.prefetchConcurrency) return 0;
    const buffered = [...this.entries.values()].filter(entry => !entry.demand
      && (!entry.settled || entry.page?.status === 'ok')).length;
    return Math.max(0, Math.min(this.prefetchBuffer - buffered,
      this.maxPrefetchPages - this.stats.prefetchScheduled));
  }

  unavailableHost(url) {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const records = this.records.filter(page =>
      new URL(page.url).hostname.replace(/^www\./, '') === host);
    if (records.some(page => page.status === 'ok')) return false;
    const failures = records.filter(page => page.status === 'error');
    // A blocked host should not consume every replacement slot. One isolated
    // timeout is inconclusive, but two failures from the same host are enough
    // to try other domains for the remainder of this vehicle run.
    return failures.some(page => /HTTP (?:401|403|451)\b/i.test(page.error || ''))
      || failures.length >= 2;
  }

  shouldRetry(page) {
    return retryable(page) && (this.retryTimedOutPages || page.errorCode !== 'PAGE_TIMEOUT');
  }

  prefetch(urls) {
    for (const url of urls) {
      if (!this.prefetchRoom()) break;
      const key = sourceUrl(url);
      if (this.entries.has(key)) continue;
      this.stats.prefetchScheduled++;
      this.enqueue(key, false, {});
    }
    // Let demanded pages from the same search callback take the first slots.
    queueMicrotask(() => this.pump());
  }

  get(url, options = {}) {
    options.signal?.throwIfAborted();
    this.signal?.throwIfAborted();
    const key = sourceUrl(url);
    let entry = this.entries.get(key);
    let reused = false;

    if (entry?.settled && this.shouldRetry(entry.page) && entry.attempt < 2) {
      this.stats.retries++;
      entry = this.enqueue(key, true, options, entry.attempt + 1);
    } else if (entry) {
      reused = true;
      this.stats.hits++;
      if (!entry.settled) this.stats.inFlightHits++;
      if (!entry.demand) {
        this.stats.prefetchUsed++;
        entry.demand = true;
      }
      this.log('page_pool_reused', { url: key, pending: !entry.settled });
    } else {
      entry = this.enqueue(key, true, options);
    }

    this.pump();
    return waitForPage(entry.promise, options.signal).then(page => {
      // A demanded page can be the only source for a paint that is absent from
      // the other palette pages. Retry one transient network failure while the
      // caller still has time; the pool coalesces concurrent demanders onto
      // that same second attempt.
      if (page.status === 'error' && this.shouldRetry(page) && entry.attempt < 2
        && !options.signal?.aborted && !this.signal?.aborted) return this.get(url, options);
      return { ...page, url, fetchReused: reused };
    });
  }

  fetchPages(urls, options = {}) {
    return Promise.all(urls.map(url => this.get(url, options)));
  }

  enqueue(url, demand, options, attempt = 1) {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const entry = { url, demand, options, attempt, promise, resolve,
      controller: new AbortController(), settled: false };
    this.entries.set(url, entry);
    this.queue.push(entry);
    return entry;
  }

  pump() {
    while (this.active < this.concurrency) {
      let index = this.queue.findIndex(entry => entry.demand);
      if (index < 0 && !this.prefetchClosed && this.activePrefetch < this.prefetchConcurrency) index = 0;
      if (index < 0 || !this.queue.length) break;
      const [entry] = this.queue.splice(index, 1);
      this.active++;
      const speculative = !entry.demand;
      if (speculative) this.activePrefetch++;
      this.download(entry).finally(() => {
        this.active--;
        if (speculative) this.activePrefetch--;
        this.pump();
      });
    }
  }

  async download(entry) {
    const record = { url: entry.url, status: 'pending', fetchStarted: false,
      prefetched: !entry.demand, attempt: entry.attempt };
    this.records.push(record);
    const signal = AbortSignal.any([entry.controller.signal, ...(this.signal ? [this.signal] : []),
      AbortSignal.timeout(PAGE_FETCH_BUDGET_MS)]);

    try {
      signal.throwIfAborted();
      record.fetchStarted = true;
      this.log('page_fetch_queued', { url: entry.url, prefetched: record.prefetched,
        attempt: entry.attempt, budgetMs: PAGE_FETCH_BUDGET_MS });
      const work = Promise.resolve().then(() => this.fetch([entry.url], {
        ...entry.options, concurrency: 1, scheduler: this.scheduler,
        timeoutMs: PAGE_FETCH_BUDGET_MS, totalTimeoutMs: PAGE_FETCH_BUDGET_MS,
        directRetries: 0, prefetch: !entry.demand, signal,
        onFetchState: state => {
          record.fetchStarted = state.started;
          if (state.started) this.log('page_fetch_start', { url: entry.url,
            prefetched: record.prefetched, attempt: entry.attempt, budgetMs: PAGE_FETCH_BUDGET_MS });
          entry.options.onFetchState?.(state);
        },
      }));
      const [page] = await waitForPage(work, signal);
      if (!page) throw new Error('Page fetch returned no result');
      entry.page = { ...page, url: entry.url };
      Object.assign(record, { status: page.status, error: page.error, errorCode: page.errorCode,
        fetchStarted: page.fetchStarted ?? record.fetchStarted });
    } catch (error) {
      const cancelled = this.signal?.aborted || entry.controller.signal.aborted;
      entry.page = { url: entry.url, status: !record.fetchStarted ? 'skipped' : cancelled ? 'cancelled' : 'error',
        text: '', error: error.message || String(error),
        errorCode: !record.fetchStarted ? 'PAGE_BUDGET_EXHAUSTED'
          : cancelled ? 'PAGE_CANCELLED' : signal.aborted ? 'PAGE_TIMEOUT' : error.code || 'PAGE_FETCH_FAILED',
        fetchStarted: record.fetchStarted };
      Object.assign(record, entry.page);
    } finally {
      entry.settled = true;
      entry.resolve(entry.page);
      this.log('page_fetch_complete', { ...record });
    }
  }

  async stopPrefetch() {
    this.prefetchClosed = true;
    const pending = [];
    for (const entry of this.entries.values()) {
      if (entry.demand || entry.settled) continue;
      const reason = new Error('Unused prefetch cancelled after discovery');
      entry.controller.abort(reason);
      const index = this.queue.indexOf(entry);
      if (index >= 0) {
        this.queue.splice(index, 1);
        entry.page = { url: entry.url, status: 'skipped', text: '', error: reason.message,
          errorCode: 'PAGE_CANCELLED', fetchStarted: false };
        entry.settled = true;
        entry.resolve(entry.page);
      }
      pending.push(entry.promise);
    }
    await Promise.all(pending);
  }

  async drain() {
    await this.stopPrefetch();
    await Promise.all([...this.entries.values()].map(entry => entry.promise));
  }

  summary() {
    return { ...this.stats,
      prefetchStarted: this.records.filter(page => page.prefetched && page.fetchStarted !== false).length,
      uniqueUrls: this.entries.size };
  }
}

module.exports = { PagePool };
