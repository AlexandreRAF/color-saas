const { loadCandidates, eligibleCandidateIds } = require('./database_code_agent');
const { stripPaintFinish } = require('./paint_name');
const { isSingleName, printedNameKey, sourceCodes, hasNameLeadEvidence, nameResearchQueries,
  relatesToNameLead, requiresNameCheck } = require('./paint_evidence');
const { abbreviatedMatch } = require('./name_completeness');
const { selectSources } = require('./research_plan');
const { paintSearch, groupPaints, normalized } = require('./search_groups');

// Database names are search hints, never new research evidence by themselves.
async function refineNameQuery(lead, vehicle, { signal, lookup = loadCandidates } = {}) {
  if (lead.compoundVariant) return lead;
  if (!lead.codes.length) return lead;

  const matches = await lookup([{ name: lead.name, source_evidence: lead.source_evidence }],
    { brand: vehicle.brand, year: vehicle.manufacturingYear, signal });
  const rows = matches[0]?.candidates || [];
  const eligible = eligibleCandidateIds(rows, vehicle.brand, vehicle.manufacturingYear);
  const catalogNames = rows.filter(row => eligible.has(row.candidate_id) && row.source_code_match)
    .map(row => row.description.split('/')[0].trim())
    .filter(name => (!isSingleName(name) || /\s+MET\.?$/i.test(name))
      && ((` ${printedNameKey(name)} `).includes(` ${printedNameKey(lead.name)} `)
        || abbreviatedMatch(lead.name, name)));
  let names = [...new Set(catalogNames.map(stripPaintFinish))];

  const unversioned = names.filter((name) => !/\b(?:II|III|IV|V|VI|VII|VIII|IX|X)$/i.test(name));

  if (unversioned.length) names = unversioned;
  else if (!/\b(?:II|III|IV|V|VI|VII|VIII|IX|X|\d+)$/i.test(lead.name)) return lead;
  if (names.length !== 1) return lead;

  // A catalog's "HYPER MET" is a useful search hint for a single-word web
  // label. Expand the finish abbreviation only in the query; a fetched source
  // must still print the full name before it can enter the palette.
  const matching = catalogNames.filter(name => stripPaintFinish(name) === names[0]);
  const metOnly = isSingleName(names[0]) && matching.length
    && matching.every(name => /\s+MET\.?$/i.test(name));
  const hint = metOnly ? `${names[0]} Metallic` : names[0];

  return { ...lead, database_hint: hint,
    query: `${[vehicle.brand, vehicle.model].filter(Boolean).join(' ')} "${hint}" paint colour code` };
}

function nameSourceMatches(source, lead, vehicle) {
  const titlePath = `${source.title || ''} ${new URL(source.url).pathname}`;
  const metadata = `${titlePath} ${source.snippet || ''}`;
  const paintContext = /paint|colou?r|cores|pintura|tinta|farb|couleur|vernici|lack|pearl|perol/i.test(titlePath);
  const modelContext = titlePath.toLowerCase().includes(vehicle.model.toLowerCase());
  // A general archive can mention a name/code somewhere in a large document.
  // Clarification should target a paint source or an actual vehicle page.
  return (paintContext || modelContext) && hasNameLeadEvidence(metadata, lead.name, lead.codes);
}

function nameLeads(source) {
  return source.nameLeads || (source.nameLead ? [{ name: source.nameLead, codes: source.nameLeadCodes || [] }] : []);
}

function nameResearchVehicle(source, vehicle) {
  const leads = nameLeads(source);
  if (leads.length > 1) return { ...vehicle, paintNameLeads: leads };
  return leads.length ? { ...vehicle, paintNameLead: leads[0].name, paintCodeLeads: leads[0].codes } : vehicle;
}

function nameSearchGroups(leads, remaining, focusedNames = new Set()) {
  const focused = leads.filter(lead => focusedNames.has(lead.name));
  const ordinary = leads.filter(lead => !focusedNames.has(lead.name));
  return remaining >= leads.length + Math.ceil(ordinary.length / 2)
    ? [...focused.map(lead => [lead]), ...groupPaints(ordinary, lead => lead, 2)]
    : leads.map(lead => [lead]);
}

function nameGroupQuery(vehicle, group, focusedNames = new Set()) {
  if (group.length > 1) return paintSearch(vehicle, group, 'name');
  const [lead] = group;
  return focusedNames.has(lead.name) && lead.codes.length
    ? `${vehicle.brand} "${lead.database_hint || lead.name}" "${lead.codes[0]}" paint color` : lead.query;
}

