'use strict';

const { hueFamilies } = require('./hue_review');
const { printedNameKey } = require('./paint_evidence');
const { stripPaintFinish } = require('./paint_name');
const { modelNameMatches } = require('./model_name_match');
const { selectSources, sourceYearRelevance } = require('./research_plan');
const { vehicleProfile } = require('./vehicle_profiles');

const SHADE = /\b(?:vermelh[oa]|branc[oa]|pret[oa]|cinza|prata|azul|verde|amarel[oa]|laranja|bege|marrom|red|white|black|gr[ae]y|silver|blue|green|yellow|orange|beige|brown|rojo|blanc[oa]|negro|gris|plata)\s+[\p{L}][\p{L}\p{M}'-]{2,}/giu;
const PALETTE = /\b(?:cores|colou?rs?|colores|paint|pintura|tintas?|brochure|brochura|cat[aá]logo|folheto|folder)\b/iu;
const OWNER_MANUAL = /\b(?:manual do propriet[aá]rio|owner'?s? manual|user manual)\b/iu;
const SHOP = /(?:mercadolivre|shopee|ebay|olx|amazon)\./iu;
const NOT_SHADE = /^(?:that|the|this|with|for|and|paint|color|colour|tinta|cor|cores|automotiva|automotivo|original)$/iu;

function snippetLeads(index, vehicle, candidates = []) {
  const wanted = hueFamilies(vehicle.predominantColor);
  if (!wanted.size || !vehicle.model) return [];

  const observed = candidates.flatMap(candidate => [candidate.name, ...(candidate.aliases || []),
    ...(candidate.sources || []).flatMap(source => source.evidence || [])]);
  const normalized = observed.map(printedNameKey);
  const leads = new Map();

  for (const source of index.values()) {
    const heading = `${source.title || ''} ${new URL(source.url).pathname}`;
    if (!modelNameMatches(heading, vehicle.model) || !PALETTE.test(heading)
      || !PALETTE.test(`${source.title || ''} ${source.snippet || ''}`)) continue;

    // A neighboring publication year is a navigation clue, never proof of
    // applicability to the requested model year.
    const years = [...heading.matchAll(/\b(?:19|20)\d{2}\b/g)].map(match => Number(match[0]));
    if (years.length && Number.isInteger(vehicle.manufacturingYear)
      && years.every(year => Math.abs(year - vehicle.manufacturingYear) > 1)) continue;

    for (const match of String(source.snippet || '').matchAll(SHADE)) {
      const name = match[0].trim();
      const key = printedNameKey(name);
      if (!key || ![...hueFamilies(name)].some(hue => wanted.has(hue))
        || NOT_SHADE.test(name.split(/\s+/).at(-1))
        || normalized.some(text => (` ${text} `).includes(` ${key} `))) continue;

      if (!leads.has(key)) leads.set(key, { name, key, url: source.url,
        yearRelation: sourceYearRelevance(source, vehicle) });
    }
  }

  return [...leads.values()].sort((a, b) => b.yearRelation - a.yearRelation).slice(0, 8);
}

function weakYearCandidates(run, vehicle) {
  const wanted = hueFamilies(vehicle.predominantColor);
  if (!wanted.size) return [];

  const yearDistance = candidate => Math.min(Infinity, ...candidate.sources.map(source => {
    if (!/^https?:/.test(source.url || '')) return Infinity;
    const indexed = run.index.get(source.url) || source;
    const label = `${indexed.title || ''} ${new URL(source.url).pathname}`;
    const years = [...label.matchAll(/(?<!\d)(?:19|20)\d{2}(?!\d)/g)]
      .map(match => Number(match[0]));
    return years.length ? Math.min(...years.map(year => Math.abs(year - vehicle.manufacturingYear))) : Infinity;
  }));

  return run.candidates().filter(candidate => {
    if (![...hueFamilies(candidate.name)].some(hue => wanted.has(hue))) return false;
    const sources = candidate.sources || [];
    if (sources.some(source => source.url?.startsWith('catalog:basf_models:'))) return false;
    const web = sources.filter(source => /^https?:/.test(source.url || '')
      && modelNameMatches(`${run.index.get(source.url)?.title || ''} ${new URL(source.url).pathname}`,
        vehicle.model));
    return web.length && !web.some(source =>
      sourceYearRelevance(run.index.get(source.url) || source, vehicle) === 1);
  }).sort((a, b) => yearDistance(a) - yearDistance(b)
    || indexedMentions(run.index, a.name) - indexedMentions(run.index, b.name)
  ).slice(0, 5).map(candidate => candidate.name);
}

function indexedMentions(index, name) {
  const key = printedNameKey(stripPaintFinish(name));
  return [...index.values()].filter(source => printedNameKey(`${source.title || ''} ${source.snippet || ''}`)
    .includes(key)).length;
}

function yearPalettePages(pages, vehicle) {
  if (!Number.isInteger(vehicle.manufacturingYear)) return [];
  const model = String(vehicle.model || '').toLocaleLowerCase();
  const year = vehicle.manufacturingYear;

  return pages.filter(page => page.status === 'ok' && page.candidates?.length >= 2
    && (sourceYearRelevance(page, vehicle) === 1
      || model && new RegExp(`\\b(?:linha|line|model(?:o)?\\s+year|ano\\s+modelo)\\s+(?:[\\p{L}\\s]{0,30})?${year}\\b`, 'iu')
        .test(page.text || '')));
}

function paletteSearchQuery(vehicle) {
  // A result title may name just one trim. Search the requested model first;
  // source review determines whether any trim-specific paint is applicable.
  const subject = [vehicle.brand, vehicle.model, vehicle.manufacturingYear]
    .filter(Boolean).join(' ');
  const kind = vehicleProfile(vehicle.automobileType).kind;
  const brazilian = /brazil|brasil/i.test(vehicle.country || '');

  if (brazilian && kind === 'car') return `${subject} cores catálogo PDF`;
  if (brazilian) return `${subject} cores originais catálogo pintura PDF`;
  return `${subject} exterior paint colors brochure color chart PDF`;
}

function paletteSources(run, vehicle, queries, limit) {
  const index = new Map([...run.index].filter(([, source]) => source.queries?.some(query => queries.includes(query))));
  const eligible = selectSources(index, run.attempted, vehicle, index.size)
    .filter(source => !run.pagePool?.unavailableHost(source.url) && !SHOP.test(source.url));
  const score = source => {
    const title = `${source.title || ''} ${source.url}`;
    const snippet = String(source.snippet || '');
    return sourceYearRelevance(source, vehicle) * 25
      + (/\.pdf\b|brochure|brochura|folheto|folder|cat[aá]logo/iu.test(title) ? 25 : 0)
      + (PALETTE.test(title) ? 12 : 0)
      + (new RegExp(`\\b${vehicle.manufacturingYear}\\b`).test(snippet) ? 8 : 0)
      - (OWNER_MANUAL.test(title) ? 60 : 0)
      - (/(?:facebook|instagram|youtube|tiktok)\.com/iu.test(source.url) ? 25 : 0)
      - (source.rank || 0);
  };

  return eligible.sort((a, b) => score(b) - score(a)).slice(0, limit);
}

async function researchPaletteGaps(run, vehicle) {
  if (!Number.isInteger(vehicle.manufacturingYear) || !run.discoverySignal
    || run.discoverySignal.aborted || run.searchBlocked) return;

  const candidates = run.candidates();
  const leads = snippetLeads(run.index, vehicle, candidates);
  const weakYears = weakYearCandidates(run, vehicle);
  const yearPages = yearPalettePages(run.pages, vehicle);
  const richButUnscoped = run.pages.filter(page => page.status === 'ok'
    && page.candidates?.length >= 3).length >= 2 && !yearPages.length;

  if (!leads.length && !weakYears.length && !richButUnscoped) return;

  const brochureQuery = paletteSearchQuery(vehicle);
  // One OR query gives several independently indexed names a chance to find a
  // model/year palette without spending one search per candidate. These are
  // navigation terms only; no query term becomes a paint fact.
  const leadNames = [...new Set([...leads.map(lead => lead.name), ...weakYears]
    .map(name => stripPaintFinish(name).replace(/["“”]/gu, '').trim()))].filter(Boolean).slice(0, 3);
  const leadTerms = leadNames.map(name => `"${name}"`).join(' OR ');
  const leadQuery = leadNames.length && [vehicle.brand, vehicle.model, vehicle.manufacturingYear,
    leadNames.length > 1 ? `(${leadTerms})` : leadTerms, 'cores catálogo'].filter(Boolean).join(' ');
  const searches = [run.search([brochureQuery], vehicle, run.discoverySignal, { forPalette: true }),
    ...(leadQuery ? [run.search([leadQuery], vehicle, run.discoverySignal, { forPalette: true })] : [])];

  await Promise.allSettled(searches);
  await Promise.allSettled(run.searchJobs);

  const queries = [brochureQuery, leadQuery].filter(query => run.queries.has(query));
  const room = Math.max(0, run.maxPages - run.pages.filter(page => !page.nameResearch).length);
  const sources = paletteSources(run, vehicle, queries, Math.min(2, room));

  run.log('palette_gap_research', { leadNames: leads.map(item => item.name), weakYearNames: weakYears,
    yearPalettePages: yearPages.length, queries, sources: sources.map(source => source.url) });
  run.paletteGapResearch = { attempted: true, leadNames: leads.map(item => item.name),
    weakYearNames: weakYears, queries, pagesSelected: sources.length };

  await run.readSources(sources, vehicle, run.discoverySignal, () => {}, { useProvidedSignal: true });
}

function paletteGapStatus(run, vehicle) {
  if (!vehicle) return { attempted: false, yearPalettePages: 0,
    unresolvedLeadNames: [], weakYearNames: [] };
  const unresolved = snippetLeads(run.index, vehicle, run.candidates());
  const weakYears = weakYearCandidates(run, vehicle);
  return { attempted: !!run.paletteGapResearch?.attempted,
    yearPalettePages: yearPalettePages(run.pages, vehicle).length,
    unresolvedLeadNames: unresolved.map(lead => lead.name), weakYearNames: weakYears };
}

module.exports = { snippetLeads, weakYearCandidates, yearPalettePages, paletteSearchQuery,
  paletteSources, researchPaletteGaps, paletteGapStatus };
