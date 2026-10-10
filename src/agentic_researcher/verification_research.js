'use strict';

const { createLimiter } = require('./runtime');
const { sourceUrl } = require('./source_index');
const { completePaintName } = require('./paint_name');
const { PAGE_FETCH_BUDGET_MS } = require('./fetch_pages');
const { candidateFinishRelation } = require('./paint_finish');
const { normalized: normalize, paintCodes: codes, paintSearch, groupPaints, mentions } = require('./search_groups');
const { SearchBudget } = require('./search_budget');
const { pageDomain } = require('./source_claim_scope');
const { modelNameMatches } = require('./model_name_match');
const { busBodyPaintPossible } = require('./bus_paint_context');

// Cache source research, never a verification decision. Matching/formatting can
// enrich codes and finishes without creating a second search for the same name.
const keyFor = color => normalize(completePaintName(color.name));
const MAX_PRIMARY_SEARCHES = 6;
const MAX_FOLLOWUP_SEARCHES = 2;
const MAX_FETCHES = 12;
const MIN_SEARCH_WINDOW_MS = 2000;

function normalizedPage(page, cache) {
  const cached = cache?.get(page);
  if (cached?.source === page.text) return cached.text;
  const text = ` ${normalize(page.text)} `;
  cache?.set(page, { source: page.text, text });
  return text;
}

function modelLinkedPage(page, color, vehicle) {
  if (!vehicle?.model || !page?.text || page.status !== 'ok'
    || !mentions(page.text, color.name) || !busBodyPaintPossible(page, color, vehicle)) return false;
  let path = '';
  try { path = new URL(page.url).pathname; } catch { /* An injected source may omit its URL. */ }
  const titlePath = `${page.title || ''} ${path}`;
  const brandContext = `${page.title || ''} ${path} ${page.text.slice(0, 1200)}`;
  if (modelNameMatches(titlePath, vehicle.model)
    && (!vehicle.brand || mentions(brandContext, vehicle.brand))) return true;

  // On a multi-model table, the model must belong to this paint's own row.
  // A model in site navigation or an unrelated row cannot establish fitment.
  return page.text.split(/\r?\n/).some(line => line.length <= 500
    && mentions(line, color.name) && modelNameMatches(line, vehicle.model)
    && (!vehicle.brand || mentions(line, vehicle.brand) || mentions(brandContext, vehicle.brand)));
}

function existingEvidence(pages, color, requestedFinish, cache, vehicle) {
  const ranked = pages.filter(page => page.status === 'ok' && page.text).map(page => {
    const text = normalizedPage(page, cache);
    const named = text.includes(` ${normalize(color.name)} `);
    const coded = codes(color).some(code => text.includes(` ${normalize(code)} `));
    const finish = (named || coded) && requestedFinish && ['compatible', 'incompatible'].includes(
      candidateFinishRelation(color, [page.text], requestedFinish));
    return { page, score: (named ? 4 : 0) + (coded ? 1 : 0) + (finish ? 4 : 0)
      + (modelLinkedPage(page, color, vehicle) ? 7 : 0)
      + ((named || coded) && color.sources?.includes(page.url) ? 2 : 0) };
  }).filter(row => row.score).sort((a, b) => b.score - a.score);
  const unique = [...new Map(ranked.map(({ page }) => [page.url, page])).values()];
  if (!unique.length) return [];
  const domain = page => pageDomain(page);
  return [unique[0], unique.find(page => domain(page) !== domain(unique[0])) || unique[1]].filter(Boolean);
}

// Run-local evidence preparation, with no AI decisions. Matching/omission repair
// can change names and codes; final selection always uses the actual final color.
class VerificationResearch {
  constructor(vehicle, options) {
    this.vehicle = vehicle;
    this.options = options;
    this.searchBudget = options.searchBudget || new SearchBudget(20, options.log);
    this.entries = new Map();
    this.normalizedPages = new WeakMap();
    this.pending = [];
    this.cache = new Map();
    this.pages = [];
    this.queries = [];
    this.searches = new Map();
    this.primarySearches = 0;
    this.followupSearches = 0;
    this.searchesSkipped = 0;
    this.searchesSkippedDeadline = 0;
    this.fetchAdmissions = 0;
    this.fetchSkipped = 0;
    this.limit = createLimiter(options.fetchConcurrency || 20);
    this.earlyCandidates = new Map();
    this.earlyStarted = false;
  }

  existing() { return [...(this.options.getExistingPages?.() || this.options.existingPages || []), ...this.pages]; }

