const GENERIC_HUES = new Set([
  'amarelo', 'amarela', 'azul', 'bege', 'beige', 'branco', 'branca', 'cinza', 'dourado', 'dourada',
  'laranja', 'marrom', 'ouro', 'prata', 'prateado', 'prateada', 'preto', 'preta', 'rosa', 'roxo', 'roxa',
  'verde', 'vermelho', 'vermelha', 'violeta',
  'black', 'blue', 'brown', 'gold', 'golden', 'gray', 'grey', 'green', 'orange',
  'pink', 'purple', 'red', 'silver', 'white', 'yellow',
  'amarillo', 'amarilla', 'blanco', 'blanca', 'dorado', 'dorada', 'gris', 'marron',
  'negro', 'negra', 'plata', 'rojo', 'roja', 'violeta',
  'argent', 'blanc', 'blanche', 'bleu', 'bleue', 'dore', 'doree', 'jaune', 'noir',
  'noire', 'vert', 'verte',
]);

const GENERIC_FINISHES = new Set([
  'met', 'prl',
  'metalico', 'metalica', 'metalizado', 'metalizada', 'metallic', 'metallise', 'metallisee',
  'perol', 'perolizado', 'perolizada', 'pearlescent', 'perlado', 'perlada', 'nacre',
  'solido', 'solida', 'solid', 'liso', 'lisa', 'mat', 'mate', 'matte', 'fosco', 'fosca',
  'metalise', 'metalized', 'pearl', 'pearlcoat', 'pearlized', 'pearlised', 'mica',
  'gloss', 'glossy', 'brilhante', 'brillo', 'satin', 'satinado', 'satinada',
  'clearcoat', 'clear', 'coat',
  'tricoat', 'tricamada', 'tricamadas', 'bicoat', 'bicamada', 'bicapa', 'tricapa',
  'acetinado', 'acetinada',
]);

const TRANSLATED_COLOR_WORDS = new Map([
  ['prata', 'silver'], ['plata', 'silver'], ['plateado', 'silver'], ['plateada', 'silver'],
  ['cinza', 'gray'], ['gris', 'gray'], ['grey', 'gray'],
  ['branco', 'white'], ['branca', 'white'], ['blanco', 'white'], ['blanca', 'white'],
  ['preto', 'black'], ['preta', 'black'], ['negro', 'black'], ['negra', 'black'],
  ['azul', 'blue'], ['verde', 'green'],
  ['vermelho', 'red'], ['vermelha', 'red'], ['rojo', 'red'], ['roja', 'red'],
  ['amarelo', 'yellow'], ['amarela', 'yellow'], ['amarillo', 'yellow'], ['amarilla', 'yellow'],
  ['dourado', 'gold'], ['dourada', 'gold'], ['dorado', 'gold'], ['dorada', 'gold'], ['oro', 'gold'],
  ['marrom', 'brown'], ['marron', 'brown'],
]);

function stripCoatingSuffix(name) {
  return String(name || '').replace(/(?:[\s,;:/-]+\(?\b(?:tri[ -]?coat|three[ -]coat|3[ -]coat|tri[ -]?camada|tri[ -]?capa|bi[ -]?coat|two[ -]coat|2[ -]coat|bi[ -]?camada|bi[ -]?capa)s?\)?)+[\s.]*$/iu, '').trim();
}

function stripPaintFinish(name) {
  if (typeof name !== 'string') return '';

  // Supplier catalogs also attach short effect abbreviations with a hyphen.
  // Remove only an exact terminal abbreviation, never a marketing-name word.
  const detached = stripCoatingSuffix(name).replace(/[-_/](?:met|mat|prl)\.?$/iu, '');
  let words = detached.split(/\s+/);

  while (words.length > 1) {
    const coatingRemoved = stripCoatingSuffix(words.join(' ')).split(/\s+/);

    if (coatingRemoved.length < words.length) { words = coatingRemoved; continue; }

    const normalized = words.at(-1).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, '');

    if (!GENERIC_FINISHES.has(normalized)) break;

    words.pop();
  }

  return words.join(' ').replace(/[\s,;:/-]+$/u, '').trim();
}

function paintIdentityKey(name) {
  const words = stripPaintFinish(name).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) || [];
  return words.map((word) => TRANSLATED_COLOR_WORDS.get(word) || word).sort().join(' ');
}