function resolvedName(run, lead) {
  return run.pages.some(page => page.status === 'ok' && page.candidates?.some(candidate =>
    (!requiresNameCheck(candidate.name) || (candidate.name.toLowerCase() === lead.name.toLowerCase()
      && candidate.name !== stripPaintFinish(candidate.name)
      && sourceCodes(candidate.name, candidate.evidence || []).some(code => lead.codes.includes(code))))
    && (lead.compoundVariant
      ? printedNameKey(candidate.name) === printedNameKey(lead.name)
      : relatesToNameLead(candidate, lead.name, lead.codes))
    && (!lead.database_hint || normalized(stripPaintFinish(candidate.name)) === normalized(stripPaintFinish(lead.database_hint)))));
}

async function readNameGroup(run, leads, query, vehicle, signal) {
  const selected = new Map();
  for (const lead of leads.filter(lead => !resolvedName(run, lead))) {
    const index = new Map([...run.index].filter(([, source]) =>
      source.queries.includes(query) && nameSourceMatches(source, lead, vehicle)));
    const strong = [...index.values()].filter(source => {
      const metadata = `${source.title || ''} ${source.snippet || ''}`.toLowerCase();
      return metadata.includes(lead.name.toLowerCase())
        && lead.codes.some(code => new RegExp(`\\b${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(metadata));
    }).map(source => source.url);
    for (const source of selectSources(index, new Set(), vehicle, 2, strong)) {
      const page = selected.get(source.url) || { ...source, nameResearch: true, nameLeads: [] };
      page.nameLeads.push({ name: lead.name, codes: lead.codes });
      selected.set(source.url, page);
    }
  }
  await run.readSources([...selected.values()], vehicle, signal);
}

async function clarifyNameBatch(run, vehicle, signal, selectedNames) {
  if (signal.aborted) return;
  const remaining = Math.max(0, run.maxNameSearches - run.nameQueries.size);
  const selected = nameResearchQueries(run.candidates(), vehicle).filter(lead =>
    !run.checkedNames.has(lead.name.toLowerCase()) && (!selectedNames || selectedNames.has(lead.name)))
    .slice(0, remaining);
  selected.forEach(lead => run.checkedNames.add(lead.name.toLowerCase()));
  const leads = await Promise.all(selected.map(async lead => {
    try { return await refineNameQuery(lead, vehicle, { signal, lookup: run.options.nameLookupFn }); }
    catch (error) { run.log('name_lookup_failed', { name: lead.name, error: error.message }); return lead; }
  }));

  // Reserve an individual fallback for every grouped lead. If the quota cannot
  // fund that worst case, retain ordinary individual searches for this wave.
  const groups = nameSearchGroups(leads, remaining, run.focusedNameLeads);
  const outcomes = await Promise.allSettled(groups.map(async group => {
    const query = nameGroupQuery(vehicle, group, run.focusedNameLeads);
    run.dump(`name-research-${run.checkedNames.size}-${normalized(group[0].name)}`, { leads: group, query });
    const start = run.searchJobs.length;
    await run.search([query], vehicle, signal, { forNames: true });
    await Promise.allSettled(run.searchJobs.slice(start));
    await readNameGroup(run, group, query, vehicle, signal);

    const fallbacks = await Promise.allSettled(group.map(async lead => {
      if (!resolvedName(run, lead) && lead.query !== query && !signal.aborted) {
        const start = run.searchJobs.length;
        await run.search([lead.query], vehicle, signal, { forNames: true });
        await Promise.allSettled(run.searchJobs.slice(start));
        await readNameGroup(run, [lead], lead.query, vehicle, signal);
      }
      run.log('grouped_search_coverage', { stage: 'name_clarification', name: lead.name,
        covered: resolvedName(run, lead) });
    }));
    for (const result of fallbacks) if (result.status === 'rejected') run.warn('name_resolution', result.reason);
  }));
  for (const result of outcomes) if (result.status === 'rejected') run.warn('name_resolution', result.reason);
  run.log('name_research_complete', { queries: run.nameQueries.size, leads: leads.length,
    unresolved: leads.filter(lead => !resolvedName(run, lead)).map(lead => lead.name) });
}

module.exports = { refineNameQuery, nameSourceMatches, nameLeads, nameResearchVehicle,
  nameSearchGroups, nameGroupQuery, resolvedName, clarifyNameBatch };