  // Settled main-agent approvals can start one small evidence lookup while
  // unrelated reviews finish. It reuses the normal search/fetch quotas and
  // makes no verification decision. Final colors still run the full research.
  offer(colors) {
    if (!this.options.primeDuringReview || this.earlyStarted || this.options.signal?.aborted) return;
    for (const color of colors) {
      if (color?.name && color.sources?.length) this.earlyCandidates.set(keyFor(color), color);
    }
    if (this.earlyCandidates.size < 2) return;

    this.earlyStarted = true;
    const candidates = [...this.earlyCandidates.values()].filter(color => !this.reusable(color));
    const color = candidates.sort((a, b) =>
      existingEvidence(this.existing(), a, this.vehicle.paintFinish, this.normalizedPages, this.vehicle).length
      - existingEvidence(this.existing(), b, this.vehicle.paintFinish, this.normalizedPages, this.vehicle).length)[0];
    if (!color || !this.searchBudget.remaining('verification')) return;

    this.earlyJob = (async () => {
      const results = await this.search(paintSearch(this.vehicle, [color]));
      await this.select(color, results); // At most two page fetches; no per-color follow-up search.
    })().catch(error => this.options.warn?.('verification_prefetch', error));
  }

  add(colors) {
    for (const color of colors) {
      const key = keyFor(color);
      if (!key) continue;
      if (this.entries.has(key)) {
        this.entries.get(key).color = structuredClone(color);
        continue;
      }
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      const entry = { color: structuredClone(color), promise, resolve };
      this.entries.set(key, entry);
      this.pending.push(entry);
    }
    if (this.pending.length && !this.timer) this.timer = setTimeout(() => this.flush(), 40);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const pending = this.pending.splice(0).sort((a, b) =>
      Number(this.hasIdentity(existingEvidence(this.existing(), a.color, undefined,
        this.normalizedPages, this.vehicle), a.color))
      - Number(this.hasIdentity(existingEvidence(this.existing(), b.color, undefined,
        this.normalizedPages, this.vehicle), b.color)));
    for (const batch of groupPaints(pending, entry => entry.color)) {
      this.prepare(batch).catch(error => {
        this.options.warn?.('verification_search', error);
        for (const entry of batch) entry.resolve([]);
      });
    }
  }

  async search(query, followup = false) {
    if (this.searches.has(query)) return this.searches.get(query);
    const pending = this.searchOnce(query, followup);
    this.searches.set(query, pending);
    return pending;
  }

  async searchOnce(query, followup) {
    const o = this.options;
    const signal = o.searchSignal || o.signal;
    if (signal?.aborted || o.signal?.aborted || o.timing.signal.aborted) return [];
    // A query also needs time to select/fetch evidence before this cutoff.
    // Keep the existing evidence and mandatory final model review when a late
    // palette cannot use another paid search productively.
    const remainingMs = o.timing.remainingMs(signal);
    if (remainingMs < MIN_SEARCH_WINDOW_MS) {
      this.searchesSkippedDeadline++;
      o.log?.('verification_search_deadline_skipped', { remainingMs, minimumMs: MIN_SEARCH_WINDOW_MS });
      return [];
    }
    if (!this.searchBudget.remaining('verification')
      || (followup ? this.followupSearches >= MAX_FOLLOWUP_SEARCHES : this.primarySearches >= MAX_PRIMARY_SEARCHES)) {
      this.searchesSkipped++;
      if (this.searchesSkipped === 1) o.log?.('verification_search_budget_exhausted', {
        primaryLimit: MAX_PRIMARY_SEARCHES, followupLimit: MAX_FOLLOWUP_SEARCHES });
      return [];
    }
    if (followup) this.followupSearches++;
    else this.primarySearches++;
    this.queries.push(query);
    o.onQuery?.(query);
    try {
      return await o.browse([query], { provider: o.provider, country: this.vehicle.country,
        state: o.searchState, signal, serperCost: o.serperCost,
        searchBudget: this.searchBudget, searchPhase: 'verification',
        onEngineRequest: o.onEngineRequest, onEngineComplete: o.onEngineComplete,
        remainingMs: () => o.timing.remainingMs(signal), onEvent: o.log });
    } catch (error) { o.warn?.('verification_search', error); return []; }
  }

  fetch(url) {
    url = sourceUrl(url);
    if (!this.cache.has(url)) this.cache.set(url, this.limit(async () => {
      const existing = this.existing().find(page => page.url === url && page.status === 'ok');
      if (existing) return existing;
      const o = this.options;
      if (o.signal.aborted || o.timing.signal.aborted) return null;
      if (this.fetchAdmissions >= MAX_FETCHES) {
        this.fetchSkipped++;
        if (this.fetchSkipped === 1) o.log?.('verification_fetch_budget_exhausted', { limit: MAX_FETCHES });
        return null;
      }
      this.fetchAdmissions++;
      const [page] = await o.fetchPages([url], { signal: o.searchSignal || o.signal,
        timeoutMs: PAGE_FETCH_BUDGET_MS, totalTimeoutMs: PAGE_FETCH_BUDGET_MS, directRetries: 0 });
      if (page) {
        const recorded = { ...page, verification: true };
        this.pages.push(recorded);
        o.onFetchedPage?.(recorded);
      }
      return page;
    }).catch(error => { this.options.warn?.('verification_fetch', error); return null; }));
    return this.cache.get(url);
  }

  hasIdentity(pages, color) {
    return pages.some(page => {
      const text = normalizedPage(page, this.normalizedPages);
      return text.includes(` ${normalize(color.name)} `)
        || color.sources?.includes(page.url) && codes(color).some(code => text.includes(` ${normalize(code)} `));
    });
  }

