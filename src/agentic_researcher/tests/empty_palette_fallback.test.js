'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { emptyPaletteFallback, canUseEmptyFallback } = require('../empty_palette_fallback');

const vehicle = { brand: 'Example', model: 'EX 320', manufacturingYear: 2020,
  predominantColor: 'amarelo', paintFinish: 'perolizado' };

function candidate(id, name, pageId, url) {
  return { id, name, sources: [{ page_id: pageId, url,
    evidence: [`${name} — tinta original Example`] }] };
}

test('fallback uses an observed named paint only after normal colors are empty', () => {
  const source = 'https://maker.example/ex-320-2020-paints';
  const page = { id: 'P1', url: source, status: 'ok', title: 'Example EX 320 2020 paints',
    text: 'Example EX 320 2020: Amarelo Sol paint.' };
  const found = emptyPaletteFallback([candidate('C1', 'Amarelo Sol', 'P1', source)],
    { C1: { exclude_reason: 'incompatible_finish' } }, [page], vehicle);
  assert.equal(found.color.name, 'Amarelo Sol');
  assert.deepEqual(found.color.sources, [source]);
  assert.equal(found.color.universal_code, '');
  assert.deepEqual(found.color.code_candidates, []);
  assert.deepEqual(found.report, { reason: 'no_valid_colors', candidateId: 'C1',
    reviewReason: 'incompatible_finish', sourceQuality: 'fetched' });
});

test('fallback prefers complete names with fetched model evidence over weak snippets', () => {
  const snippet = candidate('C1', 'Hyper', 'S1', 'https://search.example/hyper');
  const fetched = candidate('C2', 'Amarelo Sol', 'P1', 'https://maker.example/ex-320');
  const pages = [
    { id: 'S1', url: snippet.sources[0].url, status: 'search_snippet', text: 'Hyper paint Example' },
    { id: 'P1', url: fetched.sources[0].url, status: 'ok',
      title: 'Example EX 320 colors', text: 'Example EX 320 Amarelo Sol paint' },
  ];
  assert.equal(emptyPaletteFallback([snippet, fetched], {}, pages, vehicle).color.name, 'Amarelo Sol');
});

test('a rejected non-paint artifact or absent named source cannot become a fallback', () => {
  const url = 'https://maker.example/paint';
  const candidates = [candidate('C1', 'Amarelo Sol', 'P1', url)];
  const page = { id: 'P1', url, status: 'ok', text: 'Paint page with no named shade.' };
  assert.equal(emptyPaletteFallback(candidates, { C1: { exclude_reason: 'not_paint_name' } },
    [page], vehicle), null);
  assert.equal(emptyPaletteFallback(candidates, {}, [], vehicle), null);
  assert.equal(emptyPaletteFallback([], {}, [page], vehicle), null);
});

test('a real paint rejected for the target vehicle remains an explicitly labelled last resort', () => {
  const url = 'https://maker.example/other-model';
  const found = emptyPaletteFallback([candidate('C1', 'Amarelo Sol', 'P1', url)],
    { C1: { exclude_reason: 'unrelated_vehicle' } },
    [{ id: 'P1', url, status: 'ok', title: 'Example other model paint',
      text: 'Amarelo Sol paint for another model.' }], vehicle);
  assert.equal(found.color.name, 'Amarelo Sol');
  assert.equal(found.report.reviewReason, 'unrelated_vehicle');
});

test('unfinished reviews and omission audits cannot trigger the exception', () => {
  const ready = { candidates: [{ id: 'C1' }], reviewedCandidates: [{ id: 'C1' }],
    unreviewedCandidates: [], unresolvedNames: [],
    omissionReview: { total: 1, checked: 1, incomplete: 0, repairFailures: 0 },
    verificationEnabled: true };
  assert.equal(canUseEmptyFallback(ready), true);
  assert.equal(canUseEmptyFallback({ ...ready, unreviewedCandidates: [{ id: 'C1' }] }), false);
  assert.equal(canUseEmptyFallback({ ...ready, omissionReview: { ...ready.omissionReview,
    checked: 0, incomplete: 1 } }), false);
  assert.equal(canUseEmptyFallback({ ...ready, unresolvedNames: [{ name: 'Hyper' }] }), false);
  assert.equal(canUseEmptyFallback({ ...ready, candidates: [] }), false);
});
