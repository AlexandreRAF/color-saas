const { paintIdentityKey, splitPaintNames, GENERIC_FINISHES } = require('./paint_name');
const { printedNameKey } = require('./paint_evidence');
const { hasPortugueseName } = require('./portuguese_names');
const { brandKey } = require('./database_code_agent');

const HUES = new Set(['white', 'black', 'silver', 'gray', 'red', 'blue', 'green',
  'yellow', 'gold', 'brown', 'orange', 'pink', 'purple', 'beige']);
const LOCAL_HUES = { laranja: 'orange', rosa: 'pink', roxo: 'purple', roxa: 'purple',
  violeta: 'purple', bege: 'beige' };
const FINISHES = new Map([
  ...['pearl', 'pearlcoat', 'prl', 'pearlescent', 'perol', 'perolizado', 'perolizada', 'perlado', 'perlada', 'nacre',
    'pearlized', 'pearlised'].map(word => [word, 'pearl']),
  ...['met', 'metalico', 'metalica', 'metalizado', 'metalizada', 'metallic', 'metallise',
    'metallisee', 'metalise', 'metalized'].map(word => [word, 'metallic']),
  ...['mat', 'matte', 'mate', 'fosco', 'fosca'].map(word => [word, 'matte']),
  ...['solid', 'solido', 'solida'].map(word => [word, 'solid']),
]);
const ROMAN_VERSIONS = new Map([
  ['i', 1], ['ii', 2], ['iii', 3], ['iv', 4], ['v', 5],
  ['vi', 6], ['vii', 7], ['viii', 8], ['ix', 9], ['x', 10],
]);

const words = name => String(name || '').normalize('NFKD').replace(/\p{M}/gu, '')
  .toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const uniqueKey = values => [...new Set(values)].sort().join(' ');

function describe(name) {
  const text = words(name).join(' ');
  const base = text.replace(/\s+(?:tri\s?coat|three coat|3 coat|tri\s?camada|pearlcoat)s?$/, '');
  const core = [], hues = [], finishes = [];

  for (const word of base.split(' ')) {
    const hue = LOCAL_HUES[word] || paintIdentityKey(word);
    if (HUES.has(hue)) hues.push(hue);
    else if (GENERIC_FINISHES.has(word)) finishes.push(FINISHES.get(word) || word);
    else core.push(word);
  }

  return { base, core: core.join(' '), hue: uniqueKey(hues), hueWords: hues.length,
    finish: uniqueKey(finishes), coating: base !== text };
}

function matchedDescriptor(color, field) {
  const rows = color.code_candidates || [];

  // Only matcher-selected rows can explain an omitted descriptor. Never use
  // unrelated hue words from a whole catalog, or infer a hue from the code.
  if (!rows.length) return '';

  const values = rows.map(row => describe(row.description)[field]);

  return values.every(value => value && value === values[0]) ? values[0] : '';
}

function publishedAliasPair(left, right) {
  const keys = [paintIdentityKey(left.name), paintIdentityKey(right.name)];
  if (!keys.every(Boolean) || keys[0] === keys[1]) return false;
  const rightPages = new Set((right._sourceEvidence || []).map(source => source.url));

  return (left._sourceEvidence || []).some(source => rightPages.has(source.url)
    && (source.passages || []).some(passage => passage.split(/\r?\n/).some(line => {
      const heading = line.match(/^\s*#{2,6}\s+(.+?)\s*$/u);
      if (!heading) return false;
      const names = splitPaintNames(heading[1]);
      return names.length === 2 && names.map(paintIdentityKey).sort().join('|') === [...keys].sort().join('|');
    })));
}

function oneLetterApart(left, right) {
  if (Math.abs(left.length - right.length) > 1) return false;
  let i = 0, j = 0, edits = 0;

  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (left.length >= right.length) i++;
    if (right.length >= left.length) j++;
  }

  return edits + (left.length - i) + (right.length - j) === 1;
}

