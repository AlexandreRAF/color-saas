'use strict';

const knownManufacturers = require('./data/known_manufacturers.json');
const { indexResults } = require('./research_plan');
const { hueFamilies } = require('./hue_review');
const { printedNameKey } = require('./paint_evidence');
const { sourceYearRelevance } = require('./source_year');
const { PAGE_FETCH_BUDGET_MS } = require('./fetch_pages');

const ALIASES = new Map([
  ['vw', 'Volkswagen'], ['volkswagen', 'Volkswagen'],
  ['ford', 'Ford'], ['fiat', 'Fiat'], ['renault', 'Renault'],
  ['toyota', 'Toyota'], ['honda', 'Honda'],
  ['gm', 'Chevrolet'], ['general motors', 'Chevrolet'], ['chevrolet', 'Chevrolet'],
]);
const MAX_SEARCHES = 2;
const MAX_PAGES_PER_DONOR = 2;
const MAX_COLORS_PER_PAGE = 4;
const MAX_UNFILTERED_COLORS_PER_PAGE = 8;
const normalize = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const contains = (text, word) => (` ${normalize(text)} `).includes(` ${normalize(word)} `);

// A documented paint-sharing practice is a navigation clue, never proof that
// the whole donor palette was offered on a particular model or year.
function sharedPaintClaims(pages, vehicle) {
  if (!vehicle?.brand) return [];
  const makers = new Map([...knownManufacturers.map(name => [normalize(name), name]), ...ALIASES]);
  const claims = new Map();

  for (const page of pages) {
    if (page.status !== 'ok' || !page.text || page.catalog) continue;
    for (const passage of page.text.split(/(?<=[.!?])\s+|\r?\n/)) {
      const statement = normalize(passage);
      if (passage.length > 700 || !contains(passage, vehicle.brand)
        || !/\b(?:cor(?:es)?|tintas?|pintura|paint|colou?rs?)\b/iu.test(passage)
        || !/\b(?:adot\w*|us(?:a|ava|ou|am|ed|es)|utiliz\w*|compartilh\w*|emprest\w*|borrow\w*|shar\w*)\b/iu.test(passage)
        || /\b(?:nao|nunca|never|not)\b.{0,30}\b(?:adot\w*|us\w*|utiliz\w*|borrow\w*|shar\w*)\b/u.test(statement)) continue;

      for (const [alias, donorMake] of makers) {
        if (alias.length < 2 || normalize(donorMake) === normalize(vehicle.brand)
          || !contains(passage, alias) || claims.has(donorMake)) continue;
        claims.set(donorMake, { donorMake, page, passage: passage.trim(),
          position: ` ${normalize(passage)} `.indexOf(` ${alias} `) });
      }
    }
  }

  return [...claims.values()].sort((a, b) => a.position - b.position);
}

function donorSources(results, donorMake, year, attempted, country) {
  const index = new Map();
  indexResults(results, index);
  return [...index.values()].filter(source => {
    if (attempted.has(source.url) || !contains(`${source.title} ${source.snippet}`, donorMake)
      || sourceYearRelevance(source, { manufacturingYear: year }) !== 1) return false;
    const title = `${source.title || ''} ${new URL(source.url).pathname}`;
    const host = new URL(source.url).hostname;
    return /\b(?:cores?|colou?rs?|paint|pintura|tinta|paleta|cat[aá]logo)\b/iu.test(title)
      && (!/brazil|brasil/i.test(country || '')
        || /\b(?:brasil|brazil|brasileir\w*|cores?|tintas?|pintura)\b/iu
          .test(`${source.title || ''} ${source.snippet || ''} ${host}`))
      && !/(?:^|\.)(?:facebook|instagram|pinterest|youtube|tiktok|scribd)\.com$/i.test(host);
  }).sort((a, b) => a.rank - b.rank);
}

