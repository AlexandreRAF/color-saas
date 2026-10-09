// Explicit live evaluation (uses paid APIs). Not part of node --test.
const fs = require('node:fs');
const path = require('node:path');

// npm --prefix runs from this backend; always load the repository environment.
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const { AgenticLoop } = require('./ai');
const { lookupKey } = require('./catalog_research');
const { matchesReference, COROLLA_PEARL_070 } = require('./vehicle_reference_checks');
const { DEFAULT_TARGET_TIME_MS, DEFAULT_MAX_TIME_MS } = require('./research_deadlines');

const cases = {
  ix35: { brand: 'Hyundai', model: 'ix35', predominantColor: 'prata' },
  azera: { brand: 'Hyundai', model: 'Azera', manufacturingYear: 2017, predominantColor: 'branco', paintFinish: 'perolizado' },
  corolla: { brand: 'Toyota', model: 'Corolla', manufacturingYear: 2018, predominantColor: 'branco', paintFinish: 'perolizado' },
  gol: { brand: 'Volkswagen', model: 'Gol', manufacturingYear: 2015, predominantColor: 'prata' },
  puma: { brand: 'Puma', model: 'Puma GTS', manufacturingYear: 1978, predominantColor: 'vermelho' },
  cruze: { brand: 'Chevrolet', model: 'Cruze', manufacturingYear: 2018 },
  s10: { brand: 'Chevrolet', model: 'S10', manufacturingYear: 2025 },
  versa: { brand: 'Nissan', model: 'Versa', manufacturingYear: 2017,
    predominantColor: 'cinza', paintFinish: 'perolizado' },
  saveiro: { brand: 'Volkswagen', model: 'Saveiro', manufacturingYear: 2015,
    predominantColor: 'vermelho' },
};

// Reference identities belong in evaluations, never in production research.
const references = {
  ix35: { name: /^Shimmering Silver$/i, code: 'N3S' },
  azera: { name: /^Ice White$/i },
  // https://www.lincetoyota.com.br/wp-content/uploads/2017/10/Catalogo-Corolla.pdf
  // Toyota's Brazilian 2018 brochure lists Branco Perolizado (070). Branco
  // Lunar (089) appears in later brochures, so do not require it for 2018.
  // International catalogs may print the 070 paint under these full names.
  corolla: { name: /^(?:Branco Perolizado|White Crystal Shine|Blizzard Pearl)$/i, code: '070' },
  gol: { name: /^Cinza Platinum$/i, code: 'LD7X' },
  puma: { name: /^Vermelho Mont(?:e)? Carlo$/i },
  cruze: { name: /^Prata Switchblade$/i },
  s10: { name: /^Prata Shark$/i },
  versa: { name: /^Cinza Titanium$/i },
  // Volkswagen's 2015 Saveiro brochure prints both reds, including the
  // metallic Opera, under the model's exterior-color table.
  // https://blog.le-parnass.com/catalogue_pdf/vw_saveiro_cross.pdf
  saveiro: { name: /^Vermelho Ópera$/i },
};

function acceptance(label, result, events, candidates = []) {
  const reference = references[label];
  const colors = result.colors || [];
  const checked = events.filter(event => event.event === 'catalog_candidate_checked');
  const names = new Set(checked.map(lookupKey));
  const coverage = result.research?.reviewCoverage;
  const omissions = result.research?.omissionReview;
  const matching = result.research?.matchingCoverage;
  // A fully processed historical/specialist search can still have only
  // manufacturer-scoped comparisons. Keep the output partial, but do not call
  // the processing itself incomplete when this is its sole limitation.
  const evidenceOnlyLimit = result.completion?.status === 'partial'
    && result.completion.issues?.length === 1
    && result.completion.issues[0] === 'no_model_linked_colors'
    && result.paletteScope?.modelCandidates === 0
    && result.paletteScope?.manufacturerLeads === colors.length;
  const checks = {
    successful: !result.error && colors.length > 0,
    processingComplete: result.completion?.status === 'complete' || evidenceOnlyLimit,
    searchCreditsAvailable: !events.some(event => event.details?.code === 'SEARCH_CREDITS_EXHAUSTED'),
    referenceFound: colors.some(color => reference.name.test(color.name)
      && (!reference.code || color.codes?.some(code => code.split(/[,/;]/).map(c => c.trim()).includes(reference.code)))),
    uniqueDisplayNames: new Set(colors.map(color => color.name.toLocaleLowerCase('pt-BR'))).size === colors.length,
    // R-M's Hyundai chart links IX35, WJX and Hyper met; the short "Hyper"
    // retailer label alone cannot distinguish Hyundai's other Hyper paints.
    // https://www.rmpaint.com/data/sites/rm/files/2024-02/R-M_Schemi_colori__auto_2010%5B1%5D.pdf
    ...(label === 'ix35' && { hyperWjxFound: colors.some(color => /^Hyper (?:Metallic|Met)$/i.test(color.name)
      && color.codes?.some(code => code.split(/[,/;]/).map(part => part.trim()).includes('WJX'))) }),
    ...(label === 'corolla' && { pearl070Found: colors.some(color =>
      matchesReference(color, COROLLA_PEARL_070, result.vehicle?.make || cases[label].brand)) }),
    ...(label === 'gol' && { noKnownRedCatalogAlias: !colors.some(color =>
      color.name.toLocaleLowerCase('pt-BR') === 'muranorot perleffekt') }),
    ...(label === 'saveiro' && {
      flashAlsoFound: colors.some(color => /^Vermelho Flash$/i.test(color.name)),
      noSilverOrGray: !colors.some(color => /\b(?:silver|silber|gray|grey|grau|cinza|prata)\b/iu.test(color.name)),
    }),
    allCatalogsQueried: checked.length > 0 && checked.every(event => ['lazzumix', 'basf', 'basf_models'].every(catalog => event.catalogs.includes(catalog)))
      && candidates.every(candidate => names.has(lookupKey(candidate))),
    everyCandidateReviewed: !(result.research?.unreviewedNames?.length
      || result.research?.unreviewedCandidates?.length)
      && !!coverage && coverage.unreviewed === 0 && Number.isInteger(coverage.reviewed)
      && coverage.reviewed > 0 && coverage.total === coverage.reviewed,
    ...(result.verification && { everyFinalColorReviewed: colors.length > 0
      && colors.every(color => color.verification?.reviewed === true)
      && result.verification.colorsChecked === colors.length && result.verification.colorsUnchecked === 0
      && result.verification.colorsTotal === colors.length }),
    everyCodeMatchCompleted: !!matching && Number.isInteger(matching.total) && matching.total > 0
      && matching.completed === matching.total && matching.incomplete === 0 && !matching.incompleteNames?.length,
    omissionReviewComplete: !!omissions && omissions.status !== 'disabled' && Number.isInteger(omissions.total)
      && omissions.total >= 0 && omissions.checked === omissions.total && omissions.incomplete === 0 && !omissions.repairFailures,
    noConfirmedSolidForPearl: cases[label].paintFinish !== 'perolizado'
      || colors.every(color => !color.paintFinish?.includes('sólido')),
    deadline: result.timeMs <= DEFAULT_MAX_TIME_MS + 500, // Serialization/timer bookkeeping allowance.
    cost: (Number.isFinite(result.usage?.upperBoundUsd) && result.usage.upperBoundUsd <= 0.065
      && Number.isFinite(result.totalUpperBoundUsd) && result.totalUpperBoundUsd <= 0.08)
      || (result.usage?.costComplete === true && Number.isFinite(result.usage.estimatedCostUsd)
        && result.usage.estimatedCostUsd <= 0.065 && Number.isFinite(result.totalEstimatedCostUsd)
        && result.totalEstimatedCostUsd <= 0.08),
  };

  return { passed: Object.values(checks).every(Boolean),
    targetMet: result.timeMs <= DEFAULT_TARGET_TIME_MS + 500,
    qualityPassed: Object.entries(checks).filter(([key]) => !['deadline', 'cost'].includes(key)).every(([, value]) => value), checks };
}

