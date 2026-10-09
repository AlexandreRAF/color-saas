// Google result links can contain either a destination URL or an opaque token.
// Tokens require an HTTP redirect; never invent a URL from a display breadcrumb.
function googleNavigation(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const google = /^(?:(?:www|consent|accounts)\.)?google\.(?:com|cat|[a-z]{2}|(?:com|co)\.[a-z]{2})$/.test(host);
    const ads = /^(?:www\.)?googleadservices\.com$/.test(host);

    return (google && (/^\/(?:goto|url|aclk|pagead\/aclk|search|sorry)(?:\/|$)/i.test(url.pathname)
      || /^(?:consent|accounts)\./.test(host)))
      || (ads && /^\/pagead\/aclk\/?$/i.test(url.pathname));
  } catch { return false; }
}

function searchNavigation(value) {
  if (googleNavigation(value)) return true;

  try {
    const url = new URL(value);
    return (/^(?:www\.)?bing\.com$/.test(url.hostname) && /^\/(?:ck\/a|aclick|search)(?:\/|$)/.test(url.pathname))
      || (/^(?:(?:www|links|duckduckgo)\.)?duckduckgo\.com$/.test(url.hostname) && /^\/l\/?$/.test(url.pathname));
  } catch { return false; }
}

function destinationUrl(value) {
  try {
    const seen = new Set();
    let url = new URL(value, 'https://www.google.com');

    if (!/^https?:\/\//i.test(value) && !/^\/(?:goto|url)\?/.test(value)) return null;

    for (let step = 0; step < 5; step++) {
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      if (!searchNavigation(url.href)) return url.href;
      if (seen.has(url.href)) return null;

      seen.add(url.href);

      const bing = /^(?:www\.)?bing\.com$/.test(url.hostname) ? url.searchParams.get('u') : null;
      const decodedBing = bing?.startsWith('a1') ? Buffer.from(bing.slice(2), 'base64url').toString('utf8') : bing;
      const target = [...['url', 'q', 'adurl', 'uddg'].map(key => url.searchParams.get(key)), decodedBing]
        .find(value => /^https?:\/\//i.test(value || ''));

      if (!target) return null;

      url = new URL(target);
    }
  } catch { /* Invalid result link. */ }

  return null;
}

async function resolveSearchUrl(value, { request = fetch, signal } = {}) {
  const direct = destinationUrl(value);

  if (direct) return direct;

  let url = new URL(value, 'https://www.google.com').href;

  if (!searchNavigation(url)) throw new Error('Invalid search result URL');

  const timeout = AbortSignal.timeout(2000);
  const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const seen = new Set();

  for (let step = 0; step < 4 && !seen.has(url); step++) {
    seen.add(url);

    const response = await request(url, { method: 'GET', redirect: 'manual', signal: bounded });
    const location = response.headers.get('location');

    // Inspect redirect headers only, never download a target page in the search adapter.
    await response.body?.cancel();

    if (response.status < 300 || response.status >= 400 || !location) break;

    url = new URL(location, url).href;

    const target = destinationUrl(url);

    if (target) return target;
    if (!searchNavigation(url)) break;
  }

  throw new Error('Search result did not resolve to a source URL');
}

module.exports = { googleNavigation, searchNavigation, destinationUrl, resolveSearchUrl };
