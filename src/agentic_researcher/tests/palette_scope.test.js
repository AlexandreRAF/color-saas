'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { candidateInventory } = require('../candidate_inventory');
const { partitionPalette } = require('../palette_scope');

const vehicle = { brand: 'Caterpillar', model: '320', manufacturingYear: 2020 };

test('a single-paint page does not lend a related thumbnail its identity', () => {
  const page = { id: 'P1', status: 'ok',
    url: 'https://paint.example/paint/384007-caterpillar-tractor-yellow',
    title: 'Match of Caterpillar Tractor Yellow',
    text: 'Caterpillar Tractor Yellow paint. '
      + '[![Image 5: Caterpillar New Yellow](https://paint.example/images/new-yellow.jpg)]'
      + '(https://paint.example/paint/384009-caterpillar-new-yellow)',
    candidates: [
      { name: 'Caterpillar Tractor Yellow', evidence: ['Caterpillar Tractor Yellow paint'] },
      { name: 'Caterpillar New Yellow', evidence: [
        '[![Image 5: Caterpillar New Yellow](https://paint.example/images/new-yellow.jpg)]'
        + '(https://paint.example/paint/384009-caterpillar-new-yellow)'] },
    ] };
  const artifacts = [];
  const inventory = candidateInventory([page], { manufacturer: vehicle.brand,
    onArtifact: item => artifacts.push(item) });
  assert.deepEqual(inventory.map(row => row.name), ['Caterpillar Tractor Yellow']);
  assert.equal(artifacts[0].reason, 'related_paint_link');
});

test('retail coating titles do not become paint names, while separately named colors survive', () => {
  const page = { id: 'P1', status: 'ok', url: 'https://shop.example/caterpillar-yellow',
    title: 'Tintas Caterpillar', text: 'Tinta PU Amarelo Caterpillar 6461 3,6L. '
      + 'Cor: Amarelo Caterpillar. R$ 365,00',
    candidates: [
      { name: 'Tinta PU Amarelo Caterpillar 6461', evidence: ['Tinta PU Amarelo Caterpillar 6461 3,6L'] },
      { name: 'Amarelo Caterpillar', evidence: ['Cor: Amarelo Caterpillar'] },
    ] };
  const artifacts = [];
  const inventory = candidateInventory([page], { onArtifact: item => artifacts.push(item) });
  assert.deepEqual(inventory.map(row => row.name), ['Amarelo Caterpillar']);
  assert.equal(artifacts[0].reason, 'retail_product_title');
});

test('retailer paint-product prose is not a model paint identity', () => {
  const page = { id: 'P1', status: 'ok', url: 'https://parts.example/tinta-amarela-ano-95',
    title: '2Y5445: Tinta Amarela Caterpillar Moderno Ano 95',
    text: 'Tinta Amarela Brasilux Moderno Caterpillar Ano 95 é um esmalte sintético para pintura da máquina.',
    candidates: [{ name: 'Tinta Amarela Brasilux Moderno Caterpillar Ano 95',
      evidence: ['Tinta Amarela Brasilux Moderno Caterpillar Ano 95 é um esmalte sintético.'] }] };
  const artifacts = [];
  assert.deepEqual(candidateInventory([page], { onArtifact: item => artifacts.push(item) }), []);
  assert.equal(artifacts[0].reason, 'retail_product_title');
});

test('maker-wide paints remain visible as leads; model pages, catalogs and explicit fleet claims stay in the palette', () => {
  const brand = { name: 'Amarelo Caterpillar 81', sources: ['https://paint.example/caterpillar'] };
  const model = { name: 'Amarelo Original', sources: ['https://manual.example/320-2020-cores'] };
  const catalog = { name: 'Amarelo Cat', sources: [], catalogSources: [
    { catalog: 'basf_models', recordId: 7 }] };
  const display = { name: 'Amarelo', identityType: 'vehicle_display_color', sources: [] };
  const fleet = { name: 'Yellow Standard', identityType: 'fleet_standard_paint', sources: [] };
  const pages = [
    { url: brand.sources[0], status: 'ok', title: 'Caterpillar paints', text: 'Amarelo Caterpillar 81.' },
    { url: model.sources[0], status: 'ok', title: 'Caterpillar 320 2020 cores',
      text: 'Caterpillar 320 2020 — Amarelo Original.' },
  ];
  const modelCatalogPages = [{ catalog: 'basf_models', catalog_record: {
    record_id: 7, model_match: 'exact' } }];
  const scoped = partitionPalette([brand, model, catalog, display, fleet], vehicle,
    pages, modelCatalogPages);
  assert.deepEqual(scoped.colors.map(color => color.applicabilityScope), [
    'manufacturer_only', 'model_page', 'model_catalog', 'model_display_label', 'fleet_standard' ]);
  assert.deepEqual(scoped.paletteScope, { modelCandidates: 4, manufacturerLeads: 1 });
});

test('a qualified model row and unrelated navigation cannot establish model applicability', () => {
  const color = { name: 'Amarelo Caterpillar 81', sources: ['https://paint.example/brand'],
    catalogSources: [{ catalog: 'basf_models', recordId: 8 }] };
  const pages = [{ url: color.sources[0], status: 'ok', title: 'Caterpillar paint chart',
    text: 'Model menu: Caterpillar 320.\nColor: Amarelo Caterpillar 81.' }];
  const modelCatalogPages = [{ catalog: 'basf_models', catalog_record: {
    record_id: 8, model_match: 'qualified_model' } }];
  const scoped = partitionPalette([color], vehicle, pages, modelCatalogPages);
  assert.deepEqual(scoped.paletteScope, { modelCandidates: 0, manufacturerLeads: 1 });
});
