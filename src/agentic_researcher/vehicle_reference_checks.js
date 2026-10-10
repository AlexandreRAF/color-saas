'use strict';

const { completePaintName } = require('./paint_name');

const normalizeName = value => completePaintName(String(value || '')).normalize('NFKD')
  .replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Evaluation fixtures only. Published aliases establish an expected identity;
// arbitrary hue words, a similar appearance, or a bare code cannot pass it.
const COROLLA_PEARL_070 = {
  manufacturer: 'Toyota', code: '070',
  names: ['Blizzard Pearl', 'White Pearl Crystal Shine', 'White Crystal Shine',
    'Crystal White IV'],
};

function matchesReference(color, reference, manufacturer) {
  if (manufacturer && reference.manufacturer
    && normalizeName(manufacturer) !== normalizeName(reference.manufacturer)) return false;
  const names = reference.names.map(normalizeName);
  const codes = (color.codes || []).flatMap(code => String(code).split(/[,/;]/))
    .map(code => code.trim().toUpperCase());
  return names.includes(normalizeName(color.name)) && codes.includes(reference.code);
}

module.exports = { matchesReference, COROLLA_PEARL_070 };