function completePaintName(name) {
  const stripped = stripPaintFinish(name);
  // A terminal hyphenated catalog abbreviation is metadata even when the
  // published shade has one word (for example, Quicksilver-MET.). Preserve
  // longer printed names such as Crystal Pearl-MET. for name review.
  if (/^\S+[-_/](?:met|mat|prl)\.?$/iu.test(String(name || ''))) return stripped;
  // Keep the published wording when removing a finish would leave one word.
  // The researcher, not the suffix normalizer, decides whether that is complete.
  return (stripped.match(/[\p{L}\p{N}]+/gu) || []).length === 1 ? stripCoatingSuffix(name) : stripped;
}

function stripSupplierReference(name) {
  // Formula/vendor numbers in a parenthesized tail are provenance, not a
  // shade version. Keep descriptive qualifiers and unnumbered layer letters.
  return String(name || '').replace(/\s+\((?:(?:PPG|PAG|MAZ|BASF|DUPONT|AXALTA)\.?\s*[-#: ]?\s*\d+[A-Z]?(?:\s*[/,;]\s*)?)+\)\s*$/iu, '').trim();
}

function isPaintCodeCombination(name, documentedCodes = []) {
  if (typeof name !== 'string') return false;
  const parts = name.trim().toUpperCase().split(/\s*[+/;]\s*/);
  if (parts.length < 2 || !parts.every(part => /^[A-Z\d]{2,8}$/.test(part))) return false;
  const known = new Set([...documentedCodes].map(code => String(code).trim().toUpperCase()));

  // Letter-only OEM codes need catalog evidence. A descriptive two-tone name
  // such as Ice + Ink must not be discarded merely because its words are short.
  return parts.every(part => known.has(part) || /\d/.test(part));
}

// Manufacturer-prefixed identifiers need catalog/source proof. Never classify
// a real numbered name (Silver 77, Rosso 2C) by its shape alone.
function isCatalogCodeLabel(description, manufacturer, codes) {
  const prefix = String(manufacturer || '').replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase();
  if (prefix.length !== 3) return false;
  const known = new Set([...codes || []].map(code => String(code).trim().toUpperCase()));
  let prefixed = false;
  return String(description).toUpperCase().split(/\s*[+/,;]\s*/).every(part => {
    const value = part.trim();
    const code = value.startsWith(`${prefix}-`) ? value.slice(4) : value;
    if (value !== code) prefixed = true;
    return known.has(code);
  }) && prefixed;
}

function splitPaintNames(name) {
  const names = [];
  let start = 0, depth = 0;
  for (let index = 0; index < name.length; index++) {
    if (name[index] === '(' || name[index] === '[') depth++;
    else if (name[index] === ')' || name[index] === ']') depth = Math.max(0, depth - 1);
    else if (!depth && /[,/]/.test(name[index])) {
      names.push(name.slice(start, index).trim());
      start = index + 1;
    }
  }
  names.push(name.slice(start).trim());
  return names;
}

function isGenericPaintName(name, documentedCodes = []) {
  if (typeof name !== 'string') return false;

  // Process/category headings can be extracted beside real palette rows.
  // Alone they do not identify a shade; compound names remain eligible.
  if (/^\s*(?:mixing|mistura|paint|tinta|color|colour|cor|cores)\s*$/iu.test(name)) return true;

  // A catalog's generic commercial shade is not a complete paint identity.
  if (/^\s*[\p{L}]+\s*\(\s*(?:comm\.|commercial|comercial)\s*\)\s*$/iu.test(name)) {
    const hue = name.trim().match(/^[\p{L}]+/u)?.[0].normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    if (GENERIC_HUES.has(hue)) return true;
  }

  // A catalog combination of bare codes is not a named paint. Keep actual
  // names containing a number (for example Silver 77 or Rosso 2C).
  if (/^[\d\s+/,;.-]+$/.test(name.trim()) || isPaintCodeCombination(name, documentedCodes)) return true;

  const words = name.normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase().match(/[\p{L}\p{N}]+/gu);

  return !!words?.length && ((GENERIC_HUES.has(words[0])
    && words.slice(1).every((word) => GENERIC_FINISHES.has(word)))
    || words.every((word) => GENERIC_FINISHES.has(word)));
}

function isExtractionArtifactName(name) {
  const value = stripPaintFinish(String(name || '')).normalize('NFKD')
    .replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

  // Broken character decoding and parser placeholders are not paint names,
  // even when a supplier accidentally publishes them inside a shade list.
  return /\uFFFD/u.test(String(name || ''))
    || /^(?:bad|invalid|illegal|unsupported|replacement) character(?:s)?$/u.test(value);
}

module.exports = { isGenericPaintName, isPaintCodeCombination, isCatalogCodeLabel, splitPaintNames, stripPaintFinish, stripCoatingSuffix,
  completePaintName, stripSupplierReference, paintIdentityKey, isExtractionArtifactName, GENERIC_FINISHES };
