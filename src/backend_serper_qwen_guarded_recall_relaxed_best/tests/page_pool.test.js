const test = require('node:test');
const assert = require('node:assert/strict');
const { PagePool } = require('../page_pool');

test('a demanded page retries one transient fetch failure and shares that retry', async () => {
  let calls = 0;
  const pool = new PagePool({ fetchPages: async () => {
    calls++;
    return [calls === 1
      ? { status: 'error', text: '', error: 'timed out', errorCode: 'PAGE_TIMEOUT' }
      : { status: 'ok', text: 'Published paint chart' }];
  }, concurrency: 2, prefetchConcurrency: 0 });

  const [first, second] = await Promise.all([
    pool.get('https://paint.test/model'),
    pool.get('https://paint.test/model'),
  ]);

  assert.equal(first.status, 'ok');
  assert.equal(second.status, 'ok');
  assert.equal(calls, 2);
  assert.equal(pool.stats.retries, 1);
  assert.deepEqual(pool.records.map(record => record.status), ['error', 'ok']);
  await pool.drain();
});

test('a permanent fetch failure keeps its final error without a retry loop', async () => {
  let calls = 0;
  const pool = new PagePool({ fetchPages: async () => {
    calls++;
    return [{ status: 'error', text: '', error: 'HTTP 404', errorCode: 'HTTP_404' }];
  }, prefetchConcurrency: 0 });

  const page = await pool.get('https://paint.test/missing');
  assert.equal(page.status, 'error');
  assert.equal(calls, 1);
  await pool.drain();
});
