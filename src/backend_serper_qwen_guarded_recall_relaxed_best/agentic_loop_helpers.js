const fs = require('node:fs');
const path = require('node:path');

const { searchLocale } = require('./browse');
const { normalizePaintFinish } = require('./paint_finish');

function readFile(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8');
}

function isMissing(value) {
  return value == null || (typeof value === 'string'
    && ['', 'not specified', 'unknown', 'n/a'].includes(value.trim().toLowerCase()));
}

function optionalText(value, field) {
  if (isMissing(value)) return null;
  if (typeof value !== 'string') throw new Error(`${field} must be a string when provided`);
  return value.trim();
}

function validateVehicle(vehicle) {
  if (!vehicle || typeof vehicle !== 'object' || Array.isArray(vehicle)) {
    throw new Error('loop input must be a vehicle object');
  }

  if (typeof vehicle.model !== 'string' || isMissing(vehicle.model)) {
    throw new Error('model must be a non-empty string');
  }

  if (!isMissing(vehicle.manufacturingYear)
    && (!Number.isInteger(vehicle.manufacturingYear) || vehicle.manufacturingYear < 1886)) {
    throw new Error('manufacturingYear must be a valid integer year');
  }

  const country = optionalText(vehicle.country, 'country');
  const predominantColor = optionalText(vehicle.predominantColor, 'predominantColor');
  const paintFinish = normalizePaintFinish(vehicle.paintFinish);

  return {
    automobileType: optionalText(vehicle.automobileType, 'automobileType'),
    brand: optionalText(vehicle.brand, 'brand'),
    manufacturingYear: isMissing(vehicle.manufacturingYear) ? null : vehicle.manufacturingYear,
    model: vehicle.model.trim(),
    predominantColor: predominantColor || 'not specified',
    ...(paintFinish && { paintFinish }),
    country: country ? searchLocale(country).location : null,
  };
}

function initialColorQuery(vehicle) {
  const searchLanguage = searchLocale(vehicle.country).hl || 'en';
  const colorTerms = {
    pt: 'cores', es: 'colores', fr: 'couleurs', de: 'Farben',
    it: 'colori', ja: 'カラー', ko: '색상', zh: '颜色', en: 'colors',
  };

  const model = vehicleModelName(vehicle);

  return [model, vehicle.manufacturingYear, colorTerms[searchLanguage] || 'colors']
    .filter((part) => part != null)
    .join(' ');
}

function vehicleModelName(vehicle) {
  const brand = String(vehicle.brand || '').trim();
  const model = String(vehicle.model || '').trim();
  return brand && !model.toLowerCase().startsWith(`${brand.toLowerCase()} `)
    && model.toLowerCase() !== brand.toLowerCase() ? `${brand} ${model}` : model;
}

module.exports = { readFile, validateVehicle, initialColorQuery, vehicleModelName };
