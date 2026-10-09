const test = require('node:test');
const assert = require('node:assert/strict');

const { VerificationResearch, existingEvidence, modelLinkedPage } = require('../verification_research');

test('late confirmation research reuses evidence without spending search slots or calling the browser', async () => {
  const signal = new AbortController().signal;
  const events = [];
  const page = { url: 'https://catalog.test/', status: 'ok', text: 'Opal White pearl 123' };
  const research = new VerificationResearch({}, {
    signal, searchSignal: signal, timing: { signal, remainingMs: () => 1999 },
    existingPages: [page], log: (event, detail) => events.push({ event, ...detail }),
    browse: async () => assert.fail('No paid search near the retrieval cutoff'),
    fetchPages: async () => assert.fail('Existing evidence is already fetched'),
  });
  const result = await research.evidence({ name: 'Opal White', codes: ['123'], sources: [page.url] });
  await research.drain();
  assert.deepEqual(result, [page]);
  assert.equal(research.searchesSkippedDeadline, 1);
  assert.equal(research.queries.length, 0);
  assert.equal(research.searchBudget.used, 0);
  assert.equal(events[0].event, 'verification_search_deadline_skipped');
});

test('confirmation searches still run with a usable window and keep normal counters', async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  const research = new VerificationResearch({}, {
    signal, timing: { signal, remainingMs: () => 5000 },
    browse: async () => { calls++; return []; },
  });
  await research.search('Example color');
  await research.search('Example color');
  assert.equal(calls, 1);
  assert.equal(research.primarySearches, 1);
  assert.equal(research.searchesSkippedDeadline, 0);
});

test('settled colors prefetch one source in parallel and final review reuses it', async () => {
  const signal = new AbortController().signal;
  const first = { name: 'Opal White', codes: [], sources: ['https://maker.test/colors'] };
  const second = { name: 'Ruby Red', codes: [], sources: ['https://maker.test/colors'] };
  const original = { url: 'https://maker.test/colors', status: 'ok', text: 'Opal White and Ruby Red paints' };
  const extra = { url: 'https://independent.test/opal-white', status: 'ok', text: 'Opal White paint for Example Sedan' };
  let searches = 0, fetches = 0;
  const research = new VerificationResearch({ brand: 'Example', model: 'Sedan', country: 'Brazil' }, {
    signal, searchSignal: signal, primeDuringReview: true,
    timing: { signal, remainingMs: () => 10000 }, existingPages: [original], reuseEvidence: true,
    browse: async () => { searches++; return [{ results: [{ url: extra.url,
      title: 'Opal White paint', snippet: 'Example Sedan color' }] }]; },
    fetchPages: async () => { fetches++; return [extra]; },
  });

  research.offer([first, second]);
  await research.earlyJob;
  const pages = await research.evidence(first);
  await research.drain();

  assert.equal(searches, 1);
  assert.equal(fetches, 1);
  assert.equal(research.primarySearches, 1);
  assert.deepEqual(new Set(pages.map(page => page.url)), new Set([original.url, extra.url]));
});

test('normalized page reuse is run-local and invalidated when source text changes', () => {
  const page = { url: 'https://catalog.test/', status: 'ok', text: 'Opal White pearl 123' };
  const color = { name: 'Opal White', codes: [] };
  const first = new VerificationResearch({}, {});
  const second = new VerificationResearch({}, {});

  assert.deepEqual(existingEvidence([page], color, undefined, first.normalizedPages), [page]);
  assert.equal(first.hasIdentity([page], color), true);
  assert.equal(second.normalizedPages.has(page), false);

  page.text = 'Updated catalog: Garnet Red 456';
  assert.deepEqual(existingEvidence([page], color, undefined, first.normalizedPages), []);
  assert.equal(first.hasIdentity([page], color), false);
  assert.equal(first.hasIdentity([page], { name: 'Garnet Red' }), true);
});

test('two maker-wide paint pages do not suppress a bounded model-specific verification search', async () => {
  const signal = new AbortController().signal;
  const vehicle = { brand: 'Example Heavy', model: 'EX 320', manufacturingYear: 2020, country: 'Brazil' };
  const color = { name: 'Signal Yellow', codes: ['Y1'], sources: [
    'https://paint.example/signal-yellow', 'https://other.example/signal-yellow'] };
  const broad = color.sources.map(url => ({ url, status: 'ok', title: 'Example Heavy Signal Yellow paint',
    text: 'Example Heavy Signal Yellow paint. Code Y1.' }));
  const model = { url: 'https://equipment.example/ex-320-2020-paint', status: 'ok',
    title: 'Example Heavy EX 320 2020 paint', text: 'Example Heavy EX 320 2020 Signal Yellow paint code Y1.' };
  let searches = 0, fetches = 0;
  const research = new VerificationResearch(vehicle, { signal, searchSignal: signal,
    timing: { signal, remainingMs: () => 12000 }, existingPages: broad, reuseEvidence: true,
    browse: async queries => {
      searches++;
      assert.match(queries[0], /EX 320 2020/);
      return [{ results: [{ url: model.url, title: model.title, snippet: model.text }] }];
    },
    fetchPages: async () => { fetches++; return [model]; },
  });

  assert.equal(modelLinkedPage(broad[0], color, vehicle), false);
  assert.equal(modelLinkedPage(model, color, vehicle), true);
  const pages = await research.evidence(color);
  await research.drain();

  assert.equal(searches, 1);
  assert.equal(fetches, 1);
  assert.ok(pages.some(page => page.url === model.url));
});

test('model navigation elsewhere on a broad product page is not paint fitment', () => {
  const vehicle = { brand: 'Example Heavy', model: 'EX 320' };
  const color = { name: 'Signal Yellow' };
  const page = { url: 'https://paint.example/signal-yellow', status: 'ok',
    title: 'Signal Yellow paint', text: 'Signal Yellow paint for Example Heavy.\nBrowse EX 320 spare parts.' };
  assert.equal(modelLinkedPage(page, color, vehicle), false);
});

test('two subdomains of one paint seller do not count as independent reusable evidence', () => {
  const vehicle = { brand: 'Example Heavy', model: 'EX 320' };
  const color = { name: 'Signal Yellow', sources: [] };
  const pages = ['shop', 'docs'].map(host => ({
    url: `https://${host}.paint.example/ex-320`, status: 'ok',
    title: 'Example Heavy EX 320 paints', text: 'Signal Yellow paint for Example Heavy EX 320.',
  }));
  const research = new VerificationResearch(vehicle, { existingPages: pages, reuseEvidence: true });
  assert.equal(research.reusable(color), null);
});
