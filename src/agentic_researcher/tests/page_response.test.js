const test = require('node:test');
const assert = require('node:assert/strict');

const { pageBytes } = require('../page_response');
const { fetchPages } = require('../fetch_pages');

test('response limits check both declared length and actual streamed bytes', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(pageBytes(new Response('small', { headers: { 'content-length': '200' } }), signal, 100),
    { code: 'PAGE_TOO_LARGE' });
  await assert.rejects(pageBytes(new Response('x'.repeat(101)), signal, 100), { code: 'PAGE_TOO_LARGE' });
  assert.equal(new TextDecoder().decode(await pageBytes(new Response('á Paint'), signal, 100)), 'á Paint');
});

test('oversized sources fail explicitly without truncating evidence or retrying through a reader', async () => {
  let calls = 0;
  const [page] = await fetchPages(['https://example.com/colors'], {
    maxResponseBytes: 100, request: async () => {
      calls++;
      return new Response('x'.repeat(101), { headers: { 'content-type': 'text/html' } });
    },
  });
  assert.equal(page.errorCode, 'PAGE_TOO_LARGE');
  assert.equal(page.text, '');
  assert.equal(calls, 1);
});

for (const phase of ['request', 'body', 'reader']) {
  test(`page ${phase} ignoring cancellation cannot hold the run past its deadline`, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Caller deadline')), 50);
    const stuck = () => new Promise(() => {});
    try {
      const [page] = await fetchPages(['https://example.com/colors'], {
        signal: controller.signal,
        request: async url => {
          if (phase === 'request') return stuck();
          if (phase === 'reader' && url.startsWith('https://r.jina.ai/')) return { ok: true, text: stuck };
          return { ok: true, headers: new Headers({ 'content-type': 'text/html' }),
            arrayBuffer: phase === 'body' ? stuck : async () => new TextEncoder().encode('403 Forbidden').buffer };
        },
      });
      assert.equal(page.status, 'cancelled');
      assert.equal(page.error, 'Caller deadline');
    } finally { clearTimeout(timer); }
  });
}
