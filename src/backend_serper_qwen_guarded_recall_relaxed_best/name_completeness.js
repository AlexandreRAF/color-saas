const { GENERIC_FINISHES, isGenericPaintName } = require('./paint_name');

function tokens(name) {
  return (String(name || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/\b(?:pag|page|pagina)\.\s*\d+\b/g, '') // Catalog page references are not name fragments.
    .match(/[a-z0-9]+\.?/g) || []).map(raw => {
    const word = raw.replace(/\.$/, '');

    // Dotted initials/fragments need evidence of the full name. Roman versions
    // and ordinary hue/finish words are not incomplete just because of a dot.
    const abbreviated = raw.endsWith('.') && /^[a-z]{1,4}$/.test(word)
      && !/^(?:i|ii|iii|iv|v|vi|vii|viii|ix|x)$/.test(word)
      && !isGenericPaintName(word) && !GENERIC_FINISHES.has(word);

    return { word: word === 'grey' ? 'gray' : word, abbreviated };
  });
}

function isAbbreviatedName(name) {
  return tokens(name).some(token => token.abbreviated);
}

// This only proposes a lexical expansion. Callers must also establish a unique
// matching source code and independently approve the full candidate's relevance.
function abbreviatedMatch(shortName, fullName) {
  const short = tokens(shortName), full = tokens(fullName);

  if (!short.some(t => t.abbreviated) || full.some(t => t.abbreviated)) return false;

  const anchors = short.filter(t => !t.abbreviated).map(t => t.word);

  if (!anchors.length) return false;

  const remaining = [];
  const positions = [];
  let next = 0;

  for (const [index, { word }] of full.entries()) {
    if (word === anchors[next]) { positions.push(index); next++; }
    else remaining.push({ word, index });
  }

  if (next !== anchors.length || !remaining.length) return false;

  // Repeated finish initials may refer to the same published finish word.
  // Every extra distinctive word/version still needs its own abbreviation.
  const available = [...remaining];
  let preceding = 0;
  let previousExpansion = -1;

  for (const token of short) {
    if (!token.abbreviated) { preceding++; continue; }

    const index = available.findIndex(({ word, index }) => word.startsWith(token.word)
      && (GENERIC_FINISHES.has(word) || (index > Math.max(previousExpansion, positions[preceding - 1] ?? -1)
        && index < (positions[preceding] ?? full.length))));

    if (index < 0) return false;

    if (!GENERIC_FINISHES.has(available[index].word)) {
      previousExpansion = available[index].index;
      available.splice(index, 1);
    }
  }

  return available.every(({ word }) => GENERIC_FINISHES.has(word));
}

module.exports = { isAbbreviatedName, abbreviatedMatch };
