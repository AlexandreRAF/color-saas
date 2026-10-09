'use strict';

// PaintColourChart model archives expose a year selector. Its year page is a
// much better lead source than the full history when the vehicle year is known.
// Derive only a year visibly offered by the fetched archive, then fetch it as
// an ordinary page; a failed year page falls back to the original archive.
function catalogYearLink(page, vehicle) {
  const year = Number(vehicle.manufacturingYear);
  if (!Number.isInteger(year) || year < 1886 || year > 2100) return null;

  let url;
  try { url = new URL(page.url); } catch { return null; }
  if (!/(?:^|\.)paintcolourchart\.com$/i.test(url.hostname)
    || !/^\/cars\/\d+\/[a-z\d-]+\.html$/i.test(url.pathname)) return null;

  const selector = String(page.text || '').split(/or choose a year/i)[1];
  if (!selector || !new RegExp(`(?:^|\\n)\\s*${year}\\s*(?:\\n|$)`).test(selector.slice(0, 1200))) return null;

  url.pathname = url.pathname.replace(/\.html$/i, `/${year}.html`);
  return url.href;
}

module.exports = { catalogYearLink };
