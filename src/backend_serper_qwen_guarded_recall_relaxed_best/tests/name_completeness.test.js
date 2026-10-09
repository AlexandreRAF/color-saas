const test = require('node:test');
const assert = require('node:assert/strict');
const { isAbbreviatedName, abbreviatedMatch } = require('../name_completeness');
const { sourceCodes, candidateSourceCodes, nameResearchQueries } = require('../paint_evidence');
const { candidateInventory, reviewedColors, reviewSchema } = require('../candidate_inventory');
const { catalogNameExpansion, catalogHueHints, retainCatalogHuePossibility } = require('../candidate_review');
const { brandKey } = require('../database_code_agent');

const page = (id, name, row) => ({ id, url: `https://${id}.test/chart`, candidates: [{ name, evidence: [row] }] });
const decide = candidates => Object.fromEntries(candidates.map(c => [c.id, {
  action: 'include', name: null, confidence: 'low', reason: 'Model supported by source.',
  source_ids: c.sources.map(s => s.page_id), ...(c.name_check && { name_status: 'complete' }),
}]));

test('dotted fragments need clarification while complete names and versions remain intact', () => {
  for (const name of ['Powder-P.-White-P.', 'Prata Tit.', 'S. Blue', 'Cinza Plat.']) {
    assert.equal(isAbbreviatedName(name), true, name);
  }
  for (const name of ['Steel Gray II', 'Steel Gray I.', 'Ice White', 'X-Treme Blue', 'Candy Red.', 'MF Red', 'Noble White (PAG.813)']) {
    assert.equal(isAbbreviatedName(name), false, name);
  }
  assert.equal(abbreviatedMatch('Powder-P.-White-P.', 'Powder White Pearl'), true);
  assert.equal(abbreviatedMatch('Prata Tit.', 'Prata Titanium'), true);
  assert.equal(abbreviatedMatch('Prata Tit.', 'Prata Titanium II'), false);
  assert.equal(abbreviatedMatch('Powder-P.-White-P.', 'Pure Pearl White'), false);
  assert.equal(abbreviatedMatch('S. Blue', 'Sky Blue'), true);
  assert.equal(abbreviatedMatch('S. Blue', 'Steel Blue'), true); // Caller must resolve ambiguity.
  assert.equal(abbreviatedMatch('S. Blue', 'Blue Sky'), false);
  assert.equal(abbreviatedMatch('T. S. Blue', 'Titanium Sky Blue'), true);
  assert.equal(abbreviatedMatch('T. S. Blue', 'Sky Titanium Blue'), false);
});

test('suffix codes are associated with the exact name, without mining years, URLs or other rows', () => {
  assert.deepEqual(sourceCodes('powder-p.-white-p.', ['### powder-p.-white-p. - N2']), ['N2']);
  assert.deepEqual(sourceCodes('Prata Lunar', ['Prata Lunar | A7', 'Prata Lunar (A7)', 'Paint Code (A7)']), ['A7']);
  assert.deepEqual(sourceCodes('Cinza Titanium', ['Cinza Titanium - Code: Y6G']), ['Y6G']);
  assert.deepEqual(sourceCodes('Pearl Snow', ['Pearl Snow - AB / CD']), ['AB', 'CD']);
  assert.deepEqual(sourceCodes('Pearl Snow', ['Pearl Snow-N2', '`N2` Pearl Snow', '## N2 Pearl Snow']), ['N2']);
  assert.deepEqual(sourceCodes('Pearl Snow', ['Pearl Snow - 2017', 'Ford F150 - 2019',
    'Other White - N2', 'https://a.test/color_code/N2', 'Pearl Snow fits Model N2']), []);
});

