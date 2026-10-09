'use strict';

const { seedQueries, selectSources, sourceYearRelevance, planningCandidates, sparseResearchQueries } = require('./research_plan');
const { modelEvidencePages } = require('./model_evidence');
const { candidateInventory, object } = require('./candidate_inventory');
const { readFile } = require('./agentic_loop_helpers');
const { portugueseNameQuery } = require('./portuguese_names');
const { nameResearchQueries, printedNameKey } = require('./paint_evidence');
const { nameResearchVehicle } = require('./name_research');
const { vehicleModelName } = require('./agentic_loop_helpers');
const { searchFollowups } = require('./followup_search');
const { searchSnippetLeads } = require('./search_snippet_leads');
const { searchAmbiguousPeriodCode } = require('./code_clarification');
const { hueFamilies } = require('./hue_review');
const { brandKey } = require('./database_code_agent');
const { DISCOVERY_TARGET_MS } = require('./research_deadlines');
const { sourceUrl } = require('./source_index');
const { modelNameMatches } = require('./model_name_match');
const { vehicleProfile } = require('./vehicle_profiles');
const { pageDomain } = require('./source_claim_scope');
const { recoverSharedPaints } = require('./shared_paint_research');
const { researchPaletteGaps, paletteGapStatus } = require('./palette_gap_research');

const PLAN_SCHEMA = object({ queries: { type: 'array', items: { type: 'string' } },
  preferred_urls: { type: 'array', items: { type: 'string' } }, rationale: { type: 'string' } });

async function catalogHueLeads(run, vehicle, leads, requestedFamilies) {
  if (!requestedFamilies.size || typeof run.catalogs?.lookup !== 'function') return [];
  const researched = await Promise.all(leads.map(async lead => {
    if (!lead.codes?.length) return null;
    try {
      const result = await run.catalogs.lookup({ name: lead.name, brand: vehicle.brand,
        model: vehicle.model, year: vehicle.manufacturingYear, source_codes: lead.codes }, run.discoverySignal);
      const sameMake = (result.candidates || []).filter(row =>
        brandKey(row.manufacturer) === brandKey(vehicle.brand));
      if (!sameMake.some(row => row.source_code_match
        && [...hueFamilies(row.description)].some(family => requestedFamilies.has(family)))) return null;
      const base = printedNameKey(lead.name);
      const competingCodes = new Set(sameMake.filter(row => {
        const key = printedNameKey(row.description);
        return key === base || key.startsWith(`${base} `);
      }).map(row => row.universal_code).filter(Boolean));
      return { lead, ambiguity: competingCodes.size };
    } catch { return null; }
  }));
  return researched.filter(Boolean).sort((left, right) => right.ambiguity - left.ambiguity)
    .map(row => row.lead);
}

async function clarifyLateName(run, vehicle, signal, requestedFamilies) {
  if (signal?.aborted || run.searchBudget.remaining('research') < 1
    || run.nameQueries.size >= run.maxNameSearches) return;
  const leads = nameResearchQueries(run.candidates(), vehicle).filter(lead => lead.codes.length
    && !run.checkedNames.has(lead.name.toLowerCase()));
  if (!leads.length) return;

  const hinted = await catalogHueLeads(run, vehicle, leads, requestedFamilies);
  const lead = hinted[0];
  if (!lead || signal.aborted) return;
  run.focusedNameLeads.add(lead.name);
  await run.clarifyNames(vehicle, signal, new Set([lead.name]));
}

function paletteQueries(vehicle) {
  const model = [vehicleModelName(vehicle), vehicle.manufacturingYear].filter(Boolean).join(' ');
  const profile = vehicleProfile(vehicle.automobileType);
  if (['agricultural', 'construction'].includes(profile.kind)) return [];
  if (profile.kind !== 'car') return [`${model} ${profile.localCodes}`,
    `${vehicleModelName(vehicle)} ${profile.internationalParts}`];
  // Source families are reusable across vehicles; no expected paint is seeded.
  return [`${model} paint colors site:paintscratch.com`,
    // This specialist chart is often an all-year model page. A year term can
    // suppress it even though its table contains the requested edition.
    `${vehicleModelName(vehicle)} paint colours site:paintcolourchart.com`];
}

