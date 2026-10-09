const { modelScheduler } = require('./model_scheduler');
const { extractHtmlText, compactText } = require('./html_text');
const { PDFParse } = require('pdf-parse');
const { searchNavigation } = require('./search_urls');
const { publicPageRequest, publicPageUrl } = require('./public_page_request');
const { pageBytes, cancelBody, DEFAULT_MAX_BYTES } = require('./page_response');
const { awaitWithSignal } = require('./model_stream');

const { setTimeout: delay } = require('node:timers/promises');

const PAGE_FETCH_BUDGET_MS = 5000;

async function extractPdfText(bytes) {
  const parser = new PDFParse({ data: bytes });

  try {
    const result = await parser.getText();

    // An image-only scan has no extractable text layer.
    return compactText((result.text || '')
      .split(/\r?\n/)
      .filter((line) => !/^--\s*\d+\s+of\s+\d+\s*--$/.test(line.trim()))
      .join('\n')
      .trim());
  } finally {
    await parser.destroy();
  }
}

function decodeHtml(bytes, contentType) {
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1] || 'utf-8';

  try {
    return new TextDecoder(charset).decode(bytes);
  } catch (error) {
    if (error instanceof RangeError) return new TextDecoder().decode(bytes);
    throw error;
  }
}

function isTransientNetworkError(error) {
  const cause = error?.cause || error;

  return ['TimeoutError', 'AbortError'].includes(error?.name) || ['TimeoutError', 'AbortError'].includes(cause?.name)
    || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNREFUSED']
      .includes(cause?.code)
    || /fetch failed|network error/i.test(error?.message || '');
}

function networkErrorText(error) {
  const cause = error?.cause || error;
  const code = cause?.code ? ` (${cause.code})` : '';
  return `${error?.message || String(error)}${code}`;
}

