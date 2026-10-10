const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewInput } = require('../review_input');

test('review references preserve every verbatim passage, source and name check', () => {
  const vehicle = { brand: 'Volkswagen', model: 'Gol', country: 'Brazil' };
  const shared = 'Gol colors\nLD7X Cinza Platinum\nPrata Lunar\nNot available on all trims';
  const sources = [
    { page_id: 'P1', url: 'https://a.test', evidence: [shared, 'Model year 2015'] },
    { page_id: 'P2', url: 'https://b.test', evidence: [shared, '2016 only; not 2015'] },
  ];
  const candidates = [
    { id: 'C1', name: 'Cinza Platinum', aliases: [], sources },
    { id: 'C2', name: 'Prata Lunar', sources },
    { id: 'C3', name: 'Hyper', sources, name_check: { required: true, longer_names: ['Hyper Silver'] } },
  ];
  const pages = sources.map(({ page_id, url }) => ({ id: page_id, url, title: 'Catalog', text: shared }));
  const original = structuredClone({ candidates, pages });
  const input = reviewInput(vehicle, candidates, pages);
  assert.equal(Object.keys(input.evidence).length, 3);
  assert.deepEqual(input.candidates.map((candidate) => ({ ...candidate,
    sources: candidate.sources.map((source) => ({ page_id: source.page_id,
      url: input.pages.find((page) => page.id === source.page_id).url,
      evidence: source.evidence_ids.map((id) => input.evidence[id]),
    })),
  })), candidates);
  assert.deepEqual({ candidates, pages }, original);
});
