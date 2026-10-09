const { parse } = require('parse5');

const attribute = (node, name) => node.attrs?.find(attr => attr.name === name)?.value;
const nodeText = node => node.nodeName === '#text' ? node.value
  : (node.childNodes || []).map(nodeText).join('');

function descendants(node, tag) {
  const result = [];
  const pending = [...(node.childNodes || [])].reverse();
  while (pending.length) {
    const child = pending.pop();
    if (child.tagName && (!tag || child.tagName === tag)) result.push(child);
    for (let i = (child.childNodes?.length || 0) - 1; i >= 0; i--) pending.push(child.childNodes[i]);
  }
  return result;
}

const OMITTED_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS',
  'IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'EMBED',
]);

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DIV',
  'DL', 'DT', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION',
  'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL',
]);

const CHROME_TAGS = new Set(['NAV', 'FOOTER', 'FORM']);
const COLOR_CONTEXT = /\b(?:cor(?:es)?|color(?:s)?|paint(?:s)?|pintura(?:s)?|tinta(?:s)?|pumacor)\b|\b(?:18|19|20)\d{2}\b/i;

function skipChrome(node) {
  const tagName = node.tagName.toUpperCase();
  const classAndId = `${attribute(node, 'class') || ''} ${attribute(node, 'id') || ''}`;
  const obviousChrome = /cookie|consent|social[-_ ]?share|share[-_ ]?buttons|breadcrumb/i.test(classAndId);

  if (!CHROME_TAGS.has(tagName) && !obviousChrome
    && attribute(node, 'role') !== 'navigation') return false;

  const text = nodeText(node);

  // Adjacent label/option text can concatenate as "ColorPrata" in the tree.
  // Keep labelled paint selectors even when that hides the word boundary.
  if (tagName === 'FORM' && descendants(node, 'label').some(label => COLOR_CONTEXT.test(nodeText(label)))) return false;

  if (obviousChrome && !COLOR_CONTEXT.test(text)) return true;

  // Navigation and footer lists can contain useful paint names; keep those lists
  // whenever they mention paint context, a model year, or several linked entries.
  if (COLOR_CONTEXT.test(text) || descendants(node, 'a').length >= 3) return false;

  return true;
}

function compactText(text) {
  const seen = new Set();

  return text.split(/\n\s*\n/).map((block) => block
    .split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n'))
    .filter((block) => {
      if (!block) return false;

      const key = block.replace(/\s+/g, ' ').toLocaleLowerCase();

      if (key.length < 100) return true;
      if (seen.has(key)) return false;

      seen.add(key);

      return true;
    }).join('\n\n');
}

function extractHtmlText(html, url) {
  // Use the same HTML parser as jsdom without building a browser environment.
  // Text, swatches, structured product data and continuation rules stay intact.
  const withoutStyles = html.replace(/<style\b[^>]*>[\s\S]*?(?:<\/style\s*>|$)/gi, '');
  const document = parse(withoutStyles, { scriptingEnabled: false });
  const elements = descendants(document);
  const parts = [];

  function visit(node) {
    if (node.nodeName === '#text') {
      const value = node.value.replace(/\s+/g, ' ').trim();
      if (value) parts.push(value, ' ');
      return;
    }

    if (!node.tagName) return;

    const tagName = node.tagName.toUpperCase();

    if (tagName === 'IMG' && attribute(node, 'alt')?.trim()) {
      parts.push('\n', attribute(node, 'alt'), '\n');
    }

    if (OMITTED_TAGS.has(tagName) || skipChrome(node)) return;

    const isBlock = BLOCK_TAGS.has(tagName);

    if (isBlock) parts.push('\n');

    for (const child of node.childNodes) visit(child);

    if (isBlock) parts.push('\n');
  }

  const title = elements.find(node => node.tagName === 'title');
  const body = elements.find(node => node.tagName === 'body');
  if (title) parts.push(nodeText(title), '\n');
  if (body) visit(body);

  // Product variants often publish their paint name only in structured metadata.
  function productText(value) {
    if (Array.isArray(value)) return value.forEach(productText);
    if (!value || typeof value !== 'object') return;

    const types = [].concat(value['@type'] || []);

    if (types.some((type) => /Product|ProductGroup|Vehicle|Car|Motorcycle/i.test(type))) {
      for (const key of ['name', 'color', 'description', 'model']) {
        if (typeof value[key] === 'string') parts.push('\n', value[key], '\n');
      }
    }

    for (const child of Object.values(value)) if (typeof child === 'object') productText(child);
  }

  for (const script of elements.filter(node => node.tagName === 'script' && attribute(node, 'type') === 'application/ld+json')) {
    try { productText(JSON.parse(nodeText(script))); } catch { /* Malformed site metadata. */ }
  }

  const continuations = new Set();

  for (const anchor of elements.filter(node => node.tagName === 'a' && attribute(node, 'href') !== undefined)) {
    try {
      const link = new URL(attribute(anchor, 'href'), url);
      const label = nodeText(anchor).trim();
      const next = attribute(anchor, 'rel') === 'next' || /^(next|pr[oó]xim[oa]|seguinte|suivant|weiter)\b/i.test(label);
      const numbered = /^\d{1,2}$/.test(label) && /[?&](page|p)=\d+/i.test(link.href);
      const documentLink = /\.pdf(?:\?|$)/i.test(link.href) && /paint|colou?r|cores|brochure|cat[aá]log/i.test(label);

      if (['http:', 'https:'].includes(link.protocol) && (next || numbered || documentLink)) {
        continuations.add(link.href);
      }
    } catch { /* Invalid site link. */ }
  }

  for (const link of continuations) parts.push('\nCatalog continuation: ', link, '\n');

  return compactText(parts.join('').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim());
}

module.exports = { extractHtmlText, compactText };
