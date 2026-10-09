const test = require('node:test');
const assert = require('node:assert/strict');
const { literalPaintRows } = require('../literal_paint_rows');
const { structuredExtraction } = require('../structured_extraction');
const { sourceCodes } = require('../paint_evidence');

test('club color/reference tables recover complete paints with code and period context', () => {
  const text = 'Cores da linha PUMA\nTabela de Cores da Linha PUMA\nCor | Ref\n'
    + '84 Vermelho Fênix metálico | M3610\n74 Vermelho Rubi | M3042\n'
    + '80 Prata continental metálico | M7043\nMenu Principal';
  const rows = literalPaintRows(text, { brand: 'Puma', model: 'Puma GTS', manufacturingYear: 1978 });

  assert.deepEqual(rows.map(row => row.name), ['Vermelho Fênix metálico', 'Vermelho Rubi', 'Prata continental metálico']);
  assert.deepEqual(sourceCodes(rows[1].name, rows[1].evidence), ['M3042']);
  assert.ok(rows.every(row => row.evidence.some(passage => passage.includes('Cor | Ref'))));
});

test('flattened color/reference columns recover repeated OEM rows without product codes', () => {
  const text = 'Cores da linha Puma - clube\n\nTabela de Cores da Linha PUMA\n\nCor\n\nRef\n\n'
    + 'Quantil noturno automotivo\n\n133200730\n\nQuantil bate-pedra\n\n133206099\n\n'
    + 'Amarelo Puma\n\nM2835\n\n84 Vermelho Fênix metálico\n\nM3610\n\n'
    + '80 Prata continental metálico\n\nM7043\n\n74 Vermelho Rubi\n\nM3042\n\n'
    + 'You are here:\nHome';
  const rows = literalPaintRows(text, { brand: 'Puma', model: 'Puma GTS', manufacturingYear: 1978 });

  assert.deepEqual(rows.map(row => row.name), [
    'Amarelo Puma', 'Vermelho Fênix metálico', 'Prata continental metálico', 'Vermelho Rubi',
  ]);
  assert.deepEqual(rows.map(row => sourceCodes(row.name, row.evidence)),
    [['M2835'], ['M3610'], ['M7043'], ['M3042']]);
  assert.ok(rows.every(row => row.evidence.every(passage => text.includes(passage))));
  assert.deepEqual(literalPaintRows(text.replace('Cor\n\nRef', 'Produto\n\nSKU'), { brand: 'Puma' }), []);
});

test('a consecutive named code list recovers paints without treating formula fragments as OEM codes', () => {
  const text = 'Puma Classic: PUMACOR\nLaca Acrílica Original - PUMACOR\n'
    + 'Branco Polar - COD 0750-3712\nOuro Puma Metálico - COD 0750-3939\n'
    + 'Vermelho Mont Carlo - COD 0750-4330\nOutras informações';
  const rows = literalPaintRows(text, { brand: 'Puma', model: 'Puma GTS', manufacturingYear: 1978 });

  assert.ok(rows.some(row => row.name === 'Vermelho Mont Carlo'));
  assert.deepEqual(sourceCodes('Vermelho Mont Carlo', rows.find(row => row.name === 'Vermelho Mont Carlo').evidence), []);
  assert.deepEqual(literalPaintRows('Vermelho Mont Carlo - COD 0750-4330'), []);
});

test('labelled swatch lists preserve consecutive name/code pairs and their limiting context', () => {
  const text = 'Example Model paint colour codes\nChoose from the colour swatches below.\n'
    + 'Marine Blue\nA1/HYA1\nPiston Grey\n5K/HY5K\nCool Brown\nBB/HYWBB/WB4\n'
    + 'Not all years or markets used every listed paint.\nCustomer support\nHELLO';
  const rows = literalPaintRows(text);
  assert.deepEqual(rows.map(row => row.name), ['Marine Blue', 'Piston Grey', 'Cool Brown']);
  assert.ok(rows.every(row => row.evidence.some(passage => passage.includes('Not all years'))));
  assert.equal(rows[2].evidence[0], 'Cool Brown\nBB/HYWBB/WB4');
  const residual = structuredExtraction(text);
  assert.equal(residual.text.includes('Marine Blue\nA1/HYA1'), false);
  assert.ok(residual.text.includes('Not all years or markets'));
  assert.equal(residual.complete, false, 'the model still reads unparsed qualifications');
  assert.deepEqual(literalPaintRows(text.replace('paint colour codes', 'accessories')), []);
  assert.deepEqual(literalPaintRows(text.replace('colour swatches', 'products')), []);
  assert.deepEqual(literalPaintRows('Paint codes\nColour swatches\nMarine Blue\nA1\nPiston Grey\n5K'), []);
});

