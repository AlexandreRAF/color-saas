'use strict';

const { isGenericPaintName } = require('./paint_name');

const plain = text => text.replace(/\[([^\]]+)\]\(https?:\/\/[^\n]*?\)/g, '$1').trim();

// Repeated color-gallery headings followed by exact name/year captions are
// mechanical evidence, not a model-year availability claim. Keep each complete
// section (including repaint/finish qualifications) for the ordinary reviewer.
function galleryPaintRows(text, vehicle = {}) {
  const brand = String(vehicle.brand || '').trim();
  if (!brand || !/\bcolou?r(?:s| galleries| gallery)\b/i.test(text)) return { candidates: [], spans: [] };
  const headings = [...text.matchAll(/^#{2,6}[ \t]+[^\r\n]+/gm)];
  const suffix = new RegExp(`\\s+${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+Colou?r(?:\\s+[A-Z0-9]{2,8})?$`, 'i');
  const rows = [];

  for (const [index, heading] of headings.entries()) {
    const caption = plain(heading[0].replace(/^#+\s*/, ''));
    if (!suffix.test(caption)) continue;
    const name = caption.replace(suffix, '').trim();
    if (!name || name.length > 100 || !/\p{L}/u.test(name)) continue;
    const end = headings[index + 1]?.index ?? text.length;
    const section = text.slice(heading.index, end);
    const body = section.slice(heading[0].length);
    const captions = [...body.matchAll(/[^\r\n]+/g)].filter(line => {
      const value = plain(line[0]);
      return value.startsWith(`${name} `) && /^(?:18|19|20)\d{2}\s+\S/.test(value.slice(name.length + 1));
    });
    if (!captions.length) continue;
    rows.push({ name, section, heading: heading[0], captions: captions.map(line => line[0]) });
  }

  // One isolated heading is not enough to establish a structured gallery.
  if (new Set(rows.map(row => row.name)).size < 3) return { candidates: [], spans: [] };
  const context = text.slice(0, headings[0].index).trim();
  const targetYear = vehicle.manufacturingYear == null ? NaN : Number(vehicle.manufacturingYear);
  const nearRequestedYear = row => {
    if (!Number.isInteger(targetYear)) return true;

    // A gallery caption explicitly dates its own car. A section containing
    // only cars from a remote generation is historical evidence, not a lead
    // for this model year. Keep nearby years and any stated reuse; the full
    // page remains available for later source checks.
    const years = row.captions.flatMap(caption =>
      [...plain(caption).matchAll(/(?<!\d)(?:18|19|20)\d{2}(?!\d)/g)].map(match => Number(match[0])));
    if (!years.length || years.some(year => Math.abs(year - targetYear) <= 10)) return true;
    return new RegExp(`(?<!\\d)${targetYear}(?!\\d)`).test(row.section.slice(row.heading.length));
  };
  const candidates = rows.filter(row => !isGenericPaintName(row.name) && nearRequestedYear(row)).map(row => ({
    name: row.name, evidence: [row.section, context].filter(Boolean),
  }));
  // A remote-year section made solely of its heading and dated captions has
  // already been scoped out. Remove that exact section from the model input,
  // or the residual extractor can recreate old colors as unqualified leads.
  // Any additional prose stays available to the model, including reuse notes.
  const spans = rows.filter(row => !isGenericPaintName(row.name))
    .flatMap(row => {
      const remainder = row.captions.reduce((text, caption) => text.replace(caption, ''),
        row.section.slice(row.heading.length));
      if (!nearRequestedYear(row) && !remainder.trim()) return [row.section];
      return [row.heading, ...row.captions];
    });
  return { candidates, spans };
}

module.exports = { galleryPaintRows };
