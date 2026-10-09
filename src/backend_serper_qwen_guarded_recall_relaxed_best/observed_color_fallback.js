'use strict';

const { modelNameMatches } = require('./model_name_match');
const { mentions } = require('./search_groups');
const { hueFamilies } = require('./hue_review');
const { sourceYearRelevance } = require('./source_year');

const HUES = new Map([
  ['branco', 'Branco'], ['branca', 'Branca'], ['white', 'Branco'],
  ['preto', 'Preto'], ['preta', 'Preta'], ['black', 'Preto'],
  ['prata', 'Prata'], ['silver', 'Prata'], ['plata', 'Prata'],
  ['cinza', 'Cinza'], ['gray', 'Cinza'], ['grey', 'Cinza'], ['gris', 'Cinza'],
  ['azul', 'Azul'], ['blue', 'Azul'], ['verde', 'Verde'], ['green', 'Verde'],
  ['vermelho', 'Vermelho'], ['vermelha', 'Vermelha'], ['red', 'Vermelho'],
  ['amarelo', 'Amarelo'], ['amarela', 'Amarela'], ['yellow', 'Amarelo'],
  ['bege', 'Bege'], ['beige', 'Bege'], ['marrom', 'Marrom'], ['brown', 'Marrom'],
  ['laranja', 'Laranja'], ['orange', 'Laranja'],
]);

function observedHue(page) {
  const lines = String(page.text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    const labelled = line.match(/^(?:cor|color|colour)\s*[:|=-]\s*([\p{L}]+)/iu)
      || line.match(/^(?:cor|color|colour)\s+([\p{L}]+)$/iu);
    const nextLine = /^(?:cor|color|colour)\s*:?$/iu.test(line) ? lines[index + 1] : null;
    const raw = labelled?.[1] || nextLine?.match(/^([\p{L}]+)$/u)?.[1];
    const key = raw?.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    if (HUES.has(key)) return { name: HUES.get(key), evidence: nextLine ? `${line}\n${nextLine}` : line };
  }
  return null;
}

// A listing's color field describes an observed vehicle. It is not a named
// paint formula, an OEM code or proof that every model-year unit used it.
function observedColorFallback(pages, vehicle) {
  const wanted = hueFamilies(vehicle.predominantColor);
  const possible = pages.filter(page => page.status === 'ok' && page.url && page.text)
    .flatMap(page => {
      let path;
      try { path = new URL(page.url).pathname; } catch { return []; }
      const titlePath = `${page.title || ''} ${path}`;
      if (!modelNameMatches(titlePath, vehicle.model)
        || vehicle.brand && !mentions(`${titlePath} ${page.text.slice(0, 1200)}`, vehicle.brand)) return [];

      const hue = observedHue(page);
      if (!hue || wanted.size && ![...hueFamilies(hue.name)].some(family => wanted.has(family))) return [];
      return [{ page, hue, yearRelation: sourceYearRelevance(page, vehicle) }];
    }).sort((a, b) => b.yearRelation - a.yearRelation);

  const best = possible[0];
  if (!best) return null;

  return {
    color: { name: best.hue.name, identityType: 'observed_hue', confidence: 'low',
      universal_code: '', code_candidates: [], sources: [best.page.url],
      source_evidence: [{ url: best.page.url, passages: [best.hue.evidence], paint_codes: [] }] },
    report: { reason: 'no_named_paint_found', evidenceType: 'model_listing_appearance',
      sourceQuality: 'fetched', sourceYearRelation: best.yearRelation === 1 ? 'matching'
        : best.yearRelation === -1 ? 'different' : 'unknown' },
  };
}

module.exports = { observedColorFallback, observedHue };
