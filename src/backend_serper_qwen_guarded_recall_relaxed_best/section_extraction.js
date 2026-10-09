'use strict';

const { createHash } = require('node:crypto');
const { restoreEvidence } = require('./page_evidence');

// Only explicit navigation links are ignored. Plain words, paint links, table
// headings, years and restrictions remain part of the extraction/cache identity.
function withoutNavigationLinks(text) {
  return text.split(/\r?\n/).filter(line =>
    !/^\s*\[(?:home|cart|shopping cart|checkout|login|sign in|contact us|privacy policy|terms of use|inicio|carrinho|contato)\]\(https?:\/\/[^)]+\)\s*$/i.test(line)).join('\n');
}

class SectionExtractionCache {
  constructor() { this.entries = new Map(); }

  async extract(vehicle, reference, source, execute, onReuse) {
    if (!reference) return execute();
    const key = createHash('sha256').update(JSON.stringify([vehicle, reference.text, reference.breakBefore])).digest('hex');
    const existing = this.entries.get(key);
    if (existing) {
      const result = await existing;
      const restored = (result.found || []).map(candidate =>
        restoreEvidence(candidate, reference.units, reference.breakBefore)).filter(Boolean);
      const normalize = text => text.replace(/\s+/g, ' ').trim().toLowerCase();
      // References are restored against this page's units, never another URL's
      // quotation. A changed finish/year/table cell produces a different key.
      if (result.found && restored.length === result.found.length && restored.every(candidate =>
        candidate.evidence.some(passage => normalize(passage).includes(normalize(candidate.name)))
        && candidate.evidence.every(passage => normalize(source).includes(normalize(passage))))) {
        onReuse?.();
        return { ...result, candidates: restored, requests: 0, usage: undefined };
      }
    }
    const job = execute();
    this.entries.set(key, job);
    try { return await job; }
    catch (error) { if (this.entries.get(key) === job) this.entries.delete(key); throw error; }
  }
}

module.exports = { SectionExtractionCache, withoutNavigationLinks };