function coverage(pages, candidates, { afterRecovery = false, vehicle } = {}) {
  const specialist = ['agricultural', 'construction', 'truck', 'bus']
    .includes(vehicleProfile(vehicle?.automobileType).kind) && !!vehicle?.automobileType;
  const usable = pages.filter(page => page.status === 'ok' && !page.sharedPaintDonor
    && page.candidates?.length);
  const domains = new Set(usable.map(page => new URL(page.url).hostname.replace(/^www\./, '')));
  const fullPalettes = usable.filter(page => page.candidates.length >= (specialist ? 1 : 3));
  const palettes = new Set(fullPalettes.map(page => new URL(page.url).hostname.replace(/^www\./, '')));
  const namesByDomain = new Map();
  for (const page of fullPalettes) {
    const domain = new URL(page.url).hostname.replace(/^www\./, '');
    const names = namesByDomain.get(domain) || new Set();
    for (const candidate of page.candidates) {
      if (typeof candidate?.name === 'string') names.add(printedNameKey(candidate.name));
    }
    namesByDomain.set(domain, names);
  }
  const [first, second] = [...namesByDomain.values()];
  // Once collection is exhausted, two independent full palettes that
  // corroborate several exact names can establish depth for a scarce model.
  // Never waive the initial search or use this shortcut during early discovery.
  const crossCheckedTwoDomains = afterRecovery && domains.size === 2 && palettes.size === 2
    && first?.size >= 3 && second?.size >= 3
    && [...first].filter(name => name && second.has(name)).length >= 3;
  const webNames = new Map();
  for (const page of fullPalettes.filter(page => /^https?:/.test(page.url || ''))) {
    const site = pageDomain(page);
    const names = webNames.get(site) || new Set();
    for (const candidate of page.candidates) {
      if (candidate?.name) names.add(printedNameKey(candidate.name));
    }
    webNames.set(site, names);
  }
  const corroboratedSpecialist = afterRecovery && specialist && webNames.size >= 2
    && [...webNames.values()].some(names => [...names].some(name => name
      && candidates.some(candidate => printedNameKey(candidate.name) === name)
      && [...webNames.values()].filter(other => other.has(name)).length >= 2));
  const fleetBridge = afterRecovery && specialist && candidates.some(candidate =>
    candidate.identityType === 'fleet_standard_paint'
      && candidate.sources.some(source => source.claimScope === 'fleet_standard_paint')
      && candidate.sources.some(source => source.claimScope === 'model_period_context'));
  const specialistDepth = corroboratedSpecialist || fleetBridge;
  return { domains: domains.size, palettes: palettes.size, candidates: candidates.length,
    ...(crossCheckedTwoDomains && { crossCheckedTwoDomains: true }),
    ...(specialistDepth && { specialistDepth: true }),
    needsExpansion: !specialistDepth && (palettes.size < 2
      || (domains.size < 3 && !crossCheckedTwoDomains) || candidates.length < 3) };
}

function finalDiscoveryCoverage(run) {
  const discoveryDeadline = !!run.discoverySignal?.aborted;
  const recoveryAttempted = !!run.discoveryCoverage?.recoveryAttempted;
  const finalCoverage = coverage(run.pages, run.candidates(),
    { afterRecovery: recoveryAttempted || discoveryDeadline, vehicle: run.vehicle });
  const paletteGap = paletteGapStatus(run, run.vehicle);

  return { ...run.discoveryCoverage, ...finalCoverage,
    ...(run.vehicle && { paletteGap }),
    needsExpansion: finalCoverage.needsExpansion || (paletteGap.attempted
      && (paletteGap.unresolvedLeadNames.length > 0 || paletteGap.weakYearNames.length > 0)
      && paletteGap.yearPalettePages === 0),
    ...(discoveryDeadline && !recoveryAttempted ? { sourceLimit: 'discovery_deadline' } : {}) };
}

