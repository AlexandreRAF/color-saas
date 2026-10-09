const { stripCoatingSuffix, stripPaintFinish, completePaintName, isExtractionArtifactName,
  isCatalogCodeLabel, isPaintCodeCombination } = require('./paint_name');
const { printedNameKey, printedCodePrefixRow } = require('./paint_evidence');
const { hasPortugueseName } = require('./portuguese_names');
const { samePaint, preferredName, sourceSpellingAlias } = require('./paint_duplicates');
const { outputPaintFinish } = require('./paint_finish_output');
const { isModelSource, catalogReferences } = require('./model_evidence');

function titleCase(name) {
  return name.toLocaleLowerCase('pt-BR').replace(/\p{L}[\p{L}\p{M}]*/gu,
    (word) => word.replace(/^\p{L}/u, (letter) => letter.toLocaleUpperCase('pt-BR')));
}

// Only spelling/punctuation here: do not erase finish or version words.
function spellingKey(name) {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)?.map((word) => word === 'grey' ? 'gray' : word).join(' ') || '';
}

const accentCount = name => (name.normalize('NFD').match(/\p{M}/gu) || []).length;

function colorCodes(color) {
  return [...new Set([color.universal_code,
    ...(color.code_candidates || []).map((candidate) => candidate.universal_code)].filter(Boolean))];
}

function sameVolkswagenCodeVariant(left, right, manufacturer) {
  if (!/^(?:volkswagen|vw|audi)$/i.test(String(manufacturer || '').trim())) return false;

  const codes = [...colorCodes(left), ...colorCodes(right)].map(code => String(code).toUpperCase());
  if (!colorCodes(left).length || !colorCodes(right).length) return false;

  // VW/Audi catalogs commonly print the same paint as A7W and LA7W. This
  // spelling relation is narrow; unrelated codes with an identical marketing
  // name remain separate comparison options.
  const normalized = codes.map(code => /^L[A-Z0-9]{3}$/.test(code) ? code.slice(1) : code);
  return new Set(normalized).size === 1 && new Set(codes).size > 1;
}

function publishedOutputName(color) {
  if (color._catalogName) return color._catalogName.name;
  if (color._webName) return color._webName.name;
  const passages = (color.source_evidence || []).flatMap(source => source.passages || []);
  const withoutCode = name => printedCodePrefixRow(name, passages)
    ? name.replace(/^[A-Z0-9]{2,8}\s+/iu, '') : name;
  const key = spellingKey(stripPaintFinish(withoutCode(color.name)));
  const names = [color.name, ...(color.source_evidence || []).map(source => source.source_name).filter(Boolean)]
    .map(withoutCode)
    .filter(name => spellingKey(stripPaintFinish(name)) === key);

  // Display a real published label with its suffixes, never a reconstructed
  // combination. Canonical names remain available for internal matching only.
  return names.sort((a, b) => b.length - a.length
    || accentCount(b) - accentCount(a) || a.localeCompare(b))[0];
}

function mergeColor(target, color) {
  target._finishInputs.push(...(color._finishInputs || [color]));
  if (color.nearbyYearLead) target.nearbyYearLead = true;
  if (target.identityType !== color.identityType) delete target.identityType;
  if (target.codeOrigin !== color.codeOrigin) delete target.codeOrigin;

  if (color.finishMatch === 'confirmed') target.finishMatch = 'confirmed';

  const codes = [...new Set([...colorCodes(target), ...colorCodes(color)])];

  target.sources = [...new Set([...target.sources, ...(color.sources || [])])];
  const aliases = [...new Set([...(target.aliases || []), ...(color.aliases || [])])];
  if (aliases.length) target.aliases = aliases;
  const catalogSources = [...new Map([...(target.catalogSources || []), ...(color.catalogSources || [])]
    .map(source => [JSON.stringify(source), source])).values()];
  if (catalogSources.length) target.catalogSources = catalogSources;
  target.universal_code = codes.length === 1 ? codes[0] : '';

  const rows = [...(target.code_candidates || []), ...(color.code_candidates || [])];

  target.code_candidates = codes.flatMap(universal_code => {
    const matches = rows.filter(row => row.universal_code === universal_code);
    return matches.length ? matches : [{ universal_code }];
  });

  const rank = { high: 3, medium: 2, low: 1 };

  if (rank[color.confidence] > rank[target.confidence]) target.confidence = color.confidence;
}

