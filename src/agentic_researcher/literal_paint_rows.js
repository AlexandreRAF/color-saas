const { isGenericPaintName, isCatalogCodeLabel, stripPaintFinish } = require('./paint_name');
const { clearlyDifferentSwatch } = require('./swatch_hue');

function swatchCodeList(value) {
  const parts = value.split(/\s*[/,]\s*/);
  return parts.every(part => /^[A-Z0-9]{2,8}$/.test(part))
    && parts.some(part => /\d/.test(part) || part.length <= 4);
}

function pairedSwatch(row, name) {
  const lines = row.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.length === 2 && lines[0] === name && swatchCodeList(lines[1]);
}

// Salvage explicit, labelled paint-code rows after model extraction fails.
// No inferred names, finishes, codes or fitment: normal agents still review
// these verbatim leads. This does not claim the rest of the page was extracted.
function literalPaintRows(text, vehicle = {}, { onSkippedRow = () => {} } = {}) {
  const candidates = new Map();
  let rowContext;
  const hasCodeHeading = /^(?:#{1,6}\s*)?(?:[\p{L}\d &()]+\s+)?(?:paint codes?|colou?r codes?|paint colou?rs?|c[oó]digos? de cores)\s*[:.]?\s*$/imu.test(text);

  for (const line of String(text).split(/\r?\n/)) {
    const labelled = line.trim().match(/^(?:(?:paint|colou?r)\s+code|c[oó]digo\s+(?:d[ae]\s+)?(?:cor|tinta))\s*[:#]?\s*([a-z\d][a-z\d /,.-]{0,25}?)\s+[-–—|:]\s+([^<>\n]{2,120})$/iu);
    const bare = hasCodeHeading
      && line.trim().match(/^([A-Z\d]{2,8})\s+[-–—|:]\s+([\p{L}][^<>\n]{2,100})$/u);
    // Without a per-row label, long alphabetic tokens can be manufacturers or
    // navigation headings. Let the extractor assess those rather than creating
    // a new paint from a brand/model link.
    const match = labelled || (bare && (/\d/.test(bare[1]) || bare[1].length <= 4) && bare);

    if (!match) continue;

    const name = match[2].trim();

    if (!/\p{L}/u.test(name) || isGenericPaintName(name) || /https?:\/\/|[{}=]/i.test(name)) continue;

    // Preserve named leads for the reviewer: marketing hue words alone cannot
    // establish a visual mismatch with the customer's requested color.
    const previous = candidates.get(name) || { name, evidence: [] };

    // Keep only the opening BEFORE the first paint row. A fixed character
    // excerpt can borrow neighboring codes or even truncate one into a new code.
    rowContext ??= String(text).slice(0, String(text).indexOf(line)).split(/\r?\n/).slice(0, 8).join('\n').trim();
    previous.evidence.push(...[line.trim(), rowContext].filter(Boolean));
    candidates.set(name, previous);
  }

  // Some model palettes list a paint name followed by linked model years,
  // without printing a code. Require an explicit color-list introduction and
  // at least two distinct years; ordinary navigation/year prose is not a row.
  const source = String(text);

  // Club and manufacturer archives often publish a simple color/reference
  // table. Require several adjacent rows under an explicit paint heading;
  // isolated vehicle specs and unrelated site navigation remain model work.
  const lines = source.split(/\r?\n/);

  // Manufacturer brochures commonly place code/name rows under "Cores" and
  // print the model-year caption elsewhere in the PDF. Keep these exact rows
  // as review leads; the reviewer still decides market and year applicability.
  const model = String(vehicle.model || '').trim();
  const targetYear = Number(vehicle.manufacturingYear);
  const brochureContext = model && source.slice(0, 1200).toLocaleLowerCase().includes(model.toLocaleLowerCase())
    && Number.isInteger(targetYear) && new RegExp(`\\b${targetYear}\\b`).test(source);
  if (brochureContext) {
    for (let headingIndex = 0; headingIndex < lines.length; headingIndex++) {
      if (!/^(?:cores|cores e acabamentos|colou?rs?|exterior colou?rs?)\s*[:.]?$/iu
        .test(lines[headingIndex].trim())) continue;

      const rows = [];
      for (const line of lines.slice(headingIndex + 1, headingIndex + 55)) {
        const value = line.trim();
        const codeFirst = /^([A-Z\d]{2,8})\s*[-–—]\s*([\p{L}][\p{L}\p{M}\d .'’()+/&-]{2,70}?)(?:\s+[AB])?$/u.exec(value);
        const codeLast = /^([\p{L}][\p{L}\p{M}\d .'’()+/&-]{2,70}?)\s*[-–—]?\s+([A-Z\d]{2,8})$/u.exec(value);
        const code = codeFirst?.[1] || codeLast?.[2];
        const name = (codeFirst?.[2] || codeLast?.[1] || '').trim();
        if (!code || !name || !/\d/.test(code) || isGenericPaintName(name)) continue;
        rows.push({ name, line: value });
      }

      if (new Set(rows.map(row => row.name)).size < 3) continue;
      const context = [lines.slice(0, 4).join('\n').trim(), lines[headingIndex].trim()];
      for (const row of rows) {
        const previous = candidates.get(row.name) || { name: row.name, evidence: [] };
        previous.evidence.push(row.line, ...context);
        candidates.set(row.name, previous);
      }
    }
  }

  const tableHeading = lines.findIndex(line => /^(?:cor|nome da cor|colou?r|paint colou?r)\s*\|\s*(?:ref\.?|code|c[oó]digo)\s*$/iu.test(line.trim()));
  if (tableHeading >= 0) {
    const rows = [];
    for (const line of lines.slice(tableHeading + 1)) {
      const match = /^(?:(?:19|20)?\d{2}\s+)?([\p{L}][\p{L}\d .,'’()+/&-]{2,90}?)\s*\|\s*([A-Z\d-]{2,15}|sem c[oó]digo)\s*$/iu.exec(line.trim());
      if (!match) break;
      rows.push({ name: match[1].trim(), line: line.trim() });
    }
    if (rows.length >= 3) {
      const context = [lines.slice(0, Math.min(8, tableHeading)).join('\n').trim(), lines[tableHeading].trim()]
        .filter(Boolean);
      for (const row of rows.filter(row => !isGenericPaintName(row.name))) {
        const previous = candidates.get(row.name) || { name: row.name, evidence: [] };
        previous.evidence.push(row.line, ...context);
        candidates.set(row.name, previous);
      }
    }
  }

  // Some HTML-to-text readers flatten a two-column color/reference table into
  // alternating lines. Recover repeated pairs under its explicit headings;
  // skip product rows whose reference is too long to be an OEM paint code.
  const units = [...source.matchAll(/[^\r\n]+/g)].filter(match => match[0].trim())
    .map(match => ({ text: match[0].trim(), start: match.index, end: match.index + match[0].length }));
  const flatHeading = units.findIndex((unit, index) => /^(?:cor|colou?r)$/iu.test(unit.text)
    && /^(?:ref\.?|code|c[oó]digo)$/iu.test(units[index + 1]?.text || ''));
  const opening = lines.slice(0, 8).join('\n');
  if (flatHeading >= 0 && /\b(?:cores|colou?rs|paint)\b/iu.test(opening)
    && [vehicle.brand, vehicle.model].some(name => name
      && opening.toLocaleLowerCase().includes(String(name).toLocaleLowerCase()))) {
    const rows = [];
    for (let index = flatHeading + 2; index + 1 < Math.min(units.length, flatHeading + 75); index++) {
      const nameLine = units[index].text;
      const codeLine = units[index + 1].text;
      const name = /^(?:(?:19|20)?\d{2}\s+)?([\p{L}][\p{L}\d .,'’()+/&-]{2,90})$/u.exec(nameLine)?.[1]?.trim();
      const code = /^[A-Z0-9]{2,8}$/u.test(codeLine) && /\d/.test(codeLine);

      if (name && code) {
        rows.push({ name, line: source.slice(units[index].start, units[index + 1].end) });
        index++;
      } else if (rows.length) break;
    }
    if (rows.length >= 3) {
      const context = [opening.trim(), source.slice(units[flatHeading].start, units[flatHeading + 1].end)];
      for (const row of rows.filter(row => !isGenericPaintName(row.name))) {
        const previous = candidates.get(row.name) || { name: row.name, evidence: [] };
        previous.evidence.push(row.line, ...context);
        candidates.set(row.name, previous);
      }
    }
  }

  // Some archives spell the code label after each name instead of using a
  // table column. A consecutive list is needed to distinguish a palette from
  // a stray article sentence. Keep formula references verbatim; a later code
  // matcher decides whether they are standard/OEM paint codes.
  let codedRows = [];
  const addCodedRows = () => {
    if (codedRows.length < 3) return;
    const context = lines.slice(0, 8).join('\n').trim();
    for (const row of codedRows.filter(row => !isGenericPaintName(row.name))) {
      const previous = candidates.get(row.name) || { name: row.name, evidence: [] };
      previous.evidence.push(...[row.line, context].filter(Boolean));
      candidates.set(row.name, previous);
    }
  };
  for (const line of lines) {
    const match = /^([\p{L}][\p{L}\d .,'’()+/&-]{2,90}?)\s*[-–—]\s*(?:COD|CODE|C[oÓ]DIGO)\s*[:.#-]?\s*([A-Z\d-]{2,15})\s*$/iu.exec(line.trim());
    if (match) codedRows.push({ name: match[1].trim(), line: line.trim() });
    else if (line.trim()) { addCodedRows(); codedRows = []; }
  }
  addCodedRows();

  // Some catalog swatches place the full caption above its code list. Require
  // an explicit code heading, a swatch introduction, and three consecutive
  // well-formed pairs. Ordinary navigation or isolated name/year prose stays AI work.
  const swatches = /\b(?:colou?r swatches|amostras de cores)\b[^\r\n]*/iu.exec(source);
  if (hasCodeHeading && swatches) {
    const units = [...source.matchAll(/[^\r\n]+/g)].filter(match => match[0].trim())
      .map(match => ({ text: match[0].trim(), start: match.index, end: match.index + match[0].length }));
    let index = units.findIndex(unit => unit.start > swatches.index + swatches[0].length);
    const rows = [];
    while (index >= 0 && index + 1 < units.length) {
      const name = units[index].text;
      if (name.length > 100 || !/^[\p{L}][\p{L}\d\s.'’()+/&-]+$/u.test(name)
        || !swatchCodeList(units[index + 1].text)) break;
      rows.push({ name, evidence: source.slice(units[index].start, units[index + 1].end) });
      index += 2;
    }
    if (rows.length >= 3) {
      const context = source.slice(0, swatches.index).split(/\r?\n/).slice(0, 8).join('\n').trim();
      const closing = units.slice(index, index + 8).map(unit => unit.text).join('\n');
      for (const row of rows.filter(row => !isGenericPaintName(row.name))) {
        const previous = candidates.get(row.name) || { name: row.name, evidence: [] };
        previous.evidence.push(...[row.evidence, context, swatches[0], closing].filter(Boolean));
        candidates.set(row.name, previous);
      }
    }
  }

  // Vehicle posts sometimes publish a compact palette as "Name (OEM code)"
  // lines. Require several adjacent rows and the requested model in the
  // heading; a lone parenthetical number elsewhere is not paint evidence.
  const heading = source.slice(0, 500).toLowerCase();
  if (model && heading.includes(model.toLowerCase())
    && /\b(?:cor|cores|colou?rs?|paleta|palette|paint)\b/i.test(heading)) {
    const lines = source.split(/\r?\n/);
    const row = /^([\p{L}][\p{L}\d .'’+/-]{2,75}?)\s*\(([A-Z\d]{2,8})\)\s*$/u;
    let group = [];
    const keepGroup = () => {
      if (group.length < 3) return;
      for (const item of group) {
        if (isGenericPaintName(item.name)) continue;
        const previous = candidates.get(item.name) || { name: item.name, evidence: [] };
        previous.evidence.push(item.line, lines.slice(0, 5).join('\n').trim());
        candidates.set(item.name, previous);
      }
    };
    for (const line of lines) {
      const match = row.exec(line.trim());
      if (match) group.push({ name: match[1].trim(), line: line.trim() });
      else if (line.trim()) { keepGroup(); group = []; }
    }
    keepGroup();
  }

  // Product cards often print a complete heading followed by its labelled code.
  // Capture that exact span; do not use image captions as substitute identities.
  const cards = /^(#{2,6})[ \t]+([^\r\n]{2,120})\r?\n(?:[ \t]*\r?\n)*[ \t]*(?:Mfr\.[ \t]*)?(?:Paint|Colou?r)[ \t]+Code[ \t]*:[ \t]*([A-Z0-9]{2,8}(?:[ \t]*[/,][ \t]*[A-Z0-9]{2,8})*)[^\r\n]*(?:\r?\n[ \t]*(?:(?:For|Only|Except|Excludes|Not for|Available|Model|Year|Finish|Acabamento)\b)[^\r\n]*)*/gimu;
  let cardContext;
  for (const match of source.matchAll(cards)) {
    const name = match[2].trim();
    if (!/\p{L}/u.test(name) || isGenericPaintName(name) || /[\[\]{}<>]/.test(name)) continue;
    const preceding = source.slice(Math.max(0, match.index - 500), match.index);
    const swatch = [...preceding.matchAll(/!\[[^\]\r\n]+\]\([^\r\n]*?b_rgb:([a-f\d]{6})[^\r\n]*\)/gim)].at(-1);
    if (swatch && !preceding.slice(swatch.index + swatch[0].length).trim()
      && clearlyDifferentSwatch(name, swatch[1], vehicle.predominantColor)) continue;
    const previous = candidates.get(name) || { name, evidence: [] };
    // Preserve following fitment/finish prose with the card it qualifies.
    let end = match.index + match[0].length;
    for (const line of source.slice(end).matchAll(/[^\r\n]*(?:\r?\n|$)/g)) {
      if (!line[0] || /^(?:[#!*\d]|https?:)/i.test(line[0].trim())) break;
      end += line[0].length;
    }
    cardContext ??= source.slice(0, match.index).split(/\r?\n/).slice(0, 8).join('\n').trim();
    previous.evidence.push(...[source.slice(match.index, end), cardContext].filter(Boolean));
    candidates.set(name, previous);
  }

  // A missing year must remain unknown, not Number(null) = 0.
  const requestedYear = vehicle.manufacturingYear == null ? NaN : targetYear;

  // A year-specific chart with repeated standard-code | full-name rows can be
  // extracted without a model call. Require a vehicle/year heading and several
  // rows so navigation links and supplier identifiers remain in model review.
  const yearHeading = source.match(/^paint colou?rs? for [^\r\n]+ year (?:18|19|20)\d{2}\s*$/im);
  if (yearHeading && Number.isInteger(requestedYear)
    && new RegExp(`\\b${requestedYear}\\b`).test(yearHeading[0])
    && (!vehicle.brand || yearHeading[0].toLowerCase().includes(String(vehicle.brand).toLowerCase()))
    && (!vehicle.model || yearHeading[0].toLowerCase().includes(String(vehicle.model).toLowerCase()))) {
    const section = source.slice(yearHeading.index + yearHeading[0].length).split(/\bor choose a year\b/i)[0];
    const rows = [...section.matchAll(/^([A-Z\d]{2,8})\s*\|\s*([^\r\n]{3,100})\s*$/gm)];

    if (rows.length >= 3) {
      for (const row of rows) {
        const name = row[2].trim();
        if (!/\p{L}/u.test(name) || isGenericPaintName(name)
          || isCatalogCodeLabel(name, vehicle.brand, new Set([row[1]]))
          || /^(?:[A-Z]{2,6}-[A-Z\d]{2,8})(?:\s*[/,+]\s*[A-Z]{2,6}-[A-Z\d]{2,8})+$/i.test(name)) continue;

        const following = section.slice(row.index + row[0].length);
        const range = /^\s*((?:18|19|20)\d{2}\s*[-–]\s*(?:18|19|20)\d{2})/.exec(following)?.[1];
        const previous = candidates.get(name) || { name, evidence: [] };
        previous.evidence.push(row[0].trim(), ...[range, yearHeading[0].trim()].filter(Boolean));
        candidates.set(name, previous);
      }
    }
  }

  // Factory equipment PDFs often publish exterior paints as one labelled
  // code/name/finish row. The model heading and repeated rows distinguish
  // this table from accessory descriptions later in the same document.
  for (let headingIndex = 0; headingIndex < lines.length; headingIndex++) {
    if (!/^cores externas\s*[:.]?$/iu.test(lines[headingIndex].trim())) continue;
    if (!model || !source.slice(0, 1200).toLocaleLowerCase().includes(model.toLocaleLowerCase())) continue;

    const rows = [];
    for (const line of lines.slice(headingIndex + 1, headingIndex + 35)) {
      const match = /^\s*-\s*Cor\s+([A-Z0-9]{2,8})\s*\([^\n)]*\),\s*([\p{L}][\p{L}\d .'’+/-]{2,70}?)\s*\([^\n)]{2,80}\)/iu.exec(line);
      if (match) rows.push({ name: match[2].trim(), line: line.trim() });
      else if (rows.length && line.trim()) break;
    }
    if (rows.length < 3) continue;

    const context = [lines.slice(0, 3).join('\n').trim(), lines[headingIndex].trim()].filter(Boolean);
    for (const row of rows.filter(row => !isGenericPaintName(row.name))) {
      const previous = candidates.get(row.name) || { name: row.name, evidence: [] };
      previous.evidence.push(row.line, ...context);
      candidates.set(row.name, previous);
    }
  }

  // PDF brochures sometimes flatten a color table into one cell per line.
  // A finish cell can run into the next name ("Sólido Prata Classic"). Recover
  // only a repeated, model-labelled palette; each lead stays subject to review.
  const hue = /^(?:branc[oa]|pret[oa]|cinza|prata|azul|vermelh[oa]|verde|amarel[oa]|bege|marrom|laranja|dourad[oa]|white|black|gr[ae]y|silver|blue|red|green|yellow|gold|brown|beige)\b/iu;
  const finishCell = /^(?:s[oó]lid[oa]|met[aá]lic[oa]|perolizad[oa]|pearlescent|metallic|solid)\b/iu;
  const paletteHeading = /^(?:cores|cores dispon[ií]veis|colou?rs|exterior colou?rs)\s*[:.]?$/iu;

  // Short model palettes may be numbered instead of tabular. Keep the printed
  // year with each row: a nearby edition is a comparison lead, not proof of
  // factory availability in the requested year.
  for (let headingIndex = 0; headingIndex < lines.length; headingIndex++) {
    const heading = lines[headingIndex].trim();
    if (heading.length > 120 || !/\b(?:cores|colou?rs|colores|paleta|palette)\b/iu.test(heading)
      || !model || !heading.toLocaleLowerCase().includes(model.toLocaleLowerCase())) continue;

    const years = [...heading.matchAll(/\b(?:18|19|20)\d{2}\b/gu)].map(match => Number(match[0]));
    if (Number.isInteger(requestedYear) && (!years.length
      || years.every(year => Math.abs(year - requestedYear) > 1))) continue;

    const rows = [];
    for (const line of lines.slice(headingIndex + 1, headingIndex + 24)) {
      const value = line.trim();
      if (!value) continue;
      const match = /^(?:[-*]\s*)?(\d{1,2})[.)]\s+([\p{L}][\p{L}\p{M}\d .'’()+/&-]{3,75})$/u.exec(value);
      if (!match || (rows.length && Number(match[1]) !== rows.at(-1).number + 1)) {
        if (rows.length) break;
        continue;
      }
      const name = stripPaintFinish(match[2].trim());
      if (!hue.test(name) || isGenericPaintName(name)) break;
      rows.push({ number: Number(match[1]), name, line: value });
    }

    if (rows.length < 3) continue;
    for (const row of rows) {
      const previous = candidates.get(row.name) || { name: row.name, evidence: [] };
      previous.evidence.push(row.line, heading);
      if (Number.isInteger(requestedYear) && !years.includes(requestedYear)) previous.nearbyYearLead = true;
      candidates.set(row.name, previous);
    }
  }

  for (let headingIndex = 0; headingIndex < lines.length; headingIndex++) {
    if (!paletteHeading.test(lines[headingIndex].trim())) continue;

    const nearby = lines.slice(Math.max(0, headingIndex - 8), headingIndex + 5).join(' ');
    if (!model || !nearby.toLocaleLowerCase().includes(model.toLocaleLowerCase())) continue;

    const rows = [];
    let started = false;
    let adjacentName = false;

    for (const line of lines.slice(headingIndex + 1, headingIndex + 35)) {
      let value = line.trim();
      if (!value) continue;

      // A leading finish belongs to the previous PDF table cell, so it is
      // removed from this paint's evidence rather than assigned to this name.
      const prefix = finishCell.exec(value);
      if (prefix && value.length > prefix[0].length) value = value.slice(prefix[0].length).trim();

      if (hue.test(value) && /^[\p{L}\d .,'’()+/&-]{4,70}$/u.test(value)
        && !isGenericPaintName(value)) {
        rows.push({ name: value, line: value });
        started = true;
        adjacentName = line.trim() === value;
      } else if (started && finishCell.test(value) && value.replace(finishCell, '').trim() === '') {
        const previous = rows.at(-1);
        if (previous && adjacentName) previous.line += `\n${line.trim()}`;
        adjacentName = false;
      } else if (started) break;
    }

    if (rows.length < 3) continue;

    const context = lines.slice(headingIndex, headingIndex + 3).join('\n').trim();
    for (const row of rows) {
      const previous = candidates.get(row.name) || { name: row.name, evidence: [] };
      previous.evidence.push(row.line, context);
      candidates.set(row.name, previous);
    }
  }

  const introduction = /\b(?:lista de cores|list of (?:paint )?colou?rs|available paint colou?rs)\b/iu.exec(source);

  if (introduction) {
    const lineEnd = source.indexOf('\n', introduction.index);
    const context = [source.slice(0, Math.min(1000, introduction.index)).trim(),
      source.slice(introduction.index, lineEnd < 0 ? source.length : lineEnd).trim()].filter(Boolean);
    const units = [...source.matchAll(/[^\r\n]+/g)]
      .filter(match => match[0].trim()).map(match => ({ text: match[0].trim(),
        start: match.index, end: match.index + match[0].length }));

    for (let index = 0; index < units.length - 2; index++) {
      const unit = units[index];
      const name = unit.text;

      if (unit.start <= introduction.index || name.length > 100
        || !/^[\p{L}\d][\p{L}\d\s.'’()+/&-]+$/u.test(name)
        || !/\p{L}/u.test(name) || isGenericPaintName(name)) continue;

      let end = index + 1;
      while (end < units.length && /^(?:19|20)\d{2}$/.test(units[end].text)) end++;

      if (new Set(units.slice(index + 1, end).map(row => row.text)).size < 2) continue;

      const years = units.slice(index + 1, end).map(row => Number(row.text));
      // These adjacent year cells are an explicit application range. Keep a
      // nearby edition for uncertain model-year boundaries, but do not turn a
      // remote all-year archive row into a current vehicle candidate.
      if (Number.isInteger(requestedYear) && requestedYear >= 1886
        && (requestedYear < Math.min(...years) - 2 || requestedYear > Math.max(...years) + 2)) {
        onSkippedRow(source.slice(unit.start, units[end - 1].end));
        index = end - 1;
        continue;
      }

      const previous = candidates.get(name) || { name, evidence: [] };
      // Include the introduction and preceding model context, without asserting
      // that the listed years cover the user's requested year.
      previous.evidence.push(source.slice(unit.start, units[end - 1].end), ...context);
      candidates.set(name, previous);
      index = end - 1;
    }
  }

  return [...candidates.values()].map(candidate => ({ ...candidate, evidence: [...new Set(candidate.evidence)] }));
}

module.exports = { literalPaintRows, pairedSwatch };
