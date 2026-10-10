'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { galleryPaintRows } = require('../gallery_paint_rows');
const { structuredExtraction } = require('../structured_extraction');

const section = (name, year, note = '') => `## [${name} Example Color](https://example.test/# "Expand")\n\n[${name} ${year} Model](https://example.test/paint/)\n\n${note}\n`;
const text = '# All Example Model Colors\n\n' + section('Blue Moon', 1989)
  + section('Silver Sky Metallic', 1990, 'Only a custom repaint; not a factory color.')
  + section('White Sand', 2001, 'Finish: solid.');

test('repeated gallery rows preserve complete names, years and qualifying prose', () => {
  const result = structuredExtraction(text, { brand: 'Example' });
  assert.deepEqual(result.candidates.map(row => row.name), ['Blue Moon', 'Silver Sky Metallic', 'White Sand']);
  assert.ok(result.candidates[1].evidence.some(row => row.includes('not a factory color')));
  assert.ok(result.candidates[0].evidence.some(row => row.includes('1989')));
  assert.ok(result.text.includes('not a factory color'));
  assert.ok(result.text.includes('Finish: solid'));
  assert.ok(!result.text.includes('Blue Moon 1989'));
  assert.equal(result.complete, false);
});

test('isolated headings, wrong makers and captions with different paint names stay model work', () => {
  assert.equal(galleryPaintRows(section('Blue Moon', 1989), { brand: 'Example' }).candidates.length, 0);
  assert.equal(galleryPaintRows(text, { brand: 'Other' }).candidates.length, 0);
  assert.equal(galleryPaintRows(text.replace('Blue Moon 1989', 'Blue Star 1989'), { brand: 'Example' }).candidates.length, 0);
  assert.equal(galleryPaintRows(text).candidates.length, 0);
});

test('remote gallery generations do not create current-year leads while nearby and reused paints remain', () => {
  const gallery = '# All Example Model Colors\n\n' + section('Blue Moon', 1989)
    + section('Silver Sky Metallic', 1990)
    + section('White Sand', 2023)
    + section('Red Echo', 1991, 'Also used on 2025 Example Model.');
  const result = galleryPaintRows(gallery, {
    brand: 'Example', model: 'Model', manufacturingYear: 2025,
  });

  assert.deepEqual(result.candidates.map(row => row.name), ['White Sand', 'Red Echo']);
  assert.ok(result.spans.some(span => span.includes('Blue Moon')));
  assert.deepEqual(galleryPaintRows(gallery, { brand: 'Example', model: 'Model' })
    .candidates.map(row => row.name), ['Blue Moon', 'Silver Sky Metallic', 'White Sand', 'Red Echo']);

  const extracted = structuredExtraction(gallery, {
    brand: 'Example', model: 'Model', manufacturingYear: 2025,
  });
  assert.ok(!extracted.text.includes('Blue Moon 1989'));
  assert.ok(!extracted.text.includes('Silver Sky Metallic 1990'));
  assert.ok(extracted.text.includes('Also used on 2025 Example Model.'));
});

test('a wholly historical gallery does not re-enter extraction when it has no current-year leads', () => {
  const gallery = '# All Example Model Colors\n\n' + section('Blue Moon', 1989)
    + section('Silver Sky Metallic', 1990) + section('White Sand', 2001);
  const result = structuredExtraction(gallery, {
    brand: 'Example', model: 'Model', manufacturingYear: 2025,
  });

  assert.deepEqual(result.candidates, []);
  assert.ok(!result.text.includes('Blue Moon 1989'));
  assert.ok(!result.text.includes('Silver Sky Metallic 1990'));
  assert.ok(!result.text.includes('White Sand 2001'));
});