// A one-letter difference is only an alias when one candidate's short,
// source-owned excerpts explicitly mention both complete spellings. A broad
// gallery page or a shared URL by itself cannot establish paint identity.
function sourceSpellingAlias(left, right) {
  const a = describe(left.name), b = describe(right.name);
  if (a.hue !== b.hue || a.finish !== b.finish) return false;

  const first = words(left.name), second = words(right.name);
  if (first.length !== second.length) return false;
  const differences = first.map((word, index) => [word, second[index]])
    .filter(([word, other]) => word !== other);
  if (differences.length !== 1 || differences[0].some(word => word.length < 4)
    || !oneLetterApart(...differences[0])) return false;

  for (const [primary, secondary] of [[left, right], [right, left]]) {
    const urls = new Set((secondary._sourceEvidence || []).map(source => source.url));
    if ((primary._sourceEvidence || []).some(source => urls.has(source.url)
      && [left, right].every(color => (source.passages || []).some(passage =>
        passage.length <= 1000 && (` ${words(passage).join(' ')} `)
          .includes(` ${words(color.name).join(' ')} `))))) return true;
  }

  return false;
}

function numberedNameKey(name) {
  const parts = printedNameKey(name).split(' ').filter(Boolean);
  if (parts.length < 2) return '';

  const last = parts.at(-1);
  const version = ROMAN_VERSIONS.get(last)
    || (/^(?:[1-9]|10)$/u.test(last) ? Number(last) : 0);
  if (!version) return '';

  parts[parts.length - 1] = String(version);
  return parts.join(' ');
}

function samePaint(left, right) {
  const a = describe(left.name), b = describe(right.name);
  const manufacturers = [left, right].map(color => uniqueKey((color.code_candidates || [])
    .map(row => brandKey(row.manufacturer)).filter(Boolean)));

  if (manufacturers.every(Boolean) && manufacturers[0] !== manufacturers[1]) return false;
  if (a.base === b.base) return true;
  if (publishedAliasPair(left, right)) return true;

  // Catalogs can print the same numbered shade with Arabic or Roman numerals.
  // The caller also requires a shared OEM code; other version numbers stay distinct.
  const leftNumbered = numberedNameKey(left.name);
  if (leftNumbered && leftNumbered === numberedNameKey(right.name)
    && (!a.finish || !b.finish || a.finish === b.finish)) return true;

  // The caller groups only identical complete code sets. Two catalog labels
  // that differ solely by a finish suffix are one shade with finish variants.
  // Distinctive words and different OEM codes still remain separate paints.
  const leftIdentity = printedNameKey(left.name);
  if (leftIdentity && leftIdentity === printedNameKey(right.name)
    && left.sources?.length && right.sources?.length) {
    // A shared marketing base does not make matte and metallic variants equal.
    if (a.finish && b.finish && a.finish !== b.finish) return false;
    return true;
  }

  // Keep distinctive words and versions, in order. Code equality alone never
  // merges unrelated marketing names. Reordering is left to the alias review.
  if (!a.core || a.core !== b.core) return false;
  // A Brazilian label may omit the English source's effect suffix. When both
  // labels are independently published, have the same distinctive words and
  // visual hue, and the caller has already checked their OEM code overlap,
  // keep one paint while retaining all reported finish evidence.
  if (a.hue && a.hue === b.hue && (!a.finish || !b.finish)
    && Boolean(hasPortugueseName(left.name)) !== Boolean(hasPortugueseName(right.name))
    && left.sources?.length && right.sources?.length) return true;
  // Reordered/translated names need a published alias statement above. A
  // shared code and matching hue words alone can identify different shades.
  if (a.hue === b.hue && a.finish === b.finish) {
    // Redundant bilingual hue words are safe to collapse. A translated name
    // also needs both source-backed labels; code equality alone is too weak.
    return Boolean(a.hue) && (a.hueWords !== b.hueWords
      || (Boolean(hasPortugueseName(left.name)) !== Boolean(hasPortugueseName(right.name))
        && Boolean(left.sources?.length) && Boolean(right.sources?.length)));
  }

  for (const field of ['hue', 'finish']) {
    if (a[field] && b[field] && a[field] !== b[field]) return false;
    if (a[field] === b[field]) continue;

    const missing = a[field] ? right : left;

    if (matchedDescriptor(missing, field) !== (a[field] || b[field])) return false;
  }

  return true;
}

function preferredName(colors) {
  const accents = name => (name.normalize('NFD').match(/\p{M}/gu) || []).length;
  return [...colors].sort((a, b) => {
    const score = color => {
      const d = describe(color.name);
      return Number(!!d.hue) * 10 + Number(!!d.finish) * 2 + Number(d.coating);
    };

    return Number(hasPortugueseName(b.name)) - Number(hasPortugueseName(a.name))
      || score(b) - score(a)
      || accents(b.name) - accents(a.name)
      || a.name.length - b.name.length;
  })[0].name;
}

module.exports = { samePaint, preferredName, sourceSpellingAlias };
