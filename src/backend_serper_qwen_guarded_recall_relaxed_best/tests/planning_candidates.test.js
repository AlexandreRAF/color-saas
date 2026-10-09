const test = require('node:test');
const assert = require('node:assert/strict');

const { planningCandidates } = require('../research_plan');
const { catalogHueLeads } = require('../discovery_pipeline');
const { hueFamilies } = require('../hue_review');

test('planning retains every lead and source reference without repeating review evidence', () => {
  const candidates = [{ id: 'C1', name: 'Example Silver', aliases: ['Prata Example'],
    sources: [{ page_id: 'P1', url: 'https://example.com/paints', evidence: ['Code A12 - Example Silver'] },
      { page_id: 'BM1', url: 'catalog:basf_models:1', evidence: ['Long catalog evidence'] }],
    catalog_check: { rows: [{ candidate_id: 1 }] } }];
  const before = structuredClone(candidates);
  const summary = planningCandidates(candidates);

  assert.equal(summary.length, candidates.length);
  assert.deepEqual(summary[0].source_ids, ['P1', 'BM1']);
  assert.deepEqual(summary[0].aliases, ['Prata Example']);
  assert.equal(summary[0].has_model_catalog_evidence, true);
  assert.equal(summary[0].has_web_evidence, true);
  assert.equal(summary[0].sources, undefined);
  assert.equal(summary[0].catalog_check, undefined);
  assert.deepEqual(candidates, before);
});

test('a matching catalog code can prioritize name clarification without deciding hue', async () => {
  const leads = [{ name: 'Pewter', codes: ['YT3'] }, { name: 'Hyper', codes: ['WJX'] },
    { name: 'Blueberry', codes: ['WAE'] }];
  const run = { catalogs: { lookup: async request => ({ candidates: request.name === 'Hyper'
    ? [{ manufacturer: 'HYUNDAI', source_code_match: true, description: 'GRAPHITE GRAY MET', universal_code: 'WJX' },
      { manufacturer: 'HYUNDAI', source_code_match: false, description: 'HYPER WHITE', universal_code: 'WW2' },
      { manufacturer: 'HYUNDAI', source_code_match: false, description: 'HYPER SILVER', universal_code: 'P2S' }]
    : [{ manufacturer: 'HYUNDAI', source_code_match: true,
      description: request.name === 'Pewter' ? 'PEWTER GRAY MET' : 'BLUE MET',
      universal_code: request.source_codes[0] }] }) } };
  const hints = await catalogHueLeads(run, { brand: 'Hyundai', model: 'ix35' }, leads, hueFamilies('prata'));

  assert.deepEqual(hints.map(lead => lead.name), ['Hyper', 'Pewter']);
});