test('failed extraction can recover literal English and Portuguese labelled paint rows', () => {
  const rows = ['COLOR CODE N3S - Shimmering Silver Metallic',
    'Paint code: WA636R — Switchblade Silver', 'Código da cor 070 | Branco Lunar Perolizado'];
  const candidates = literalPaintRows(rows.join('\n'));
  assert.deepEqual(candidates.map(candidate => candidate.name),
    ['Shimmering Silver Metallic', 'Switchblade Silver', 'Branco Lunar Perolizado']);
  assert.deepEqual(candidates.map(candidate => candidate.evidence[0]), rows);
});

test('unlabelled code guesses, generic hues and prose cannot become recovered paint names', () => {
  assert.deepEqual(literalPaintRows('N3S - Shimmering Silver\nColor Code N2 - White\nSKU N3S - Product\n'
    + 'See the color code N3S - Shimmering Silver in our catalog'), []);
});

test('a standalone paint-code heading grounds literal code/name rows', () => {
  const text = 'Hyundai ix35\nPaint codes\nN3S - Shimmering Silver Metallic\nNKA - Phantom Black';
  const candidates = literalPaintRows(text);
  assert.deepEqual(candidates.map(row => row.name), ['Shimmering Silver Metallic', 'Phantom Black']);
  assert.ok(candidates.every(row => row.evidence.some(passage => passage.includes('Hyundai ix35'))));
  assert.deepEqual(literalPaintRows('We sell paint codes and products\n123 - Shelf Paint'), []);
});

test('a paint heading does not turn manufacturer navigation links into paint rows', () => {
  const text = 'Colour code\nHYUNDAI - TUCSON\nTOYOTA - COROLLA\n'
    + 'N3S - Shimmering Silver\nNKA - Phantom Black';
  assert.deepEqual(literalPaintRows(text).map(row => row.name), ['Shimmering Silver', 'Phantom Black']);
});

test('literal recovery leaves visual hue and finish assessment to the evidence reviewer', () => {
  const text = 'Paint codes\nA1 - Bright Red\nB2 - Blue Silver\nC3 - Cobalt Coast\n'
    + 'D4 - Shimmering Silver Solid\nE5 - Steel Grey';
  assert.deepEqual(literalPaintRows(text, { predominantColor: 'prata', paintFinish: 'perolizado' })
    .map(row => row.name), ['Bright Red', 'Blue Silver', 'Cobalt Coast', 'Shimmering Silver Solid', 'Steel Grey']);
  assert.equal(literalPaintRows(text).length, 5);
});

test('explicit paint-name and year lists recover every named lead without hue guesses', () => {
  const text = 'Example Model\n\nLista de cores do modelo\n\n'
    + 'Golden Mist\n\n2018\n\n2017\n\nOcean Blue\n\n2018\n\n2017\n\n'
    + 'White\n\n2018\n\n2017\n\nNavigation';
  const candidates = literalPaintRows(text, { predominantColor: 'verde' });

  assert.deepEqual(candidates.map(row => row.name), ['Golden Mist', 'Ocean Blue']);
  assert.ok(candidates.every(row => row.evidence.every(passage => text.includes(passage))));
  assert.ok(candidates.every(row => row.evidence.some(passage => passage.includes('Example Model'))));
  assert.deepEqual(literalPaintRows('Example Model\n2018\n2017'), []);
  assert.deepEqual(literalPaintRows('List of paint colors\nOcean Blue\n2018'), []);
  assert.deepEqual(literalPaintRows('List of paint colors\nOcean Blue\n2018\n2018'), []);
});

test('explicit all-year list ranges retain target and nearby years without remote editions', () => {
  const text = 'Toyota Corolla list of colours\nOld Copper\n1988\n1995\n'
    + 'White Crystal Shine\n2003\n2026\nNearby Silver\n2015\n2017\n'
    + 'Future Blue\n2026\n2028\n';

  assert.deepEqual(literalPaintRows(text, { manufacturingYear: 2018 })
    .map(row => row.name), ['White Crystal Shine', 'Nearby Silver']);
  assert.deepEqual(literalPaintRows(text, {})
    .map(row => row.name), ['Old Copper', 'White Crystal Shine', 'Nearby Silver', 'Future Blue']);
  const residual = structuredExtraction(text, { manufacturingYear: 2018 });
  assert.ok(!residual.text.includes('Old Copper'));
  assert.ok(!residual.text.includes('Future Blue'));
  assert.ok(residual.candidates.some(row => row.name === 'White Crystal Shine'));
});

