'use strict';

const { completePaintName, isGenericPaintName, isCatalogCodeLabel } = require('./paint_name');

const CATALOG_PREFIX = 'catalog:basf_models:';

// Local records join the evidence inventory, never the HTTP fetch counters.
// This is a faithful field rendering, not a generated description or web page.
function modelEvidencePages(records, vehicle) {
  const pages = [];
  const codesByManufacturer = new Map();
  const manufacturerKey = record => String(record.manufacturer || '').trim().toUpperCase();
  const targetYear = vehicle.manufacturingYear == null ? NaN : Number(vehicle.manufacturingYear);
  const bounds = record => {
    const match = String(record.year || '').match(/^\s*((?:18|19|20)\d{2})\s*[-–]\s*((?:18|19|20)\d{2})\s*$/);
    if (match) return [Number(match[1]), Number(match[2])];
    const single = String(record.year || '').match(/^\s*((?:18|19|20)\d{2})\s*$/);
    return single ? [Number(single[1]), Number(single[1])] : null;
  };
  const gap = record => {
    const years = bounds(record);
    if (!years || !Number.isInteger(targetYear)) return 0;
    return Math.max(0, years[0] - targetYear, targetYear - years[1]);
  };
  const currentPalette = Number.isInteger(targetYear)
    && records.filter(record => bounds(record) && gap(record) <= 2).length >= 3;
  const currentExactModel = Number.isInteger(targetYear)
    && records.filter(record => record.model_match === 'exact'
      && bounds(record) && gap(record) <= 2).length >= 3;

  // The model palette already contains the component paints. Use its own OEM
  // code column to distinguish combinations from names without another lookup
  // or assuming that every short uppercase word is a code.
  for (const record of records) {
    const key = manufacturerKey(record);
    if (!key) continue;
    if (!codesByManufacturer.has(key)) codesByManufacturer.set(key, new Set());
    for (const code of String(record.universal_code || '').split(/[,/;]/)) {
      if (code.trim()) codesByManufacturer.get(key).add(code.trim().toUpperCase());
    }
  }

  for (const record of records) {
    // When the catalog has a current palette, very old model editions stay
    // searchable through all three catalog lookups and can corroborate a
    // separately discovered paint. They do not each start a new review for a
    // different generation. Sparse specialist catalogs retain every lead.
    if (currentPalette && gap(record) > 10) continue;
    // A qualified model can be a different body (for example a crossover or
    // wagon sharing a sedan's name). When exact current records exist, those
    // qualified rows still participate in lookup but need web model linkage
    // before becoming independent paint leads.
    if (currentExactModel && record.model_match === 'qualified_model') continue;
    const name = completePaintName(record.description);
    const codes = codesByManufacturer.get(manufacturerKey(record));
    if (!name || isGenericPaintName(name, codes)
      || isCatalogCodeLabel(record.description, record.manufacturer, codes)) continue;

    // A marketing name is a research lead, not a measured hue. Keep every
    // named model record for evidence review, even if its words suggest a
    // different family from the customer's visual description.

    const text = `Manufacturer: ${record.manufacturer}. Model: ${record.model}. Paint: ${record.description}.`
      + (record.universal_code ? ` Color code: ${record.universal_code}.` : '')
      + ` Catalog years: ${record.year || 'unknown'}. Market: unknown.`;

    pages.push({ id: `BM${record.record_id}`, url: `${CATALOG_PREFIX}${record.record_id}`,
      title: `BASF model catalog: ${record.manufacturer} ${record.model}`,
      status: 'ok', catalog: 'basf_models', catalog_record: record, text,
      candidates: [{ name: record.description, evidence: [text] }] });
  }

  return pages;
}

function isModelSource(url) {
  return typeof url === 'string' && url.startsWith(CATALOG_PREFIX);
}

function catalogReferences(sources = []) {
  return [...new Set(sources.filter(isModelSource))].map(url => ({
    catalog: 'basf_models', recordId: Number(url.slice(CATALOG_PREFIX.length)),
  }));
}

// A catalog's explicit model association can corroborate applicability. Its
// paint-year range is deliberately not promoted to a confirmed model year.
function modelVerificationEvidence(color, pages) {
  return pages.filter(page => color.catalogSources?.some(source =>
    source.catalog === 'basf_models' && source.recordId === page.catalog_record?.record_id));
}

module.exports = { modelEvidencePages, isModelSource, catalogReferences, modelVerificationEvidence, isCatalogCodeLabel };
