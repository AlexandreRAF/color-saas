'use strict';

const { evidenceUnits } = require('./page_evidence');

function numberedEvidence(pages) {
  const ranges = new Map();
  const numbered = pages.map(page => {
    let cursor = 0;
    const units = evidenceUnits(page.text).map(text => {
      const start = page.text.indexOf(text, cursor);
      if (start < 0) throw new Error('Verification source unit is not literal');
      cursor = start + text.length;
      return { start, end: cursor, text };
    });
    ranges.set(page.id, { text: page.text, units });
    return { ...page, text: units.map((unit, index) => `${index + 1}| ${unit.text}`).join('\n') };
  });
  return { pages: numbered, ranges };
}

function restoreChecks(checks, ranges) {
  return checks.map(check => {
    if (!check || typeof check !== 'object') return { quote: '' };
    // Compatibility for injected reviewers; API responses use evidence_ids.
    if (typeof check.quote === 'string') return check;
    const source = ranges.get(check.source_id);
    const ids = [...new Set(Array.isArray(check.evidence_ids) ? check.evidence_ids : [])].sort((a, b) => a - b);
    const valid = source && ids.length && ids.every((id, index) => Number.isInteger(id)
      && id >= 1 && id <= source.units.length && (!index || id === ids[index - 1] + 1));
    const quote = valid ? source.text.slice(source.units[ids[0] - 1].start,
      source.units[ids.at(-1) - 1].end) : '';
    return { ...check, quote: quote.includes('[…]') ? '' : quote };
  });
}

module.exports = { numberedEvidence, restoreChecks };