function mergePaintVariants(colors) {
  const groups = [];
  const sharesCode = (left, right) => colorCodes(left).some(code => colorCodes(right).includes(code));

  return colors.filter(color => {
    const codes = colorCodes(color);

    // Check every original member: an underspecified name cannot bridge two
    // conflicting shades through a series of otherwise plausible pair merges.
    const group = groups.find(entry => entry.members.every(member =>
      codes.length ? sharesCode(member, color) && samePaint(member, color)
        : !colorCodes(member).length && sourceSpellingAlias(member, color)));
    const member = { ...color, code_candidates: [...color.code_candidates] };

    if (!group) {
      groups.push({ target: color, members: [member] });
      return true;
    }

    group.members.push(member);
    const originalName = group.target.name;
    mergeColor(group.target, color);
    group.target.name = preferredName(group.members);
    group.target.aliases = [...new Set([...(group.target.aliases || []), originalName, color.name])]
      .filter(name => name !== group.target.name);

    return false;
  });
}

// Distinct catalog identities may share a display name after finish suffixes
// move to paintFinish. Keep their evidence separate under one palette label.
function groupDisplayVariants(colors) {
  const groups = new Map();

  for (const color of colors) {
    const group = groups.get(color.name) || [];
    group.push(color);
    groups.set(color.name, group);
  }

  return [...groups.values()].map(group => {
    if (group.length === 1) return group[0];

    const sources = [...new Set(group.flatMap(color => color.sources || []))];
    const catalogSources = [...new Map(group.flatMap(color => color.catalogSources || [])
      .map(source => [JSON.stringify(source), source])).values()];
    const codes = [...new Set(group.flatMap(colorCodes))];
    const rank = { high: 3, medium: 2, low: 1 };
    const confidence = group.reduce((best, color) => rank[color.confidence] > rank[best]
      ? color.confidence : best, 'low');
    const finishes = group.map(color => JSON.stringify(color.paintFinish));
    const paintFinish = new Set(finishes).size === 1 ? group[0].paintFinish : ['desconhecido'];

    return { name: group[0].name, paintFinish, finishMatch: 'unknown',
      ...(group.some(color => color.nearbyYearLead) && { nearbyYearLead: true }),
      ...(group[0].identityType && group.every(color => color.identityType === group[0].identityType)
        && { identityType: group[0].identityType }),
      ...(group.every(color => color.codeOrigin === 'cross_checked_web')
        && { codeOrigin: 'cross_checked_web' }),
      confidence, sources, catalogSources, universal_code: codes.length === 1 ? codes[0] : '',
      code_candidates: codes.map(universal_code => ({ universal_code })),
      variants: group.map(({ name, ...variant }) => variant) };
  });
}

