'use strict';

const { indexResults } = require('./research_plan');
const { hueFamilies } = require('./hue_review');
const { printedNameKey } = require('./paint_evidence');
const { PAGE_FETCH_BUDGET_MS } = require('./fetch_pages');
const { modelLinkedPage } = require('./verification_research');

const HUE = '(?:branc[oa]|white|cinza|gray|grey|gris|prata|silver|plata|pret[oa]|black|azul|blue|verde|green|vermelh[oa]|red|amarel[oa]|yellow|bege|beige|marrom|brown|laranja|orange)';
const COATING = '(?:tintas?|esmalte|paint|spray paint)';
const PRODUCT_WORD = '(?:PU|poliuretano|automotiv[ao]|automotive|base|sint[eé]tic[ao]|acr[ií]lic[ao]|spray|skymix)';
const VERSION = '(?:[IVX]{1,5}|[0-9]{1,3})';
const MAX_SEARCHES = 2;
const MAX_PAGES = 3;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A coating product title is evidence only for its printed shade. Its package
// size, seller SKU and chemistry are never part of the paint name or code.
function namedManufacturerPaint(title, vehicle) {
  const brand = String(vehicle.brand || '').trim();
  if (!brand) return null;

  const pattern = new RegExp(`\\b${COATING}\\s+(?:${PRODUCT_WORD}\\s+){0,5}(${HUE})\\s+(${escapeRegExp(brand)})(?:\\s+(${VERSION}))?(?=$|[^\\p{L}\\p{N}])`, 'iu');
  const match = String(title || '').match(pattern);
  if (!match) return null;

  const name = [match[1], match[2], match[3]].filter(Boolean).join(' ');
  return { name, evidence: match[0] };
}

function manufacturerQueries(vehicle) {
  const brand = String(vehicle.brand || '').trim();
  const hue = vehicle.predominantColor === 'not specified' ? '' : String(vehicle.predominantColor || '').trim();
  return [
    [`"${brand}"`, 'tinta PU', hue, 'cor automotiva'].filter(Boolean).join(' '),
    [`"${brand}"`, 'paint color', hue, 'bodywork'].filter(Boolean).join(' '),
  ];
}

function sourcePriority(source, vehicle) {
  const requested = hueFamilies(vehicle.predominantColor);
  const named = hueFamilies(namedManufacturerPaint(source.title, vehicle)?.name);
  return requested.size && [...named].some(family => requested.has(family)) ? 1 : 0;
}

function hasModelLinkedPaint(run, vehicle) {
  const pages = new Map(run.evidencePages().map(page => [page.id, page]));
  return run.candidates().some(candidate => candidate.sources.some(source => {
    const page = pages.get(source.page_id);
    return page?.catalog === 'basf_models' && page.catalog_record?.model_match === 'exact'
      || modelLinkedPage(page, { name: candidate.name }, vehicle);
  }));
}

function recoveredCandidateCount(run) {
  const recoveredIds = new Set(run.evidencePages().filter(page => page.manufacturerPaintRecovery)
    .map(page => page.id));
  return run.candidates().filter(candidate => candidate.sources.some(source =>
    recoveredIds.has(source.page_id))).length;
}

async function searchManufacturer(run, vehicle, query, signal) {
  if (!run.searchBudget.remaining('verification')) return [];

  run.queries.add(query);
  run.log('manufacturer_paint_search_start', { query });

  try {
    const results = await run.browse([query], {
      country: vehicle.country, provider: run.searchProvider, signal,
      state: run.searchState, searchBudget: run.searchBudget, searchPhase: 'verification',
      serperCost: run.serperCost, remainingMs: () => run.timing.remainingMs(signal),
      onEvent: (event, detail) => run.log(event, detail),
      onEngineRequest: engine => { run.engineSearches[engine] = (run.engineSearches[engine] || 0) + 1; },
      onEngineComplete: (_engine, { failed }) => { if (failed) run.failedBrowserUses++; },
    });
    const found = new Map();
    indexResults(results, found);
    indexResults(results, run.index);
    run.log('manufacturer_paint_search_complete', { query, indexedSources: found.size });
    return [...found.values()];
  } catch (error) {
    run.warn('manufacturer_paint_search', error);
    return [];
  }
}

