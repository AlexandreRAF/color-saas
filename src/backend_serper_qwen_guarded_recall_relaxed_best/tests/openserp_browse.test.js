const test = require('node:test');
const assert = require('node:assert/strict');
const { browse: search, searchLocale } = require('../openserp_browse');
const browse = (queries, options) => search(queries, { engines: ['google'], ...options });
const { destinationUrl, googleNavigation, resolveSearchUrl } = require('../search_urls');
const { indexResults, selectSources } = require('../research_plan');
const { sourceUrl } = require('../source_index');
const { fetchPages } = require('../fetch_pages');

const envelope = results => ({ ok: true, json: async () => ({ results }) });
const redirect = location => ({ status: 302, headers: new Headers({ location }), body: { cancel: async () => {} } });

test('search highlights collapse to one canonical catalog source', () => {
  const base = 'https://catalog.test/toyota/corolla';
  assert.equal(sourceUrl(`${base}?highlight=Branco%20Lunar&utm_source=search`), base);
  const index = new Map();
  indexResults([{ query: 'Toyota Corolla colors', results: [
    { url: `${base}?highlight=Branco%20Lunar`, title: 'Corolla paint catalog' },
    { url: base, title: 'Corolla paint catalog' },
  ] }], index);
  assert.equal(index.size, 1);
});

test('Google locale retains Brazil without a strict Portuguese language filter', async () => {
  assert.deepEqual(searchLocale('Brazil'), { region: 'BR' });
  await browse(['Hyundai Azera paint color chart'], { host: '127.0.0.1:7000', country: 'Brazil',
    request: async input => {
      const url = new URL(input);
      assert.equal(url.pathname, '/google/search');
      assert.equal(url.searchParams.get('region'), 'BR');
      assert.equal(url.searchParams.has('lang'), false);
      assert.equal(url.searchParams.get('extract'), '0');
      return envelope([]);
    } });
});

test('plain destination links unwrap without HTTP and opaque links never become invented URLs', () => {
  assert.equal(destinationUrl('https://www.google.com.br/url?q=https%3A%2F%2Fpaint.test%2Fchart'), 'https://paint.test/chart');
  assert.equal(destinationUrl('/url?url=https%3A%2F%2Fpaint.test%2Fchart'), 'https://paint.test/chart');
  assert.equal(destinationUrl('https://www.google.com.br/goto?url=CAESopaque'), null);
  assert.equal(destinationUrl('javascript:alert(1)'), null);
  assert.equal(destinationUrl('https://google.example.com/goto?url=opaque'), 'https://google.example.com/goto?url=opaque');
  assert.equal(googleNavigation('https://consent.google.com/m'), true);
});

test('OpenSERP resolves tokens, deduplicates destinations and ranks actual paint domains', async () => {
  let redirects = 0, downloads = 0;
  const results = await browse(['first', 'second'], { host: 'localhost:7000', request: async (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'localhost') return envelope([
      { title: 'Hyundai Azera paint colors', url: '/goto?url=one', snippet: 'Paint chart' },
      { title: 'Hyundai Azera paint colors', url: '/goto?url=two', snippet: 'Paint chart' },
    ]);
    if (url.hostname === 'www.google.com') {
      redirects++;
      assert.equal(options.redirect, 'manual');
      return redirect('https://paint.test/Hyundai/Azera?utm_source=google');
    }
    downloads++;
    throw new Error('Search must not download target pages');
  } });
  assert.equal(redirects, 2); // Shared across both queries.
  assert.equal(downloads, 0);
  assert.ok(results.every(row => !row.error && row.results.length === 1));
  const index = new Map();
  indexResults(results, index);
  assert.equal(index.size, 1);
  const [source] = selectSources(index, new Set(), { model: 'Azera', brand: 'Hyundai' }, 10);
  assert.equal(source.url, 'https://paint.test/Hyundai/Azera');
});

test('unresolved Google links report a search warning while keeping usable peers', async () => {
  const [result] = await browse(['query'], { host: 'localhost:7000', request: async input => {
    if (new URL(input).hostname === 'localhost') return envelope([
      { title: 'Wrapped', url: 'https://www.google.com/goto?url=bad' },
      { title: 'Usable', url: 'https://paint.test/chart' },
    ]);
    return { status: 200, headers: new Headers(), body: { cancel: async () => {} } };
  } });
  assert.equal(result.warnings[0].details.code, 'SEARCH_UNRESOLVED_URLS');
  assert.equal(result.warnings[0].details.unresolvedResults, 1);
  assert.deepEqual(result.results.map(row => row.url), ['https://paint.test/chart']);
});

test('three engines run concurrently, merge sources and isolate Google blocks', async () => {
  const state = {}, started = [], delivered = [];
  const request = async input => {
    const engine = new URL(input).pathname.split('/')[1];
    started.push(engine);
    if (engine === 'google') return { ok: false, status: 403, json: async () => ({ error: 'blocked' }) };
    return envelope([{ title: 'Hyper White', url: 'https://paint.test/chart' },
      { title: engine, url: `https://${engine}.test/chart` }]);
  };
  const [result] = await search(['paint query'], { host: 'localhost:7000', request, state,
    onResults: row => delivered.push(row), onEngineRequest: engine => assert.ok(['google', 'bing', 'duckduckgo'].includes(engine)) });
  assert.deepEqual(started, ['google', 'bing', 'duckduckgo']);
  assert.equal(result.error, undefined);
  assert.equal(result.results.length, 3);
  assert.deepEqual(result.results[0].engines, ['bing', 'duckduckgo']);
  assert.equal(result.warnings[0].details.engine, 'google');
  assert.equal(delivered.length, 3);
  started.length = 0;
  await search(['another query'], { host: 'localhost:7000', request, state });
  assert.deepEqual(started, ['bing', 'duckduckgo']);
});

test('Bing and DuckDuckGo redirect parameters unwrap without extra HTTP calls', () => {
  const target = 'https://paint.test/chart?a=1';
  assert.equal(destinationUrl(`https://www.bing.com/ck/a?u=a1${Buffer.from(target).toString('base64url')}`), target);
  assert.equal(destinationUrl(`https://duckduckgo.com/l/?uddg=${encodeURIComponent(target)}`), target);
});

test('redirect loops are bounded and opaque results never enter the source index', async () => {
  let calls = 0;
  await assert.rejects(resolveSearchUrl('/goto?url=loop', { request: async () => {
    calls++;
    return redirect('/goto?url=loop');
  } }), /did not resolve/);
  assert.equal(calls, 1);
  const index = new Map();
  indexResults([{ query: 'paint', results: [{ url: 'https://www.google.com/goto?url=opaque' }] }], index);
  assert.equal(index.size, 0);
});

test('unresolved navigation pages and Google consent redirects never reach extraction or reader fallback', async () => {
  let calls = 0;
  const [wrapped] = await fetchPages(['https://www.google.com.br/goto?url=opaque'], {
    request: async () => { calls++; throw new Error('Unexpected fetch'); },
  });
  assert.equal(calls, 0);
  assert.equal(wrapped.status, 'error');
  const [consent] = await fetchPages(['https://paint.test/chart'], { request: async () => {
    calls++;
    return { ok: true, url: 'https://consent.google.com/m', body: { cancel: async () => {} } };
  } });
  assert.equal(calls, 1);
  assert.equal(consent.status, 'error');
  assert.equal(consent.text, '');
});