test('manufacturer code cross references are identifiers, not missing paint names', () => {
  const row = 'P3S | HYUNDAI GF / HYUNDAI P2S';
  const artifacts = [];
  const candidates = candidateInventory([{ id: 'P1', url: 'https://catalog.test/ix35',
    text: row, candidates: ['GF', 'P2S'].map(name => ({ name, evidence: [row] })) }],
  { manufacturer: 'Hyundai', onArtifact: item => artifacts.push(item) });
  assert.deepEqual(candidates, []);
  assert.deepEqual(artifacts.map(item => item.name), ['GF', 'P2S']);

  const combined = candidateInventory([{ id: 'P2', url: 'https://catalog.test/ix35',
    text: row, candidates: [{ name: 'HYUNDAI GF / HYUNDAI P2S', evidence: [row] }] }],
  { manufacturer: 'Hyundai' });
  assert.deepEqual(combined, []);
});

test('a complete published finish name can carry two code forms on one source row', () => {
  const candidates = candidateInventory([page('P1', 'Pewter Metallic',
    'COLOR CODE 11/ WA382E - Pewter Metallic'),
  page('P2', 'Very Dark Pewter (Interior)', 'Very Dark Pewter (Interior) - WA382E')]);
  const decisions = decide(candidates);
  decisions[candidates.find(item => item.name === 'Very Dark Pewter (Interior)').id] = 'interior_or_component';
  const unresolved = [];
  const colors = reviewedColors(candidates, decisions, { onUnresolved: item => unresolved.push(item) });
  assert.deepEqual(colors.map(color => color.name), ['Pewter Metallic']);
  assert.deepEqual(unresolved, []);
});

test('a complete name in a model color list is not withheld for a different unlinked name', () => {
  const candidates = candidateInventory([
    page('P1', 'Gun Metallic', 'Versa colors: Brilliant Silver Metallic, Gun Metallic, Super Black'),
    page('P2', 'Gun Metal Blue', 'Another model: Gun Metal Blue - B45'),
  ]);
  const unresolved = [];
  const decisions = decide(candidates);
  decisions[candidates.find(item => item.name === 'Gun Metal Blue').id] = 'unrelated_vehicle';
  const colors = reviewedColors(candidates, decisions, { onUnresolved: item => unresolved.push(item) });

  assert.deepEqual(colors.map(color => color.name), ['Gun Metallic']);
  assert.deepEqual(unresolved, []);
});

test('a reviewer can use a full name printed in its selected source', () => {
  const candidates = candidateInventory([
    page('P1', 'Gun', 'Gun\nMETALLIC KAD\n16-19'),
    page('P2', 'Gun', 'Versa colors: Brilliant Silver Metallic, Gun Metallic, Super Black'),
  ]);
  const decisions = decide(candidates);
  decisions.C1.name = 'Gun Metallic';
  decisions.C1.source_ids = ['P2'];
  const unresolved = [];
  const colors = reviewedColors(candidates, decisions, { onUnresolved: item => unresolved.push(item) });

  assert.deepEqual(colors.map(color => color.name), ['Gun Metallic']);
  assert.deepEqual(unresolved, []);
});

test('one full sibling on the same page can complete a reviewed short mention', () => {
  const candidates = candidateInventory([{ id: 'P1', url: 'https://archive.test/saveiro-colors',
    text: 'Vermelho Coral\nA minha é a coral', candidates: [
      { name: 'Coral', evidence: ['A minha é a coral'] },
      { name: 'Vermelho Coral', evidence: ['Vermelho Coral'] },
    ] }]);
  const short = candidates.find(candidate => candidate.name === 'Coral');
  const decisions = decide(candidates);
  decisions[short.id].name = 'Vermelho Coral';
  const unresolved = [];
  const colors = reviewedColors(candidates, decisions, { onUnresolved: item => unresolved.push(item) });

  assert.deepEqual(colors.map(color => color.name), ['Vermelho Coral']);
  assert.deepEqual(unresolved, []);
});

test('an independently printed same-code finish name completes a short lead', () => {
  const candidates = candidateInventory([
    page('P1', 'Hyper', 'Hyper - WJX'),
    page('P2', 'Hyper Metallic', 'Hyper Metallic - WJX'),
  ]);
  const unresolved = [];
  const colors = reviewedColors(candidates, decide(candidates), { onUnresolved: item => unresolved.push(item) });

  assert.deepEqual(colors.map(color => color.name), ['Hyper Metallic']);
  assert.deepEqual(unresolved, []);
});

