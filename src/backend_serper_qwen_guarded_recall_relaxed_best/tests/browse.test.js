const test = require('node:test');
const assert = require('node:assert/strict');
const { browse, searchLocale } = require('../browse');

test('one failed query does not erase successful searches in the same batch', async () => {
  const results = await browse(['factory brochure', 'parts catalogue'], { apiKey: 'test', request: async (url, options) => {
    const { q } = JSON.parse(options.body);
    return q === 'parts catalogue'
      ? { ok: false, status: 403, json: async () => ({ error: { message: 'Denied' } }) }
      : { ok: true, json: async () => ({ organic: [{ link: 'https://factory.test/brochure', title: 'Brochure' }] }) };
  } });
  assert.equal(results[0].results.length, 1);
  assert.equal(results[1].errorDetails.httpStatus, 403);
  assert.equal(results[1].errorDetails.code, 'SEARCH_AUTH_FAILED');
  assert.deepEqual(results[1].results, []);
});

test('unknown markets are preserved instead of silently changed to Brazil', () => {
  assert.deepEqual(searchLocale('Unresolved market'), { location: 'Unresolved market' });
  assert.deepEqual(searchLocale(null), {});
});

test('Serper reports retries without changing the successful result', async () => {
  const events = [];
  let attempts = 0;
  const results = await browse(['paint catalogue'], {
    apiKey: 'test', onEvent: (event, detail) => events.push({ event, ...detail }),
    request: async () => {
      if (++attempts === 1) throw new TypeError('Temporary connection failure');
      return { ok: true, json: async () => ({ organic: [{ link: 'https://paint.test/catalogue' }] }) };
    },
  });
  assert.equal(attempts, 2);
  assert.equal(results[0].results.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'search_engine_retry');
  assert.equal(events[0].engine, 'serper');
  assert.equal(events[0].attempt, 1);
});

test('Serper publishes a completed query while another query is still pending', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const delivered = [];
  const result = await browse(['fast', 'slow'], {
    apiKey: 'test',
    onResults: row => { delivered.push(row.query); if (row.query === 'fast') release(); },
    request: async (_url, options) => {
      if (JSON.parse(options.body).q === 'slow') await blocked;
      return { ok: true, json: async () => ({ organic: [] }) };
    },
  });
  assert.equal(result.length, 2);
  assert.deepEqual(delivered, ['fast', 'slow']);
});
