const { sourceCodes, printedNameKey } = require('./paint_evidence');
const { hueFamilies } = require('./hue_review');
const { finishSearchTerms } = require('./paint_finish');
const { paintSearch } = require('./search_groups');
const { paintIdentityKey, completePaintName, isGenericPaintName } = require('./paint_name');
const { catalogFinishRelation } = require('./lazzumix_finish');

// Localization needs an actual catalog label, identical complete vocabulary
// (only the existing hue translation map), same maker and a common matched OEM
// code. Never synthesize a translation or bridge versions by code alone.
function catalogPortugueseName(color, rows, sameMaker) {
  if (hasPortugueseName(color.name) || !color.code_candidates?.length) return null;
  const tokens = value => new Set(String(value || '').toUpperCase().split(/[,/;]/).map(code => code.trim()).filter(Boolean));
  const selected = color.code_candidates;
  const sharedCodes = [...tokens(selected[0].universal_code)]
    .filter(code => selected.every(row => tokens(row.universal_code).has(code)));
  if (!sharedCodes.length) return null;
  const key = paintIdentityKey(color.name);
  const matches = rows.filter(row => row.catalog === 'lazzumix' && Number.isInteger(row.candidate_id)
    && hasPortugueseName(row.description) && paintIdentityKey(row.description) === key
    && selected.every(chosen => sameMaker(row.manufacturer, chosen.manufacturer))
    && sharedCodes.some(code => tokens(row.universal_code).has(code))
    && !['sólido', 'fosco', 'acetinado', 'brilhante'].some(finish => {
      const local = catalogFinishRelation(row.description, finish);
      return selected.some(chosen => [local, catalogFinishRelation(chosen.description, finish)]
        .includes('compatible') && [local, catalogFinishRelation(chosen.description, finish)].includes('incompatible'));
    }));
  const names = [...new Set(matches.map(row => completePaintName(row.description)))];
  if (names.length !== 1) return null;
  const row = matches[0];
  return { name: names[0], catalog: 'lazzumix', recordId: row.candidate_id,
    evidence: { catalog: row.catalog, description: row.description, manufacturer: row.manufacturer,
      universal_code: row.universal_code, year: row.year } };
}

// Detect published Portuguese hue words, never manufacture a translated name.
function hasPortugueseName(name) {
  return /\b(?:amarel[oa]|azul|bege|branc[oa]|cinza|dourad[oa]|laranja|marrom|ouro|prata|pret[oa]|rosa|rox[oa]|verde|vermelh[oa])\b/i.test(name);
}

