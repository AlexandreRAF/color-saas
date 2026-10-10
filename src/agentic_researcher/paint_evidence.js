const { stripPaintFinish, stripCoatingSuffix, splitPaintNames, GENERIC_FINISHES, paintIdentityKey } = require('./paint_name');
const { isAbbreviatedName, abbreviatedMatch } = require('./name_completeness');

const HUE_WORDS = new Set(['silver', 'gray', 'white', 'black', 'blue', 'red', 'green',
  'yellow', 'orange', 'brown', 'gold', 'pink', 'purple', 'beige']);
const hueWords = name => new Set(paintIdentityKey(name).split(' ')
  .filter(word => HUE_WORDS.has(word)).map(word => ['silver', 'gray'].includes(word) ? 'silver-gray' : word));

// Preserve word order and language. Translated/reordered names can be different paints.
function printedNameKey(name) {
  return stripPaintFinish(name.replace(/[-/.]+/g, ' ')).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)?.map((word) => word === 'grey' ? 'gray' : word).join(' ') || '';
}

function printedCodePrefixRow(name, passages = []) {
  const prefix = String(name || '').trim().match(/^([A-Z0-9]{2,8})\s+(.+)$/iu);
  if (!prefix) return null;
  if (!/\d/u.test(prefix[1]) && prefix[1] !== prefix[1].toUpperCase()) return null;

  const wantedName = printedNameKey(prefix[2]);
  if (!wantedName) return null;

  for (const passage of passages) {
    for (const line of String(passage || '').split(/\r?\n/)) {
      const row = line.trim().match(/^([A-Z0-9]{2,8})\s*[-:|]\s*(.+)$/iu);
      if (row?.[1].toUpperCase() !== prefix[1].toUpperCase()) continue;
      if (splitPaintNames(row[2]).some(part => printedNameKey(part) === wantedName)) return line.trim();
    }
  }

  return null;
}

function isSingleName(name) {
  return printedNameKey(name).split(' ').filter(Boolean).length === 1;
}

function requiresNameCheck(name) {
  return isSingleName(name) || isAbbreviatedName(name);
}

function codeTokens(value) {
  return String(value || '').toUpperCase().match(/[A-Z0-9]+/g) || [];
}

