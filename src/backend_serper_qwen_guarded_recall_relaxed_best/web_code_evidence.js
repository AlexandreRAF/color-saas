'use strict';

const { printedNameKey, sourceCodes } = require('./paint_evidence');

// Local catalogs remain the first code authority. If they have no match, two
// independent fetched domains may establish the same paint-owned OEM code.
// A broad source page, search snippet, supplier SKU, or nearby code cannot.
function crossCheckedWebCodes(color) {
  if (color.identityType === 'vehicle_display_color') return [];
  const byCode = new Map();
  const target = printedNameKey(color.name);

  for (const source of color.source_evidence || []) {
    if (!/^https?:\/\//i.test(source.url || '') || source.retrievalMethod === 'search_snippet'
      || printedNameKey(source.source_name || color.name) !== target) continue;
    let host;
    try { host = new URL(source.url).hostname.replace(/^www\./, ''); }
    catch { continue; }

    for (const passage of source.passages || []) {
      if (!(` ${printedNameKey(passage)} `).includes(` ${target} `)) continue;
      const explicitCode = /\b(?:paint|colou?r|cor|tinta)\s*(?:code|c[oó]digo|ref(?:erence|er[eê]ncia)?)\b|\b(?:c[oó]digo|code|ref(?:erence|er[eê]ncia)?)\s*(?:d[ae]\s*)?(?:cor|tinta|colou?r)\b/iu.test(passage)
        || /\b[A-Z]{1,3}\d{2,5}\s*[-:|]\s*[\p{L}]/u.test(passage);
      if (!explicitCode) continue;

      for (const code of ['model_period_context', 'shared_paint_context'].includes(source.claimScope)
        ? [] : sourceCodes(source.source_name || color.name, [passage])) {
        if (!/^[A-Z0-9]{2,8}$/.test(code) || !/\d/.test(code)) continue;
        if (!byCode.has(code)) byCode.set(code, new Set());
        byCode.get(code).add(host);
      }
    }
  }

  return [...byCode].filter(([, hosts]) => hosts.size >= 2).map(([universal_code, hosts]) => ({
    universal_code, codeOrigin: 'cross_checked_web', sourceCount: hosts.size,
  }));
}

module.exports = { crossCheckedWebCodes };
