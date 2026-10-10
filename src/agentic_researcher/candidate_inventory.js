const { completePaintName, stripPaintFinish, isGenericPaintName, isCatalogCodeLabel,
  isPaintCodeCombination, splitPaintNames, paintIdentityKey, stripSupplierReference,
  isExtractionArtifactName } = require('./paint_name');
const { printedNameKey, printedCodePrefixRow, isSingleName, requiresNameCheck, sourceCodes,
  candidateSourceCodes, sourceEvidence } = require('./paint_evidence');
const { isAbbreviatedName, abbreviatedMatch } = require('./name_completeness');
const { combineFinishRelations } = require('./paint_finish');
const { swatchCards, swatchFamily } = require('./swatch_evidence');
const { clearlyHistoricalLead, clearlyOtherModelLead } = require('./candidate_year_scope');
const { isSupportedDisplayColor } = require('./display_color');
const { bridgeFleetStandards, bridgeSharedPaintLeads } = require('./source_claim_scope');

const needsNameCheck = candidate => candidate.identityType !== 'vehicle_display_color'
  && requiresNameCheck(candidate.name);

function mergeFinishEvidence(target, other) {
  const relations = [target, other].flatMap(color => color._finishRelations ||
    [color.finishMatch === 'confirmed' ? 'compatible' : color.finishMatch || 'unknown']);

  if (!target.finishMatch && !other.finishMatch) return;

  target._finishRelations = [...new Set(relations)];

  const relation = combineFinishRelations(relations);

  target.finishMatch = relation === 'compatible' ? 'confirmed' : relation === 'conflict' ? 'unknown' : relation;
}

function candidateCodes(candidate) {
  return new Set(candidate.sources.flatMap(source => candidateSourceCodes(candidate, source)));
}

function splitConflictingCodes(entry) {
  const groups = [];
  const uncoded = [];

  for (const source of entry.sources) {
    const codes = new Set(candidateSourceCodes(entry, source));
    if (!codes.size) { uncoded.push(source); continue; }

    const connected = groups.filter(group => [...codes].some(code => group.codes.has(code)));
    const group = connected.shift() || { codes: new Set(), sources: [] };
    for (const code of codes) group.codes.add(code);
    group.sources.push(source);
    for (const other of connected) {
      for (const code of other.codes) group.codes.add(code);
      group.sources.push(...other.sources);
      groups.splice(groups.indexOf(other), 1);
    }
    if (!groups.includes(group)) groups.push(group);
  }

  if (groups.length <= 1) return [entry];
  // An identical short label can refer to two different paint codes. Keep
  // each code-linked source with its own candidate; uncoded name-only pages
  // can support either candidate without asserting a code equivalence.
  return groups.map(group => ({ ...entry, sources: [...group.sources, ...uncoded],
    ...(entry.visual_swatches && { visual_swatches: entry.visual_swatches.filter(swatch =>
      group.sources.some(source => source.page_id === swatch.page_id)) }) }));
}

function sharesSingleCode(left, right) {
  return left.size === 1 && right.size === 1 && [...left][0] === [...right][0];
}

function sharesExactCodeSet(left, right) {
  return left.size > 0 && left.size === right.size && [...left].every(code => right.has(code));
}