test('merged finish names retain each source row and its own paint code', () => {
  const candidates = candidateInventory([
    page('P1', 'Hyper Metallic', 'Hyper Metallic\nSELECT'),
    page('P2', 'Hyper', 'Hyper\nWJX'),
  ]);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].sources.map(source => candidateSourceCodes(candidates[0], source)),
    [[], ['WJX']]);
  assert.deepEqual(nameResearchQueries(candidates, { brand: 'Hyundai', model: 'ix35' })[0].codes,
    ['WJX']);
});

test('a coded catalog base name completes a one-word paint without hiding a version', () => {
  const candidates = candidateInventory([
    page('P1', 'Crush', 'COLOR CODE WA413C/ G16 - Crush'),
    page('P2', 'Gasoline', 'COLOR CODE WA457B/ GPA - Gasoline'),
  ]);
  candidates[0].catalog_check = { rows: [{ description: 'CRUSH LISA', universal_code: 'G16-413C' }] };
  candidates[1].catalog_check = { rows: [{ description: 'GASOLINE MET 2/CL', universal_code: 'GPA' }] };
  const decisions = decide(candidates);
  for (const decision of Object.values(decisions)) decision.name_status = 'unresolved';
  const unresolved = [];
  const colors = reviewedColors(candidates, decisions, { onUnresolved: item => unresolved.push(item) });

  assert.deepEqual(colors.map(color => color.name), ['Crush']);
  assert.deepEqual(unresolved.map(item => item.name), ['Gasoline']);
});

test('one exact BASF code can supply a distinctive full-name version', () => {
  assert.equal(brandKey('GENERAL MOTORS'), brandKey('Chevrolet'));
  const [candidate] = candidateInventory([page('P1', 'Gasoline', 'COLOR CODE WA457B/ GPA - Gasoline')]);
  const rows = [
    { catalog: 'basf', description: 'GASOLINE METALLIC II', manufacturer: 'GENERAL MOTORS',
      universal_code: 'WA457B', year_evidence: { relation: 'within_catalog_range' } },
    { catalog: 'basf', description: 'GASOLINE MET', manufacturer: 'GENERAL MOTORS',
      universal_code: 'WA339A', year_evidence: { relation: 'outside_catalog_range' } },
  ];
  const expansion = catalogNameExpansion(candidate, rows, { brand: 'Chevrolet' });
  assert.deepEqual(expansion, { name: 'GASOLINE METALLIC II', code: 'WA457B' });
  candidate.name_check.catalog_expansion = expansion;
  const decisions = decide([candidate]);
  decisions.C1.name_status = 'unresolved';
  const unresolved = [];
  const colors = reviewedColors([candidate], decisions, { onUnresolved: item => unresolved.push(item) });
  assert.deepEqual(colors.map(color => color.name), ['GASOLINE METALLIC II']);
  assert.deepEqual(unresolved, []);
  assert.deepEqual(catalogNameExpansion(candidate, rows.map(row => ({ ...row,
    year_evidence: { relation: 'outside_catalog_range' } })), { brand: 'Chevrolet' }), expansion);
});

test('an unambiguous BASF code resolves a one-word supplier alias with a different spelling', () => {
  const [candidate] = candidateInventory([page('P1', 'Denim',
    '### Denim\nMfr. Color Code: G54/WA189X')]);
  const rows = [
    { catalog: 'basf', description: 'BLUE RAY MET', manufacturer: 'GENERAL MOTORS',
      universal_code: 'WA189X', year_evidence: { relation: 'near_catalog_range' } },
    { catalog: 'basf', description: 'DENIM BLUE MET', manufacturer: 'GENERAL MOTORS',
      universal_code: 'WA154L', year_evidence: { relation: 'within_catalog_range' } },
  ];
  const expansion = catalogNameExpansion(candidate, rows, { brand: 'Chevrolet' });
  assert.deepEqual(expansion, { name: 'BLUE RAY', code: 'WA189X' });
  candidate.name_check.catalog_expansion = expansion;
  const decisions = decide([candidate]);
  decisions[candidate.id].name_status = 'unresolved';
  assert.deepEqual(reviewedColors([candidate], decisions).map(color => color.name), ['BLUE RAY']);
  assert.deepEqual(catalogNameExpansion(candidate, rows.map(row => ({ ...row,
    year_evidence: { relation: 'outside_catalog_range' } })), { brand: 'Chevrolet' }), expansion);
  assert.equal(catalogNameExpansion(candidate, [rows[0], { ...rows[0],
    description: 'ANOTHER BLUE MET' }], { brand: 'Chevrolet' }), null);
});