function routeOutcomes(events) {
  const routes = new Map();
  for (const event of events) {
    if (!['model_route_start', 'model_route_complete', 'model_route_fallback'].includes(event.event)) continue;
    const key = `${event.kind || 'unknown'}:${event.provider}:${event.model}`;
    const row = routes.get(key) || { kind: event.kind || 'unknown', provider: event.provider,
      model: event.model, started: 0, completed: 0, failedAttempts: 0, completedMs: 0 };
    if (event.event === 'model_route_start') row.started++;
    if (event.event === 'model_route_complete') {
      row.completed++;
      row.completedMs += event.durationMs || 0;
    }
    if (event.event === 'model_route_fallback') row.failedAttempts++;
    routes.set(key, row);
  }
  return [...routes.values()].map(row => ({ ...row, completedMs: Math.round(row.completedMs) }));
}

async function evaluate(label, directory = path.resolve(__dirname, '..', 'tmp', 'catalog-vehicle-evaluation')) {
  if (!Object.hasOwn(cases, label)) throw new Error(`Choose one of: ${Object.keys(cases).join(', ')}`);

  const events = [];
  const vehicle = { automobileType: 'car', country: 'Brazil', ...cases[label] };
  const loop = new AgenticLoop({ onProgress: event => events.push(event) });
  const result = await loop.loop(vehicle);

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${label}.json`), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(directory, `${label}-events.json`), JSON.stringify(events, null, 2));

  const cache = events.filter(event => event.event === 'search_engine_http')
    .reduce((counts, event) => { const key = event.cache || 'unknown'; counts[key] = (counts[key] || 0) + 1; return counts; }, {});

  return { label, vehicle, runId: result.runId, error: result.error, timeMs: result.timeMs,
    searchCache: cache,
    acceptance: acceptance(label, result, events, loop.candidates()),
    cost: result.totalEstimatedCostUsd ?? result.usage?.estimatedCostUsd,
    costUpperBound: result.totalUpperBoundUsd ?? null,
    aiCost: result.usage?.estimatedCostUsd, aiCostUpperBound: result.usage?.upperBoundUsd ?? null,
    serperCost: result.serperCost?.estimatedCostUsd,
    totalAdmissionEstimateUsd: result.totalAdmissionEstimateUsd,
    modelCalls: events.filter(event => event.event === 'model_route_start').length,
    timing: result.timing,
    modelFallbacks: events.filter(event => event.event === 'model_route_fallback').length,
    capacityBypasses: events.filter(event => event.event === 'model_route_capacity_bypass').length,
    routeOutcomes: routeOutcomes(events),
    searchRetries: events.filter(event => event.event === 'search_engine_retry').length,
    reusedSections: events.filter(event => event.event === 'page_section_reused').length,
    byModel: result.usage?.byModel, verification: result.verification, completion: result.completion,
    browserUses: result.browserUses, pagesFetched: result.pagesFetched,
    research: result.research,
    warnings: result.warnings || result.research?.warnings || [],
    catalogChecks: events.filter(event => event.event === 'catalog_candidate_checked').length,
    detailRequests: events.filter(event => event.event === 'extractor_detail_request').length,
    colors: result.colors?.map(({ name, codes, paintFinish }) => ({ name, codes, paintFinish })) };
}

module.exports = { cases, evaluate, acceptance };

if (require.main === module) {
  require('./vehicle_test_runner').main(process.argv.slice(2))
    .then(code => { process.exitCode = code; })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