function selectPeriodColors(page, vehicle, existingNames = new Set()) {
  const requested = hueFamilies(vehicle.predominantColor);
  if (sourceYearRelevance(page, vehicle) !== 1) return [];

  const eligible = (page.candidates || []).filter(candidate =>
    !existingNames.has(printedNameKey(candidate.name)) && candidate.evidence?.length);

  if (!requested.size) {
    // A whole-palette request should not spend every donor slot on the first
    // color section of a chart. Name words guide diversity, not eligibility.
    const byFamily = new Map();
    for (const candidate of eligible) {
      const family = [...hueFamilies(candidate.name)][0] || 'unknown';
      if (!byFamily.has(family)) byFamily.set(family, []);
      byFamily.get(family).push(candidate);
    }
    const selected = [];
    while (selected.length < MAX_UNFILTERED_COLORS_PER_PAGE && byFamily.size) {
      for (const [family, candidates] of byFamily) {
        selected.push(candidates.shift());
        if (!candidates.length) byFamily.delete(family);
        if (selected.length === MAX_UNFILTERED_COLORS_PER_PAGE) break;
      }
    }
    return selected;
  }

  const scored = eligible.map(candidate => {
    const families = hueFamilies(candidate.name);
    const matching = [...families].some(family => requested.has(family));
    return { candidate, score: matching ? 2 : families.size ? 0 : 1 };
  }).sort((a, b) => b.score - a.score);

  return scored.slice(0, MAX_COLORS_PER_PAGE).map(row => row.candidate);
}

// Spend at most two existing browser slots only after a fetched page explicitly
// documents shared paints. Donor charts enter normal review as uncertain leads.
async function recoverSharedPaints(run, vehicle, signal) {
  const claims = sharedPaintClaims(run.pages, vehicle);
  const requested = hueFamilies(vehicle.predominantColor);
  if (!claims.length || !vehicle.manufacturingYear || signal.aborted
    || run.searchBlocked || run.searchBudget.remaining('verification') <= 2) return 0;

  let recovered = 0;
  for (const claim of claims.slice(0, MAX_SEARCHES)) {
    if (signal.aborted || run.timing.remainingMs(signal) < PAGE_FETCH_BUDGET_MS + 1500
      || run.searchBudget.remaining('verification') <= 2
      || run.pages.filter(page => !page.nameResearch).length >= run.maxPages) break;

    const hue = requested.size ? vehicle.predominantColor : '';
    const query = [claim.donorMake, 'Brasil', vehicle.manufacturingYear,
      'catálogo cores', hue, 'pintura'].filter(Boolean).join(' ');
    run.queries.add(query);
    let results;

    try {
      results = await run.browse([query], {
        country: vehicle.country, provider: run.searchProvider, signal,
        state: run.searchState, searchBudget: run.searchBudget, searchPhase: 'verification',
        serperCost: run.serperCost, remainingMs: () => run.timing.remainingMs(signal),
        onEvent: (event, detail) => run.log(event, detail),
        onEngineRequest: engine => { run.engineSearches[engine] = (run.engineSearches[engine] || 0) + 1; },
        onEngineComplete: (_engine, { failed }) => { if (failed) run.failedBrowserUses++; },
      });
    } catch (error) {
      run.warn('shared_paint_search', error);
      continue;
    }

    const sources = donorSources(results, claim.donorMake, vehicle.manufacturingYear,
      run.attempted, vehicle.country).slice(0, MAX_PAGES_PER_DONOR);
    for (const source of sources) {
      if (signal.aborted || run.timing.remainingMs(signal) < PAGE_FETCH_BUDGET_MS + 1500
        || run.pages.filter(page => !page.nameResearch).length >= run.maxPages) break;

      const existingNames = new Set(run.candidates().map(candidate => printedNameKey(candidate.name)));
      const donorVehicle = { ...vehicle, brand: claim.donorMake, model: '' };
      try {
        await run.readSources([{ ...source, sharedPaintDonor: claim.donorMake,
          sharedPaintClaimPageId: claim.page.id }], donorVehicle, signal, () => {},
        { useProvidedSignal: true });
      } catch (error) {
        run.warn('shared_paint_fetch', error);
        continue;
      }

      const page = run.pages.filter(item => item.sharedPaintDonor === claim.donorMake
        && item.sharedPaintClaimPageId === claim.page.id && item.status === 'ok'
        && sourceYearRelevance(item, vehicle) === 1)
        .sort((a, b) => (b.candidates?.length || 0) - (a.candidates?.length || 0))[0];
      if (!page) continue;
      page.candidates = selectPeriodColors(page, vehicle, existingNames);
      if (!page.candidates.length) continue;

      claim.page.sharedPaintClaims ||= [];
      claim.page.sharedPaintClaims.push({ donorMake: claim.donorMake, passage: claim.passage });
      recovered += page.candidates.length;
      run.log('shared_paint_leads', { donorMake: claim.donorMake, url: page.url,
        candidates: page.candidates.map(candidate => candidate.name) });
      break;
    }
  }

  return recovered;
}

module.exports = { sharedPaintClaims, donorSources, selectPeriodColors, recoverSharedPaints };
