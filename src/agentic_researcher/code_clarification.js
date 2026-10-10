'use strict';

const { sourceYearRelevance } = require('./research_plan');
const { candidateSourceCodes } = require('./paint_evidence');
const { hueFamilies } = require('./hue_review');
const { brandKey } = require('./database_code_agent');

// Spend at most one spare discovery search where a period source names a paint
// but gives no code and the same-make catalogs offer competing code identities.
// Search results are only leads: extraction, review and the matcher still decide.
async function searchAmbiguousPeriodCode(run, vehicle, signal) {
  if (signal.aborted || run.searchBlocked) return;

  const pages = new Map(run.pages.filter(page => page.status === 'ok')
    .map(page => [page.id, page]));
  const requested = hueFamilies(vehicle.predominantColor);
  const candidates = run.candidates().filter(candidate => {
    const named = hueFamilies(candidate.name);
    if (requested.size && named.size && ![...named].some(hue => requested.has(hue))) return false;
    if (candidate.sources.some(source => candidateSourceCodes(candidate, source).length)) return false;
    return candidate.sources.some(source => {
      const page = pages.get(source.page_id);
      if (!page || !/^https?:/.test(page.url || '')) return false;
      return vehicle.manufacturingYear
        ? sourceYearRelevance(page, vehicle) === 1
        : `${page.url} ${page.title || ''}`.toLowerCase().includes(vehicle.model.toLowerCase());
    });
  });

  const ambiguous = await Promise.all(candidates.map(async candidate => {
    const checked = await run.catalogs.get(candidate);
    const codes = new Set((checked.candidates || []).filter(row =>
      brandKey(row.manufacturer) === brandKey(vehicle.brand)
      && ['all_words', 'related_words'].includes(row.name_match))
      .map(row => row.universal_code).filter(Boolean));
    return { candidate, codes: codes.size, unnamedHue: !hueFamilies(candidate.name).size };
  }));
  const lead = ambiguous.filter(item => item.codes > 1)
    .sort((a, b) => Number(b.unnamedHue) - Number(a.unnamedHue)
      || b.candidate.sources.length - a.candidate.sources.length || b.codes - a.codes)[0];

  if (!lead || signal.aborted) return;

  const local = /^(?:br|brazil|brasil)$/i.test(String(vehicle.country || ''));
  const query = [vehicle.brand, vehicle.model, vehicle.manufacturingYear,
    `"${lead.candidate.name}"`, local ? 'código da cor tinta' : 'paint color code']
    .filter(Boolean).join(' ');

  run.log('code_clarification_search', { name: lead.candidate.name, competingCodes: lead.codes });
  await run.search([query], vehicle, signal, { forCodes: true });
}

module.exports = { searchAmbiguousPeriodCode };
