'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VerificationResearch } = require('../verification_research');
const { verifyFinalColors } = require('../final_verification_agent');
const { SectionExtractionCache, withoutNavigationLinks } = require('../section_extraction');
const { referenceSegments } = require('../page_evidence');
const { RunTiming } = require('../run_timing');
const { parseLoadArgs } = require('../evaluate_load');
const { summarize } = require('../vehicle_test_runner');

const vehicle = { brand: 'Example', model: 'Example Car' };
const page = { url: 'https://paint.test/model', status: 'ok', text: 'Example Car Moon White A1' };

test('verification preparation overlaps work and is reused with final matched codes', async () => {
  const timing = new RunTiming({ softDeadlines: true });
  let searches = 0, reviews = 0;
  const color = { name: 'Moon White', sources: [page.url], codes: [] };
  const options = { timing, signal: timing.signal, existingPages: [page],
    browse: async () => { searches++; return []; }, fetchPages: async () => [],
    review: async (_stage, _schema, input) => {
      reviews++;
      assert.deepEqual(input.colors[0].codes, ['A1']);
      return { V1: { checks: [] } };
    } };
  try {
    const research = new VerificationResearch(vehicle, options);
    research.add([color]); research.flush();
    await research.drain();
    assert.equal(reviews, 0);
    const result = await verifyFinalColors({ colors: [{ ...color, codes: ['A1'] }] }, vehicle, { ...options, research });
    assert.equal(searches, 1);
    assert.equal(reviews, 1);
    assert.equal(result.summary.colorsChecked, 1);
    research.add([{ ...color, name: 'Different Pearl' }]);
    await research.drain();
    assert.ok(searches > 1); // Renamed identities need their own evidence.
  } finally { timing.close(); }
});

test('section reuse restores this page quotations and never reuses changed finish or scope', async () => {
  const cache = new SectionExtractionCache();
  const text = 'Example Car\nMoon Pearl | A1 | Finish: pearl';
  const reference = referenceSegments(text)[0];
  let calls = 0;
  const execute = async () => { calls++; return { requests: 1, usage: { input_tokens: 1 },
    found: [{ name: 'Moon Pearl', evidence_ids: [1, 2] }], candidates: [] }; };
  await cache.extract(vehicle, reference, text, execute);
  const reused = await cache.extract(vehicle, reference, text, execute);
  assert.equal(calls, 1);
  assert.equal(reused.requests, 0);
  assert.equal(reused.usage, undefined);
  assert.ok(reused.candidates[0].evidence.every(passage => text.includes(passage)));
  const different = text.replace('pearl', 'solid');
  await cache.extract(vehicle, referenceSegments(different)[0], different, execute);
  await cache.extract({ ...vehicle, model: 'Other Car' }, reference, text, execute);
  assert.equal(calls, 3);
  const navigation = `[Home](https://shop.test/)\n${text}\n[Paints](https://shop.test/paints)`;
  assert.equal(withoutNavigationLinks(navigation), text + '\n[Paints](https://shop.test/paints)');
});

test('failed sections are retryable and do not become cached successes', async () => {
  const cache = new SectionExtractionCache();
  const reference = referenceSegments('Example Pearl A1')[0];
  await assert.rejects(cache.extract(vehicle, reference, reference.sourceText, async () => { throw new Error('Failed'); }));
  let called = false;
  await cache.extract(vehicle, reference, reference.sourceText, async () => { called = true; return { found: [], candidates: [] }; });
  assert.equal(called, true);
});

test('a reused section cannot borrow a paint name present only in another page URL', async () => {
  const cache = new SectionExtractionCache();
  const first = '[Swatch](https://paint.test/Moon)';
  const second = '[Swatch](https://paint.test/Other)';
  const a = referenceSegments(first)[0], b = referenceSegments(second)[0];
  assert.equal(a.text, b.text); // Link destinations are hidden from the extractor.
  let calls = 0;
  const execute = async () => { calls++; return { found: [{ name: 'Moon', evidence_ids: [1] }], candidates: [] }; };
  await cache.extract(vehicle, a, first, execute);
  await cache.extract(vehicle, b, second, execute);
  assert.equal(calls, 2);
});

test('load reporting includes queue latency and validates paid-run arguments', () => {
  assert.deepEqual(parseLoadArgs([]), { levels: [1, 2, 4, 7], repeat: 2 });
  assert.throws(() => parseLoadArgs(['--levels=100']));
  const summary = summarize([10, 20, 50].map(time => ({ timeMs: time,
    endToEndMs: time + 100, queueWaitMs: 100, cost: 0.01,
    acceptance: { passed: false, checks: {} } })), 3, '/tmp/report');
  assert.deepEqual(summary.metrics.totalTimeMs, { median: 120, p95: 150 });
  assert.deepEqual(summary.metrics.queueWaitMs, { median: 100, p95: 100 });
});

test('invalid cached references trigger extraction instead of silently dropping candidates', async () => {
  const cache = new SectionExtractionCache();
  const text = 'Moon Pearl A1';
  const reference = referenceSegments(text)[0];
  let calls = 0;
  const execute = async () => {
    calls++;
    return { found: [{ name: 'Moon Pearl', evidence_ids: [999] }], candidates: [] };
  };
  await cache.extract(vehicle, reference, text, execute);
  await cache.extract(vehicle, reference, text, execute);
  assert.equal(calls, 2);
});
