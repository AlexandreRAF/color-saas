'use strict';

const { awaitWithSignal } = require('./model_stream');

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

function cancelBody(body) {
  // Broken transports must not hold cleanup past the page deadline.
  try { Promise.resolve(body?.cancel()).catch(() => {}); } catch { /* Already closed. */ }
}

async function pageBytes(response, signal, maximum = DEFAULT_MAX_BYTES) {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Page response limit must be a positive byte count');
  const oversized = () => Object.assign(new Error(`Page response exceeds ${maximum} bytes`), { code: 'PAGE_TOO_LARGE' });
  const length = Number(response.headers?.get?.('content-length'));
  if (length > maximum) { cancelBody(response.body); throw oversized(); }

  // Injected test/adaptor responses may expose only the standard convenience
  // methods. Real fetch bodies are streamed and bounded before concatenation.
  if (!response.body?.getReader) {
    const bytes = await awaitWithSignal(async () => response.arrayBuffer
      ? new Uint8Array(await response.arrayBuffer()) : new TextEncoder().encode(await response.text()), signal);
    if (bytes.byteLength > maximum) throw oversized();
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await awaitWithSignal(() => reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw oversized();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Already closed. */ }
  }
}

module.exports = { pageBytes, cancelBody, DEFAULT_MAX_BYTES };
