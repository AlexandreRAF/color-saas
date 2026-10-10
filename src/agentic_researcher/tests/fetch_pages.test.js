const test = require('node:test');
const assert = require('node:assert/strict');
const { extractHtmlText, fetchPages } = require('../fetch_pages');

test('preserves color swatches, table rows, product variants and catalog continuation links', () => {
  const text = extractHtmlText(`<html><body><h1>Motorcycle paint chart</h1>
    <img alt="Shimmering Silver"><table><tr><th>2020–2022</th><td>Quicksilver</td></tr></table>
    <script type="application/ld+json">{"@type":"Product","name":"Fairing","color":"Azul Solar"}</script>
    <a rel="next" href="?page=2">Next</a><a href="/brochure.pdf">Paint brochure</a>
    <script>throw new Error('Never execute website code')</script></body></html>`, 'https://example.org/colors');
  assert.match(text, /Shimmering Silver/);
  assert.match(text, /2020–2022[\s\S]*Quicksilver/);
  assert.match(text, /Azul Solar/);
  assert.match(text, /Catalog continuation: https:\/\/example.org\/colors\?page=2/);
  assert.match(text, /Catalog continuation: https:\/\/example.org\/brochure.pdf/);
  assert.doesNotMatch(text, /Never execute/);
});

test('HTML extraction decodes entities and retains named paints in forms and navigation', () => {
  const text = extractHtmlText('<title>Paint &amp; Colors</title><body>'
    + '<nav><a>Paint colors</a><a>Branco Lunar</a><a>Ice White</a></nav>'
    + '<form><label>Color</label><select><option>Prata Switchblade</option></select></form>'
    + '<div class="cookie-consent">Accept cookies</div><style>.bad{}</style>'
    + '<p>White Pearl &amp; Silver</p></body>', 'https://example.org');
  for (const name of ['Paint & Colors', 'Branco Lunar', 'Ice White', 'Prata Switchblade', 'White Pearl & Silver']) {
    assert.ok(text.includes(name), name);
  }
  assert.doesNotMatch(text, /Accept cookies|\.bad/);
});

test('retries a blocked direct response through the reader and preserves peer success', async () => {
  const calls = [];
  const pages = await fetchPages(['https://a.test/paint', 'https://b.test/paint'], {
    request: async (url) => {
      calls.push(url);
      if (url.startsWith('https://r.jina.ai/')) {
        return { ok: true, text: async () => 'Factory color chart: Azul Solar for Model' };
      }
      const text = url.includes('a.test') ? '403 Forbidden' : 'Model color chart: Shimmering Silver';
      return { ok: true, headers: new Headers({ 'content-type': 'text/html' }),
        arrayBuffer: async () => new TextEncoder().encode(`<body>${text}</body>`).buffer };
    },
  });
  assert.ok(pages.every((page) => page.status === 'ok'));
  assert.equal(pages[0].retrievalMethod, 'reader_fallback');
  assert.equal(calls.length, 3);
});

test('reader 403 template does not count as a fetched paint page', async () => {
  const [page] = await fetchPages(['https://blocked.test/paint'], { request: async url => {
    const text = url.startsWith('https://r.jina.ai/')
      ? 'Title: The request could not be satisfied\nWarning: Target URL returned error 403: Forbidden\n## 403 ERROR'
      : '<body>403 Forbidden</body>';
    return { ok: true, headers: new Headers({ 'content-type': 'text/html' }),
      arrayBuffer: async () => new TextEncoder().encode(text).buffer };
  } });
  assert.notEqual(page.status, 'ok');
});

test('direct fetch and reader fallback share one total budget', async () => {
  let calls = 0;
  const [page] = await fetchPages(['https://slow.test/paint'], {
    timeoutMs: 60, totalTimeoutMs: 100,
    request: (_url, { signal }) => new Promise((resolve, reject) => {
      calls++;
      const timer = setTimeout(() => reject(new Error('Mock request ignored cancellation')), 1000);
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }),
  });
  assert.equal(calls, 2);
  assert.equal(page.status, 'error');
  assert.equal(page.errorCode, 'PAGE_TIMEOUT');
});

test('parent deadline cancels active fetches and skips queued URLs without retries', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new DOMException('Processing deadline exceeded', 'TimeoutError'), { deadlineExceeded: true });
  let calls = 0;
  const pages = await fetchPages(['https://active.test', 'https://queued.test'], {
    concurrency: 1, signal: controller.signal, directRetries: 2,
    request: async () => { calls++; controller.abort(reason); throw reason; },
  });
  assert.equal(calls, 1);
  assert.deepEqual(pages.map(page => [page.status, page.fetchStarted, page.errorCode]), [
    ['cancelled', true, 'PAGE_DEADLINE'], ['skipped', false, 'PAGE_DEADLINE'],
  ]);
});