  hasFinish(pages, color) {
    if (!this.vehicle.paintFinish) return true;
    return ['compatible', 'incompatible'].includes(candidateFinishRelation(color,
      pages.filter(page => page.status === 'ok').map(page => page.text), this.vehicle.paintFinish));
  }

  hasModelLink(pages, color) {
    return !this.vehicle.model || pages.some(page => modelLinkedPage(page, color, this.vehicle));
  }

  reusable(color) {
    const pages = existingEvidence(this.existing(), color, this.vehicle.paintFinish,
      this.normalizedPages, this.vehicle);
    const domains = new Set(pages.filter(page => this.hasIdentity([page], color))
      .map(pageDomain));
    return this.options.reuseEvidence === true && domains.size >= 2 && this.hasModelLink(pages, color)
      ? pages : null;
  }

  async select(color, results) {
    const ready = existingEvidence(this.existing(), color, this.vehicle.paintFinish,
      this.normalizedPages, this.vehicle);
    const namedDomains = new Set(ready.filter(page => normalizedPage(page, this.normalizedPages).includes(normalize(color.name)))
      .map(pageDomain));
    if (this.options.reuseEvidence === true && namedDomains.size >= 2
      && this.hasModelLink(ready, color)) return ready;
    const name = normalize(color.name);
    const cited = new Set((color.sources || []).map(sourceUrl));
    const rows = results.flatMap(result => result.results || []).filter(row => {
      const text = `${row.title || ''} ${row.snippet || ''} ${row.url || ''}`;
      const paint = /paint|colou?r|cores|pintura|tinta|farb|couleur|pearl|perol/i.test(text);
      const vehicle = mentions(text, this.vehicle.model) || mentions(text, this.vehicle.brand);
      return cited.has(sourceUrl(row.url)) || mentions(text, color.name) && (paint || vehicle)
        || codes(color).some(code => mentions(text, code)) && paint && vehicle;
    }).sort((a, b) => {
      const score = row => Number(mentions(`${row.title || ''} ${row.url || ''}`, this.vehicle.model)) * 4
        + Number(mentions(`${row.title || ''} ${row.snippet || ''}`, color.name)) * 2
        + Number(mentions(`${row.title || ''} ${row.snippet || ''}`, this.vehicle.manufacturingYear));
      return score(b) - score(a)
        || Number(normalize(`${b.title} ${b.snippet} ${b.url}`).includes(name))
          - Number(normalize(`${a.title} ${a.snippet} ${a.url}`).includes(name));
    });
    const urls = [...new Set([...(ready.length ? [] : (color.sources || []).slice(0, 1)),
      ...rows.map(row => { try { return sourceUrl(row.url); } catch { return null; } })].map(url => {
      try { new URL(url); return /^https?:\/\//.test(url) ? url : null; }
      catch { return null; }
    }).filter(Boolean))].slice(0, 2);
    for (const page of await Promise.all(urls.map(url => this.fetch(url)))) {
      if (page?.status === 'ok' && page.text && !ready.some(other => other.url === page.url)) ready.push(page);
    }
    return ready;
  }

  async prepare(batch) {
    const missing = batch.filter(entry => {
      const ready = this.reusable(entry.color);
      if (ready) entry.resolve(ready);
      return !ready;
    });
    if (!missing.length) return;

    const needsModelLink = missing.some(entry => !this.hasModelLink(
      existingEvidence(this.existing(), entry.color, undefined,
        this.normalizedPages, this.vehicle), entry.color));
    const query = paintSearch(this.vehicle, missing.map(entry => entry.color),
      needsModelLink ? 'applicability' : 'verification');
    const results = await this.search(query);
    await Promise.all(missing.map(async entry => {
      let ready = await this.select(entry.color, results);
      const identity = this.hasIdentity(ready, entry.color);
      // Unknown finish is left to the final web/catalog review. It must not
      // trigger a separate search for every paint, or another wave after matching.
      if ((!identity || !this.hasModelLink(ready, entry.color))
        && !entry.followupAttempted && this.queries.includes(query)) {
        entry.followupAttempted = true;
        const individual = await this.search(paintSearch(this.vehicle, [entry.color], 'name'), true);
        ready = [...ready, ...await this.select(entry.color, individual)];
      }
      this.options.log?.('grouped_search_coverage', { stage: 'verification', name: entry.color.name,
        identity: this.hasIdentity(ready, entry.color), finish: this.hasFinish(ready, entry.color) });
      entry.resolve(ready);
    }));
  }

  async evidence(color) {
    this.add([color]);
    this.flush();
    const pages = await this.entries.get(keyFor(color)).promise;
    return existingEvidence([...pages, ...this.existing()], color, this.vehicle.paintFinish,
      this.normalizedPages, this.vehicle);
  }

  async drain() {
    if (this.earlyJob) await this.earlyJob;
    this.flush();
    await Promise.all([...this.entries.values()].map(entry => entry.promise));
    await Promise.all(this.cache.values());
  }
}

module.exports = { VerificationResearch, existingEvidence, modelLinkedPage };