function sourceCodes(name, passages = []) {
  const found = new Set();
  const nameWords = new Set(codeTokens(name));
  const publishedKey = value => stripCoatingSuffix(String(value)).normalize('NFKD')
    .replace(/\p{M}/gu, '').toLowerCase().replace(/\bgrey\b/g, 'gray')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const containsName = value => (` ${publishedKey(value)} `).includes(` ${publishedKey(name)} `);
  const add = (value) => {
    for (const code of codeTokens(value)) {
      if (/^[A-Z0-9]{2,8}$/.test(code) && (/\d/.test(code) || code.length <= 3) && !/^(19|20)\d{2}$/.test(code)
        && !nameWords.has(code)) found.add(code);
    }
  };
  const chartYearHeading = passages.some(block => /^(?:cor|nome da cor|colou?r|paint colou?r)\s*\|\s*(?:ref\.?|code|c[oó]digo)\s*$/imu.test(block));

  for (const block of passages) {
    const lines = block.split(/\r?\n/).filter(line => line.trim());
    for (const [index, passage] of lines.entries()) {
      // Only code-shaped table cells, labels and prefixes. Never mine arbitrary prose.
      const text = passage.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1')
        .replace(/^\s*#{1,6}\s+/, '').replace(/[*`]/g, '').trim();
      const namedHere = containsName(text);
      const namedBefore = index > 0 && containsName(lines[index - 1]);
      const namedAfter = index + 1 < lines.length && containsName(lines[index + 1]);
      const isolated = lines.length === 1;

      const exteriorRow = text.match(/^-\s*Cor\s+([A-Z0-9]{2,8})\s*\([^\n)]*\),\s*([\p{L}][\p{L}\d .'’+/-]{2,70}?)\s*\([^\n)]{2,80}\)/iu);
      if (exteriorRow && printedNameKey(exteriorRow[2].trim()) === printedNameKey(name)) add(exteriorRow[1]);

      // Linked catalog cards: [`N2` ### Published Name 2005–2015 · White](url).
      // Associate the code with this exact name; never borrow the next card's code.
      const card = text.match(/^([A-Z0-9]{2,8})\s+#{2,6}\s+(.+?)(?:\s+(?:19|20)\d{2}\b|\s*[·|]|$)/);

      if (card && printedNameKey(card[2]) === printedNameKey(name)) add(card[1]);

      // Supplier titles and table rows commonly put the code AFTER the name.
      // Require the whole left side to match this paint, never an arbitrary word
      // or a nearby row belonging to another paint.
      const suffix = text.match(/^(.*?)\s*(?:[-–—|:]\s*|\(\s*)([A-Z0-9]{2,8}(?:\s*[/,]\s*[A-Z0-9]{2,8})*)\s*\)?$/);

      const chartYear = suffix && /^\d{2}\s+(.+)$/.exec(suffix[1]);
      if (suffix && (printedNameKey(suffix[1]) === printedNameKey(name)
        || chartYear && chartYearHeading && printedNameKey(chartYear[1]) === printedNameKey(name))) add(suffix[2]);

      const formatted = passage.trim().match(/^`([A-Z0-9]{2,8})`\s+/);

      if (formatted && namedHere) add(formatted[1]);
      if ((isolated || namedBefore || namedAfter) && /^[A-Z0-9]{2,8}(?:\s*[/,]\s*[A-Z0-9]{2,8})*$/.test(text)) add(text);

      // Some vehicle color galleries print NAME on one line and FINISH CODE
      // on the next (for example "Gun" / "METALLIC KAD"). Bind the code only
      // when the preceding line is exactly this paint's published name.
      const finishCode = text.match(/^(?:METALLIC|METALIZADO|MET[AÁ]LICO|MET|PEARL|PEROLIZADO|PRL|MATTE|MAT|SOLID|S[OÓ]LIDO)\s+([A-Z0-9]{2,8})$/iu);
      if (finishCode && index > 0 && printedNameKey(lines[index - 1].trim()) === printedNameKey(name)) {
        add(finishCode[1]);
      }

      // Product descriptions can place an exact published name and its OEM
      // code at the end of a sentence. The immediately preceding text must
      // end with this name; a code elsewhere on the page is not paint-owned.
      const trailingCode = text.match(/^(.*?)\s*\(([A-Z0-9]{2,8})\)\s*$/u);
      if (trailingCode && publishedKey(trailingCode[1]).endsWith(` ${publishedKey(name)}`)) {
        add(trailingCode[2]);
      }

      const prefix = text.match(/^([A-Z0-9]{2,8})\s+[-|:]\s+/);

      if (prefix && (namedHere || isolated)) add(prefix[1]);

      for (const match of text.matchAll(/(?:(?:paint\s+code|colou?r\s+code|c[oó]d(?:igo)?(?:\s+d[ae]\s+(?:cor|tinta))?)\s*[:#-]?|code\s*[:#-])\s*[(`]?\s*([A-Z0-9]{2,8})(?:\s*[/,]\s*[A-Z0-9]{2,8})*\b(?![-\d])/gi)) {
        // Ignore model headings such as "Ford F150" unless explicitly code-labelled.
        if ((namedHere || namedBefore || isolated)
          && (/\d/.test(match[1]) || /[:#]/.test(match[0]) || match[1] === match[1].toUpperCase())) {
          add(match[0].slice(match[0].indexOf(match[1])));
        }
      }

      const labelledSuffix = text.match(/^(.*?)\s*[-|:]?\s*\bCode\s*[:#-]\s*([A-Z0-9]{2,8})\b/i);

      if (labelledSuffix && printedNameKey(labelledSuffix[1].replace(/[-|:]\s*$/, '')) === printedNameKey(name)) add(labelledSuffix[2]);

      for (const match of passage.matchAll(/#{2,}\s+([A-Z0-9]{2,8}(?:\/[A-Z0-9]{2,8})*)\b/g)) {
        if (namedHere || isolated) add(match[1]);
      }
    }
  }

  return [...found];
}

function sourceEvidence(candidate, selected) {
  return selected.map(source => {
    const published = sourcePrintedName(candidate, source);

    return { url: source.url, passages: source.evidence,
      ...(source.retrievalMethod && { retrievalMethod: source.retrievalMethod }),
      ...(source.nearbyYearLead && { nearbyYearLead: true }),
      ...(source.claimScope && { claimScope: source.claimScope }),
      ...(source.catalog && { catalog: source.catalog, catalog_record: source.catalog_record }),
      // Keep the name used to read this source's code even if later agents
      // complete or localize the public name. Otherwise a short published
      // label can lose its own code during the final database lookup.
      ...(published && { source_name: published }),
      paint_codes: candidateSourceCodes(candidate, source) };
  });
}

function sourcePrintedName(candidate, source) {
  return (candidate.aliases || []).filter(name => printedNameKey(name) === printedNameKey(candidate.name)
    && source.evidence.some(passage => passage.toLowerCase().includes(name.toLowerCase())))
    .sort((a, b) => b.length - a.length)[0] || candidate.name;
}

function candidateSourceCodes(candidate, source) {
  if (['model_period_context', 'shared_paint_context'].includes(source.claimScope)) return [];
  return [...new Set((source.evidence || []).flatMap(passage =>
    sourceCodes(sourcePrintedName(candidate, { evidence: [passage] }), [passage])))];
}

function nameResearchQueries(candidates, vehicle) {
  const vehicleName = [vehicle.brand, vehicle.model].filter(Boolean).join(' ');
  const printedNames = new Set(candidates.map(candidate => printedNameKey(candidate.name)));
  const requestedHues = hueWords(vehicle.predominantColor);
  const catalogReference = candidate => {
    if (/^(?:PAG|PAGE|MAZ)\.\d+\)?$/i.test(candidate.name)) return true;
    if (!vehicle.brand || !/^[A-Z0-9]{2,4}$/.test(candidate.name)) return false;
    const brand = vehicle.brand.toUpperCase();
    return candidate.sources.some(source => source.evidence.some(passage =>
      passage.toUpperCase().includes(`${brand} ${candidate.name}`)
      && passage.toUpperCase().includes(`/ ${brand} `)));
  };
  const leads = candidates.filter((candidate) => candidate.identityType !== 'vehicle_display_color'
    && requiresNameCheck(candidate.name)
    // These remain in the main inventory for review, but explicit catalog page
    // references and manufacturer/code cross-references are not name searches.
    && !catalogReference(candidate)
    && !(isAbbreviatedName(candidate.name) && candidate.name_check?.longer_names.length === 1)
    && printedNameKey(candidate.name) !== printedNameKey(vehicle.brand || '')
    && !/^(?=.*\d)[a-z\d]{2,6}$/i.test(candidate.name)).map((candidate) => {
    const codes = [...new Set(candidate.sources.flatMap((source) => candidateSourceCodes(candidate, source)))];
    const priority = 10 + Math.min(codes.length, 3);
    return { candidate, codes, priority };
  });

  // A catalog may concatenate a prefix and a separately published shade,
  // such as a long marketing label ending in a two-word paint identity.
  // Search for that exact suffix as a lead; never split or rename the paint
  // from its wording alone. A distinct source must still print the shorter name.
  const suffixLeads = candidates.flatMap(candidate => {
    const words = stripPaintFinish(candidate.name).trim().split(/\s+/);
    if (words.length < 4) return [];
    const shortName = words.slice(-2).join(' ');
    const key = printedNameKey(shortName);
    const webSources = candidate.sources.filter(source => /^https?:/.test(source.url || ''));
    if (!key || printedNames.has(key)
      || new Set(webSources.map(source => new URL(source.url).hostname)).size < 2) return [];
    const codes = [...new Set(candidate.sources.flatMap(source => candidateSourceCodes(candidate, source)))];
    const hues = hueWords(shortName);
    const requested = requestedHues.size > 0 && [...hues].some(hue => requestedHues.has(hue));
    return [{ candidate, name: shortName, codes, priority: requested ? 16 : 9, compoundVariant: true }];
  });

  const seen = new Set();
  const ordered = [...leads, ...suffixLeads].sort((a, b) => b.priority - a.priority)
    .filter(lead => {
      const key = printedNameKey(lead.name || lead.candidate.name);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return ordered.map(({ candidate, name = candidate.name, codes, compoundVariant }) => ({ name, codes,
    ...(compoundVariant && { compoundVariant: true, originalName: candidate.name }),
    source_evidence: sourceEvidence(candidate, candidate.sources),
    query: compoundVariant ? `${vehicleName} "${name}" paint color code`
      : `${vehicleName} "${candidate.name}" ${codes.slice(0, 3).join(' ')} full paint color name` }));
}

function relatesToNameLead(candidate, lead, codes) {
  return (` ${printedNameKey(candidate.name)} `).includes(` ${printedNameKey(lead)} `)
    || abbreviatedMatch(lead, candidate.name)
    || sourceCodes(candidate.name, candidate.evidence).some((code) => codes.includes(code));
}

function hasNameLeadEvidence(text, lead, codes = []) {
  if (Array.isArray(lead)) return !lead.length || lead.some(item => hasNameLeadEvidence(text, item.name, item.codes));
  if (!lead) return true;

  const normalize = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
  const words = normalize(stripPaintFinish(lead)).split(' ')
    .filter(word => word.length >= 3 && !GENERIC_FINISHES.has(word));

  // Very short initials cannot establish absence: leave them to the extractor.
  // Substring checks intentionally favor recall, including partial-word labels.
  if (!words.length) return true;

  const source = ` ${normalize(text).trim()} `;
  return words.some(word => source.includes(word))
    || (Array.isArray(codes) ? codes : []).some(code => normalize(code).trim()
      && source.includes(` ${normalize(code).trim()} `));
}

module.exports = { printedNameKey, printedCodePrefixRow, isSingleName, requiresNameCheck, codeTokens, sourceCodes,
  sourcePrintedName, candidateSourceCodes, sourceEvidence, nameResearchQueries,
  relatesToNameLead, hasNameLeadEvidence };