function plannedSourceHints(index, attempted, preferred, limit = 1) {
  const seenHosts = new Map();
  for (const source of index.values()) {
    const known = new URL(source.url);
    const host = known.hostname.replace(/^www\./, '');
    if (!seenHosts.has(host)) seenHosts.set(host, new Set());
    seenHosts.get(host).add(known.protocol);
  }
  const hints = [];

  for (const raw of preferred || []) {
    if (hints.length >= limit) break;
    try {
      const parsed = new URL(raw);
      const host = parsed.hostname.replace(/^www\./, '');
      // A model-suggested page is only a navigation hint when search has
      // already found this exact host. Public-page fetching still validates
      // the destination. Do not spend a page slot on a home page or duplicate.
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname === '/'
        || !seenHosts.has(host)) continue;
      // Follow a scheme already seen on this host when the proposed one has
      // never appeared in search results; older paint archives may be HTTP.
      const schemes = seenHosts.get(host);
      if (!schemes.has(parsed.protocol)) parsed.protocol = schemes.values().next().value;
      const url = sourceUrl(parsed.href);
      if (index.has(url) || attempted.has(url)) continue;
      hints.push({ url, title: parsed.pathname.split('/').pop().replace(/[-_]/g, ' '),
        snippet: '', queries: [], rank: 0, plannedSource: true });
    } catch { /* Ignore malformed model-proposed URLs. */ }
  }

  return hints;
}

function vettedPreferredUrls(index, preferred, vehicle) {
  return (preferred || []).filter(raw => {
    try {
      const url = sourceUrl(raw);
      const indexed = index.get(url);
      // A planner preference bypasses ordinary source ranking. Require model
      // context before granting that privilege, especially for opaque PDFs
      // that can contain an entire maker's unrelated historical palette.
      return modelNameMatches(`${indexed?.title || ''} ${new URL(url).pathname}`,
        vehicle.model) && (!indexed || sourceYearRelevance(indexed, vehicle) >= 0);
    } catch { return false; }
  });
}

function selectComplementarySources(run, vehicle, count, preferred = [], options = {}) {
  const available = selectSources(run.index, run.attempted, vehicle, run.index.size, preferred, options)
    .filter(source => !run.pagePool?.unavailableHost(source.url));
  const ranks = new Map(available.map((source, index) => [source.url, index]));
  const preferredUrls = new Set(preferred.map(sourceUrl));
  const domains = new Map();
  const queries = new Set();
  for (const page of run.pages.filter(page => !page.nameResearch)) {
    const host = new URL(page.url).hostname.replace(/^www\./, '');
    domains.set(host, (domains.get(host) || 0) + 1);
    for (const query of page.queries || []) queries.add(query);
  }
  const selected = [];
  const selectedByHost = new Map();
  const equipment = ['agricultural', 'construction', 'truck', 'bus']
    .includes(vehicleProfile(vehicle.automobileType).kind);
  while (available.length && selected.length < count) {
    const score = source => {
      const host = new URL(source.url).hostname.replace(/^www\./, '');
      const period = sourceYearRelevance(source, vehicle);
      const paintPage = /paint|colou?r|cores|pintura|tinta|farb|couleur|cat[aá]logo/i
        .test(`${source.title || ''} ${source.url}`);
      const social = /(?:^|\.)(?:instagram|facebook|tiktok|youtube|pinterest)\.com$/.test(host);
      const listing = /mercadolivre|mfrural|olx|classificados|marketplace/i.test(host);
      return (source.queries || []).some(query => !queries.has(query)) * 12
        + period * 10 + (paintPage ? 10 : 0) - (social ? 30 : 0)
        - (equipment && social ? 20 : 0) - (equipment && listing ? 18 : 0)
        + (preferredUrls.has(source.url) || source.plannedSource ? 24 : 0)
        - (/(?:^|\.)(?:scribd|issuu)\.com$|(?:^|\.)academia\.edu$/.test(host) ? 24 : 0)
        - (domains.get(host) || 0) * 8 - ranks.get(source.url);
    };
    available.sort((a, b) => score(b) - score(a));
    const choice = available.findIndex(source => {
      const host = new URL(source.url).hostname.replace(/^www\./, '');
      const readable = run.pages.some(page => page.status === 'ok'
        && new URL(page.url).hostname.replace(/^www\./, '') === host);
      return !equipment || readable || (selectedByHost.get(host) || 0) < 2;
    });
    if (choice < 0) break;
    const [source] = available.splice(choice, 1);
    selected.push(source);
    const host = new URL(source.url).hostname.replace(/^www\./, '');
    domains.set(host, (domains.get(host) || 0) + 1);
    selectedByHost.set(host, (selectedByHost.get(host) || 0) + 1);
    for (const query of source.queries || []) queries.add(query);
  }
  return selected;
}