async function fetchPageTextDirect(url, { request = publicPageRequest, parsePdf = extractPdfText,
  timeoutMs = PAGE_FETCH_BUDGET_MS, signal, maxResponseBytes = DEFAULT_MAX_BYTES } = {}) {
  signal?.throwIfAborted();
  publicPageUrl(url);
  const attemptSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

  let response;

  try {
    response = await awaitWithSignal(() => request(url, {
      signal: attemptSignal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/pdf,text/plain;q=0.9,*/*;q=0.1',
      },
    }), attemptSignal);
  } catch (error) {
    if (error.code === 'PAGE_DESTINATION_BLOCKED' || error.cause?.code === 'PAGE_DESTINATION_BLOCKED') {
      throw Object.assign(new Error('Source page resolved to a blocked destination', { cause: error }),
        { code: 'PAGE_DESTINATION_BLOCKED' });
    }
    throw new Error(`Page request failed for ${url}: ${networkErrorText(error)}`, { cause: error });
  }

  if (!response.ok) {
    cancelBody(response.body);
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }

  if (response.url && searchNavigation(response.url)) {
    cancelBody(response.body);
    throw Object.assign(new Error('Page redirected to search, consent or a redirect interstitial'),
      { code: 'PAGE_INTERSTITIAL' });
  }

  const contentType = response.headers.get('content-type') || '';
  let bytes;

  try {
    bytes = await pageBytes(response, attemptSignal, maxResponseBytes);
  } catch (error) {
    if (error.code === 'PAGE_TOO_LARGE') throw error;
    throw new Error(`Page response body failed for ${url}: ${networkErrorText(error)}`, { cause: error });
  }

  const pdfHeader = new TextDecoder('ascii').decode(bytes.subarray(0, 5)) === '%PDF-';

  if (pdfHeader || /application\/pdf/i.test(contentType)) {
    return awaitWithSignal(() => parsePdf(bytes), attemptSignal);
  }

  if (/^(image|video|audio)\//i.test(contentType)) return '';
  if (contentType && !/(html|text\/plain|application\/octet-stream)/i.test(contentType)) return '';

  if (!/(html|text\/plain)/i.test(contentType)) {
    const opening = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart();
    if (!/^<(?:!doctype\s+html|html|head|body)\b/i.test(opening)) return '';
  }

  return extractHtmlText(decodeHtml(bytes, contentType), url);
}

function readerUrl(base, url) {
  return `${base.replace(/\/+$/, '')}/${url}`;
}

async function fetchReaderText(url, { request, timeoutMs, readerProxyBase, signal, scheduler = modelScheduler,
  prefetch = false, maxResponseBytes = DEFAULT_MAX_BYTES }) {
  signal?.throwIfAborted();
  const ticket = await scheduler.acquire({ choices: [{ model: 'network:reader' }],
    tokens: 1, kind: prefetch ? 'prefetch' : 'fetch', signal });
  let response, started = false;
  try {
    signal?.throwIfAborted();
    started = true;
    const attemptSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    response = await awaitWithSignal(() => request(readerUrl(readerProxyBase, url), {
      signal: attemptSignal,
      headers: { Accept: 'text/plain,text/markdown;q=0.9,*/*;q=0.1' },
    }), attemptSignal);

    if (!response.ok) {
      cancelBody(response.body);
      throw new Error(`Reader fallback failed: HTTP ${response.status}`);
    }

    const text = new TextDecoder().decode(await pageBytes(response, attemptSignal, maxResponseBytes)).trim();
    // Reader services can answer HTTP 200 while their body says the target
    // returned 429/403/5xx. Such text is an error, not a fetched source.
    const targetStatus = /(?:^|\n)Warning:\s*Target URL returned error\s*:?[ \t]*([45]\d\d)\b/im.exec(text)?.[1]
      || /(?:^|\n)Title:\s*([45]\d\d)\s+(?:Too Many Requests|Forbidden|Not Found|Service Unavailable|Bad Gateway|Internal Server Error)\b/im.exec(text)?.[1];

    if (targetStatus) throw Object.assign(new Error(`Reader target returned HTTP ${targetStatus}`),
      { code: `PAGE_SOURCE_HTTP_${targetStatus}` });

    return text;
  } finally {
    if (started) ticket.complete(response);
    else ticket.cancel();
  }
}

async function fetchPageTextWithMethod(url, options = {}) {
  options.signal?.throwIfAborted();

  // Direct fetch, retries, response bodies and reader fallback share one budget.
  // A retry must not receive a fresh full page budget near the research deadline.
  const totalTimeoutMs = options.totalTimeoutMs ?? PAGE_FETCH_BUDGET_MS;
  const budget = AbortSignal.timeout(Math.max(1, Math.ceil(totalTimeoutMs)));
  const signal = options.signal ? AbortSignal.any([options.signal, budget]) : budget;

  try {
    return await fetchPageAttempts(url, { ...options, signal });
  } catch (error) {
    options.signal?.throwIfAborted();
    if (budget.aborted) throw Object.assign(new Error(`Page fetch exceeded its ${Math.ceil(totalTimeoutMs)} ms budget`,
      { cause: error }), { code: 'PAGE_TIMEOUT' });
    throw error;
  }
}

