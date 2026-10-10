'use strict';

const words = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '')
  .toLowerCase().match(/[a-z0-9]+/g) || [];

// Exact spelling remains the normal path. Long numbered models may reorder
// their generation/variant tokens in different markets (G7 1200 / 1200 G7).
// Require every distinct token, including the number and generation, so a
// nearby sibling model cannot qualify through a shared family name alone.
function modelNameMatches(text, model) {
  const modelWords = words(model);
  if (!modelWords.length) return false;
  const textWords = words(text);
  const target = modelWords.join('');
  for (let start = 0; start < textWords.length; start++) {
    let phrase = '';
    for (let index = start; index < textWords.length && phrase.length < target.length; index++) {
      phrase += textWords[index];
      if (phrase === target) return true;
    }
  }
  if (modelWords.length < 3 || !modelWords.some(word => /\d/.test(word))) return false;
  const required = new Map();
  for (const word of modelWords) required.set(word, (required.get(word) || 0) + 1);
  for (let start = 0; start < textWords.length; start++) {
    for (let end = start + modelWords.length; end <= Math.min(textWords.length, start + modelWords.length + 2); end++) {
      const window = textWords.slice(start, end);
      const found = new Map();
      for (const word of window) found.set(word, (found.get(word) || 0) + 1);
      if ([...required].some(([word, count]) => (found.get(word) || 0) < count)) continue;
      // A nearby 1600 or G8 may be a sibling model in the same heading.
      // A publication/model year may sit between the model tokens.
      if (window.some(word => /\d/.test(word) && !required.has(word)
        && !(Number(word) >= 1886 && Number(word) <= 2100))) continue;
      return true;
    }
  }
  return false;
}

module.exports = { modelNameMatches };