function publishedSlashAlias(shortName, fullName, sources) {
  const shortKey = printedNameKey(shortName);
  const fullKey = printedNameKey(fullName);

  return sources.some(source => (source.passages || []).some(passage =>
    passage.split(/\r?\n/).some(line => {
      const parts = splitPaintNames(line.replace(/^\s*#{1,6}\s*/, '').replace(/^\s*[A-Z0-9]{2,8}\s*[|:-]\s*/, ''));
      return parts.length >= 2 && parts.some(part => printedNameKey(part) === shortKey)
        && parts.some(part => printedNameKey(part) === fullKey);
    })));
}

function reviewedCandidateName(candidateName, reviewedName) {
  const printedParts = splitPaintNames(String(reviewedName || ''));
  const matchingParts = printedParts.filter(part =>
    part.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
      === candidateName.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase());

  // A source may print alternatives as "Name A/Name B". The reviewer can
  // cite that whole label, but this candidate owns only its printed part.
  return completePaintName(matchingParts.length === 1 ? matchingParts[0] : reviewedName);
}

function isGenericHueCodeLabel(name, evidence) {
  const match = String(name).trim().match(/^([\p{L}]+)\s+([A-Z]{1,4}\d[A-Z\d]{0,3})$/iu);
  if (!match || !isGenericPaintName(match[1])) return false;

  const code = match[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return evidence.some(passage => new RegExp(`(?:manufacturer\\s+part\\s+number|mfr\\.?\\s+colou?r\\s+code|(?:paint|colou?r)\\s+code)\\s*[.:#-]*\\s*${code}\\b`, 'iu').test(passage));
}

function catalogConfirmsShortName(candidate, selected) {
  if (!isSingleName(candidate.name)) return false;
  const sourceCodesFound = [...new Set(selected.flatMap(source => candidateSourceCodes(candidate, source)))];
  if (!sourceCodesFound.length) return false;
  const sourceCodeKey = code => String(code).toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^WA(?=[A-Z0-9]{4,}$)/, '');

  return (candidate.catalog_check?.rows || []).some(row => {
    if (printedNameKey(stripPaintFinish(row.description)) !== printedNameKey(candidate.name)) return false;
    const code = sourceCodeKey(row.universal_code);
    return sourceCodesFound.every(value => code.includes(sourceCodeKey(value)));
  });
}

function codeLinkedCompleteAlias(candidate, selected) {
  if (!requiresNameCheck(candidate.name)) return null;
  const originalCodes = candidateCodes(candidate);
  if (originalCodes.size !== 1) return null;
  const aliases = [...new Set((candidate.aliases || []).map(completePaintName))].filter(alias =>
    alias.toLowerCase() !== candidate.name.toLowerCase()
    && alias.toLowerCase().startsWith(`${candidate.name.toLowerCase()} `)
    && selected.some(source => source.evidence.some(passage =>
      passage.toLowerCase().includes(alias.toLowerCase())
      && sharesSingleCode(originalCodes, new Set(sourceCodes(alias, [passage]))))));
  return aliases.length === 1 ? aliases[0] : null;
}

function publishedExpansions(shortName, candidate, sources = candidate.sources) {
  return [...new Set([candidate.name, ...(candidate.aliases || [])])].filter(name =>
    abbreviatedMatch(shortName, name) && sources.some(source => source.evidence.some(passage =>
      passage.toLowerCase().includes(name.toLowerCase()))));
}

function documentedCodes(text) {
  const labels = /(?:colou?r\s+code|paint\s+code|c[oó]digo\s+(?:d[ae]\s+)?(?:cor|tinta|color)|codice\s+colore|farbcode|code\s+(?:couleur|peinture))\s*[:#-]?\s*([a-z\d-]{1,10})\b/gi;
  const codes = [...text.matchAll(labels)].map((match) => match[1]);

  // Some catalogs print the code twice: `RAH - Rah Sleek Silver Metallic`.
  // Require a code heading and the repeated token, not just a short paint word.
  if (/(?:colou?r|paint)\s+codes?|c[oó]digos?\s+(?:d[ae]\s+)?(?:cor|tinta)/i.test(text)) {
    for (const match of text.matchAll(/^\s*([A-Z\d]{2,6})\s*[-:|]\s*(\S+)\s+\S.*$/gm)) {
      if (match[1].toLowerCase() === match[2].toLowerCase()) codes.push(match[1]);
    }
  }

  return [...new Set(codes)];
}

function withoutDocumentedCode(name, codes) {
  for (const code of codes) {
    const prefix = `${code} `;
    const suffix = ` ${code}`;

    if (name.toLowerCase().startsWith(prefix.toLowerCase())) name = name.slice(prefix.length).trim();
    if (name.toLowerCase().endsWith(suffix.toLowerCase())) name = name.slice(0, -suffix.length).trim();
  }

  return name;
}

function inventoryCodes(pages) {
  return new Set(pages.flatMap(page => [
    ...documentedCodes(page.text || ''),
    ...String(page.catalog_record?.universal_code || '').split(/[,/;]/),
    ...(page.candidates || []).flatMap(candidate => sourceCodes(candidate.name, candidate.evidence || [])),
  ]).filter(Boolean).map(code => String(code).trim().toUpperCase()));
}

// Some supplier tables print only equivalent manufacturer codes in the name
// column, for example `P3S | HYUNDAI GF / HYUNDAI P2S`. Those right-hand
// tokens are identifiers, not three separate published paint names.
function isManufacturerCodeCrossReference(name, manufacturer, evidence = []) {
  const maker = String(manufacturer || '').trim().toUpperCase();
  if (!maker) return false;
  const nameParts = splitPaintNames(String(name || '').toUpperCase()).map(part => part.trim());
  const codesToCheck = nameParts.every(part => part.startsWith(`${maker} `))
    ? nameParts.map(part => part.slice(maker.length + 1).trim()) : nameParts;
  if (!codesToCheck.length || !codesToCheck.every(code => /^[A-Z0-9]{2,5}$/.test(code))) return false;

  return evidence.some(passage => String(passage).split(/\r?\n/).some(line => {
    const row = line.trim().match(/^([A-Z0-9]{2,8})\s*[|:-]\s*(.+)$/);
    if (!row || codesToCheck.includes(row[1])) return false;
    const aliases = row[2].split(/\s*\/\s*/).map(part => part.trim());
    if (aliases.length < 2) return false;
    const codes = aliases.map(part => part.toUpperCase().startsWith(`${maker} `)
      ? part.slice(maker.length + 1).trim().toUpperCase() : '');
    return codes.every(value => /^[A-Z0-9]{2,5}$/.test(value))
      && codesToCheck.every(code => codes.includes(code));
  }));
}

function isBrandwidePromotion(page, name) {
  const text = String(page.text || '');
  const heading = /\b(?:top|popular)\s+(?:shade|colou?r|paint)\s+codes?\s+[\p{L}]/iu.exec(text);
  if (!heading) return false;
  const start = heading.index;
  const end = /\b(?:to apply this shade|our products|where can i find my shade)\b/i.exec(text.slice(start));
  const section = text.slice(start, start + (end?.index ?? text.length - start));
  const key = value => String(value).replace(/\p{Cf}/gu, '').normalize('NFKD')
    .replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const named = key(name);
  return named && (` ${key(section)} `).includes(` ${named} `)
    && !(` ${key(text.slice(0, start))} `).includes(` ${named} `);
}

function isVehicleVersionLabel(candidate) {
  const name = String(candidate.name || '').trim();
  if (!name || name.length > 50) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const version = new RegExp(`\\b(?:vers[aã]o|version|trim|edi[cç][aã]o|edition|modelo|model)\\s+[“"']?${escaped}(?![\\p{L}\\p{N}])`, 'iu');
  const paint = new RegExp(`\\b(?:paint|colou?r|cor|tinta)\\s*(?:name|code|c[oó]digo)?\\s*[:|=-]\\s*${escaped}(?![\\p{L}\\p{N}])`, 'iu');
  const passages = candidate.evidence || [];
  return passages.some(passage => version.test(passage))
    && !passages.some(passage => paint.test(passage));
}

function isRelatedPaintLink(page, candidate) {
  // A single-paint product page often links thumbnails for other shades. Those
  // links are navigation, not evidence that this page owns the linked shade.
  let path = '';
  try { path = new URL(page.url).pathname; } catch { return false; }
  if (!/\/paint\/\d+[-/]/i.test(path)) return false;
  const name = printedNameKey(candidate.name);
  if (printedNameKey(page.title || '').includes(name)) return false;
  const ownedText = String(page.text || '').replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '');
  return !printedNameKey(ownedText).includes(name);
}

function isRetailProductTitle(candidate) {
  // Coating chemistry, package size and product line are not part of a paint
  // name. A separate color declaration on the page remains an independent lead.
  return /^(?:tintas?\b|esmalte\s+sint[eé]tico\b)/iu
    .test(String(candidate.name || '').trim());
}

function candidateInventory(pages, { manufacturer, vehicle, onArtifact = () => {} } = {}) {
  const entries = new Map();
  const knownCodes = inventoryCodes(pages);

  for (const page of pages) {
    // Code headings may sit outside the short passages selected by the extractor.
    const codes = documentedCodes(page.text || (page.candidates || []).flatMap((candidate) => candidate.evidence || []).join('\n'));
    const printedRows = String(page.text || '').split(/\r?\n/);
    const names = (page.candidates || []).filter((candidate) => {
      if (typeof candidate?.name !== 'string') return false;
      const relatedLink = isRelatedPaintLink(page, candidate);
      if (relatedLink || isRetailProductTitle(candidate)) {
        onArtifact({ name: candidate.name, sources: [page.url],
          reason: relatedLink ? 'related_paint_link' : 'retail_product_title' });
        return false;
      }
      if (isVehicleVersionLabel(candidate)) {
        onArtifact({ name: candidate.name, sources: [page.url], reason: 'vehicle_version_label' });
        return false;
      }
      if (vehicle && clearlyOtherModelLead(candidate, page, vehicle)) {
        onArtifact({ name: candidate.name, sources: [page.url], reason: 'documented_other_model' });
        return false;
      }
      if (vehicle && clearlyHistoricalLead(candidate, page, vehicle)) {
        onArtifact({ name: candidate.name, sources: [page.url], reason: 'documented_other_year' });
        return false;
      }
      const maker = page.catalog_record?.manufacturer || manufacturer;
      const artifact = isPaintCodeCombination(candidate.name, knownCodes)
        || isCatalogCodeLabel(candidate.name, maker, knownCodes)
        || isManufacturerCodeCrossReference(candidate.name, maker, candidate.evidence);
      const promoted = isBrandwidePromotion(page, candidate.name);
      if (artifact || promoted) onArtifact({ name: candidate.name, sources: [page.url],
        reason: promoted ? 'brandwide_promotion' : 'documented_code_label' });
      return !artifact && !promoted;
    })
      .flatMap((candidate) => splitPaintNames(candidate.name.replace(/\p{Cf}/gu, ''))
        .map((name) => ({ ...candidate, name })));

    for (const candidate of names) {
      const evidence = (candidate.evidence || []).filter((text) => typeof text === 'string' && text.trim());
      let name = completePaintName(stripSupplierReference(withoutDocumentedCode(candidate.name, codes)));
      if (isExtractionArtifactName(name)) {
        onArtifact({ name, sources: [page.url], reason: 'source_text_artifact' });
        continue;
      }
      if (isGenericHueCodeLabel(name, evidence)) {
        onArtifact({ name, sources: [page.url], reason: 'generic_hue_with_product_code' });
        continue;
      }
      if (isCatalogCodeLabel(name, page.catalog_record?.manufacturer || manufacturer, knownCodes)) {
        onArtifact({ name, sources: [page.url], reason: 'documented_code_label' });
        continue;
      }
      // An evidence passage can contain several lines. A separately printed
      // code/name row establishes the boundary even when the card title repeats
      // the code inside the extracted name. Never strip numbers by shape alone.
      const codeRow = printedCodePrefixRow(name, [...evidence, ...printedRows]);
      if (codeRow) {
        name = name.replace(/^[A-Z0-9]{2,8}\s+/iu, '');
        // The extractor may quote only the card heading. Keep the separate
        // code/name row from that same fetched page for subsequent catalog work.
        if (!evidence.includes(codeRow)) evidence.push(codeRow);
      }

      const displayColor = isSupportedDisplayColor(name, evidence, page, vehicle);
      if (!name || isGenericPaintName(name, codes) && !displayColor) continue;
      if (vehicle?.brand && printedNameKey(name) === printedNameKey(vehicle.brand)) {
        onArtifact({ name, sources: [page.url], reason: 'manufacturer_name_only' });
        continue;
      }

      const key = printedNameKey(name);
      const entry = entries.get(key) || { name, aliases: [], sources: [] };
      if (displayColor) entry.identityType ||= 'vehicle_display_color';
      else if (page.manufacturerPaintRecovery) entry.identityType ||= 'manufacturer_paint_lead';
      else delete entry.identityType;

      // A card title's leading code is not another published shade name.
      if (!codeRow && !entry.aliases.includes(candidate.name)) entry.aliases.push(candidate.name);
      if (codeRow) {
        const published = splitPaintNames(codeRow.trim().replace(/^[A-Z0-9]{2,8}\s*[-:|]\s*/, ''))
          .find(part => printedNameKey(part) === printedNameKey(name));
        if (published && !entry.aliases.includes(published)) entry.aliases.push(published);
      }

      if (!evidence.length) continue;

      entry.sources.push({ page_id: page.id, url: page.url, evidence,
        ...(page.retrievalMethod && { retrievalMethod: page.retrievalMethod }),
        ...((page.nearbyYearLead || candidate.nearbyYearLead) && { nearbyYearLead: true }),
        ...(page.catalog && { catalog: page.catalog, catalog_record: page.catalog_record }) });
      entries.set(key, entry);
    }
  }

  for (const [key, entry] of entries) {
    const withoutCode = entry.name.replace(/^(?=[a-z\d]*\d)(?=[a-z\d]*[a-z])[a-z\d]{2,5}\s+/i, '');
    const other = entries.get(printedNameKey(withoutCode));

    if (other && other !== entry) {
      other.aliases.push(...entry.aliases);
      other.sources.push(...entry.sources);
      entries.delete(key);
    }
  }

  // Filtering unrelated supplier cards prevents a model-wide page from
  // starting dozens of leads. If an independent page already established
  // the same complete name AND code, its swatch is still relevant evidence.
  // Rejoin it here without creating a new candidate from the supplier page.
  for (const page of pages) {
    if (!page.text || !page.url || !page.id) continue;

    for (const card of swatchCards(page.text)) {
      const identity = paintIdentityKey(card.name);
      const entry = [...entries.values()].find(candidate =>
        candidate.sources.some(source => source.page_id !== page.id)
        && paintIdentityKey(candidate.name) === identity && candidateCodes(candidate).has(card.code));
      if (!entry) continue;

      entry.sources.push({ page_id: page.id, url: page.url, evidence: [card.evidence] });
      const family = swatchFamily(card.rgb);
      if (family) {
        entry.visual_swatches ||= [];
        if (!entry.visual_swatches.some(item => item.page_id === page.id && item.rgb === card.rgb)) {
          entry.visual_swatches.push({ page_id: page.id, rgb: card.rgb, approximate_family: family });
        }
      }
    }
  }

  if (vehicle) bridgeFleetStandards(entries, pages, vehicle);
  bridgeSharedPaintLeads(entries, pages);

  for (const entry of entries.values()) {
    const sources = new Map();

    for (const source of entry.sources) {
      const previous = sources.get(source.page_id);
      sources.set(source.page_id, { ...source,
        evidence: [...new Set([...(previous?.evidence || []), ...source.evidence])] });
    }

    entry.sources = [...sources.values()];
  }

  const separated = [...entries.values()].flatMap(splitConflictingCodes);
  const codeCache = new Map();
  const codesFor = entry => {
    if (!codeCache.has(entry)) codeCache.set(entry, candidateCodes(entry));
    return codeCache.get(entry);
  };

  return separated.map((entry, index) => {
    const alternatives = needsNameCheck(entry) ? separated.filter(other =>
      other !== entry && (isAbbreviatedName(entry.name)
        ? sharesSingleCode(codesFor(entry), codesFor(other)) && publishedExpansions(entry.name, other).length
        : printedNameKey(other.name).split(' ').includes(printedNameKey(entry.name)))) : [];

    return { id: `C${index + 1}`, ...entry, ...(needsNameCheck(entry) && {
      name_check: { required: true, longer_names: alternatives.map((other) => other.name),
        abbreviated: isAbbreviatedName(entry.name),
        source_codes: [...new Set(entry.sources.flatMap((source) => candidateSourceCodes(entry, source)))],
        instruction: 'Verify the full published name. Initials, abbreviations and single words may be incomplete; never expand them from memory.' },
    }) };
  });
}

const object = (properties) => ({ type: 'object', properties,
  required: Object.keys(properties), additionalProperties: false });

function reviewSchema(candidates) {
  // Required keys make omission impossible in a valid structured response.
  return object(Object.fromEntries(candidates.map((candidate) => [candidate.id, {
    anyOf: [
      needsNameCheck(candidate) ? object({
        exclude_reason: { type: 'string', enum: ['unrelated_vehicle', 'unrelated_hue', 'not_paint_name',
          'interior_or_component', 'repaint_only', 'authoritative_exclusion'] },
        reason: { type: 'string', description: 'Exclusion evidence. An incomplete name is unresolved, not excluded.' },
      }) : { type: 'string', description: 'Exclude: concise reason in Portuguese.' },
      object({
        action: { type: 'string', enum: ['include'], description: 'Include only a supported vehicle paint in the requested broad hue family.' },
        name: { type: ['string', 'null'], description: 'Null to keep the supplied name. Use a fuller name only when the selected source prints that exact full paint name; also remove separately printed catalog codes.' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        source_ids: { type: 'array', items: { type: 'string',
          enum: [...new Set(candidate.sources.map((source) => source.page_id))] } },
        reason: { type: 'string' },
        ...(needsNameCheck(candidate) && { name_status: { type: 'string', enum: ['complete', 'unresolved'],
          description: 'Complete only when evidence establishes the entire name, not an ambiguous fragment.' } }),
      }),
      object({ alias_of: { type: 'string', enum: candidates.map((entry) => entry.id) },
        source_ids: { type: 'array', items: { type: 'string',
          enum: [...new Set(candidate.sources.map((source) => source.page_id))] } },
        reason: { type: 'string' },
      }),
    ],
  }])));
}

function reviewedColors(candidates, decisions, { onWarning = () => {}, onUnresolved = () => {} } = {}) {
  decisions = Object.fromEntries(Object.entries(decisions).map(([id, value]) => [id,
    typeof value === 'string' ? { action: 'exclude', reason: value }
      : { ...value, action: value?.exclude_reason ? 'exclude' : value?.alias_of ? 'alias' : 'include' }]));

  const colors = [];
  const unresolved = [];
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));

  for (const candidate of candidates) {
    const decision = decisions[candidate.id];

    if (!decision || !['include', 'exclude', 'alias'].includes(decision.action)
      || !decision.reason?.trim()) throw new Error(`Missing review for ${candidate.id}: ${candidate.name}`);
    if (decision.action !== 'include') continue;

    let name = reviewedCandidateName(candidate.name, decision.name || candidate.name);
    const normalize = (text) => String(text || '').normalize('NFKD').replace(/\p{M}/gu, '')
      .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const selected = candidate.sources.filter((source) => decision.source_ids?.includes(source.page_id));
    if (candidate.identityType === 'shared_paint_lead') {
      // Keep the donor's paint row and the separate sharing claim together in
      // output even if the reviewer cited only one of those pages.
      for (const scope of ['shared_paint_candidate', 'shared_paint_context']) {
        const source = candidate.sources.find(item => item.claimScope === scope);
        if (source && !selected.includes(source)) selected.push(source);
      }
    }
    const documentedAlias = codeLinkedCompleteAlias(candidate, selected);
    if (documentedAlias && normalize(name) === normalize(candidate.name)) name = documentedAlias;

    const sourcePrintedExpansion = (fullName) => {
      const short = normalize(candidate.name);
      const full = normalize(fullName);
      const uniqueLonger = candidate.name_check?.longer_names?.length === 1
        && normalize(candidate.name_check.longer_names[0]) === full;
      const printedHere = selected.some(source => source.evidence.some(passage =>
        (` ${normalize(passage)} `).includes(` ${full} `)));
      const printedBySibling = uniqueLonger && selected.some(source => candidates.some(other =>
        other !== candidate && normalize(other.name) === full
        && other.sources.some(sibling => sibling.page_id === source.page_id
          && sibling.evidence.some(passage => (` ${normalize(passage)} `).includes(` ${full} `)))));

      // A fetched source must print the whole longer name. The original name
      // must remain a complete phrase, whether the missing words precede or
      // follow it (for example, Igaratá -> Amarelo Igaratá).
      return short && full !== short && (` ${full} `).includes(` ${short} `)
        // The extractor may cite a short conversational mention separately
        // from the full paint row on the same fetched page. Accept the
        // reviewer's explicit expansion only when that page has one matching
        // full-name sibling and no competing longer version.
        && (printedHere || printedBySibling);
    };

    if (!isGenericPaintName(candidate.name) && normalize(name) === normalize(candidate.name)) {
      const printedAliases = [...new Set((candidate.aliases || []).map(completePaintName))]
        .filter(sourcePrintedExpansion);

      if (printedAliases.length === 1) name = printedAliases[0];
    }

    if (!name || (isGenericPaintName(name) && candidate.identityType !== 'vehicle_display_color')
      || (!(` ${normalize(candidate.name)} `).includes(` ${normalize(name)} `)
        && !sourcePrintedExpansion(name))) {
      onWarning(`Ungrounded output name for ${candidate.name}; retained the source name`);
      name = candidate.name;
    }

    if (!selected.length) throw new Error(`No grounded source selected for ${candidate.name}`);

    // A reviewer may cite a name-only page while another fetched page for the
    // same candidate prints the complete finish-qualified name with its code.
    // Keep that page in the output whenever it settles name completeness.
    if (needsNameCheck(candidate) && decision.name_status === 'complete') {
      const codeLinkedNameSource = candidate.sources.find(source => !selected.includes(source)
        && source.evidence.some(passage => passage.length <= 500
          && passage.toLowerCase().includes(name.toLowerCase())
          && sourceCodes(name, [passage]).length > 0));

      if (codeLinkedNameSource) selected.push(codeLinkedNameSource);
    }

    // A complete published name can consist of one distinctive word plus a
    // finish. Keep an explicitly reviewed, code-linked full spelling even if a
    // translated longer name exists. Bare fragments still require clarification.
    const expansion = candidate.name_check?.catalog_expansion;
    const catalogExpansionSupported = expansion && selected.some(source =>
      candidateSourceCodes(candidate, source).some(code => code.toUpperCase() === expansion.code.toUpperCase()));
    if (catalogExpansionSupported) name = expansion.name;
    const spelledFinish = /\b(?:metallic|metalico|metalizado|pearlescent|perolizado|pearl|pearlcoat|matte|fosco|solid|solido|tricamada|tricoat)\b$/i
      .test(name.normalize('NFKD').replace(/\p{M}/gu, ''));
    const publishedWithFinish = spelledFinish && name !== stripPaintFinish(name)
      && selected.some(source => source.evidence.some(passage => passage.length <= 500
        && passage.toLowerCase().includes(name.toLowerCase())
        && sourceCodes(name, [passage]).length > 0));
    const rawNameKey = value => String(value).normalize('NFKD').replace(/\p{M}/gu, '')
      .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\bmet\b/g, 'metallic');
    const competingLongerName = candidate.name_check?.longer_names.some(longer =>
      rawNameKey(longer) !== rawNameKey(name));
    const completeStatus = decision.name_status === 'complete' || catalogConfirmsShortName(candidate, selected)
      || catalogExpansionSupported || publishedWithFinish && !competingLongerName;
    const listedWithFinish = name !== stripPaintFinish(name) && completeStatus
      && selected.some(source => source.evidence.some(passage => passage.length <= 600
        && passage.split(/\r?\n/).some(line => line.split(/[,;]+/).some(item =>
          printedNameKey(item) === printedNameKey(name)))));
    if (needsNameCheck(candidate) && (isAbbreviatedName(candidate.name) || (isSingleName(name) && (!completeStatus
      || (competingLongerName && !publishedWithFinish && !listedWithFinish
        && !catalogExpansionSupported))))) {
      unresolved.push({ name: candidate.name, reason: decision.reason, sources: selected.map((source) => source.url),
        source_evidence: sourceEvidence(candidate, selected) });
      continue;
    }

    const snippetOnly = selected.every(source => source.retrievalMethod === 'search_snippet');
    colors.push({ id: candidate.id, name, confidence: candidate.identityType === 'shared_paint_lead'
      || snippetOnly ? 'low' : decision.confidence,
      ...(selected.some(source => source.nearbyYearLead) && { nearbyYearLead: true }),
      ...(candidate.identityType && { identityType: candidate.identityType }),
      ...(decision.finishMatch && { finishMatch: decision.finishMatch }),
      ...(decision._finishRelations && { _finishRelations: decision._finishRelations }),
      evidence: decision.reason, sources: [...new Set(selected.map((source) => source.url))],
      source_evidence: sourceEvidence(candidate, selected) });
  }

  for (const candidate of candidates) {
    const decision = decisions[candidate.id];

    if (decision.action !== 'alias') continue;

    const target = colors.find((color) => color.id === decision.alias_of);
    const sources = candidate.sources.filter((source) => decision.source_ids?.includes(source.page_id));

    if (!sources.length) throw new Error(`No alias evidence for ${candidate.name}`);

    const targetCandidate = byId.get(decision.alias_of);
    const jointPassage = targetCandidate && sources.some((source) => source.evidence.some((passage) =>
      passage.toLowerCase().includes(candidate.name.toLowerCase())
      && passage.toLowerCase().includes(targetCandidate.name.toLowerCase())));

    const aliasCodes = new Set(sources.flatMap((source) => candidateSourceCodes(candidate, source)));
    const targetCodes = new Set((target?.source_evidence || []).flatMap((source) => source.paint_codes));
    const conflictingCodes = aliasCodes.size && targetCodes.size && ![...aliasCodes].some((code) => targetCodes.has(code));

    if (target && !isAbbreviatedName(candidate.name) && jointPassage && !conflictingCodes) {
      mergeFinishEvidence(target, decision);
      if (sources.some(source => source.nearbyYearLead)) target.nearbyYearLead = true;
      target.sources = [...new Set([...target.sources, ...sources.map((source) => source.url)])];
      target.source_evidence.push(...sourceEvidence(candidate, sources));
    } else {
      if (needsNameCheck(candidate)) {
        unresolved.push({ name: candidate.name, reason: 'Nome incompleto sem equivalência verificada.',
          sources: sources.map((source) => source.url), source_evidence: sourceEvidence(candidate, sources) });
        continue;
      }

      // An unresolved merge must not erase an otherwise source-backed named paint.
      onWarning(`Unverified alias for ${candidate.name}; retained as a separate low-confidence candidate`);
      colors.push({ id: candidate.id, name: candidate.name, confidence: 'low',
        ...(candidate.identityType && { identityType: candidate.identityType }),
        ...(decision.finishMatch && { finishMatch: decision.finishMatch }),
        ...(decision._finishRelations && { _finishRelations: decision._finishRelations }),
        evidence: 'Equivalência não verificada; candidato documentado mantido separadamente.',
        sources: [...new Set(sources.map((source) => source.url))], source_evidence: sourceEvidence(candidate, sources) });
    }
  }

  // Resolve across review batches only AFTER the main researcher has approved
  // each full candidate. A shared code by itself never establishes an alias.
  for (const lead of unresolved) {
    const codes = new Set(lead.source_evidence.flatMap(source => source.paint_codes));
    const matches = colors.flatMap(color => {
      const candidate = byId.get(color.id);
      const selected = candidate.sources.filter(source => color.sources.includes(source.url));
      const targetCodes = new Set(color.source_evidence.flatMap(source => source.paint_codes));

      if (isAbbreviatedName(lead.name)) {
        const names = publishedExpansions(lead.name, candidate, selected);
        return names.length && sharesSingleCode(codes, targetCodes) ? [{ color, names }] : [];
      }

      // Resolve a short marketing name only when an independent source prints
      // one approved full name starting with that word and the same sole code.
      const leadKey = printedNameKey(lead.name);
      const fullKey = printedNameKey(color.name);
      const fullName = fullKey.startsWith(`${leadKey} `) && !requiresNameCheck(color.name);
      const finishCompletedName = fullKey === leadKey && color.name !== lead.name
        && color.name !== stripPaintFinish(color.name)
        && color.source_evidence.some(source => source.passages.some(passage =>
          passage.toLowerCase().includes(color.name.toLowerCase())
          && sourceCodes(color.name, [passage]).length > 0));
      const independentFullSource = color.sources.some(url => !lead.sources.includes(url));
      const sameSource = color.sources.some(url => lead.sources.includes(url));
      const printedAlternative = sameSource && sharesExactCodeSet(codes, targetCodes)
        && publishedSlashAlias(lead.name, color.name, color.source_evidence);
      return (((fullName || finishCompletedName) && independentFullSource
        && sharesSingleCode(codes, targetCodes)) || printedAlternative)
        ? [{ color, names: [color.name] }] : [];
    });

    if (matches.length !== 1) { onUnresolved(lead); continue; }

    const { color, names } = matches[0];

    color.name = names.sort((a, b) => b.length - a.length)[0];
    if (lead.source_evidence.some(source => source.nearbyYearLead)) color.nearbyYearLead = true;
    color.sources = [...new Set([...color.sources, ...lead.sources])];
    color.source_evidence.push(...lead.source_evidence.map(source => ({ ...source, source_name: lead.name })));
  }

  const rank = { high: 3, medium: 2, low: 1 };
  const merged = new Map();

  for (const color of colors.sort((a, b) => rank[b.confidence] - rank[a.confidence])) {
    const linkedCodes = [...new Set(color.source_evidence.flatMap(source => source.paint_codes))].sort();
    const key = JSON.stringify([color.identityType === 'vehicle_display_color'
      ? color.name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase() : printedNameKey(color.name), linkedCodes]);
    const previous = merged.get(key);

    if (previous) {
      mergeFinishEvidence(previous, color);
      if (color.nearbyYearLead) previous.nearbyYearLead = true;
      previous.sources = [...new Set([...previous.sources, ...color.sources])];
      previous.source_evidence.push(...color.source_evidence);
    }
    else merged.set(key, color);
  }

  return [...merged.values()].map(({ id, ...color }) => color);
}

module.exports = { candidateInventory, inventoryCodes, reviewSchema, reviewedColors, object };