async function fetchPageAttempts(url, options = {}) {
  publicPageUrl(url);
  if (searchNavigation(url)) throw new Error('Unresolved search navigation URL cannot be used as a source page');

  const { request = publicPageRequest, timeoutMs = PAGE_FETCH_BUDGET_MS, signal, directRetries = 0,
    readerProxyBase = process.env.PAGE_TEXT_READER_URL || 'https://r.jina.ai' } = options;
  let directError;

  for (let attempt = 0; attempt <= directRetries; attempt++) {
    signal?.throwIfAborted();

    try {
      const text = await fetchPageTextDirect(url, { ...options, request, timeoutMs });
      if (text && !isChallengePage(text)) return { text, method: 'direct' };
      break;
    } catch (error) {
      if (['PAGE_INTERSTITIAL', 'PAGE_DESTINATION_BLOCKED', 'PAGE_TOO_LARGE'].includes(error.code)) throw error;

      directError = error;

      const message = error instanceof Error ? error.message : String(error);
      const transient = isTransientNetworkError(error)
        || /HTTP (?:408|425|429|5\d\d)/i.test(message);

      if (attempt < directRetries && transient && !signal?.aborted) await delay(250, undefined, { signal });
      else break;
    }
  }

  signal?.throwIfAborted();

  try {
    const text = await fetchReaderText(url, { request, timeoutMs, readerProxyBase, signal,
      scheduler: options.scheduler, prefetch: options.prefetch, maxResponseBytes: options.maxResponseBytes });
    if (text && !isChallengePage(text)) return { text, method: 'reader_fallback' };
    if (text) throw Object.assign(new Error('Reader fallback returned an access challenge'),
      { code: 'PAGE_CHALLENGE' });
  } catch (error) {
    if (['PAGE_TOO_LARGE', 'PAGE_DESTINATION_BLOCKED'].includes(error.code)) throw error;
    const directMessage = directError instanceof Error ? directError.message
      : directError ? String(directError) : 'direct fetch returned no extractable text';
    const fallbackMessage = error instanceof Error ? error.message : String(error);
    throw Object.assign(new Error(`${directMessage}; ${fallbackMessage}`, { cause: error }),
      { code: error.code || 'PAGE_FETCH_FAILED' });
  }

  if (directError) throw directError;

  return { text: '', method: 'reader_fallback_empty' };
}

function isChallengePage(text) {
  return text.trim().length < 30 || (text.length < 3000
    && /access denied|verify (?:that )?you are human|just a moment|captcha|(?:403|429|5\d\d) (?:forbidden|error|too many requests|service unavailable)|target url returned error\s*:?[ \t]*[45]\d\d|request could not be satisfied|enable javascript and cookies|robot or human|checking your browser|client challenge|required part of this site|para continuar,?\s*acesse|log in to continue|sign in to continue/i.test(text));
}

async function fetchPages(urls, options = {}) {
  if (!Array.isArray(urls)) throw new Error('fetchPages expects an array of URLs');

  const { concurrency = 5 } = options;

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('concurrency must be a positive integer');
  }

  const pages = new Array(urls.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < urls.length) {
      const index = nextIndex++;
      const url = urls[index];
      const startedAt = performance.now();
      let fetchStarted = false;
      let ticket;

      try {
        options.signal?.throwIfAborted();
        options.onFetchState?.({ url, started: false });
        ticket = await (options.scheduler || modelScheduler).acquire({ choices: [{ model: 'network:fetch' }],
          tokens: 1, kind: options.prefetch ? 'prefetch' : 'fetch', scope: new URL(url).hostname.replace(/^www\./, ''),
          signal: options.signal, timing: options.timing, onWait: options.onWait });
        options.signal?.throwIfAborted();
        fetchStarted = true;
        options.onFetchState?.({ url, started: true });

        const { text, method } = await fetchPageTextWithMethod(url, options);

        pages[index] = { url, status: text ? 'ok' : 'no_text', text, error: null,
          retrievalMethod: method };
      } catch (error) {
        pages[index] = {
          url,
          status: options.signal?.aborted ? (fetchStarted ? 'cancelled' : 'skipped') : 'error',
          text: '',
          error: error instanceof Error ? error.message : String(error),
          errorCode: options.signal?.aborted
            ? options.signal.reason?.deadlineExceeded ? 'PAGE_DEADLINE' : 'PAGE_CANCELLED'
            : error.code || 'PAGE_FETCH_FAILED',
          fetchStarted,
        };
      } finally {
        if (fetchStarted) ticket?.complete();
        else ticket?.cancel();
        options.onPageComplete?.(performance.now() - startedAt);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));

  return pages;
}

module.exports = { fetchPages, fetchPageTextDirect, extractHtmlText, extractPdfText, PAGE_FETCH_BUDGET_MS };
