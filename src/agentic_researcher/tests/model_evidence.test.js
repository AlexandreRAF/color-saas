const test = require('node:test');
const assert = require('node:assert/strict');

const { modelEvidencePages } = require('../model_evidence');

test('model catalog leads are never discarded by commercial hue words alone', () => {
  const names = ['Ocean Blue', 'Golden Mist', 'Rose Quartz', 'Forest Green', 'Prata Shark'];
  const records = names.map((description, index) => ({
    record_id: index + 1,
    manufacturer: 'Example',
    model: 'Example Model',
    description,
    universal_code: `C${index + 1}`,
    year: '2010-2020',
  }));

  for (const predominantColor of ['azul', 'verde', 'cinza', 'bege', 'vermelho', 'branco']) {
    const pages = modelEvidencePages(records, { predominantColor });

    assert.deepEqual(pages.map(page => page.candidates[0].name), names);
    assert.ok(pages.every(page => page.text.includes('Market: unknown')));
    assert.ok(pages.every(page => page.catalog === 'basf_models'));
  }
});

test('generic catalog labels still do not create named paint candidates', () => {
  const pages = modelEvidencePages([
    { record_id: 1, description: 'White', manufacturer: 'Example', model: 'Model' },
    { record_id: 2, description: '', manufacturer: 'Example', model: 'Model' },
  ], {});

  assert.deepEqual(pages, []);
});

test('current model palette avoids remote edition leads but sparse specialist palettes remain available', () => {
  const records = [
    { record_id: 1, description: 'Current Pearl', manufacturer: 'Example', model: 'Model', year: '2017-2020' },
    { record_id: 2, description: 'Current Silver', manufacturer: 'Example', model: 'Model', year: '2018-2021' },
    { record_id: 3, description: 'Current Gray', manufacturer: 'Example', model: 'Model', year: '2018' },
    { record_id: 4, description: 'Adjacent Blue', manufacturer: 'Example', model: 'Model', year: '2007-2008' },
    { record_id: 5, description: 'Old Copper', manufacturer: 'Example', model: 'Model', year: '1980-1984' },
  ];

  assert.deepEqual(modelEvidencePages(records, { manufacturingYear: 2018 })
    .map(page => page.candidates[0].name),
  ['Current Pearl', 'Current Silver', 'Current Gray', 'Adjacent Blue']);
  assert.deepEqual(modelEvidencePages(records.slice(3), { manufacturingYear: 2018 })
    .map(page => page.candidates[0].name), ['Adjacent Blue', 'Old Copper']);
});

test('qualified body variants need web linkage when the requested model has current exact records', () => {
  const records = [
    { record_id: 1, description: 'Pearl White', manufacturer: 'Example', model: 'Model',
      model_match: 'exact', year: '2017-2020' },
    { record_id: 2, description: 'Silver Mist', manufacturer: 'Example', model: 'Model',
      model_match: 'exact', year: '2018-2021' },
    { record_id: 3, description: 'Blue Night', manufacturer: 'Example', model: 'Model',
      model_match: 'exact', year: '2018' },
    { record_id: 4, description: 'Cross Bronze', manufacturer: 'Example', model: 'Model Cross',
      model_match: 'qualified_model', year: '2018-2022' },
  ];

  assert.deepEqual(modelEvidencePages(records, { manufacturingYear: 2018 })
    .map(page => page.candidates[0].name), ['Pearl White', 'Silver Mist', 'Blue Night']);
  assert.deepEqual(modelEvidencePages(records.slice(1), { manufacturingYear: 2018 })
    .map(page => page.candidates[0].name), ['Silver Mist', 'Blue Night', 'Cross Bronze']);
});
