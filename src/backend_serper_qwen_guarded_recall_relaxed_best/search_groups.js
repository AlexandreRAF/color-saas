'use strict';

const { finishSearchTerms } = require('./paint_finish');

const normalized = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const quoted = value => `"${String(value || '').replace(/["\\\r\n]/g, ' ').replace(/\s+/g, ' ').trim()}"`;
const alternatives = values => {
  const unique = [...new Set(values.filter(Boolean).map(quoted))];
  return unique.length > 1 ? `(${unique.join(' OR ')})` : unique[0] || '';
};

function paintCodes(color) {
  return [...new Set((color.codes || [color.universal_code,
    ...(color.code_candidates || []).map(row => row.universal_code)])
    .filter(code => typeof code === 'string' && code.trim()).map(code => code.trim()))];
}

function identityClause(color) {
  // Codes remain in the same branch as their paint, never paired with another
  // paint's name. OR permits sources which print only the name or only the code.
  return alternatives([color.database_hint || color.name,
    ...(color.database_hint ? [color.name] : []), ...paintCodes(color).slice(0, 2)]);
}

function finishAlternatives(value) {
  const families = {
    pearlescent: ['pearl', 'pearlescent', 'perolizado'],
    metallic: ['metallic', 'metálico', 'metalizado'],
    solid: ['solid', 'sólido', 'liso'],
    matte: ['matte', 'matt', 'fosco'],
    satin: ['satin', 'acetinado'],
    gloss: ['gloss', 'glossy', 'brilhante'],
    tricoat: ['tricoat', 'tri-coat', 'three coat', 'tricamada'],
  };
  const english = finishSearchTerms(value);
  return alternatives(['finish', 'acabamento', english, finishSearchTerms(value, 'pt'),
    ...Object.entries(families).filter(([key]) => mentions(english, key)).flatMap(([, words]) => words)]);
}

function paintSearch(vehicle, colors, purpose = 'verification') {
  const prefix = [vehicle.brand, vehicle.model,
    ['portuguese', 'applicability'].includes(purpose) ? vehicle.manufacturingYear : null].filter(Boolean).join(' ');
  const clauses = colors.map(identityClause).filter(Boolean);
  const identity = clauses.length > 1 ? `(${clauses.join(' OR ')})` : clauses[0] || '';
  const finish = finishAlternatives(vehicle.paintFinish);
  const suffix = purpose === 'name' ? '(paint OR tinta) (name OR nome OR cor)'
    : purpose === 'portuguese' ? '(nome OR cor OR tinta) (português OR Brasil)'
      : purpose === 'applicability' ? '(paint OR tinta OR pintura) (color OR cor OR code OR código)'
      : purpose === 'finish' ? `(paint OR tinta) ${finish}` : '(paint OR pintura OR tinta) (color OR cor OR acabamento)';
  return `${prefix} ${identity} ${suffix}`.trim();
}

function groupPaints(items, getColor = value => value, maxSize = 3, maxBranches = 3) {
  const remaining = [...items], groups = [];
  const fits = (group, item) => [...group, item].reduce((total, member) =>
    total + identityClause(getColor(member)).length + 6, 150) <= 500;
  while (remaining.length) {
    const first = remaining.shift(), group = [first];
    const firstCodes = paintCodes(getColor(first));
    // Prefer transport sharing for one code. This is not proof of alias identity;
    // each member keeps its own evidence check and final decision.
    if (firstCodes.length === 1) {
      for (let i = 0; i < remaining.length && group.length < maxSize;) {
        const other = paintCodes(getColor(remaining[i]));
        if (other.length === 1 && other[0] === firstCodes[0] && fits(group, remaining[i])) group.push(...remaining.splice(i, 1));
        else i++;
      }
    }
    // Search queries use three branches to limit result domination. Final
    // verification can transport four independent decisions with separate IDs.
    while (remaining.length && group.length < Math.min(maxBranches, maxSize)
      && fits(group, remaining[0])) group.push(remaining.shift());
    groups.push(group);
  }
  return groups;
}

function mentions(text, name) {
  const key = normalized(name);
  return Boolean(key && ` ${normalized(text)} `.includes(` ${key} `));
}

module.exports = { normalized, quoted, alternatives, paintCodes, paintSearch, groupPaints, mentions };