function outputColors(colors, { manufacturer, documentedCodes = [], aliasGroups = [], onArtifact = () => {} } = {}) {
  const spellings = [];
  const codes = new Set([...documentedCodes, ...colors.flatMap(colorCodes)]);

  for (const color of colors) {
    const name = publishedOutputName(color);
    if (isExtractionArtifactName(name)) {
      onArtifact({ name, sources: color.sources || [], reason: 'source_text_artifact' });
      continue;
    }
    if (isCatalogCodeLabel(name, manufacturer, codes) || isPaintCodeCombination(name, codes)) {
      onArtifact({ name, sources: color.sources || [], reason: 'documented_code_label' });
      continue;
    }
    const key = spellingKey(stripCoatingSuffix(name));
    const sameName = spellings.filter(item => spellingKey(stripCoatingSuffix(item.name)) === key);
    const signature = item => JSON.stringify(colorCodes(item).sort());
    const previous = sameName.find(item => signature(item) === signature(color))
      || sameName.find(item => sameVolkswagenCodeVariant(item, color, manufacturer))
      || (sameName.length === 1 && (!colorCodes(sameName[0]).length || !colorCodes(color).length)
        ? sameName[0] : null);

    if (previous) {
      previous.name = [previous.name, name].sort((a, b) => b.length - a.length
        || accentCount(b) - accentCount(a) || a.localeCompare(b))[0];
      mergeColor(previous, color);
    }
    else spellings.push({ name, confidence: color.confidence, _finishInputs: [color],
      ...(color.identityType && { identityType: color.identityType }),
      ...(color.nearbyYearLead && { nearbyYearLead: true }),
      ...(color.codeOrigin && { codeOrigin: color.codeOrigin }),
      _sourceEvidence: color.source_evidence || [],
      ...(color._catalogName && { aliases: [color.name], catalogSources: [{
        catalog: color._catalogName.catalog, recordId: color._catalogName.recordId }] }),
      ...(color._webName && { aliases: [...new Set([...(color.aliases || []), color.name])] }),
      ...(color.finishMatch && { finishMatch: color.finishMatch }),
      sources: [...new Set(color.sources || [])], universal_code: color.universal_code,
      code_candidates: (color.code_candidates || []).map(row => ({ ...row })) });
  }

  let palette = mergePaintVariants(spellings);
  for (const names of aliasGroups) {
    const keys = new Set(names.map(name => spellingKey(completePaintName(name))));
    const members = palette.filter(color => keys.has(spellingKey(completePaintName(color.name))));
    const signatures = new Set(members.map(color => JSON.stringify([
      colorCodes(color), outputPaintFinish(color._finishInputs).sort(),
    ])));
    // Only identities already proved in review can share final verification.
    // Matching that introduced ambiguity or conflicting finishes cancels reuse.
    if (members.length < 2 || signatures.size !== 1 || members.some(color => colorCodes(color).length !== 1)) continue;
    const target = members.find(color => hasPortugueseName(color.name)) || members[0];
    target.aliases = [...new Set(members.flatMap(color => [color.name, ...(color.aliases || [])]))]
      .filter(name => name !== target.name);
    for (const color of members) if (color !== target) mergeColor(target, color);
    palette = palette.filter(color => color === target || !members.includes(color));
  }
  const localNames = new Map();
  const identity = (color) => JSON.stringify([printedNameKey(color.name), colorCodes(color)[0]]);

  for (const color of palette) {
    if (hasPortugueseName(color.name) && colorCodes(color).length === 1) {
      const key = identity(color);
      localNames.set(key, [...(localNames.get(key) || []), color]);
    }
  }

  const displayed = palette.filter((color) => {
    if (hasPortugueseName(color.name) || colorCodes(color).length !== 1) return true;

    const local = localNames.get(identity(color));

    // Require an already researched local name, matching full-name vocabulary,
    // and the exact same unambiguous catalog code. Code alone is insufficient.
    if (local?.length !== 1) return true;

    mergeColor(local[0], color);

    return false;
  }).map(({ _finishInputs, _sourceEvidence, ...color }) => {
    const paintFinish = outputPaintFinish(_finishInputs);
    const catalogSources = [...new Map([...(color.catalogSources || []), ...catalogReferences(color.sources)]
      .map(source => [JSON.stringify(source), source])).values()];
    return { ...color, name: titleCase(completePaintName(color.name)), paintFinish,
      ...(color.aliases?.length && { aliases: [...new Set(color.aliases.map(name => titleCase(completePaintName(name))))] }),
      sources: color.sources.filter(url => !isModelSource(url)),
      ...(catalogSources.length && { catalogSources }),
      ...(paintFinish.includes('conflitante') && color.finishMatch && { finishMatch: 'unknown' }),
      code_candidates: colorCodes(color).map(universal_code => ({ universal_code })) };
  });

  return groupDisplayVariants(displayed);
}

function compactWarnings(warnings = []) {
  const groups = new Map();

  for (const { stage, details } of warnings) {
    const key = JSON.stringify([stage, details?.code, details?.engine]);
    const group = groups.get(key) || { stage, count: 0,
      ...(details && { ...details }) };

    group.count++;
    groups.set(key, group);
  }

  return [...groups.values()];
}

// Keep the existing AI-only cost stable; report the combined estimate separately.
function searchCostOutput(result) {
  if (!result.serperCost) return {};

  const aiCost = result.cost?.estimatedCostUsd;
  const searchCost = result.serperCost.estimatedCostUsd;

  return {
    serperCost: result.serperCost,
    totalEstimatedCostUsd: Number.isFinite(aiCost) && Number.isFinite(searchCost)
      ? Number((aiCost + searchCost).toFixed(6)) : null,
    totalUpperBoundUsd: Number.isFinite(result.cost?.upperBoundUsd) && Number.isFinite(searchCost)
      ? Number((result.cost.upperBoundUsd + searchCost).toFixed(6)) : null,
    totalAdmissionEstimateUsd: Number.isFinite(result.cost?.admissionEstimateUsd) && Number.isFinite(searchCost)
      ? Number((result.cost.admissionEstimateUsd + searchCost).toFixed(6)) : null,
  };
}