async function readManufacturerLeads(run, sources, vehicle, signal, pageBudget) {
  const room = Math.max(0, run.maxPages - run.pages.filter(page => !page.nameResearch).length);
  let admitted = 0;
  const selected = sources.filter(source => {
    if (run.pages.some(page => page.url === source.url && page.manufacturerPaintRecovery)
      || run.snippetPages.some(page => page.url === source.url && page.manufacturerPaintRecovery)) return false;
    if (run.pages.some(page => page.url === source.url)) return true;
    if (admitted >= Math.min(pageBudget, room)) return false;
    admitted++;
    return true;
  }).slice(0, MAX_PAGES);
  if (!selected.length) return { leads: 0, grounded: 0, fetched: 0 };

  const fetched = await Promise.all(selected.map(async source => {
    const existing = run.pages.find(page => page.url === source.url);
    if (existing) return { source, page: existing, existing: true };

    run.attempted.add(source.url);
    try {
      const [page] = await run.getPagePool().fetchPages([source.url], {
        signal, timeoutMs: PAGE_FETCH_BUDGET_MS, totalTimeoutMs: PAGE_FETCH_BUDGET_MS,
      });
      return { source, page: page || { status: 'error', error: 'Page fetch returned no result',
        fetchStarted: true }, existing: false };
    } catch (error) {
      run.warn('manufacturer_paint_fetch', `${source.url}: ${error.message}`);
      return { source, page: { status: 'error', error: error.message, fetchStarted: true }, existing: false };
    }
  }));

  let leads = 0;
  let grounded = 0;
  for (const { source, page, existing } of fetched) {
    const paint = namedManufacturerPaint(source.title, vehicle);
    const printed = page?.status === 'ok' && printedNameKey(String(page.text || ''))
      .includes(printedNameKey(paint.name));
    const evidence = printed ? paint.evidence : [source.title, source.snippet].filter(Boolean).join('\n');
    const candidate = { name: paint.name, evidence: [evidence] };

    if (page?.status === 'ok' && printed) {
      if (existing) {
        page.manufacturerPaintRecovery = true;
        (page.candidates ||= []).push(candidate);
      } else {
        run.pages.push({ ...source, ...page, id: `MP${run.pages.length + 1}`,
          url: source.url, title: source.title, manufacturerPaintRecovery: true,
          candidates: [candidate] });
      }
      leads++;
      grounded++;
    } else {
      if (!existing) run.pages.push({ ...source, ...page, id: `MP${run.pages.length + 1}`,
        url: source.url, title: source.title, candidates: [] });
      // A search title remains a weak, explicitly labelled lead if its page
      // failed or did not print the same shade. It never proves model fitment.
      run.snippetPages.push({ ...source, id: `MS${run.snippetPages.length + 1}`,
        status: 'search_snippet', retrievalMethod: 'search_snippet', text: evidence,
        manufacturerPaintRecovery: true, candidates: [candidate] });
      leads++;
    }
  }

  return { leads, grounded, fetched: fetched.filter(item => !item.existing).length };
}

// This runs only after ordinary discovery produced no named candidate. Spend
// at most two reserved browser uses and three pages; successful products still
// enter the normal main review, code matcher and final verifier.
async function recoverManufacturerPaints(run, vehicle, signal) {
  if (!vehicle.brand || signal.aborted || run.searchBlocked || hasModelLinkedPaint(run, vehicle)) return 0;

  let remainingPages = MAX_PAGES;
  const indexed = [...run.index.values()].filter(source => namedManufacturerPaint(source.title, vehicle))
    .sort((a, b) => sourcePriority(b, vehicle) - sourcePriority(a, vehicle) || a.rank - b.rank);
  const reused = await readManufacturerLeads(run, indexed, vehicle, signal, remainingPages);
  remainingPages -= reused.fetched;
  if (reused.grounded && recoveredCandidateCount(run)) {
    run.log('manufacturer_paint_recovered', { leads: reused.leads, source: 'existing_search' });
    return reused.leads;
  }

  for (const query of manufacturerQueries(vehicle).slice(0, MAX_SEARCHES)) {
    if (signal.aborted || run.timing.remainingMs(signal) < PAGE_FETCH_BUDGET_MS + 1500) break;
    const sources = (await searchManufacturer(run, vehicle, query, signal))
      .filter(source => namedManufacturerPaint(source.title, vehicle))
      .sort((a, b) => sourcePriority(b, vehicle) - sourcePriority(a, vehicle) || a.rank - b.rank);
    if (!sources.length) continue;

    const recovered = await readManufacturerLeads(run, sources, vehicle, signal, remainingPages);
    remainingPages -= recovered.fetched;
    if (recovered.grounded && recoveredCandidateCount(run)) {
      run.log('manufacturer_paint_recovered', {
        leads: recovered.leads, candidates: recoveredCandidateCount(run),
      });
      return recovered.leads;
    }
  }

  return recoveredCandidateCount(run);
}

module.exports = { recoverManufacturerPaints, hasModelLinkedPaint,
  namedManufacturerPaint, manufacturerQueries };
