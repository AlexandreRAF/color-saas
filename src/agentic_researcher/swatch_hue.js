'use strict';

const { hueFamilies } = require('./hue_review');
const { swatchFamily } = require('./swatch_evidence');

function clearlyDifferentSwatch(name, hex, requestedColor) {
  const wanted = hueFamilies(requestedColor);
  const printed = hueFamilies(name);
  const measured = swatchFamily(hex);
  if (!wanted.size || [...printed].some(family => wanted.has(family))) return false;
  if (measured && printed.has(measured) && !wanted.has(measured)) return true;

  const [red, green, blue] = [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);

  // A color whose brightest channel is this dark cannot be a white/off-white
  // swatch. A vivid low-channel color is likewise outside the white family.
  // Keep every light, muted or conflicting swatch for the agent to assess.
  return wanted.has('white') && (max < 145 || min < 120 && max - min > 90);
}

// A supplier's swatch is approximate. Remove strongly unrelated cards from
// model extraction, but retain the original page text for cross-source review.
// Ambiguous shades and silver/gray neighbors remain.
function withoutClearlyDifferentSwatches(text, requestedColor) {
  const wanted = hueFamilies(requestedColor);
  if (!wanted.size || !/b_rgb:[a-f\d]{6}/i.test(text)) return text;

  const card = /!\[[^\]\r\n]+\]\([^\r\n]*?b_rgb:([a-f\d]{6})[^\r\n]*\)[\s\S]{0,200}?^#{2,6}[ \t]+([^\r\n]+)[\s\S]{0,120}?^(?:Mfr\.\s*)?(?:Colou?r)\s+Code:[^\r\n]*/gim;

  return text.replace(card, (whole, hex, name) => {
    return clearlyDifferentSwatch(name, hex, requestedColor) ? '\n' : whole;
  });
}

module.exports = { swatchFamily, clearlyDifferentSwatch, withoutClearlyDifferentSwatches };