test('a gallery finish-and-code line resolves a short name through a same-code local catalog row', () => {
  const [candidate] = candidateInventory([page('P1', 'Gun',
    'Gun\nMETALLIC KAD\n16-19')]);
  assert.deepEqual(candidateSourceCodes(candidate, candidate.sources[0]), ['KAD']);
  const rows = [
    { catalog: 'basf', description: 'DARK METAL GRAY', manufacturer: 'NISSAN',
      universal_code: 'KAD' },
    { catalog: 'lazzumix', description: 'GUN METALLIC/CL', manufacturer: 'NISSAN',
      universal_code: 'KAD' },
  ];
  const expansion = catalogNameExpansion(candidate, rows, { brand: 'Nissan' });
  assert.deepEqual(expansion, { name: 'GUN METALLIC', code: 'KAD' });
  candidate.name_check.catalog_expansion = expansion;
  const decisions = decide([candidate]);
  decisions[candidate.id].name_status = 'unresolved';
  assert.deepEqual(reviewedColors([candidate], decisions).map(color => color.name), ['GUN METALLIC']);
});

test('an already complete BASF model name is not blocked by its own longer-name hint', () => {
  const [candidate] = candidateInventory([{ id: 'BM1', url: 'catalog:basf_models:1',
    catalog: 'basf_models', catalog_record: { record_id: 1, candidate_id: -1 },
    candidates: [{ name: 'REFLEXSILBER MET', evidence: [
      'Manufacturer: VOLKSWAGEN. Model: GOL. Paint: REFLEXSILBER MET. Color code: LA7W.',
    ] }] }]);
  candidate.name_check.longer_names = ['Reflexsilber Metallic'];
  const decisions = decide([candidate]);
  decisions[candidate.id].name = 'Reflexsilber Metallic';
  const unresolved = [];
  const colors = reviewedColors([candidate], decisions, { onUnresolved: item => unresolved.push(item) });
  assert.deepEqual(colors.map(color => color.name), ['REFLEXSILBER MET']);
  assert.deepEqual(unresolved, []);
});

test('BASF prioritizes a year-linked full name over a later local formula spelling', () => {
  const [candidate] = candidateInventory([page('P1', 'Gasoline',
    'COLOR CODE WA457B/ GPA - Gasoline')]);
  const rows = [
    { catalog: 'basf', description: 'GASOLINE METALLIC II', manufacturer: 'GENERAL MOTORS',
      universal_code: 'WA457B' },
    { catalog: 'lazzumix', description: 'GASOLINE MET 2/CL', manufacturer: 'CHEVROLET',
      universal_code: 'GPA' },
  ];
  assert.deepEqual(catalogNameExpansion(candidate, rows, { brand: 'Chevrolet' }),
    { name: 'GASOLINE METALLIC II', code: 'WA457B' });
});

test('a trailing parenthesized OEM code links an abbreviated seller name to its full source', () => {
  const row = 'NISSAN – OEMatch Automotive Vehicle Paint Kit in ETHOS GREY M. (KCH)';
  assert.deepEqual(sourceCodes('ETHOS GREY M.', [row]), ['KCH']);
  assert.deepEqual(sourceCodes('ANOTHER GREY M.', [row]), []);
  const candidates = candidateInventory([
    page('P1', 'ETHOS GREY M.', row),
    page('P2', 'ETHOS GREY MET', 'Color code: KCH - ETHOS GREY MET'),
  ]);
  const decisions = decide(candidates);
  decisions[candidates.find(item => item.name === 'ETHOS GREY M.').id].name_status = 'unresolved';
  const unresolved = [];
  const colors = reviewedColors(candidates, decisions, { onUnresolved: item => unresolved.push(item) });
  assert.deepEqual(colors.map(color => color.name), ['ETHOS GREY MET']);
  assert.deepEqual(unresolved, []);
});