// Presentation only: call after every agent finishes and the full result is saved.
function expandedOutput(result) {
  if (result.error) {
    const { fetchedPages, ...rest } = result;
    return { ...rest, ...searchCostOutput(result),
      warnings: compactWarnings(result.warnings), ...(fetchedPages && { fetchedPages }) };
  }

  const { automobileType, make, model, year, market, version, runId, tokenUsage, tokenUsageByAgent,
    modelCalls, browserUses, pagesFetched, pageFetchAttempts, fetchErrors, pagesWithoutText, pagesPending, pagesCancelled, pagesSkipped,
    totalTimeByStageMs, totalTimeMs, research } = result;
  const artifacts = [...(research.identityArtifacts || [])];
  const colors = outputColors(result.colors, { manufacturer: make,
    documentedCodes: result.identityCodes, aliasGroups: result.reviewAliasGroups,
    onArtifact: artifact => { if (!artifacts.some(row => row.name === artifact.name)) artifacts.push(artifact); } });

  return {
    automobileType, make, model, year, market, version, runId,
    ...(result.paintFinish && { paintFinish: result.paintFinish }),
    colors,
    tokenUsage, tokenUsageByAgent, modelCalls, browserUses,
    ...(result.modelRequests && { modelRequests: result.modelRequests }),
    ...(result.pagePool && { pagePool: result.pagePool }),
    ...(result.searchBudget && { searchBudget: result.searchBudget }),
    ...(result.cost && { cost: result.cost }),
    ...searchCostOutput(result),
    pagesFetched, pageFetchAttempts, fetchErrors, pagesWithoutText, pagesPending, pagesCancelled, pagesSkipped, totalTimeByStageMs, totalTimeMs,
    ...(result.timing && { timing: result.timing }),
    research: {
      status: research.status,
      ...(research.matchingCoverage && { matchingCoverage: research.matchingCoverage }),
      ...(artifacts.length && { identityArtifacts: artifacts }),
      ...(research.omissionReview && { omissionReview: research.omissionReview }),
      ...(research.completionReview && { completionReview: research.completionReview }),
      ...(research.discoveryCoverage && { discoveryCoverage: research.discoveryCoverage }),
      candidatesReviewed: research.candidatesReviewed,
      ...(Number.isInteger(research.candidatesReviewed) && { reviewCoverage: {
        total: research.candidatesReviewed + (research.unreviewedCandidates || []).length,
        reviewed: research.candidatesReviewed,
        unreviewed: (research.unreviewedCandidates || []).length,
      } }),
      unreviewedCandidates: (research.unreviewedCandidates || []).map(({ name }) => ({ name: titleCase(name) })),
      unresolvedNames: (research.unresolvedNames || []).map(({ name, sources }) => ({
        name: titleCase(name), sources: [...new Set(sources || [])].filter(url => !isModelSource(url)),
        ...(catalogReferences(sources).length && { catalogSources: catalogReferences(sources) }),
      })),
      warnings: compactWarnings(research.warnings),
    },
    ...(result.fetchedPages && { fetchedPages: result.fetchedPages }),
  };
}

function usageByModel(entries = []) {
  const models = new Map();

  for (const entry of entries) {
    const key = JSON.stringify([entry.provider, entry.model]);
    const total = models.get(key) || { provider: entry.provider, model: entry.model,
      calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
      totalTokens: 0, estimatedCostUsd: 0, knownCostUsd: 0 };

    for (const field of ['calls', 'inputTokens', 'cachedInputTokens', 'outputTokens']) {
      total[field] += entry[field] || 0;
    }

    total.knownCostUsd += entry.knownCostUsd ?? entry.estimatedCostUsd ?? 0;
    total.totalTokens = total.inputTokens + total.outputTokens;

    if (entry.missingUsage) total.missingUsage = (total.missingUsage || 0) + entry.missingUsage;
    if (entry.missingUsage) total.upperBoundUsd = total.upperBoundUsd === null
      || !Number.isFinite(entry.upperBoundUsd) ? null : (total.upperBoundUsd || 0) + entry.upperBoundUsd;

    // Sum the recorded costs across stages/tiers; unknown usage or prices stay unknown.
    total.estimatedCostUsd = total.estimatedCostUsd === null || entry.missingUsage
      || !Number.isFinite(entry.estimatedCostUsd) ? null : total.estimatedCostUsd + entry.estimatedCostUsd;
    models.set(key, total);
  }

  return [...models.values()].map((entry) => ({ ...entry,
    knownCostUsd: Number(entry.knownCostUsd.toFixed(6)),
    ...(Object.hasOwn(entry, 'upperBoundUsd') && { upperBoundUsd: Number.isFinite(entry.upperBoundUsd)
      ? Number(entry.upperBoundUsd.toFixed(6)) : null }),
    estimatedCostUsd: entry.estimatedCostUsd === null ? null : Number(entry.estimatedCostUsd.toFixed(6)),
  }));
}

