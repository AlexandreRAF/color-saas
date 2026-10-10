'use strict';

const { selectSources, sourceYearRelevance } = require('./research_plan');
const { sourceYearDistance } = require('./source_year');
const { hueFamilies } = require('./hue_review');

const HUE = '(?:cinza|prata|branc[oa]|pret[oa]|azul|vermelh[oa]|verde|amarel[oa]|marrom|bege|dourad[oa]|laranja|rosa|rox[oa]|gold|gray|grey|silver|white|black|blue|red|green|yellow|brown|orange|pink|purple|gris|plata|blanc[oa]|negro|rojo)';
const TITLE_PAINT = new RegExp(`\\b(${HUE})\\s+([\\p{L}][\\p{L}\\p{M}\\d-]{2,})\\s*$`, 'iu');
const TITLE_CODE_PAINT = new RegExp(`\\b(${HUE})\\s+([\\p{L}][\\p{L}\\p{M}\\d-]{2,})(?:[\\s\\p{L}\\p{M}\\d-]{0,70})\\bc[oó]d(?:igo)?\\s*:?\\s*[A-Z0-9-]{2,8}\\s*$`, 'iu');
const PALETTE_PAINT = new RegExp(`^(${HUE})\\s+([\\p{L}\\p{M}][\\p{L}\\p{M}\\d-]{2,}(?:\\s+[\\p{L}\\p{M}\\d-]{2,}){0,2})$`, 'iu');
const PALETTE_HEADING = /\b(?:cores|colou?rs?|colores|nuancier)\b/iu;
const NOT_SHADE = /^(?:automotiva?|automotive|original|paint|tinta|color|colour|carro|car|moto|truck)$/iu;

function normalized(text) {
  return ` ${String(text || '').normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
}

function paletteSnippetNames(source, vehicle) {
  const snippet = String(source.snippet || '');
  const context = normalized(`${source.title || ''} ${snippet}`);
  const make = normalized(vehicle.brand || vehicle.make).trim();
  const model = normalized(vehicle.model).trim();

  // A structured model palette can survive only in the search index when its
  // PDF or page blocks fetching. Require both vehicle identity and multiple
  // separately printed shade entries before admitting weak snippet leads.
  if (!PALETTE_HEADING.test(snippet) || !make || !model
    || !context.includes(` ${make} `) || !context.includes(` ${model} `)) return [];

  const segments = snippet.split(/[.;|•,:\n]+/u).map(part => part.trim()).filter(Boolean);
  const names = [...new Set(segments.flatMap(segment => {
    const match = PALETTE_PAINT.exec(segment);
    return match && !NOT_SHADE.test(match[2]) ? [`${match[1]} ${match[2]}`] : [];
  }))];
  if (names.length < 2) return [];

  const wanted = hueFamilies(vehicle.predominantColor);
  return names.filter(name => !wanted.size || [...hueFamilies(name)].some(hue => wanted.has(hue)))
    .slice(0, 8);
}

function searchSnippetLeads(index, fetchedPages, vehicle, limit = 6) {
  const fetched = new Set(fetchedPages.filter(page => page.status === 'ok').map(page => page.url));
  const leads = [];
  const names = new Map();
  let candidateCount = 0;
  const sources = [...index.values()].map(source => ({ source,
    paletteNames: paletteSnippetNames(source, vehicle) }))
    .sort((a, b) => Number(b.paletteNames.length > 0) - Number(a.paletteNames.length > 0)
      || sourceYearRelevance(b.source, vehicle) - sourceYearRelevance(a.source, vehicle)
      || (a.source.rank ?? Infinity) - (b.source.rank ?? Infinity));

  for (const { source, paletteNames } of sources) {
    if (leads.length >= limit || candidateCount >= 8) break;
    const yearRelevance = sourceYearRelevance(source, vehicle);
    const nearbyYearPalette = yearRelevance < 0
      && sourceYearDistance(source, vehicle) === 1 && paletteNames.length > 0;
    if (fetched.has(source.url)
      || (yearRelevance < 0 && !nearbyYearPalette)
      || !selectSources(new Map([[source.url, source]]), new Set(), vehicle, 1).length) continue;

    const title = String(source.title || '').split(/\s+\|\s+/)[0].trim();
    const match = title.match(TITLE_PAINT) || title.match(TITLE_CODE_PAINT);
    const label = match?.[2]?.toLocaleLowerCase('pt-BR');
    const titleName = match && !NOT_SHADE.test(label) && ![vehicle.brand, vehicle.model]
      .some(value => String(value || '').toLocaleLowerCase('pt-BR') === label)
      ? `${match[1]} ${match[2]}` : null;
    // A differently dated single-color title is insufficient. A nearby-year
    // structured palette supplies only its printed names as uncertain leads.
    const extracted = [nearbyYearPalette ? null : titleName, ...paletteNames].filter(Boolean);
    const candidates = [];

    for (const name of extracted) {
      if (candidateCount + candidates.length >= 8) break;
      const key = name.toLocaleLowerCase('pt-BR');
      if ((names.get(key) || 0) >= 2) continue;
      names.set(key, (names.get(key) || 0) + 1);
      candidates.push({ name, evidence: [[title, source.snippet].filter(Boolean).join('\n')] });
    }
    if (!candidates.length) continue;

    const text = [title, source.snippet].filter(Boolean).join('\n');

    leads.push({ id: `SR${leads.length + 1}`, url: source.url, title, text,
      status: 'search_snippet', retrievalMethod: 'search_snippet',
      ...(nearbyYearPalette && { nearbyYearLead: true }), candidates });
    candidateCount += candidates.length;
  }

  return leads;
}

module.exports = { searchSnippetLeads };
