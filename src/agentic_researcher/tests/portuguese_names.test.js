const test = require('node:test');
const assert = require('node:assert/strict');
const { portugueseNameQuery } = require('../portuguese_names');
const { seedQueries } = require('../research_plan');

test('Brazilian naming research keeps international discovery and seeks documented equivalences', () => {
  const vehicle = { brand: 'Volkswagen', model: 'Gol', manufacturingYear: 2015, country: 'Brazil' };
  const seeds = seedQueries(vehicle);
  assert.ok(seeds.some((query) => query.includes('paint color chart')));
  assert.ok(seeds.some((query) => query.includes('catálogo cores pintura')));
  const candidates = [{ name: 'Platinum Grey', sources: [{ evidence: ['LD7X - Platinum Grey'] }] },
    { name: 'Prata Lunar', sources: [{ evidence: ['LR5S - Prata Lunar'] }] }];
  const query = portugueseNameQuery(candidates, vehicle);
  assert.match(query, /Volkswagen Gol 2015 \("Platinum Grey" OR "LD7X"\)/);
  assert.match(query, /nome.*cor.*português.*Brasil/);
  assert.doesNotMatch(query, /Prata Lunar/);
});

test('empty early evidence still triggers broad Portuguese name discovery', () => {
  assert.equal(portugueseNameQuery([], { brand: 'Honda', model: 'CG 160', country: 'Brazil' }),
    'Honda CG 160 nomes cores originais códigos tinta catálogo Brasil');
});

test('requested hue guides early international and local discovery without removing broad palette searches', () => {
  const vehicle = { brand: 'Hyundai', model: 'Azera', manufacturingYear: 2017, country: 'Brazil', predominantColor: 'branco' };
  const seeds = seedQueries(vehicle);
  assert.equal(seeds.length, 6);
  assert.match(seeds[5], /lista de equipamentos cores PDF/);
  assert.match(seeds[0], /branco/);
  assert.match(seeds[2], /white/);
  assert.doesNotMatch(seeds[1], /branco|white/);
  const candidates = [
    { name: 'Ebony Black', sources: [{ evidence: ['EB - Ebony Black'] }, { evidence: ['EB - Ebony Black'] }] },
    { name: 'Noble White', sources: [{ evidence: ['NW - Noble White'] }] },
  ];
  assert.match(portugueseNameQuery(candidates, vehicle), /"Noble White" OR "NW"/);
  assert.doesNotMatch(portugueseNameQuery(candidates.slice(0, 1), vehicle), /Ebony Black/);
  assert.match(portugueseNameQuery([], vehicle), /branco/);
  assert.match(seedQueries({ ...vehicle, brand: 'Honda', model: 'CG 160', predominantColor: 'vermelho' })[2], /red/);
});