// A fetched paint row can print both names side by side, or a product page
// can state an explicit market alias. Both require paint-owned code evidence;
// a shared code by itself never establishes translated identity.
function webPortugueseName(color, pages, vehicle) {
  if (hasPortugueseName(color.name) || color._catalogName || color.code_candidates?.length > 1) return null;

  const code = String(color.code_candidates?.[0]?.universal_code || '').trim().toUpperCase();
  if (code && !/^[A-Z0-9]{2,8}$/.test(code)) return null;

  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const codePattern = code ? new RegExp(`\\b${escape(code)}\\b`, 'iu') : null;
  const namePattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escape(color.name)}(?=$|[^\\p{L}\\p{N}])`, 'iu');
  const makerPattern = new RegExp(`\\b${escape(String(vehicle.brand || ''))}\\b`, 'iu');
  const localHue = /^(?:amarel[oa]|azul|bege|branc[oa]|cinza|dourad[oa]|laranja|marrom|ouro|prata|pret[oa]|rosa|rox[oa]|verde|vermelh[oa])\s+/iu;
  const matches = new Map();

  const add = (name, page, passage, printedCode) => {
    if (!localHue.test(name) || isGenericPaintName(name)
      || name.split(/\s+/u).length > 5 || /\b(?:set|kit|tinta|paint|coat|ml)\b/iu.test(name)) return;

    const key = printedNameKey(name);
    if (!key) return;

    const entry = matches.get(key) || { name, sources: [] };
    if (!entry.sources.some(source => source.url === page.url)) {
      entry.sources.push({ url: page.url, passage, code: printedCode });
    }
    matches.set(key, entry);
  };

  for (const page of pages) {
    if (page.status !== 'ok' || !page.text || !/^https?:/.test(page.url || '')
      || !makerPattern.test(`${page.title || ''} ${page.url} ${page.text.slice(0, 400)}`)
      || !namePattern.test(page.text) || codePattern && !codePattern.test(page.text)) continue;

    if (codePattern) {
      for (const line of page.text.split(/\r?\n/)) {
        if (line.length > 350 || !codePattern.test(line) || !namePattern.test(line)
          || !/(?:paint|colou?r|touch.?up|tinta|cor|lack|verniz)/iu.test(`${line} ${page.title || ''}`)) continue;

        const parts = line.split(/\s*[|/]\s*/u);
        if (parts.length < 2) continue;
        const ownPart = parts.findIndex(part => namePattern.test(part) && codePattern.test(part));
        if (ownPart < 0) continue;

        for (const [index, part] of parts.entries()) {
          if (index === ownPart) continue;
          const printed = part.replace(/^(?:cor|color|colour|paint)\s*[:#-]?\s*/iu, '')
            .split(/[,;+(]/u, 1)[0].trim();
          const name = completePaintName(printed);
          add(name, page, line.trim(), code);
        }
      }
    }

    // A product page may state the foreign name, its OEM code and a market
    // alias in separate short lines. The alias sentence must explicitly join
    // both complete names; a shared code elsewhere cannot establish identity.
    const lines = `${page.title || ''}\n${page.text}`.split(/\r?\n/);
    const namedCodeRows = lines.flatMap((line, index) => {
      if (line.length > 250 || !namePattern.test(line)) return [];

      const nearby = lines.slice(index, index + 3).join(' ').slice(0, 250);
      return [...nearby.matchAll(/\b(?:paint|colou?r|tinta|cor)\s*(?:code|c[oó]digo)\s*[:#-]?\s*([A-Z0-9]{2,8})\b/giu)]
        .map(match => match[1].toUpperCase());
    });
    const printedCodes = [...new Set(namedCodeRows.filter(value => /\d/u.test(value)))];
    if (printedCodes.length === 1 && (!code || printedCodes[0] === code)) {
      const aliasPattern = new RegExp(`${escape(color.name)}\\s+(?:is\\s+)?(?:also\\s+)?`
        + '(?:sold|known|listed|called|marketed|commerciali[sz]ed|vendid[ao]|conhecid[ao]|chamad[ao]|comercializad[ao])'
        + '\\s+(?:as|como)\\s+([^.,;\\n]{5,90})', 'giu');

      for (const match of page.text.matchAll(aliasPattern)) {
        const name = completePaintName(match[1].split(/\s+(?:and|or|e|ou)\s+/iu, 1)[0].trim());
        add(name, page, match[0].trim(), printedCodes[0]);
      }
    }

    // A single product heading may list both market names and its paint code
    // without an "also sold as" sentence. Require that whole link in fetched
    // text; the search-result title by itself is never name evidence.
    const adjacentAlias = new RegExp(`${escape(color.name)}\\s*[,/|(–—-]\\s*`
      + '((?:amarel[oa]|azul|bege|branc[oa]|cinza|dourad[oa]|laranja|marrom|ouro|prata|pret[oa]|rosa|rox[oa]|verde|vermelh[oa])'
      + '(?:\\s+[\\p{L}\\p{N}]+){1,4})', 'iu');
    for (const line of page.text.split(/\r?\n/)) {
      if (line.length > 250 || !namePattern.test(line)
        || !/(?:paint|colou?r|tinta|cor|pintura)/iu.test(`${line} ${page.title || ''}`)) continue;

      const pair = adjacentAlias.exec(line);
      if (!pair) continue;

      const codes = [...new Set((line.match(/\b[A-Z0-9]{2,8}\b/gu) || [])
        .filter(value => /\d/u.test(value) && !/^(?:19|20)\d{2}$/u.test(value)))];
      const primaryCode = new RegExp(`\\b(?:paint|tinta|pintura)\\s+${escape(String(vehicle.brand || ''))}`
        + '\\s+([A-Z0-9]{2,8})\\b', 'iu').exec(line)?.[1]?.toUpperCase();
      const linkedCode = code || (codes.length === 1 ? codes[0] : primaryCode || '');
      if (!linkedCode || !codes.includes(linkedCode)) continue;

      const name = completePaintName(pair[1].split(/\s+(?:and|or|e|ou)\s+/iu, 1)[0].trim());
      add(name, page, line.trim(), linkedCode);
    }
  }

  return matches.size === 1 ? [...matches.values()][0] : null;
}

function portugueseNameQuery(candidates, vehicle) {
  const name = [vehicle.brand, vehicle.model, vehicle.manufacturingYear,
    finishSearchTerms(vehicle.paintFinish, 'pt')].filter(Boolean).join(' ');
  const wanted = hueFamilies(vehicle.predominantColor);
  const foreign = candidates.filter((candidate) => !hasPortugueseName(candidate.name)
    && /\b(?:silver|gr[ae]y|white|black|blue|red|green|yellow|gold|brown)\b/i.test(candidate.name)
    && (!wanted.size || [...hueFamilies(candidate.name)].some(hue => wanted.has(hue))))
    .sort((a, b) => b.sources.length - a.sources.length)[0];

  if (!foreign) return `${name} nomes cores originais códigos tinta catálogo Brasil${wanted.size ? ` ${vehicle.predominantColor}` : ''}`;

  const codes = [...new Set(foreign.sources.flatMap((source) => sourceCodes(foreign.name, source.evidence)))];

  return paintSearch(vehicle, [{ name: foreign.name, codes }], 'portuguese');
}

module.exports = { hasPortugueseName, portugueseNameQuery, catalogPortugueseName, webPortugueseName };
