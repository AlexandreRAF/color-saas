const test = require('node:test');
const assert = require('node:assert/strict');
const { isGenericPaintName, completePaintName, stripSupplierReference } = require('../paint_name');
const { candidateInventory } = require('../candidate_inventory');

test('numbered supplier references are metadata while versions and descriptive qualifiers remain', () => {
  assert.equal(stripSupplierReference('Noble White (Pag.813/Maz.3)'), 'Noble White');
  assert.equal(stripSupplierReference('Crimson Red (PPG 922749)'), 'Crimson Red');
  assert.equal(stripSupplierReference('Hyper (Violet)'), 'Hyper (Violet)');
  assert.equal(stripSupplierReference('Silver Blue (Water-Based Only)'), 'Silver Blue (Water-Based Only)');
  assert.equal(stripSupplierReference('White (B)'), 'White (B)');
});

test('finish suffix variants share one reviewed identity and retain original evidence', () => {
  const candidates = candidateInventory(['Hyper White', 'Hyper White Tricoat', 'Hyper White Tri-Coat',
    'Hyper White Three Coat', 'Hyper White Tricamada', 'Hyper White Metallic'].map((name, index) => ({
    id: `P${index}`, url: `https://paint${index}.test`, candidates: [{ name, evidence: [`Azera ${name} WC9`] }],
  })));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].name, 'Hyper White');
  assert.equal(candidates[0].sources.length, 6);
  assert.ok(candidates[0].aliases.includes('Hyper White Tricoat'));
  assert.equal(completePaintName('Pure Pearl Tricoat'), 'Pure Pearl');
  assert.equal(completePaintName('Hyper White II Tricoat'), 'Hyper White II');
  assert.equal(completePaintName('Hyper White Cream Tricoat'), 'Hyper White Cream');
});

test('rejects broad hue labels and generic finishes across common source languages', () => {
  for (const name of [
    'Prata', 'BRANCO', 'Dourada', 'Verde metálica', 'Prata Metálico',
    'Silver', 'White Metallic', 'Gold', 'Plata', 'Blanco', 'Dorada',
    'Argent', 'Bleu métallisé', 'Pearl Met.', 'Metallic Pearl', 'White (Comm.)',
  ]) {
    assert.equal(isGenericPaintName(name), true, name);
  }
});

test('normalization does not create a one-word fragment from the published name', () => {
  assert.equal(completePaintName('Galaxy Pearl'), 'Galaxy Pearl');
  assert.equal(completePaintName('Hyper Metallic'), 'Hyper Metallic');
  assert.equal(completePaintName('Shimmering Silver Metallic'), 'Shimmering Silver');
  assert.equal(completePaintName('Quicksilver-MET.'), 'Quicksilver');
});

test('retains distinguishing complete paint names', () => {
  for (const name of [
    'Prata Continental Metálico', 'Branco Lótus', 'Ouro Imperial Metálico',
    'Amarelo Puma', 'Prata metálico 77', 'Silver Moon Metallic',
  ]) {
    assert.equal(isGenericPaintName(name), false, name);
  }
});

test('code-only combinations are not named paints', () => {
  for (const name of ['040 + 209 + 209', '209 + 1H5', '209 + 4W9', '070']) {
    assert.equal(isGenericPaintName(name), true, name);
  }
  for (const name of ['Silver 77', 'Rosso 2C', 'Hyper White II']) {
    assert.equal(isGenericPaintName(name), false, name);
  }
});