test('model-labelled name and OEM-code lists recover exact paint leads', () => {
  const text = 'Qual cor você escolhe para o seu Corolla XEI?\n\n'
    + 'Branco Polar (040)\nCinza Celestial (1K3)\nPrata Supernova (1E7)\nBranco Lunar (089)\n';
  const vehicle = { model: 'Corolla', manufacturingYear: 2018 };
  const rows = literalPaintRows(text, vehicle);

  assert.deepEqual(rows.map(row => row.name),
    ['Branco Polar', 'Cinza Celestial', 'Prata Supernova', 'Branco Lunar']);
  assert.ok(rows.every(row => row.evidence.every(passage => text.includes(passage))));
  assert.deepEqual(literalPaintRows(text, { model: 'Hilux' }), []);
  assert.deepEqual(literalPaintRows('Corolla colors\nBranco Lunar (089)', vehicle), []);
});

test('a model-year code chart recovers complete names and excludes code-only combinations', () => {
  const text = 'Paint colours for Toyota Corolla year 2018\n\n'
    + '040 | SUPER WHITE II\n\n1984 - 2026\n\n'
    + '070 | WHITE CRYSTAL SHINE PRL.\n\n2003 - 2026\n\n'
    + '2KR | TOY-209 / TOY-070\n\n2016 - 2026\n\n'
    + '1G3 | MAGNETIC GREY MET.\n\n2001 - 2026\n\nOr choose a year';
  const rows = literalPaintRows(text, { brand: 'Toyota', model: 'Corolla', manufacturingYear: 2018 });

  assert.deepEqual(rows.map(row => row.name), ['SUPER WHITE II', 'WHITE CRYSTAL SHINE PRL.', 'MAGNETIC GREY MET.']);
  assert.ok(rows[1].evidence.includes('070 | WHITE CRYSTAL SHINE PRL.'));
  assert.ok(rows[1].evidence.includes('2003 - 2026'));
  assert.ok(rows[1].evidence.includes('Paint colours for Toyota Corolla year 2018'));
  assert.deepEqual(literalPaintRows(text, { brand: 'Toyota', model: 'Hilux', manufacturingYear: 2018 }), []);
});

test('a flattened model brochure palette recovers names even when finish cells run together', () => {
  const text = 'Nissan Versa 2017\nLISTA DE EQUIPAMENTOS\nCORES\nNISSAN VERSA\nLISTA DE EQUIPAMENTOS\n'
    + 'Branco Aspen\nSólido Prata Classic\nMetálico\nCinza Titanium\nMetálico\n'
    + 'Preto Premium\nSólido\nCinza Magnum\nMetálico\nVermelho Malbec\nMetálico';
  const vehicle = { brand: 'Nissan', model: 'Versa', manufacturingYear: 2017 };
  const rows = literalPaintRows(text, vehicle);

  assert.deepEqual(rows.map(row => row.name), [
    'Branco Aspen', 'Prata Classic', 'Cinza Titanium',
    'Preto Premium', 'Cinza Magnum', 'Vermelho Malbec',
  ]);
  assert.deepEqual(rows.find(row => row.name === 'Cinza Titanium').evidence[0], 'Cinza Titanium\nMetálico');
  assert.ok(rows.every(row => row.evidence.every(passage => text.includes(passage))));
  assert.deepEqual(literalPaintRows(text, { model: 'Sentra' }), []);
  assert.deepEqual(literalPaintRows(text.replace('CORES', 'EQUIPAMENTOS'), vehicle), []);
  assert.deepEqual(literalPaintRows('CORES\nNissan Versa\nCinza Titanium\nMetálico', vehicle), []);
});

test('a factory exterior-color equipment table recovers each paint and its own code', () => {
  const text = '1.4L Turbo Ecotec\nCRUZE\nMOTORIZAÇÃO\n...\nCORES EXTERNAS\n'
    + '- Cor GF8 (@85), Cinza Satin Steel (metálica - PDB) X X X\n'
    + '- Cor GP7 (@90), Branco Abalone (perolizada - PDC) X X X\n'
    + '-Cor GB8 (@70), Preto Ouro Negro (metálica - PDB) X X X\n'
    + '- Cor GAN (@78), Prata Switchblade (metálica - PDB) X X X\n'
    + 'Tapetes em carpete X X\nFriso Lateral - Branco Abalone X X';
  const rows = literalPaintRows(text, { model: 'Cruze', manufacturingYear: 2018 });

  assert.deepEqual(rows.map(row => row.name), [
    'Cinza Satin Steel', 'Branco Abalone', 'Preto Ouro Negro', 'Prata Switchblade',
  ]);
  assert.deepEqual(rows.map(row => sourceCodes(row.name, row.evidence)), ['GF8', 'GP7', 'GB8', 'GAN'].map(code => [code]));
  assert.ok(rows.every(row => row.evidence.every(passage => text.includes(passage))));
  assert.deepEqual(literalPaintRows(text, { model: 'Onix' }), []);
  assert.deepEqual(literalPaintRows(text.replace('CORES EXTERNAS', 'ACESSÓRIOS'), { model: 'Cruze' }), []);
});
