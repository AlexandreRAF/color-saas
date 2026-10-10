const test = require('node:test');
const assert = require('node:assert/strict');
const { refineNameQuery, nameSearchGroups, nameGroupQuery, resolvedName } = require('../name_research');

test('a same-code database name refines the search without fabricating fetched evidence', async () => {
  const lead = { name: 'Hyper', query: 'original', codes: ['P2S'], source_evidence: [] };
  const result = await refineNameQuery(lead, { brand: 'Hyundai', model: 'ix35' }, { lookup: async () => [{ candidates: [
    { candidate_id: 1, description: 'HYPER SILVER MET/CL', manufacturer: 'HYUNDAI', source_code_match: true },
    { candidate_id: 2, description: 'HYPER SILVER II MET/CL', manufacturer: 'HYUNDAI', source_code_match: true },
    { candidate_id: 3, description: 'HYPER WHITE', manufacturer: 'HYUNDAI', source_code_match: false },
  ] }] });
  assert.match(result.query, /"HYPER SILVER"/);
  assert.equal(result.name, 'Hyper');
  assert.deepEqual(result.source_evidence, []);
});

test('conflicting database completions remain hints rather than an arbitrary expanded name', async () => {
  const lead = { name: 'Solar', query: 'original', codes: ['A1', 'B1'], source_evidence: [] };
  const result = await refineNameQuery(lead, { brand: 'Example', model: 'Model' }, { lookup: async () => [{ candidates: [
    { candidate_id: 1, description: 'SOLAR RED MET', manufacturer: 'Example', source_code_match: true },
    { candidate_id: 2, description: 'SOLAR BLUE MET', manufacturer: 'Example', source_code_match: true },
  ] }] });
  assert.equal(result.query, 'original');
});

test('a catalog version never replaces an unversioned name search', async () => {
  const lead = { name: 'Hyper Metallic', query: 'Hyundai ix35 "Hyper Metallic" WJX full paint name',
    codes: ['WJX'], source_evidence: [] };
  const result = await refineNameQuery(lead, { brand: 'Hyundai', model: 'ix35' }, { lookup: async () => [{
    candidates: [{ candidate_id: 1, description: 'HYPER II MET/CL', manufacturer: 'HYUNDAI',
      source_code_match: true }],
  }] });
  assert.equal(result.query, lead.query);
});

test('a same-code MET abbreviation can target a complete published name', async () => {
  const lead = { name: 'Hyper', query: 'Hyundai ix35 "Hyper" WJX full paint name',
    codes: ['WJX'], source_evidence: [] };
  const result = await refineNameQuery(lead, { brand: 'Hyundai', model: 'ix35' }, { lookup: async () => [{
    candidates: [
      { candidate_id: 1, description: 'HYPER MET/CL', manufacturer: 'HYUNDAI', source_code_match: true },
      { candidate_id: 2, description: 'HYPER II MET/CL', manufacturer: 'HYUNDAI', source_code_match: true },
      { candidate_id: 3, description: 'GRAPHITE GRAY MET', manufacturer: 'HYUNDAI', source_code_match: true },
    ],
  }] });
  assert.equal(result.database_hint, 'HYPER Metallic');
  assert.equal(nameGroupQuery({ brand: 'Hyundai', model: 'ix35' }, [result], new Set(['Hyper'])),
    'Hyundai "HYPER Metallic" "WJX" paint color');
  assert.equal(result.name, 'Hyper');
});

test('one ambiguous same-code lead gets its own query within the existing quota', () => {
  const leads = ['Hyper Metallic', 'Pewter', 'Sirius', 'Galaxy Pearl'].map(name => ({ name }));
  const groups = nameSearchGroups(leads, 6, new Set(['Hyper Metallic']));
  assert.deepEqual(groups.map(group => group.map(lead => lead.name)), [
    ['Hyper Metallic'], ['Pewter', 'Sirius'], ['Galaxy Pearl'],
  ]);
  assert.equal(nameSearchGroups(leads, 4, new Set(['Hyper Metallic'])).length, 4);
  assert.equal(nameGroupQuery({ brand: 'Hyundai', model: 'ix35' }, [{ name: 'Hyper Metallic',
    codes: ['WJX'], query: 'model-specific fallback' }], new Set(['Hyper Metallic'])),
  'Hyundai "Hyper Metallic" "WJX" paint color');
  assert.equal(resolvedName({ pages: [{ status: 'ok', candidates: [{ name: 'Hyper Metallic',
    evidence: ['Hyper Metallic - WJX'] }] }] }, { name: 'Hyper Metallic', codes: ['WJX'] }), true);
});

test('abbreviated multiword names can use same-code database rows as search hints', async () => {
  const lead = { name: 'Powder-P.-White-P.', query: 'original', codes: ['N2'], source_evidence: [] };
  const result = await refineNameQuery(lead, { brand: 'Hyundai', model: 'Azera' }, { lookup: async () => [{ candidates: [
    { candidate_id: 1, description: 'POWDER WHITE PEARL/CL', manufacturer: 'HYUNDAI', source_code_match: true },
    { candidate_id: 2, description: 'PURE PEARL WHITE/CL', manufacturer: 'HYUNDAI', source_code_match: true },
  ] }] });
  assert.match(result.query, /"POWDER WHITE"/);
  assert.equal(result.name, lead.name);
  assert.deepEqual(result.source_evidence, []);
});
