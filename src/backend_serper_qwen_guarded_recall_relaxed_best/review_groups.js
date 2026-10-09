'use strict';

const { brandKey, exactCatalogIdentity } = require('./database_code_agent');
const { candidateSourceCodes } = require('./paint_evidence');
const { completePaintName } = require('./paint_name');

const normalized = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function sharedAliasEvidence(left, right, code) {
  const names = [left.name, right.name].map(name => normalized(completePaintName(name)));
  // A shared web passage must explicitly print both full identities and the
  // code. Same-code hits on unrelated pages cannot establish an alias.
  return left.sources.some(source => !source.catalog && right.sources.some(other =>
    other.url === source.url && source.evidence.some(passage => other.evidence.includes(passage)
      && [...names, normalized(code)].every(term => (` ${normalized(passage)} `).includes(` ${term} `)))));
}

// Only catalog-only aliases with an identical explicit model/year/finish scope
// share a decision. Web qualifiers, unknown finishes and conflicting identities
// remain independent. All original candidates still query every catalog.
async function groupCatalogReviews(candidates, catalogs, vehicle) {
  const groups = new Map();
  await Promise.all(candidates.map(async candidate => {
    const checked = await catalogs.get(candidate);
    const rows = exactCatalogIdentity(candidate.name, checked.candidates || [], vehicle.brand,
      candidate.sources.flatMap(source => candidateSourceCodes(candidate, source)));
    const local = candidate.sources.every(source => source.catalog === 'basf_models');
    const finishes = new Set(rows.map(row => JSON.stringify([...(row.paintFinish || [])].sort())));
    const known = finishes.size === 1 && !finishes.has('[]');
    const scope = candidate.sources.map(source => {
      const row = source.catalog_record;
      return row && JSON.stringify([row.model, row.model_match, row.year, row.universal_code]);
    }).sort();
    const modelScope = [...new Set(rows.filter(row => row.model_match === 'exact'
      && normalized(row.model) === normalized(vehicle.model))
      .map(row => JSON.stringify([row.model, row.model_match, row.year])))].sort();
    const code = rows[0]?.universal_code;
    const web = !local && known && rows.length && modelScope.length;
    const key = local && known && rows.length && scope.every(Boolean)
      ? JSON.stringify([brandKey(vehicle.brand), rows[0].universal_code, [...finishes], [...new Set(scope)]])
      : web ? JSON.stringify(['web', brandKey(vehicle.brand), code, [...finishes], modelScope]) : candidate.id;
    // Different vehicle/version qualifications stay separate even for a
    // documented alias. Only identical source sets may share an inclusion.
    const webScope = member => JSON.stringify(member.sources.filter(source => !source.catalog)
      .map(source => [source.url, [...source.evidence].sort()]).sort());
    const compatible = groups.get(key)?.every(member => sharedAliasEvidence(member, candidate, code)
      && webScope(member) === webScope(candidate));
    if (web && groups.has(key) && !compatible) {
      groups.set(candidate.id, [candidate]);
      return;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }));

  // Preserve admission priority even if catalog lookups finish out of order.
  const order = new Map(candidates.map((candidate, index) => [candidate.id, index]));
  return [...groups.values()].map(members => members.sort((a, b) => order.get(a.id) - order.get(b.id)))
    .sort((a, b) => order.get(a[0].id) - order.get(b[0].id));
}

function combinedCandidate(members) {
  if (members.length === 1) return members[0];
  const first = members[0];
  return { ...first,
    aliases: [...new Set(members.flatMap(member => [member.name, ...(member.aliases || [])]))],
    sources: members.flatMap(member => member.sources),
    catalog_alias_group: members.map(({ id, name }) => ({ id, name })),
    group_instruction: 'These complete published names have an evidence-backed shared manufacturer, OEM code, model/year scope and known finish. Review all aliases and combined evidence for this identity. Preserve conflicting or uncertain facts; do not infer aliasing from code alone.',
  };
}

function expandGroupDecision(members, decision) {
  const value = decision[members[0].id];
  if (members.length === 1) return decision;
  return Object.fromEntries(members.map(member => [member.id, typeof value === 'string' ? value : {
    ...value, name: null,
    // Every member owns equivalent catalog evidence. Never attach another
    // identity's web citation or source ID to the expanded decision.
    source_ids: member.sources.map(source => source.page_id),
  }]));
}

module.exports = { groupCatalogReviews, combinedCandidate, expandGroupDecision, sharedAliasEvidence };
