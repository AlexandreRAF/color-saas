'use strict';

// These are approximate supplier swatches, not measurements of a vehicle.
// Keep the printed name, code and image together so a reviewer can compare
// the same paint across a year-specific chart and a model-wide supplier page.
function swatchCards(text) {
  const card = /!\[[^\]\r\n]+\]\([^\r\n]*?b_rgb:([a-f\d]{6})[^\r\n]*\)[\s\S]{0,200}?^#{2,6}[ \t]+([^\r\n]+)[\s\S]{0,120}?^(?:Mfr\.\s*)?(?:Paint|Colou?r)\s+Code:\s*([A-Z0-9]{2,8})\b[^\r\n]*/gim;

  return [...String(text || '').matchAll(card)].map(match => ({
    name: match[2].trim(), code: match[3].toUpperCase(), rgb: match[1].toLowerCase(),
    evidence: match[0],
  }));
}

function swatchFamily(hex) {
  const [red, green, blue] = [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const spread = max - min;

  if (max < 70 && spread < 35) return 'black';
  if (min > 215 && spread < 25) return 'white';
  if (spread < 22 && min >= 75 && max <= 185) return 'silver-gray';
  if (spread < 65) return null;
  if (red > green * 1.35 && red > blue * 1.35) return 'red';
  if (green > red * 1.35 && green > blue * 1.2) return 'green';
  if (blue > red * 1.35 && blue > green * 1.2) return 'blue';
  return null;
}

module.exports = { swatchCards, swatchFamily };