test('a complete finish-bearing supplier label with its own code survives uncertain model wording', () => {
  const [candidate] = candidateInventory([page('P1', 'Graphite Metallic',
    '### Graphite Metallic\nMfr. Color Code: GPA/WA457B')]);
  const decisions = decide([candidate]);
  decisions[candidate.id].name_status = 'unresolved';
  const unresolved = [];
  const colors = reviewedColors([candidate], decisions, { onUnresolved: item => unresolved.push(item) });
  assert.deepEqual(colors.map(color => color.name), ['Graphite Metallic']);
  assert.deepEqual(unresolved, []);
});

test('same-make code-linked hue labels are uncertainty hints, not identity matches', () => {
  const [candidate] = candidateInventory([page('P1', 'Hyper', 'Hyper - WJX')]);
  const rows = [
    { manufacturer: 'HYUNDAI', universal_code: 'WJX', source_code_match: true,
      description: 'GRAPHITE GRAY MET' },
    { manufacturer: 'HYUNDAI', universal_code: 'P2S', source_code_match: false,
      description: 'HYPER VIOLET' },
    { manufacturer: 'FORD', universal_code: 'WJX', source_code_match: true,
      description: 'GRAPHITE GRAY MET' },
  ];
  assert.deepEqual(catalogHueHints(candidate, rows, { brand: 'Hyundai', predominantColor: 'prata' }),
    ['GRAPHITE GRAY MET']);
});

test('a code-linked catalog MET name protects an ambiguous model paint from hue exclusion', () => {
  const [candidate] = candidateInventory([page('P1', 'Hyper', 'Hyper - WJX')]);
  candidate.name_check.longer_names = ['Hyper (Violet)'];
  const rows = [{ catalog: 'basf', description: 'HYPER MET', manufacturer: 'HYUNDAI',
    universal_code: 'WJX', year_evidence: { relation: 'within_catalog_range' } }];
  candidate.name_check.catalog_expansion = catalogNameExpansion(candidate, rows, { brand: 'Hyundai' });
  candidate.catalog_check = { hue_hints: ['GRAPHITE GRAY MET'] };
  assert.deepEqual(candidate.name_check.catalog_expansion, { name: 'HYPER Metallic', code: 'WJX' });

  const kept = retainCatalogHuePossibility(candidate, {
    [candidate.id]: { exclude_reason: 'unrelated_hue', reason: 'unrelated_hue' },
  }, new Set(['silver-gray']));
  assert.equal(kept[candidate.id].action, 'include');
  assert.deepEqual(reviewedColors([candidate], kept).map(color => color.name), ['HYPER Metallic']);

  const [blue] = candidateInventory([page('P2', 'Ocean Blue', 'Ocean Blue - WJX')]);
  blue.catalog_check = candidate.catalog_check;
  const excluded = retainCatalogHuePossibility(blue, {
    [blue.id]: { exclude_reason: 'unrelated_hue', reason: 'unrelated_hue' },
  }, new Set(['silver-gray']));
  assert.equal(excluded[blue.id].exclude_reason, 'unrelated_hue');
});

test('identical short paint labels with conflicting printed codes remain separate candidates', () => {
  const candidates = candidateInventory([
    page('P1', 'Hyper', 'Hyper - WJX'),
    page('P2', 'Hyper Metallic', 'P2S\nHyper Metallic'),
  ]);
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map(candidate => candidate.sources.flatMap(source =>
    candidateSourceCodes(candidate, source))).sort((a, b) => a[0].localeCompare(b[0])),
  [['P2S'], ['WJX']]);
});

