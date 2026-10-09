const { loadCandidates } = require('./database_code_agent');
const { catalogFinishEvidence } = require('./lazzumix_finish');
const { candidateFinishRelation, combineFinishRelations } = require('./paint_finish');
const { sourceCodes, requiresNameCheck } = require('./paint_evidence');
const { hueFamilies } = require('./hue_review');
const { paintSearch } = require('./search_groups');

// Reuse at most two ordinary search slots. No extra model call, page quota or
// deadline. Database matches here are search leads; only the final agent approves
// their identity and can use them to filter the output.
async function finishResearchQueries(candidates, vehicle, options = {}) {
  if (!vehicle.paintFinish || !candidates.length || options.signal?.aborted) return [];

  const wanted = hueFamilies(vehicle.predominantColor);
  const leads = candidates.filter(candidate => {
    const found = hueFamilies(candidate.name);
    return !requiresNameCheck(candidate.name)
      && (!wanted.size || !found.size || [...found].some(hue => wanted.has(hue)));
  }).map(candidate => ({ ...candidate, source_evidence: candidate.sources.map(source => ({
    source_name: candidate.name, passages: source.evidence,
  })) }));

  if (!leads.length) return [];

  const matches = await (options.loadCandidates || loadCandidates)(leads, {
    signal: options.signal, databasePath: options.databasePath, brand: vehicle.brand,
    paintFinish: vehicle.paintFinish, year: vehicle.manufacturingYear,
  });

  const byIndex = new Map(matches.map(match => [match.index, match.candidates]));
  const queries = [];

  for (const [index, lead] of leads.entries()) {
    const web = lead.sources.map(source => candidateFinishRelation(lead, source.evidence, vehicle.paintFinish));
    const rows = (byIndex.get(index) || []).filter(row => row.source_code_match
      && String(row.manufacturer).trim().toLowerCase() === String(vehicle.brand).trim().toLowerCase());
    const relation = combineFinishRelations([...web,
      ...rows.map(row => catalogFinishEvidence(row, vehicle.paintFinish).relation)]);

    if (relation === 'compatible' || relation === 'incompatible') continue;

    const codes = [...new Set(lead.sources.flatMap(source => sourceCodes(lead.name, source.evidence)))];

    queries.push(paintSearch(vehicle, [{ name: lead.name, codes }], 'finish'));

    if (queries.length === 2) break;
  }

  return queries;
}

module.exports = { finishResearchQueries };