function recoveryPriority(page, vehicle) {
  const text = `${page.title || ''} ${page.url}`;
  const domain = new URL(page.url).hostname;
  const dated = sourceYearRelevance(page, vehicle);
  const equipment = ['agricultural', 'construction', 'truck', 'bus']
    .includes(vehicleProfile(vehicle.automobileType).kind);

  return dated * 24 + Math.min(page.candidates?.length || 0, 8) * 2
    + (/cores|colou?rs?|paint|pintura|cat[aá]logo/i.test(text) ? 8 : 0)
    - (/manual.{0,45}(?:propriet|propiet|owner|usu[aá]ri)|owner.?s?\s+manual/i.test(text) ? 55 : 0)
    - (/(?:youtube|instagram|facebook|tiktok)\.com$/i.test(domain) ? (equipment ? 55 : 35) : 0)
    - (equipment && /mercadolivre|mfrural|olx|classificados|marketplace/i.test(domain) ? 22 : 0);
}

function initialSourceAllowance(run, vehicle, initialLimit) {
  // Stream a few useful pages immediately, but reserve most slots until the
  // Brazilian and international queries can compete on relevance. Otherwise
  // one fast result set can fill the whole budget with social/retail pages.
  const started = run.pages.filter(page => !page.nameResearch).length;
  const streamingLimit = Math.min(initialLimit, Math.ceil(initialLimit / 2));
  const perResult = Math.max(1, Math.ceil(initialLimit / seedQueries(vehicle).length));
  return Math.max(0, Math.min(perResult, streamingLimit - started));
}

function prefetchSources(run, vehicle) {
  if (!run.pagePool || run.fetchSignal?.aborted
    || run.timing?.remainingTargetMs?.(run.fetchSignal) <= 0) return;

  const room = Math.min(2, run.pagePool.prefetchRoom(),
    Math.max(0, run.maxPages - run.pages.filter(page => !page.nameResearch).length));
  if (!room) return;

  // Use the same relevance/domain ranking as discovery. A first fast query
  // gets only a small head start and never consumes extraction/page slots.
  const attempted = new Set([...run.attempted, ...run.pagePool.entries.keys()]);
  const buffered = [...run.pagePool.entries.values()].filter(entry => !entry.demand)
    .map(entry => run.index.get(entry.url)).filter(Boolean);
  const sources = selectComplementarySources({ ...run, attempted,
    pages: [...run.pages, ...buffered] }, vehicle, room);
  run.pagePool.prefetch(sources.map(source => source.url));
}

async function recoverDiscovery(run, vehicle, signal) {
  const before = coverage(run.pages, run.candidates(), { vehicle });
  const readable = run.pages.filter(page => page.status === 'ok' && !page.nameResearch).length;
  const missingPages = Math.max(0, Math.min(20, run.maxPages) - readable);
  const count = Math.min(8, Math.max(0, run.maxPages - readable));
  // Depth is independent paint evidence, not a successful-download quota.
  // Keep sparse/donor recovery, but do not add broad charts to an already
  // cross-checked inventory just to replace an unrelated failed page.
  if (!before.needsExpansion) return;
  if (!count) return;
  if (signal.aborted || run.searchBlocked) return;

  // One bounded recovery wave. A failed model-specific site does not close
  // discovery while independent catalogs remain available.
  const model = vehicle.model.replace(new RegExp(`^${String(vehicle.brand || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`, 'i'), '');
  const subject = [vehicle.brand, model, vehicle.manufacturingYear].filter(Boolean).join(' ');
  if (before.needsExpansion) {
    const profile = vehicleProfile(vehicle.automobileType);
    const equipment = ['agricultural', 'construction'].includes(profile.kind);
    const queries = equipment
      ? [`${subject} ${profile.kind} OEM paint color code ${vehicle.predominantColor || ''}`,
        `${vehicle.brand || model} original equipment paint colours catalogue`]
      : profile.kind === 'bus'
        ? [`${subject} carroceria tinta código cor pintura`,
          `${vehicle.brand || model} ${model} ${vehicle.predominantColor || ''} tinta carroceria fornecedor`]
      : [`${subject} cores originais catálogo pintura`,
        `${vehicle.brand || model} paint colour chart original manufacturer shared colors`];
    await run.search(queries, vehicle, signal);
    await Promise.allSettled(run.searchJobs);
  }
  const sources = selectComplementarySources(run, vehicle, count, [],
    { allowBrandCatalogs: before.needsExpansion });
  run.log('discovery_recovery', { before, replacementPages: sources.length });
  await run.readSources(sources, vehicle, signal);
  const after = coverage(run.pages, run.candidates(), { afterRecovery: true, vehicle });
  run.discoveryCoverage = { ...after, recoveryAttempted: true,
    replacementPages: sources.length, missingPagesBeforeRecovery: missingPages };
  if (after.needsExpansion) run.warn('discovery_coverage', 'Independent paint-source coverage remains insufficient after recovery');
}