// Flat code arrays keep the public JSON small; each color carries its source URLs.
// No compact object is ever sent back into an agent.
function finalOutput(result, { format = 'compact' } = {}) {
  const expanded = expandedOutput(result);

  if (format === 'expanded') return expanded;

  const usage = result.tokenUsage || Object.values(result.tokenUsageByAgent || {}).reduce((sum, entry) => ({
    inputTokens: sum.inputTokens + entry.inputTokens, outputTokens: sum.outputTokens + entry.outputTokens,
    totalTokens: sum.totalTokens + entry.totalTokens,
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });

  const common = { formatVersion: 3, runId: result.runId,
    ...(result.modelRequests && { modelRequests: result.modelRequests }),
    ...(result.pagePool && { pagePool: result.pagePool }),
    ...(result.searchBudget && { searchBudget: result.searchBudget }),
    ...searchCostOutput(result),
    usage: { ...usage, estimatedCostUsd: result.cost?.estimatedCostUsd ?? null,
      upperBoundUsd: result.cost?.upperBoundUsd ?? null,
      admissionEstimateUsd: result.cost?.admissionEstimateUsd ?? null,
      knownCostUsd: result.cost?.knownCostUsd ?? null,
      missingUsageCalls: result.cost?.missingUsageCalls || 0,
      costComplete: result.cost?.complete ?? Number.isFinite(result.cost?.estimatedCostUsd),
      byModel: usageByModel(result.cost?.entries) },
    timeMs: Math.round(result.totalTimeMs || 0),
    ...(result.browserUses && { browserUses: result.browserUses,
      pageFetchAttempts: result.pageFetchAttempts, pagesFetched: result.pagesFetched,
      pagesCancelled: result.pagesCancelled, pagesSkipped: result.pagesSkipped,
      fetchErrors: result.fetchErrors, pagesWithoutText: result.pagesWithoutText, pagesPending: result.pagesPending }),
    ...(result.timing && { timing: result.timing }) };

  if (result.error) return { ...common, error: result.error,
    ...(result.errorDetails && { errorDetails: result.errorDetails }), warnings: expanded.warnings,
    ...(result.fetchedPages && { fetchedPages: result.fetchedPages }) };

  const compactVariant = variant => ({ paintFinish: variant.paintFinish, codes: colorCodes(variant),
    ...(variant.identityType && { identityType: variant.identityType }),
    ...(variant.codeOrigin && { codeOrigin: variant.codeOrigin }),
    ...(variant.aliases?.length && { aliases: variant.aliases }),
    ...(variant.finishMatch && { finishMatch: variant.finishMatch }),
    confidence: variant.confidence, sources: variant.sources,
    ...(variant.catalogSources && { catalogSources: variant.catalogSources }) });
  const colors = expanded.colors.map((color) => ({ name: color.name, paintFinish: color.paintFinish,
    ...(color.nearbyYearLead && { nearbyYearLead: true }),
    ...(color.identityType && { identityType: color.identityType }),
    ...(color.codeOrigin && { codeOrigin: color.codeOrigin }),
    ...(color.aliases?.length && { aliases: color.aliases }),
    ...(color.finishMatch && { finishMatch: color.finishMatch }),
    codes: colorCodes(color), confidence: color.confidence, sources: color.sources,
    ...(color.catalogSources && { catalogSources: color.catalogSources }),
    ...(color.variants && { variants: color.variants.map(compactVariant) }) }));

  const unresolved = expanded.research.unresolvedNames.map((color) => ({
    name: color.name, sources: color.sources,
    ...(color.catalogSources && { catalogSources: color.catalogSources }),
  }));

  return { ...common,
    vehicle: { automobileType: result.automobileType, make: result.make, model: result.model, year: result.year, market: result.market,
      ...(result.paintFinish && { paintFinish: result.paintFinish }) },
    colors,
    research: { status: expanded.research.status,
      ...(expanded.research.matchingCoverage && { matchingCoverage: expanded.research.matchingCoverage }),
      ...(expanded.research.identityArtifacts && { identityArtifacts: expanded.research.identityArtifacts }),
      ...(expanded.research.omissionReview && { omissionReview: expanded.research.omissionReview }),
      ...(expanded.research.completionReview && { completionReview: expanded.research.completionReview }),
      ...(expanded.research.discoveryCoverage && { discoveryCoverage: expanded.research.discoveryCoverage }),
      ...(expanded.research.reviewCoverage && { reviewCoverage: expanded.research.reviewCoverage }),
      ...(unresolved.length && { unresolvedNames: unresolved }),
      ...(expanded.research.unreviewedCandidates.length && {
        unreviewedNames: expanded.research.unreviewedCandidates.map((color) => color.name) }),
      ...(expanded.research.warnings.length && { warnings: expanded.research.warnings }),
    },
    ...(result.fetchedPages && { fetchedPages: result.fetchedPages }),
  };
}

module.exports = { finalOutput, outputColors, titleCase };
