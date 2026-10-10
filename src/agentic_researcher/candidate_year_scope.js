'use strict';

const { sourceYearRelevance } = require('./source_year');

const normalized = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const compact = value => normalized(value).replace(/\s+/g, '');

function clearlyOtherModelLead(candidate, page, vehicle) {
  if (!page?.url || page.catalog || !vehicle?.model) return false;
  const model = compact(vehicle.model);
  const stem = /^([a-z]+\d+)[a-z]$/.exec(model)?.[1];
  if (!stem || stem.length < 4) return false;
  let path;
  try { path = new URL(page.url).pathname; }
  catch { return false; }
  const titlePath = compact(`${page.title || ''} ${path}`);
  const otherModels = [...titlePath.matchAll(new RegExp(`${stem}([a-z])`, 'g'))]
    .map(match => `${stem}${match[1]}`);
  if (!otherModels.length || otherModels.includes(model)) return false;
  return !(candidate.evidence || []).some(passage => compact(passage).includes(model));
}

function explicitRange(line) {
  return [...String(line).matchAll(/(?<!\d)((?:18|19|20)\d{2})\s*(?:[-–—~/]|to|a|at[eé]|through)\s*((?:18|19|20)?\d{2})(?!\d)/giu)]
    .map(([, first, last]) => {
      const start = Number(first);
      let end = Number(last);
      if (last.length === 2) {
        end = Math.floor(start / 100) * 100 + end;
        if (end < start) end += 100;
      }
      return [start, end];
    }).filter(([start, end]) => end >= start && end - start <= 60);
}

// A dated appearance in an all-year gallery supports that dated vehicle only.
// This rejects one source lead, never the paint identity from other sources.
// Undated paint rows, a nearby year, or an explicit reuse note remain reviewable.
function clearlyHistoricalLead(candidate, page, vehicle) {
  const year = Number(vehicle?.manufacturingYear);
  if (!Number.isInteger(year) || !page?.url || page.catalog) return false;

  const name = normalized(candidate?.name);
  if (!name) return false;

  const evidence = (candidate.evidence || []).filter(value => typeof value === 'string');

  // A paint-specific model-history span is stronger than a matching year in
  // the page title. Never use ordinary catalog years for this decision.
  const ranges = evidence.flatMap(passage => passage.split(/\r?\n/).flatMap(explicitRange));
  if (ranges.length && ranges.every(([start, end]) => year < start || year > end)) {
    const targetReused = evidence.some(passage => passage.split(/\r?\n/).some(line =>
      (` ${normalized(line)} `).includes(` ${name} `)
      && new RegExp(`(?<!\\d)${year}(?!\\d)`).test(line)
      && /\b(?:used|reused|available|offered|dispon[ií]vel|utilizad[oa]|usad[oa])\b/iu.test(line)));
    return !targetReused;
  }
  if (sourceYearRelevance(page, vehicle) === 1) return false;
  if (ranges.length || evidence.some(value => new RegExp(`(?<!\\d)${year}(?!\\d)`).test(value))) return false;

  let datedLines = 0;
  for (const passage of evidence) {
    for (const line of passage.split(/\r?\n/)) {
      if (!(` ${normalized(line)} `).includes(` ${name} `)) continue;
      const years = [...line.matchAll(/(?<!\d)(?:18|19|20)\d{2}(?!\d)/g)]
        .map(match => Number(match[0]));
      if (years.some(value => Math.abs(value - year) <= 10)) return false;
      if (years.length) { datedLines++; continue; }

      // A heading or image caption is a label for the dated rows below it.
      // An undated code/name or product row is independent evidence of reuse.
      if (!/^\s*(?:#{1,6}\s|!?\[)/.test(line)) return false;
    }
  }

  return datedLines > 0;
}

module.exports = { clearlyHistoricalLead, clearlyOtherModelLead };
