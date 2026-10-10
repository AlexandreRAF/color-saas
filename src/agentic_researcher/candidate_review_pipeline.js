const { createLimiter } = require('./runtime');
const { printedNameKey, candidateSourceCodes } = require('./paint_evidence');
const { hueFamilies } = require('./hue_review');
const { sourceYearRelevance } = require('./research_plan');

function fingerprint(candidate, pages) {
  const sources = candidate.sources.map(source => {
    const page = pages.find(page => page.id === source.page_id);
    return { url: source.url, evidence: [...new Set(source.evidence)].sort(),
      title: page?.title, opening: page?.text?.slice(0, 1000), incomplete: !!page?.failures?.length };
  }).sort((a, b) => a.url.localeCompare(b.url));

  return JSON.stringify({ name: candidate.name, aliases: [...(candidate.aliases || [])].sort(),
    name_check: candidate.name_check, sources });
}

// At most one early review and one final revision per name. New sightings do
// not trigger paid reviews while pages are still streaming in.
class CandidateReviewPipeline {
  constructor(review, { pages, signal, maxEarly = 12, onEvent = () => {} }) {
    Object.assign(this, { review, pages, signal, maxEarly, onEvent });
    this.entries = new Map();
    this.jobs = [];
    this.limit = createLimiter(4);
  }

  start(candidates) {
    if (this.sealed || this.signal.aborted) return;

    for (const candidate of candidates) {
      const key = printedNameKey(candidate.name);

      if (this.entries.has(key) || this.entries.size >= this.maxEarly) continue;

      const snapshot = structuredClone(candidate);
      const version = fingerprint(candidate, typeof this.pages === 'function' ? this.pages() : this.pages);
      const stage = `research_review_early_${this.entries.size + 1}`;
      const job = this.limit(async () => {
        this.signal.throwIfAborted();
        const decisions = await this.review(snapshot, stage);
        return { candidate: snapshot, decision: decisions[snapshot.id] };
      });

      job.catch(() => {});
      this.jobs.push(job);
      this.entries.set(key, { version, job });
    }
  }

  async finish(candidate, stage) {
    const entry = this.entries.get(printedNameKey(candidate.name));

    if (entry?.version === fingerprint(candidate, typeof this.pages === 'function' ? this.pages() : this.pages)) {
      try {
        const checked = await entry.job;
        const id = candidate.id;

        Object.assign(candidate, checked.candidate, { id });
        this.onEvent('candidate_review_reused', { name: candidate.name });

        return { [id]: checked.decision };
      } catch (error) { this.signal.throwIfAborted(); }
    }

    if (entry) this.onEvent('candidate_review_revised', { name: candidate.name });

    return this.review(candidate, stage);
  }

  drain() { return Promise.allSettled(this.jobs); }
}

// Review the best vehicle evidence first when a large general catalog arrives.
// This only orders work: weak or uncertain candidates still get a review.
function prioritizeCandidates(candidates, pages, vehicle) {
  const normalize = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const model = normalize(vehicle.model);
  const year = String(vehicle.manufacturingYear || '');
  const wanted = hueFamilies(vehicle.predominantColor);
  const huePriority = candidate => {
    const found = hueFamilies(candidate.name);
    return !wanted.size ? 0 : [...found].some(hue => wanted.has(hue)) ? 100 : !found.size ? 50 : 0;
  };

  const score = candidate => huePriority(candidate)
    + (candidate.sources.some(source => candidateSourceCodes(candidate, source).length) ? 20 : 0)
    + Math.max(0, ...candidate.sources.map(source => {
    const page = pages.find(page => page.id === source.page_id);
    const passages = source.evidence.filter(text => text.length <= 450).map(normalize);
    const heading = normalize(`${page?.title || ''} ${source.url}`);
    const mentionsModel = text => model && (` ${text} `).includes(` ${model} `);
    const mentionsYear = text => year && (` ${text} `).includes(` ${year} `);
    const scopedYear = page && sourceYearRelevance({ url: source.url, title: page.title }, vehicle);
    const catalog = source.catalog_record;
    const catalogYears = String(catalog?.year || '').match(/\b(?:19|20)\d{2}\b/g)?.map(Number) || [];
    const catalogPeriod = catalogYears.length && year && Number(year) >= Math.min(...catalogYears)
      && Number(year) <= Math.max(...catalogYears);

    // A page-wide opening can mention many years; only the candidate's own
    // short passage or a year-specific title/path gets year priority. Catalog
    // ranges are retrieval hints, never proof of vehicle-year availability.
    return passages.some(text => mentionsModel(text) && mentionsYear(text)) ? 45
      : scopedYear === 1 && mentionsModel(heading) ? 40
        : catalog && catalogPeriod ? 25
        : passages.some(mentionsModel) ? 20 : mentionsModel(heading) ? 10 : 0;
  })) + Math.min(5, new Set(candidate.sources.map(source => source.url)).size);

  return candidates.map(candidate => ({ candidate, score: score(candidate) }))
    .sort((a, b) => b.score - a.score).map(row => row.candidate);
}

module.exports = { CandidateReviewPipeline, fingerprint, prioritizeCandidates };
