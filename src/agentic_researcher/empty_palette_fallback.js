'use strict';

const { sourceEvidence, printedNameKey, requiresNameCheck } = require('./paint_evidence');
const { outputColors } = require('./final_output');
const { modelLinkedPage } = require('./verification_research');
const { pageDomain } = require('./source_claim_scope');

const NOT_PAINT = new Set(['not_paint_name', 'interior_or_component']);

function decisionReason(decision) {
  if (typeof decision === 'string') return 'review_excluded';
  return decision?.exclude_reason || (decision?.alias_of ? 'unresolved_alias'
    : decision?.action === 'include' ? 'approved_but_filtered'
      : decision?.action === 'exclude' ? 'review_excluded' : 'unreviewed');
}

// This is an exceptional comparison lead, never an inferred OEM color. Its
// source must actually have been seen in this run and name this paint.
function fallbackOptions(candidates, decisions, pages, vehicle, documentedCodes = []) {
  const byId = new Map(pages.filter(page => page?.id).map(page => [page.id, page]));
  const requestedHue = printedNameKey(vehicle.predominantColor || '');

  return candidates.flatMap(candidate => {
    const reason = decisionReason(decisions[candidate.id]);
    if (NOT_PAINT.has(reason)) return [];

    const name = printedNameKey(candidate.name);
    const sources = candidate.sources.filter(source => {
      const page = byId.get(source.page_id);
      return page && ['ok', 'search_snippet'].includes(page.status)
        && source.evidence?.some(passage => printedNameKey(passage).includes(name));
    });
    if (!name || !sources.length) return [];

    const fetched = sources.filter(source => byId.get(source.page_id)?.status === 'ok');
    const selected = fetched.length ? fetched : sources;
    const color = { name: candidate.name, confidence: 'low', universal_code: '', code_candidates: [],
      sources: [...new Set(selected.map(source => source.url))],
      source_evidence: sourceEvidence(candidate, selected) };
    if (!outputColors([color], { manufacturer: vehicle.brand, documentedCodes }).length) return [];

    const modelPage = selected.some(source => modelLinkedPage(byId.get(source.page_id), color, vehicle));
    const exactModelCatalog = selected.some(source => byId.get(source.page_id)?.catalog === 'basf_models'
      && byId.get(source.page_id).catalog_record?.model_match === 'exact');
    const domains = new Set(selected.map(source => pageDomain({ url: source.url })).filter(Boolean));
    const score = (reason === 'approved_but_filtered' ? 80 : reason === 'unreviewed' ? 40 : 20)
      + (exactModelCatalog ? 40 : modelPage ? 30 : 0)
      + (fetched.length ? 15 : -15)
      + Math.min(3, domains.size) * 3
      + (requestedHue && name.includes(requestedHue) ? 5 : 0)
      - (requiresNameCheck(candidate.name) ? 20 : 0)
      - (reason === 'incompatible_finish' ? 25 : 0)
      - (reason === 'unrelated_hue' ? 30 : 0)
      - (reason === 'repaint_only' ? 35 : 0)
      - (reason === 'unrelated_vehicle' ? 60 : 0)
      - (reason === 'authoritative_exclusion' ? 70 : 0);

    return [{ color, candidateId: candidate.id, reviewReason: reason,
      sourceQuality: fetched.length ? 'fetched' : 'search_snippet', score }];
  }).sort((a, b) => b.score - a.score || a.color.name.localeCompare(b.color.name));
}

function emptyPaletteFallback(candidates, decisions, pages, vehicle, documentedCodes = []) {
  const [best] = fallbackOptions(candidates, decisions, pages, vehicle, documentedCodes);
  if (!best) return null;
  const { score, color, ...report } = best;
  return { color, report: { reason: 'no_valid_colors', ...report } };
}

function canUseEmptyFallback({ candidates, reviewedCandidates, unreviewedCandidates,
  unresolvedNames, omissionReview, verificationEnabled }) {
  if (!candidates.length || reviewedCandidates.length !== candidates.length
    || unreviewedCandidates.length || unresolvedNames.length) return false;
  if (!verificationEnabled) return true;
  return omissionReview?.checked === omissionReview?.total
    && omissionReview?.incomplete === 0 && omissionReview?.repairFailures === 0;
}

module.exports = { emptyPaletteFallback, fallbackOptions, canUseEmptyFallback };
