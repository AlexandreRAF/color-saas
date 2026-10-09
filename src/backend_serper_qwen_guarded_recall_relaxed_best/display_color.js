'use strict';

const { isGenericPaintName } = require('./paint_name');
const { modelNameMatches } = require('./model_name_match');

const normalize = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const compact = value => normalize(value).replace(/\s+/g, '');
const paletteCue = /\b(?:cores?|colou?rs?|colores|paleta|palette)\b/iu;
const finishLabel = /\b(?:met[aá]lic[oa]|metallic|metalizado|perolizad[oa]|pearl(?:escent)?|perlad[oa]|fos[oc][oa]|matte?|s[oó]lid[oa]|solid|acetinad[oa]|satin)\b/iu;
const displayLabel = /\b(?:amarel[oa]|azul|bege|branc[oa]|cinza|dourad[oa]|laranja|marrom|prata|pret[oa]|verde|vermelh[oa]|white|black|blue|red|green|yellow|silver|gr[ae]y|gold|brown|blanc[oa]|negro|rojo|gris|plata)\s+(?:met[aá]lic[oa]|metallic|metalizado|perolizad[oa]|pearl(?:escent)?|perlad[oa]|fos[oc][oa]|matte?|s[oó]lid[oa]|solid|acetinad[oa]|satin)\b/giu;

function vehicleContext(page, vehicle) {
  if (page?.catalog || page?.retrievalMethod === 'search_snippet') return false;
  const opening = `${page?.title || ''}\n${String(page?.originalText || page?.text || '').slice(0, 1400)}`;
  if (!vehicle?.model || !modelNameMatches(opening, vehicle.model)) return false;
  if (vehicle.brand && !compact(opening).includes(compact(vehicle.brand))) return false;
  if (vehicle.manufacturingYear && !new RegExp(`(?<!\\d)${vehicle.manufacturingYear}(?!\\d)`).test(opening)) return false;
  return paletteCue.test(opening);
}

// A finish-qualified, generic display label is useful only when a page ties
// its literal wording to this model's palette. It is not a unique paint code.
function isSupportedDisplayColor(name, evidence, page, vehicle) {
  if (!isGenericPaintName(name) || !finishLabel.test(name)
    || !vehicleContext(page, vehicle)) return false;
  const printed = normalize(name);
  if (!printed || !evidence?.some(passage => (` ${normalize(passage)} `).includes(` ${printed} `))) return false;

  const text = String(page.originalText || page.text || '');
  for (const match of text.matchAll(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'))) {
    const start = Math.max(0, match.index - 180);
    const end = Math.min(text.length, match.index + name.length + 100);
    if (paletteCue.test(text.slice(start, end))) return true;
  }
  return false;
}

function displayColorCandidates(page, vehicle) {
  if (!vehicleContext(page, vehicle)) return [];
  const text = String(page.text || '');
  const candidates = new Map();

  for (const match of text.matchAll(displayLabel)) {
    const lineStart = text.lastIndexOf('\n', match.index) + 1;
    const lineEnd = text.indexOf('\n', match.index + match[0].length);
    const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd).trim();
    if (line.length > 300 || !paletteCue.test(text.slice(Math.max(0, match.index - 180),
      Math.min(text.length, match.index + match[0].length + 100)))) continue;
    const name = match[0].trim();
    if (!isSupportedDisplayColor(name, [line], page, vehicle)) continue;
    const key = normalize(name);
    const entry = candidates.get(key) || { name, evidence: [], identityType: 'vehicle_display_color' };
    if (!entry.evidence.includes(line)) entry.evidence.push(line);
    candidates.set(key, entry);
  }

  return [...candidates.values()];
}

module.exports = { isSupportedDisplayColor, displayColorCandidates };
