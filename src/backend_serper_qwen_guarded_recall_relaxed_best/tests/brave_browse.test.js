const test = require('node:test');
const assert = require('node:assert/strict');
const { browse, searchLocale } = require('../brave_browse');
const { browse: search, searchProvider } = require('../search_provider');

test('Brave preserves queries, Brazilian localization, URLs and snippets', async () => {
  const query = 'Hyundai Azera Ice White & catálogo';
  const result = await browse([query], { apiKey: 'test', country: 'Brazil', request: async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin + url.pathname, 'https://api.search.brave.com/res/v1/web/search');
    assert.equal(url.searchParams.get('q'), query);
    assert.equal(url.searchParams.get('country'), 'BR');
    assert.equal(url.searchParams.get('search_lang'), 'pt-br');
    assert.equal(url.searchParams.get('count'), '10');
    assert.equal(url.searchParams.get('spellcheck'), 'false');
    assert.equal(options.headers['X-Subscription-Token'], 'test');
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    return { ok: true, json: async () => ({ web: { results: [
      { url: 'https://factory.test/chart', title: 'Cores', description: 'Ice White', page_age: '2017-01-01' }, null,
    ] } }) };
  } });
  assert.deepEqual(result, [{ query, results: [{ url: 'https://factory.test/chart', title: 'Cores',
    snippet: 'Ice White', date: '2017-01-01' }] }]);
});

test('global searches do not silently default to the US', async () => {
  assert.deepEqual(searchLocale(null), { country: 'ALL' });
  assert.deepEqual(searchLocale('unresolved market'), { country: 'ALL' });
  assert.deepEqual(searchLocale('Portugal'), { country: 'PT', search_lang: 'pt-pt' });
  await browse(['paint chart'], { apiKey: 'test', country: 'Brazil', international: true,
    request: async input => {
      const url = new URL(input);
      assert.equal(url.searchParams.get('country'), 'ALL');
      assert.equal(url.searchParams.get('search_lang'), null);
      return { ok: true, json: async () => ({ type: 'search', query: { original: 'paint chart' } }) };
    },
  });
});

test('Brave quota errors stop queued work and identify Brave without retries', async () => {
  let calls = 0;
  const results = await browse(['one', 'two'], { apiKey: 'test', concurrency: 1, request: async () => {
    calls++;
    return { ok: false, status: 429, json: async () => ({ error: { code: 'QUOTA_LIMITED', detail: 'Quota exhausted' } }) };
  } });
  assert.equal(calls, 1);
  assert.equal(results[0].errorDetails.code, 'SEARCH_CREDITS_EXHAUSTED');
  assert.equal(results[0].errorDetails.provider, 'brave');
  assert.match(results[0].error, /BRAVE_API_KEY/);
  assert.equal(results[1].skipped, true);
});

test('Brave missing credentials fail before HTTP and cancellation stays intact', async () => {
  await assert.rejects(browse(['query'], { apiKey: '' }), error =>
    error.details.provider === 'brave' && error.details.code === 'SEARCH_AUTH_FAILED');
  const controller = new AbortController();
  const reason = new Error('Caller cancelled');
  controller.abort(reason);
  await assert.rejects(browse(['query'], { apiKey: 'test', signal: controller.signal }), error => error === reason);
});

test('provider selection supports Brave and switching back to Serper', async () => {
  assert.equal(searchProvider('BRAVE'), 'brave');
  assert.throws(() => searchProvider('unknown'), /SEARCH_PROVIDER/);
  for (const provider of ['brave', 'serper']) {
    const results = await search(['query'], { provider, apiKey: 'test', request: async input => {
      assert.equal(new URL(input).hostname, provider === 'brave' ? 'api.search.brave.com' : 'google.serper.dev');
      return { ok: true, json: async () => provider === 'brave' ? { web: { results: [] } } : { organic: [] } };
    } });
    assert.equal(results[0].error, undefined);
  }
});
