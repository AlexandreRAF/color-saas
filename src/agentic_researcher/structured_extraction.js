'use strict';

const { literalPaintRows, pairedSwatch } = require('./literal_paint_rows');
const { galleryPaintRows } = require('./gallery_paint_rows');
const { withoutClearlyDifferentSwatches } = require('./swatch_hue');
const { displayColorCandidates } = require('./display_color');

// Only exact, explicitly labelled rows are removed from the AI input. Their
// verbatim evidence remains in the inventory and follows the same main review.
function structuredExtraction(text, vehicle, page = {}) {
  const outOfScopeRows = [];
  const candidates = literalPaintRows(text, vehicle, { onSkippedRow: row => outOfScopeRows.push(row) });
  candidates.push(...displayColorCandidates({ ...page, text }, vehicle));
  let remaining = withoutClearlyDifferentSwatches(text, vehicle?.predominantColor);
  for (const row of outOfScopeRows) remaining = remaining.replaceAll(row, '\n');
  for (const candidate of candidates) {
    // One color-list sentence can contain several display labels and named
    // paints. Keep that entire sentence available to the page extractor.
    if (candidate.identityType === 'vehicle_display_color') continue;
    for (const row of candidate.evidence) {
      // Context excerpts must remain for the AI. Remove only an explicit row
      // or complete labelled card already preserved as candidate evidence.
      const card = /^#{2,6}\s/.test(row) && /(?:Paint|Colou?r)\s+Code\s*:/i.test(row);
      const context = row === text.slice(0, 1000)
        || row === text.split(/\r?\n/).slice(0, 8).join('\n').trim();
      if (!context && row.includes(candidate.name)
        && (card || pairedSwatch(row, candidate.name) || row === candidate.evidence[0] && !row.includes('\n'))) {
        remaining = remaining.replaceAll(row, '\n');
      }
    }
  }
  // Repeated swatch captions add hundreds of extraction units on some shops.
  // Remove only images whose full name and labelled code were recovered above.
  // Conflicting or different captions stay in the residual for model review.
  remaining = remaining.replace(/!\[([^\]\n]+)\]\(https?:\/\/[^)\n]+\)/g, (image, caption) => {
    const normalized = caption.toLowerCase();
    const recovered = candidates.filter(candidate => normalized.includes(candidate.name.toLowerCase())
      && candidate.evidence.some(row => {
        const code = /(?:Paint|Colou?r)\s+Code\s*:\s*([A-Z0-9]{2,8})/i.exec(row)?.[1];
        return code && new RegExp(`\\b${code}\\b`, 'i').test(caption);
      }));
    // A matching caption may still contain a unique finish/fitment qualifier.
    // Keep its exact text with the candidate before removing repeated images.
    for (const candidate of recovered) {
      if (!candidate.evidence.includes(image)) candidate.evidence.push(image);
    }
    return recovered.length ? '' : image;
  });
  const gallery = galleryPaintRows(text, vehicle);
  candidates.push(...gallery.candidates);
  for (const span of gallery.spans) remaining = remaining.replaceAll(span, '\n');
  const substantive = remaining.split(/\r?\n/).filter(line => line.trim()
    && !/^(?:paint codes?|colou?r codes?|c[oó]digos? de cores)\s*[:.]?$/iu.test(line.trim()));
  // Keep contextual prose, including finish restrictions and model headings.
  // A model still reads all unparsed content once, with the original opening.
  // Never cut a code/name mid-line in repeated opening context (070 must not
  // become a seemingly published 07 at an artificial excerpt boundary).
  const firstRow = Math.min(text.length, ...candidates.map(candidate => text.indexOf(candidate.evidence[0]))
    .filter(index => index >= 0));
  const openingEnd = text.lastIndexOf('\n', Math.min(1200, firstRow));
  let opening = openingEnd >= 0 ? text.slice(0, openingEnd) : '';
  for (const row of outOfScopeRows) opening = opening.replaceAll(row, '\n');
  for (const span of gallery.spans) {
    for (const line of span.split(/\r?\n/).filter(line => line.trim())) {
      opening = opening.replaceAll(line, '\n');
    }
  }
  opening = withoutClearlyDifferentSwatches(opening, vehicle?.predominantColor);
  const residual = remaining !== text
    ? `${remaining.startsWith(opening) ? '' : opening + '\n\n'}Unparsed source content:\n${remaining}` : text;
  return { candidates, text: residual, complete: candidates.length > 0 && substantive.length === 0 };
}

module.exports = { structuredExtraction };
