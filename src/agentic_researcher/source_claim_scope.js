'use strict';

const { vehicleProfile } = require('./vehicle_profiles');
const { modelNameMatches } = require('./model_name_match');

const normalize = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const contains = (text, value) => value && (` ${normalize(text)} `).includes(` ${normalize(value)} `);
const fleetTerms = /\b(?:all|every|entire|whole|toda?s?|todos?|tutti|toutes?)\b/iu;
const equipmentTerms = /\b(?:machine|machines|equipment|equipamentos?|m[aá]quinas?|vehicles?|ve[ií]culos?|fleet|frota|escavadeiras?|tractors?|tratores?|trucks?|caminh[oõ]es|caminh[aã]o)\b/iu;
const paintTerms = /\b(?:paint|paints|colou?r|cores?|tintas?|pintura|coating|acabamento)\b/iu;
const standardTerms = /\b(?:standard|factory|original|padr[aã]o|f[aá]brica|original)\b/iu;

function equipmentProfile(vehicle) {
  // Bus body colors may belong to a coachbuilder or operator, not the chassis
  // maker. They need direct paint/model evidence rather than this fleet bridge.
  return ['agricultural', 'construction', 'truck']
    .includes(vehicleProfile(vehicle?.automobileType).kind);
}

function pageDomain(page) {
  try {
    const host = new URL(page.url).hostname.replace(/^www\./, '');
    const labels = host.split('.');
    const suffix = labels.at(-1)?.length === 2
      && /^(?:com|co|net|org|gov|edu|ac)$/.test(labels.at(-2)) ? 3 : 2;
    return labels.slice(-suffix).join('.');
  }
  catch { return ''; }
}

// A manufacturer-wide palette is useful only when the paint-specific sentence
// says it is standard across the fleet. A generic brand chart does not qualify.
function fleetStandardClaim(page, name, vehicle) {
  if (!equipmentProfile(vehicle) || page?.status !== 'ok' || page?.catalog
    || page?.retrievalMethod === 'search_snippet') return null;
  const context = `${page.title || ''} ${String(page.text || '').slice(0, 1200)}`;
  if (!contains(context, vehicle.brand)) return null;

  const passages = (page.candidates || []).filter(candidate =>
    normalize(candidate.name) === normalize(name)).flatMap(candidate => candidate.evidence || []);
  // The short extractor quote may omit the neighboring standard-use sentence.
  // Read only the fetched page, never a search snippet or another paint row.
  passages.push(String(page.text || '').slice(0, 50000));
  for (const passage of passages) {
    for (const sentence of String(passage).split(/(?<=[.!?])\s+|\r?\n/)) {
      if (contains(sentence, name) && fleetTerms.test(sentence) && equipmentTerms.test(sentence)
        && paintTerms.test(sentence) && standardTerms.test(sentence)) return sentence.trim();
    }
  }
  return null;
}

// The second document establishes that this exact machine and period belong
// to the claimed fleet. It does not itself name the paint or prove its code.
function modelPeriodClaim(page, vehicle) {
  if (!equipmentProfile(vehicle) || page?.status !== 'ok' || page?.catalog
    || page?.retrievalMethod === 'search_snippet'
    || !page?.id || !pageDomain(page)) return null;
  const opening = `${page.title || ''} ${String(page.text || '').slice(0, 1800)}`;
  const titlePath = `${page.title || ''} ${new URL(page.url).pathname}`;
  const year = vehicle.manufacturingYear;
  if (!contains(opening, vehicle.brand) || !modelNameMatches(titlePath, vehicle.model)
    || year && ![page.title || '', ...String(page.text || '').split(/\r?\n/).slice(0, 25)
      .filter(line => contains(line, vehicle.model))]
      .some(line => new RegExp(`(?<!\\d)${year}(?!\\d)`).test(line))) return null;
  if (/\b(?:miniatura|diecast|brinquedo|toy|scale model)\b/iu.test(titlePath)) return null;
  return `${page.title || ''}. ${String(page.text || '').slice(0, 350)}`.trim();
}

function bridgeFleetStandards(entries, pages, vehicle) {
  if (!equipmentProfile(vehicle)) return;
  const byId = new Map(pages.map(page => [page.id, page]));
  const modelPages = pages.map(page => ({ page, claim: modelPeriodClaim(page, vehicle) }))
    .filter(item => item.claim);

  for (const entry of entries.values()) {
    if (entry.identityType === 'vehicle_display_color') continue;
    const standards = entry.sources.map(source => ({ source, page: byId.get(source.page_id) }))
      .filter(item => item.page && fleetStandardClaim(item.page, entry.name, vehicle));
    if (!standards.length) continue;

    const model = modelPages.find(item => standards.some(standard =>
      pageDomain(standard.page) !== pageDomain(item.page)));
    if (!model) continue;
    if (entry.sources.some(source => source.page_id === model.page.id)) continue;

    for (const { source, page } of standards) {
      source.claimScope = 'fleet_standard_paint';
      const claim = fleetStandardClaim(page, entry.name, vehicle);
      if (claim && !source.evidence.includes(claim)) source.evidence.push(claim);
    }
    if (!entry.sources.some(source => source.page_id === model.page.id)) {
      entry.sources.push({ page_id: model.page.id, url: model.page.url,
        evidence: [model.claim], claimScope: 'model_period_context' });
    }
    entry.identityType ||= 'fleet_standard_paint';
  }
}

function bridgeSharedPaintLeads(entries, pages) {
  const byId = new Map(pages.filter(page => page?.id).map(page => [page.id, page]));

  for (const entry of entries.values()) {
    const donorSources = entry.sources.filter(source => byId.get(source.page_id)?.sharedPaintDonor);
    if (!donorSources.length) continue;

    for (const source of donorSources) {
      const donorPage = byId.get(source.page_id);
      const claimPage = byId.get(donorPage.sharedPaintClaimPageId);
      const claim = claimPage?.sharedPaintClaims?.find(item => item.donorMake === donorPage.sharedPaintDonor);
      if (!claim || !claimPage?.url) continue;

      source.claimScope = 'shared_paint_candidate';
      if (!entry.sources.some(item => item.page_id === claimPage.id)) {
        entry.sources.push({ page_id: claimPage.id, url: claimPage.url,
          evidence: [claim.passage], claimScope: 'shared_paint_context' });
      }
      entry.identityType ||= 'shared_paint_lead';
    }
  }
}

module.exports = { fleetStandardClaim, modelPeriodClaim, bridgeFleetStandards,
  bridgeSharedPaintLeads, pageDomain };