test('invisible separators and a bare code label do not leave a catalog alias unresolved', () => {
  const candidates = candidateInventory([page('P1',
    'WHITE CRYSTAL SHINE​/​CRYSTAL PEARL-MET.',
    'WHITE CRYSTAL SHINE​/​CRYSTAL PEARL-MET.\ncode: 070')]);
  assert.deepEqual(candidates.map(candidate => candidate.name),
    ['WHITE CRYSTAL SHINE', 'CRYSTAL PEARL-MET.']);
  assert.deepEqual(candidateSourceCodes(candidates[1], candidates[1].sources[0]), ['070']);
  const unresolved = [];
  const colors = reviewedColors(candidates, decide(candidates), {
    onUnresolved: item => unresolved.push(item),
  });
  assert.deepEqual(colors.map(color => color.name), ['WHITE CRYSTAL SHINE']);
  assert.deepEqual(unresolved, []);
});

test('brandwide promoted shades on a model landing page are not model evidence', () => {
  const artifacts = [];
  const pages = [{ id: 'P1', url: 'https://seller.test/paint-maker-model',
    text: 'Paint for Maker Model\nTOP shade code MAKER\nMAKER\nSLATE-MET.\ncode: 17, 7311\nOur Products',
    candidates: [{ name: 'SLATE-MET.', evidence: ['SLATE-MET.\ncode: 17, 7311'] }] }];
  assert.deepEqual(candidateInventory(pages, { onArtifact: item => artifacts.push(item) }), []);
  assert.equal(artifacts[0].reason, 'brandwide_promotion');
});

test('generic translated exterior descriptors are not paint identities', () => {
  assert.deepEqual(candidateInventory([page('P1', 'Prateado Brilhante Metalizado',
    'Exterior: Prateado Brilhante Metalizado')]), []);
});

test('a short name in a printed three-name slash row resolves to its approved coded alias', () => {
  const row = '### Ice/Quick Silver/Switchblade Met\nMfr. Color Code: GAN/9W5/WA636R/WA8636/17';
  const candidates = candidateInventory([page('P1', 'Ice/Quick Silver/Switchblade Met', row)]);
  const decisions = decide(candidates);
  for (const candidate of candidates) if (candidate.name !== 'Quick Silver') {
    decisions[candidate.id].name_status = 'unresolved';
  }
  const unresolved = [];
  const colors = reviewedColors(candidates, decisions, { onUnresolved: item => unresolved.push(item) });
  assert.deepEqual(colors.map(color => color.name), ['Quick Silver']);
  assert.deepEqual(unresolved, []);
});

test('a sole code-linked full name resolves a one-word lead across sources', () => {
  const candidates = candidateInventory([
    page('P1', 'Ethos', 'KCH - Ethos'),
    page('P2', 'Ethos Grey', 'KCH - Ethos Grey'),
  ]);
  const unresolved = [];
  const colors = reviewedColors(candidates, decide(candidates), {
    onUnresolved: item => unresolved.push(item),
  });
  assert.deepEqual(colors.map(color => color.name), ['Ethos Grey']);
  assert.deepEqual(new Set(colors[0].sources), new Set(['https://P1.test/chart', 'https://P2.test/chart']));
  assert.deepEqual(unresolved, []);
});

test('a printed slash alternative resolves a short lead on the same coded row', () => {
  const row = '### Copper/Dark Copper Metallic\n\nMfr. Color Code: WA381E/69';
  const candidates = candidateInventory([page('P1', 'Copper/Dark Copper Metallic', row)]);
  const unresolved = [];
  const colors = reviewedColors(candidates, decide(candidates), { onUnresolved: item => unresolved.push(item) });

  assert.deepEqual(colors.map(color => color.name), ['Dark Copper']);
  assert.deepEqual(unresolved, []);
});

test('a generic hue plus an explicit product code is not another paint name', () => {
  const artifacts = [];
  const candidates = candidateInventory([page('P1', 'SILVER AA3',
    'Auto Paint Pen Brush for HYUNDAI iX35 SIRIUS SILVER AA3; Manufacturer Part Number. AA3')],
  { onArtifact: item => artifacts.push(item) });

  assert.deepEqual(candidates, []);
  assert.deepEqual(artifacts.map(item => item.reason), ['generic_hue_with_product_code']);
  assert.equal(candidateInventory([page('P2', 'Silver 77', 'Model paint name: Silver 77')]).length, 1);
});