// One collection phase, at most one planning expansion and one clarification
// wave. Extraction and local lookups overlap; reviews wait for stable evidence.
async function discover(run, vehicle, signal) {
  const modelDiscovery = run.catalogs.modelPalette().then(records => {
    run.catalogPages.push(...modelEvidencePages(records, vehicle));
    run.catalogs.start(candidateInventory(run.catalogPages, { vehicle }));
    run.log('model_catalog_discovery', { records: records.length, namedEvidenceRows: run.catalogPages.length });
    run.dump('model-catalog', { vehicle, records });
  }).catch(error => run.warn('model_catalog_discovery', error));

  const reads = [];
  const initialLimit = run.maxPages - Math.min(4, Math.floor(run.maxPages / 4));
  await Promise.all([modelDiscovery, run.catalogs.worker?.ready,
    run.search([...seedQueries(vehicle), ...paletteQueries(vehicle)].slice(0, run.maxSearches - 1),
      vehicle, signal, { onSources: () => {
        const room = initialSourceAllowance(run, vehicle, initialLimit);
        if (room > 0) reads.push(run.readSources(selectComplementarySources(run, vehicle, room), vehicle, signal));
      } })]);

  // Reserve the Portuguese query while downloads/extraction are still running.
  // Waiting for the slowest extractor can otherwise let its search window expire.
  const localQuery = portugueseNameQuery(run.candidates(), vehicle);
  const localSearch = run.search([localQuery], vehicle, signal, { onSources: () => {
    const index = new Map([...run.index].filter(([, source]) => source.queries?.includes(localQuery)));
    const room = Math.max(0, run.maxPages - run.pages.filter(page => !page.nameResearch).length);
    reads.push(run.readSources(selectComplementarySources({ ...run, index }, vehicle,
      Math.min(2, room)), vehicle, signal));
  } });
  await localSearch;

  // Search may publish early and return while its network jobs are still live.
  // Finish those jobs before judging coverage or skipping the research planner.
  await Promise.allSettled(run.searchJobs);

  // Once the initial result sets are indexed, admit more complementary sources
  // without waiting for the slowest extraction. Keep four late-source slots.
  const collectedLimit = run.maxPages - Math.min(4, Math.floor(run.maxPages / 4));
  reads.push(run.readSources(selectComplementarySources(run, vehicle,
    Math.max(0, collectedLimit - run.pages.filter(page => !page.nameResearch).length)), vehicle, signal));
  await Promise.all(reads);

  // An all-year archive can yield dozens of paints while still hiding the
  // requested edition's palette. Use indexed names as search leads and reserve
  // a short model-year brochure wave before paid name clarification begins.
  await researchPaletteGaps(run, vehicle);

  const state = coverage(run.pages, run.candidates(), { vehicle });
  const paletteGap = paletteGapStatus(run, vehicle);
  const needsPalettePlan = (paletteGap.unresolvedLeadNames.length > 0
      || paletteGap.weakYearNames.length > 0)
    && paletteGap.yearPalettePages === 0;
  if ((state.needsExpansion || needsPalettePlan) && run.discoverySignal && !run.discoverySignal.aborted) {
    // The fast seed window is not enough for a sparse or historical vehicle.
    // Extend only its follow-up search and page admissions; other vehicles keep
    // their short path and every stage remains inside the hard run deadline.
    signal = run.discoverySignal;
    run.fetchSignal = run.discoveryFetchSignal;
    run.extractionSignal = run.discoverySignal;
    run.log('sparse_discovery_extended', { untilMs: DISCOVERY_TARGET_MS, coverage: state });
  }
  run.log('discovery_coverage', state);
  const requestedFamilies = hueFamilies(vehicle.predominantColor);
  const nameLeads = run.maxNameSearches ? nameResearchQueries(run.candidates(), vehicle) : [];
  // This only orders clarification work; a paint name is not visual proof.
  nameLeads.sort((left, right) => Number([...hueFamilies(right.name)].some(hue => requestedFamilies.has(hue)))
    - Number([...hueFamilies(left.name)].some(hue => requestedFamilies.has(hue))));
  const selectNames = nameLeads.length > 2;
  let plan = { queries: [], preferred_urls: [] };
  const sparse = sparseResearchQueries(vehicle, run.candidates(), run.evidencePages());
  const generalUsed = () => run.queries.size - run.nameQueries.size
    - run.codeQueries.size - run.paletteQueries.size;
  const supplemental = run.search(sparse.slice(0, Math.max(0, run.maxSearches - generalUsed() - 3)),
    vehicle, signal).catch(error => run.warn('catalog_search', error));

  if ((state.needsExpansion || needsPalettePlan || selectNames) && !run.searchBlocked && !signal.aborted
    && (run.timing?.remainingMs?.(signal) ?? Infinity) >= 4000
    && selectSources(run.index, new Set(), vehicle, 1).length) {
    try {
      const namesSchema = selectNames ? object({ ...PLAN_SCHEMA.properties,
        name_leads: { type: 'array', maxItems: run.maxNameSearches,
          items: { type: 'string', enum: nameLeads.map(lead => lead.name) } } }) : PLAN_SCHEMA;
      plan = await run.mainAgent('research_plan', namesSchema, { vehicle,
        remaining_queries: state.needsExpansion || needsPalettePlan
          ? Math.max(0, run.maxSearches - generalUsed()) : 0,
        remaining_name_queries: run.maxNameSearches,
        coverage: { ...state, paletteGap },
        candidates: state.needsExpansion || needsPalettePlan ? planningCandidates(run.candidates()) : [],
        sources: state.needsExpansion || needsPalettePlan
          ? [...run.index.values()].map(({ url, title, snippet }) => ({ url, title, snippet })) : [],
        ...(selectNames && { name_leads: nameLeads.map(lead => ({ name: lead.name, codes: lead.codes,
          excerpts: lead.source_evidence.flatMap(source => source.passages).slice(0, 2).map(text => text.slice(0, 350)) })) }),
      }, readFile('prompts/research_plan.md') + (selectNames ? '\n' + readFile('prompts/name_research_selection.md') : ''), signal);
      plan.preferred_urls = vettedPreferredUrls(run.index, plan.preferred_urls, vehicle);
    } catch (error) { run.warn('planning', error); }
  }

  // One bounded clarification wave, chosen with the existing discovery planner.
  // A failed planner keeps a small fallback instead of flooding six broad charts.
  const selectedNames = new Set(plan.name_leads || nameLeads.slice(0, selectNames ? 3 : run.maxNameSearches).map(lead => lead.name));
  // A short marketing name can hide the requested hue. A same-make, same-code
  // catalog description earns one search slot, never a hue or identity verdict.
  const hints = await catalogHueLeads(run, vehicle, nameLeads, requestedFamilies);
  if (selectedNames.size < Math.min(run.maxNameSearches, 4)) {
    const extra = hints.find(lead => !selectedNames.has(lead.name));
    if (extra) selectedNames.add(extra.name);
  }
  run.focusedNameLeads = new Set(hints.filter(lead => selectedNames.has(lead.name))
    .slice(0, 1).map(lead => lead.name));
  // Reserve one clarification for a source-linked compound-name suffix. The
  // search must find the shorter spelling independently before it can become
  // a candidate; this prevents a long concatenated heading hiding a paint.
  const compound = nameLeads.find(lead => lead.compoundVariant);
  if (compound) selectedNames.add(compound.name);
  const clarification = run.clarifyNames(vehicle, run.nameClarificationSignal || signal, selectedNames)
    .catch(error => run.warn('name_resolution', error));

  const missingPalettes = paletteQueries(vehicle).filter(query => !run.queries.has(query));
  await supplemental;
  // The palette wave already spent its recovery allowance. Give any remaining
  // ordinary slot to a planner query about the unresolved named lead.
  const recoverySlots = needsPalettePlan ? 0 : run.maxSearches >= 8 ? 2 : 0;
  const remaining = Math.max(0, run.maxSearches - generalUsed() - recoverySlots);
  const followupQueries = await searchFollowups(run,
    [...(run.queries.has(localQuery) ? [] : [localQuery]), ...missingPalettes, ...plan.queries], vehicle, signal, remaining);
  const localSearches = [localQuery, ...followupQueries.filter(item => item.originals.includes(localQuery)).map(item => item.query)];
  await Promise.allSettled(run.searchJobs);
  const room = Math.max(0, run.maxPages - run.pages.filter(page => !page.nameResearch).length);
  const current = coverage(run.pages, run.candidates(), { vehicle });
  // Adequate palettes still get the mandatory Portuguese follow-up. Only read
  // its new results (or an explicit planner preference), not arbitrary older
  // results from the initial search. Name clarification has its own reads.
  const targetQueries = new Set([...localSearches, ...run.paletteQueries,
    ...followupQueries.map(item => item.query)]);
  const lateIndex = current.needsExpansion ? run.index : new Map([...run.index]
    .filter(([, source]) => source.queries?.some(query => targetQueries.has(query))
      || plan.preferred_urls?.includes(source.url)));
  for (const source of plannedSourceHints(run.index, run.attempted, plan.preferred_urls, Math.min(room, 1))) {
    lateIndex.set(source.url, source);
  }
  const lateSources = selectComplementarySources({ ...run, index: lateIndex }, vehicle,
    current.needsExpansion ? room : Math.min(2, room), plan.preferred_urls);
  await run.readSources(lateSources, vehicle, signal);

  // Exact-year palette pages can arrive in the late source wave. Search once
  // for a competing code while name clarification is still running.
  await Promise.all([clarification,
    searchAmbiguousPeriodCode(run, vehicle, run.verificationSignal || signal)]);
  await Promise.allSettled(run.searchJobs);
  await Promise.all([recoverDiscovery(run, vehicle, signal),
    clarifyLateName(run, vehicle, run.reviewSignal || signal, requestedFamilies)]);

  // Failed extraction alone gets a recovery pass. Successful pages are never
  // sent through a second full-page audit on the normal path.
  const failed = run.pages.filter(page => page.fallbackSegments?.length)
    .sort((left, right) => recoveryPriority(right, vehicle) - recoveryPriority(left, vehicle));
  const sourceRich = !coverage(run.pages, run.candidates(), { vehicle }).needsExpansion;
  const fastRecoverySignal = sourceRich && run.timing?.deadlineAt
    ? run.timing.deadlineAt(Math.min(35000, run.timing.deadlineElapsedMs() + 7000)) : null;
  const recoverySignal = fastRecoverySignal || run.recoverySignal || run.extractionSignal;

  await Promise.all(failed.map(page => run.recoverPage(page,
    nameResearchVehicle(page, vehicle), recoverySignal,
    { maxSegments: sourceRich ? 2 : Infinity })));
  if (failed.some(page => page.fallbackSegments.length)) run.warn('extraction_recovery',
    'Some source segments remain unextracted after the bounded recovery pass');

  // An explicit cross-maker paint claim can justify a small, period-specific
  // donor search. These are comparison leads; the donor palette is not model fitment.
  await recoverSharedPaints(run, vehicle, run.reviewSignal || signal);

  // Keep exact paint names from indexed results when their pages reject or
  // time out. These are weak leads, clearly marked for the normal main review;
  // they never count as successful page fetches or independent source crossing.
  run.snippetPages.push(...searchSnippetLeads(run.index, run.pages, vehicle));
  if (run.snippetPages.length) run.log('search_snippet_leads', {
    names: run.snippetPages.map(page => page.candidates[0].name),
  });
  run.discoveryCoverage = finalDiscoveryCoverage(run);
  run.dump('discovery-coverage', run.discoveryCoverage);
}

module.exports = { discover, paletteQueries, coverage, selectComplementarySources,
  initialSourceAllowance, prefetchSources, recoverDiscovery, catalogHueLeads,
  recoveryPriority, finalDiscoveryCoverage, plannedSourceHints, vettedPreferredUrls };
