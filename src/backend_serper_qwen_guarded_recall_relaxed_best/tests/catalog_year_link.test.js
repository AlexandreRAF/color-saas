'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { catalogYearLink } = require('../catalog_year_link');

test('offered model year selects the scoped paint chart', () => {
  const page = { url: 'https://www.paintcolourchart.com/cars/082/corolla.html',
    text: 'Toyota Corolla paints\nOr choose a year\n2024\n2018\n2017\nAbout' };

  assert.equal(catalogYearLink(page, { manufacturingYear: 2018 }),
    'https://www.paintcolourchart.com/cars/082/corolla/2018.html');
  assert.equal(catalogYearLink(page, { manufacturingYear: 2016 }), null);
  assert.equal(catalogYearLink(page, {}), null);
  assert.equal(catalogYearLink({ ...page, url: 'https://example.test/cars/082/corolla.html' },
    { manufacturingYear: 2018 }), null);
  assert.equal(catalogYearLink({ ...page, url: 'https://www.paintcolourchart.com/cars/082/corolla/2018.html' },
    { manufacturingYear: 2018 }), null);
});
