'use strict';

const { selectSources } = require('./research_plan');
const { candidateSourceCodes, requiresNameCheck } = require('./paint_evidence');
const { candidateFinishRelation } = require('./paint_finish');
const { hasPortugueseName } = require('./portuguese_names');
const { mentions, normalized } = require('./search_groups');

function followupNeed(query, candidates) {
  const matches = candidates.filter(candidate => !requiresNameCheck(candidate.name)
    && mentions(query, candidate.name));
  if (matches.length !== 1) return null;
  const candidate = matches[0];
  const rest = normalized(query).replace(normalized(candidate.name), '');
  const kinds = [];
  if (/portugues|brazil|brasil/.test(rest) && /nome|name|cor/.test(rest)) kinds.push('portuguese');
  if (/finish|acabamento|perol|pearlescent|metallic|tricamada|tricoat/.test(rest)) kinds.push('finish');
  if (/shared|donor|same paint|compartilh|mesma tinta|mesma cor/.test(rest)) kinds.push('donor');
  return kinds.length ? { query, candidate, kinds } : null;
}

function covered(run, need, vehicle, queries) {
  const urls = new Set([...run.index.values()].filter(source =>
    source.queries.some(query => queries.includes(query))).map(source => source.url));
  const targetCodes = new Set(need.candidate.sources.flatMap(source => candidateSourceCodes(need.candidate, source)));
  // Only extracted, source-local passages count. Search snippets and adjacent
  // palette rows cannot satisfy a grouped question on behalf of this paint.
  const linked = run.candidates().flatMap(candidate => candidate.sources.filter(source => urls.has(source.url)
    && (normalized(candidate.name) === normalized(need.candidate.name)
      || candidateSourceCodes(candidate, source).some(code => targetCodes.has(code))))
    .map(source => ({ candidate, source })));
  return need.kinds.every(kind => {
    if (kind === 'portuguese') return linked.some(({ candidate }) => hasPortugueseName(candidate.name));
    if (kind === 'finish') return linked.some(({ candidate, source }) =>
      ['compatible', 'incompatible'].includes(candidateFinishRelation(candidate, source.evidence, vehicle.paintFinish)));
    return linked.some(({ source }) => source.evidence.some(passage => mentions(passage, vehicle.model)
      && /shared|same (?:paint|colou?r)|donor|compartilh|mesma (?:tinta|cor)|utiliza(?:va)?|usava/i.test(passage)));
  });
}

// The broad initial, specialist and sparse/donor-discovery queries never enter
// this helper. Only explicit follow-ups for the same named paint can share it.
async function searchFollowups(run, queries, vehicle, signal, maxQueries) {
  const fresh = [...new Set(queries)].filter(query => query && !run.queries.has(query)).slice(0, maxQueries);
  const needs = fresh.map(query => followupNeed(query, run.candidates()));
  const groups = [], used = new Set();
  let spare = Math.max(0, maxQueries - fresh.length);
  for (let i = 0; i < fresh.length; i++) {
    if (used.has(i)) continue;
    const partner = needs[i] && spare > 0 ? needs.findIndex((need, j) => j > i && !used.has(j)
      && need?.candidate.id === needs[i].candidate.id && need?.candidate.name === needs[i].candidate.name
      && fresh[i].length + fresh[j].length < 420) : -1;
    if (partner < 0) groups.push([{ query: fresh[i], need: needs[i] }]);
    else {
      groups.push([i, partner].map(j => ({ query: fresh[j], need: needs[j] })));
      used.add(partner);
      spare--; // Group + two fallbacks uses one more slot than two singles.
    }
  }

  const searched = [];
  // Reserve queries in input order, but keep independent network jobs parallel.
  const outcomes = await Promise.allSettled(groups.map(async group => {
    if (signal.aborted) return;
    const query = group.length === 1 ? group[0].query : group.map(item => `(${item.query})`).join(' OR ');
    const start = run.searchJobs.length;
    await run.search([query], vehicle, signal);
    await Promise.allSettled(run.searchJobs.slice(start));
    if (run.queries.has(query)) searched.push({ query, originals: group.map(item => item.query) });
    if (group.length === 1) return;

    const index = new Map([...run.index].filter(([, source]) => source.queries.includes(query)));
    const room = Math.max(0, run.maxPages - run.pages.filter(page => !page.nameResearch).length);
    await run.readSources(selectSources(index, run.attempted, vehicle, Math.min(2, room)), vehicle, signal);
    for (const item of group) {
      const complete = covered(run, item.need, vehicle, [query]);
      run.log('grouped_search_coverage', { stage: 'followup', name: item.need.candidate.name,
        purposes: item.need.kinds, covered: complete });
      if (!complete) {
        const start = run.searchJobs.length;
        await run.search([item.query], vehicle, signal);
        await Promise.allSettled(run.searchJobs.slice(start));
        if (run.queries.has(item.query)) searched.push({ query: item.query, originals: [item.query] });
      }
    }
  }));
  for (const result of outcomes) if (result.status === 'rejected') run.warn('followup_search', result.reason);
  return searched;
}

module.exports = { searchFollowups };