test('a one-word lead stays unresolved when two full paints share its printed code', () => {
  const candidates = candidateInventory([
    page('P1', 'Hyper', 'WC9 - Hyper'),
    page('P2', 'Hyper White', 'WC9 - Hyper White'),
    page('P3', 'Hyper Silver', 'WC9 - Hyper Silver'),
  ]);
  const unresolved = [];
  reviewedColors(candidates, decide(candidates), { onUnresolved: item => unresolved.push(item) });
  assert.deepEqual(unresolved.map(item => item.name), ['Hyper']);
});

test('multiword fragments get schema checks and use the existing clarification budget', () => {
  const candidates = candidateInventory([page('P1', 'Cinza Plat.', 'Cinza Plat. - A1')]);
  assert.equal(candidates[0].name_check.abbreviated, true);
  assert.deepEqual(candidates[0].name_check.source_codes, ['A1']);
  const schema = reviewSchema(candidates).properties.C1.anyOf.find(s => s.properties?.confidence);
  assert.ok(schema.required.includes('name_status'));
  const queries = nameResearchQueries(candidates, { brand: 'Volkswagen', model: 'Gol' });
  assert.equal(queries.length, 1);
  assert.match(queries[0].query, /Cinza Plat.*A1/);
});

test('unique approved full names resolve fragments and preserve every source for matching', () => {
  for (const [short, full, code] of [
    ['Powder-P.-White-P.', 'Powder White Pearl', 'N2'],
    ['Prata Tit.', 'Prata Titanium', 'A7'],
    ['Vermelho Rub.', 'Vermelho Rubi', 'R9'],
    ['Green For.', 'Green Forest', 'G7'],
  ]) {
    const candidates = candidateInventory([page('P1', short, `${short} - ${code}`),
      page('P2', full, `${full} - ${code}`)]);
    const unresolved = [];
    const colors = reviewedColors(candidates, decide(candidates), { onUnresolved: c => unresolved.push(c) });
    assert.equal(colors.length, 1);
    assert.equal(colors[0].name, full);
    assert.equal(colors[0].sources.length, 2);
    assert.ok(colors[0].source_evidence.every(s => s.paint_codes.includes(code)));
    assert.ok(colors[0].source_evidence.some(s => s.source_name === short));
    assert.deepEqual(unresolved, []);
    assert.equal(nameResearchQueries(candidates, { model: 'Model' }).length, 0);
  }
});

test('ambiguity, different codes and versions cannot silently merge a fragment', () => {
  for (const extra of [
    [page('P2', 'Sky Blue', 'Sky Blue - B1'), page('P3', 'Steel Blue', 'Steel Blue - B1')],
    [page('P2', 'Sky Blue', 'Sky Blue - B2')],
    [page('P2', 'Sky Blue II', 'Sky Blue II - B1')],
    [],
  ]) {
    const candidates = candidateInventory([page('P1', 'S. Blue', 'S. Blue - B1'), ...extra]);
    const unresolved = [];
    const colors = reviewedColors(candidates, decide(candidates), { onUnresolved: c => unresolved.push(c) });
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].name, 'S. Blue');
    assert.equal(colors.length, extra.length);
    assert.ok(colors.every(c => !isAbbreviatedName(c.name)));
  }
});

test('a guessed expansion or alias cannot bypass review or the unresolved-name guard', () => {
  const candidates = candidateInventory([page('P1', 'S. Blue', 'S. Blue - B1'),
    page('P2', 'Sky Blue', 'Sky Blue - B1')]);
  for (const alias of [false, true]) {
    const decisions = decide(candidates);
    decisions.C1 = alias ? { alias_of: 'C2', source_ids: ['P1'], reason: 'Proposed alias' }
      : { ...decisions.C1, name: 'Sky Blue' };
    decisions.C2 = 'Different vehicle';
    const unresolved = [];
    assert.deepEqual(reviewedColors(candidates, decisions, { onUnresolved: c => unresolved.push(c) }), []);
    assert.equal(unresolved[0].name, 'S. Blue');
  }
});
