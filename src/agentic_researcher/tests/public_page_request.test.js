const test = require('node:test');
const assert = require('node:assert/strict');

const { publicAddress, publicPageUrl, publicLookup, publicPageRequest } = require('../public_page_request');
const { fetchPages } = require('../fetch_pages');

test('page destinations reject local networks, encoded IPs, credentials and non-HTTP schemes', () => {
  for (const url of ['http://localhost/', 'https://a.localhost/', 'http://printer.local/', 'http://metadata/',
    'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://10.0.0.1/', 'http://172.16.0.1/',
    'http://192.168.1.2/', 'http://169.254.169.254/', 'http://100.64.1.1/', 'http://[::1]/',
    'http://[::ffff:127.0.0.1]/', 'http://[fc00::1]/', 'http://[fe80::1]/',
    'https://user:password@example.com/', 'file:///etc/passwd', 'http://224.0.0.1/']) {
    assert.throws(() => publicPageUrl(url), { code: 'PAGE_DESTINATION_BLOCKED' }, url);
  }
  assert.equal(publicPageUrl('https://example.com/chart').hostname, 'example.com');
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
});

test('socket lookup rejects mixed public/private answers and returns the validated addresses directly', async () => {
  const lookup = rows => publicLookup((_hostname, options, callback) => {
    assert.equal(options.all, true);
    callback(null, rows);
  });
  await assert.rejects(new Promise((resolve, reject) => lookup([
    { address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 },
  ])('example.com', { all: true }, (error, rows) => error ? reject(error) : resolve(rows))),
  { code: 'PAGE_DESTINATION_BLOCKED' });
  const rows = [{ address: '8.8.8.8', family: 4 }];
  assert.deepEqual(await new Promise((resolve, reject) => lookup(rows)('example.com', { all: true },
    (error, result) => error ? reject(error) : resolve(result))), rows);
  assert.deepEqual(await new Promise((resolve, reject) => lookup(rows)('example.com', 4,
    (error, address, family) => error ? reject(error) : resolve({ address, family }))), rows[0]);
});

test('each redirect is validated before any request can reach a private destination', async () => {
  let calls = 0;
  await assert.rejects(publicPageRequest('https://example.com/', {}, async (_url, options) => {
    calls++;
    assert.equal(options.redirect, 'manual');
    return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/' } });
  }), { code: 'PAGE_DESTINATION_BLOCKED' });
  assert.equal(calls, 1);
});

test('normal relative redirects preserve the public source, and loops remain bounded', async () => {
  const visited = [];
  const response = await publicPageRequest('https://example.com/', {}, async url => {
    visited.push(String(url));
    return visited.length === 1 ? new Response('', { status: 301, headers: { location: '/chart' } }) : new Response('Paint');
  });
  assert.deepEqual(visited, ['https://example.com/', 'https://example.com/chart']);
  assert.equal(await response.text(), 'Paint');
  let calls = 0;
  await assert.rejects(publicPageRequest('https://example.com/', {}, async () => {
    calls++;
    return new Response('', { status: 302, headers: { location: '/' } });
  }), { code: 'PAGE_REDIRECT_LIMIT' });
  assert.equal(calls, 6);
});

test('a blocked source is not retried or forwarded to the reader', async () => {
  const [page] = await fetchPages(['http://127.0.0.1/'], {
    directRetries: 2, request: async () => assert.fail('Blocked destination must never be fetched'),
  });
  assert.equal(page.errorCode, 'PAGE_DESTINATION_BLOCKED');
});
