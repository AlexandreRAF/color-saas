function sourceUrl(value) {
  try {
    const url = new URL(value);

    url.hash = '';

    for (const key of [...url.searchParams.keys()]) {
      // Search highlights change presentation, not the catalog identity. The
      // canonical page is also less likely to time out behind a highlight URL.
      if (/^utm_/i.test(key) || ['gclid', 'fbclid', 'msclkid', 'srsltid', 'highlight'].includes(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }

    url.searchParams.sort();

    return url.href;
  } catch {
    return value;
  }
}

module.exports = { sourceUrl };
