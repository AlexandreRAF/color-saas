'use strict';

const { readFile } = require('./agentic_loop_helpers');
const { reviewSchema, reviewedColors } = require('./candidate_inventory');
const { completePaintName, paintIdentityKey } = require('./paint_name');
const { candidateSourceCodes, printedNameKey } = require('./paint_evidence');
const { reviewInput } = require('./review_input');
const { brandKey, eligibleCandidateIds } = require('./database_code_agent');
const { finishReviewSchema, finishDecisions, FINISH_REVIEW_INSTRUCTIONS } = require('./paint_finish');
const { communicationSchema, COMMUNICATION_INSTRUCTIONS, extractDetails,
  individualSchema, individualDecision, INDIVIDUAL_INSTRUCTIONS } = require('./targeted_extractor');
const { hueFamilies } = require('./hue_review');

function compactCatalogRows(rows) {
  const groups = new Map();
  const identities = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.catalog, row.description, row.manufacturer,
      row.universal_code, row.paintFinish, row.model, row.model_match]);
    if (!groups.has(key)) {
      groups.set(key, { candidate_id: row.candidate_id, catalog: row.catalog, description: row.description,
        manufacturer: row.manufacturer, universal_code: row.universal_code, years: [],
        paintFinish: row.paintFinish, ...(row.model && { model: row.model, model_match: row.model_match }) });
      identities.set(row.candidate_id, []);
    }
    const group = groups.get(key);
    if (!group.years.includes(row.year)) group.years.push(row.year);
    identities.get(group.candidate_id).push(row.candidate_id);
  }
  return { rows: [...groups.values()], identities };
}

function catalogNameExpansion(candidate, rows, vehicle) {
  if (!candidate.name_check || !vehicle.brand) return null;
  const observed = new Set(candidate.sources.flatMap(source => candidateSourceCodes(candidate, source))
    .map(code => code.toUpperCase()));
  const short = printedNameKey(candidate.name);
  const matches = rows.filter(row => ['basf', 'lazzumix'].includes(row.catalog)
    && brandKey(row.manufacturer) === brandKey(vehicle.brand)
    && row.universal_code && observed.has(row.universal_code.toUpperCase()));
  const cleanName = description => String(description).replace(/\/(?:CL|COL|LF|LQ|LG)\b.*$/i, '').trim();
  const rawKey = description => cleanName(description).normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  // A catalog row with the same code may name a different paint when a page
  // extractor accidentally reads a neighboring swatch's code. An expansion
  // must contain the printed short name as whole words; independent alias
  // research handles names that are genuinely different in another language.
  const named = matches.filter(row => (` ${rawKey(row.description)} `).includes(` ${short} `)
    && rawKey(row.description) !== short);
  const namedBasf = named.filter(row => row.catalog === 'basf');
  // A wholly different catalog spelling needs a paint-owned, explicitly
  // labelled code. An unlabelled list of neighboring swatch codes cannot
  // rename Tornadorot to Tungsten Silver or another unrelated identity.
  const basf = matches.filter(row => row.catalog === 'basf');
  const labelledCode = row => candidate.sources.some(source => source.evidence.some(passage =>
    passage.length <= 350 && rawKey(passage).includes(short)
      && passage.toUpperCase().includes(row.universal_code.toUpperCase())
      && /\b(?:(?:mfr\.?|manufacturer)\s*)?(?:paint|colou?r)\s+code\b|\bc[oó]digo\s+(?:d[ae]\s+)?(?:cor|tinta)\b/iu
        .test(passage)));
  const directAliases = basf.filter(labelledCode);
  // Catalog years describe the record, not the entire paint's vehicle
  // applicability. The source still supplies the model link.
  const usable = namedBasf.length ? namedBasf : named.length ? named
    : candidate.name.trim().split(/\s+/u).length === 1
      && directAliases.length
      && new Set(directAliases.map(row => row.universal_code.toUpperCase())).size === 1
      ? directAliases : [];
  const names = [...new Set(usable.map(row => completePaintName(cleanName(row.description))
    .replace(/\s+MET\.?$/i, ' Metallic')))];

  return names.length === 1 ? { name: names[0], code: usable[0].universal_code } : null;
}

function retainCatalogHuePossibility(candidate, decisions, wanted) {
  const decision = decisions[candidate.id];
  if (decision?.exclude_reason !== 'unrelated_hue'
    || !candidate.catalog_check?.hue_hints?.length
    || !candidate.sources?.some(source => /^https?:/.test(source.url || ''))) return decisions;

  // A name like "Hyper" does not state its visual hue. An exact, same-make,
  // source-code catalog alias in the requested family defeats a confident hue
  // exclusion. Explicitly named opposing hues still need the normal review.
  const namedHues = hueFamilies(candidate.name);
  if (namedHues.size && ![...namedHues].some(hue => wanted.has(hue))) return decisions;

  return { ...decisions, [candidate.id]: {
    action: 'include', name: candidate.name, source_ids: candidate.sources.map(source => source.page_id),
    confidence: 'low', name_status: 'complete',
    reason: 'Model-linked source and same-code catalog leave the requested visual hue possible.',
  } };
}

function catalogHueHints(candidate, rows, vehicle) {
  if (!candidate.name_check) return [];
  const wanted = hueFamilies(vehicle.predominantColor);
  if (!wanted.size) return [];
  const sameMake = rows.filter(row => brandKey(row.manufacturer) === brandKey(vehicle.brand));
  const exactCodes = new Set(sameMake.filter(row => row.complete_name_match || row.name_match === 'all_words')
    .map(row => row.universal_code).filter(Boolean));
  return [...new Set(sameMake.filter(row => row.source_code_match || exactCodes.has(row.universal_code))
    .flatMap(row => [row.description, ...(row.finish_descriptions || [])])
    .filter(name => [...hueFamilies(name)].some(family => wanted.has(family))))].slice(0, 3);
}

// A different catalog's same-code name is useful hue evidence. Keep the code
// link and provenance visible to the independent hue reviewer; do not reject
// from a commercial name alone.
function catalogHueAliases(rows, vehicle) {
  const wanted = hueFamilies(vehicle.predominantColor);
  if (!wanted.size) return [];
  const sameMake = rows.filter(row => brandKey(row.manufacturer) === brandKey(vehicle.brand));
  const exactCodes = new Set(sameMake.filter(row => row.complete_name_match)
    .map(row => row.universal_code).filter(Boolean));

  return sameMake.filter(row => exactCodes.has(row.universal_code)
    && [...hueFamilies(row.description)].some(family => !wanted.has(family)))
    .map(row => ({ name: row.description, code: row.universal_code, catalog: row.catalog }))
    .slice(0, 4);
}

// Review one candidate against web/catalog evidence, with one optional
// extractor follow-up. Only final approved decisions enter code matching.
async function reviewCandidate(run, candidate, vehicle, reviewSignal, stage, recovery = {}) {
  const batch = [candidate];
  const catalog = await run.catalogs.get(batch[0]);

  if (catalog.status === 'error') throw new Error(`Required catalog lookup failed for ${batch[0].name}: ${catalog.error}`);
  const expansion = catalogNameExpansion(batch[0], catalog.candidates, vehicle);
  if (expansion) batch[0].name_check.catalog_expansion = expansion;

  const eligible = eligibleCandidateIds(catalog.candidates, vehicle.brand, vehicle.manufacturingYear,
    candidate.sources.map(source => ({ passages: source.evidence })), candidate.name);
  // An independent audit must be able to challenge an earlier catalog choice.
  const compacted = compactCatalogRows((!candidate.omission_check && catalog.selected.length ? catalog.selected : catalog.candidates)
    .filter(row => eligible.has(row.candidate_id)));
  batch[0].catalog_check = { status: catalog.status, catalogs_queried: catalog.catalogs_queried,
    rows: compacted.rows, hue_hints: catalogHueHints(batch[0], catalog.candidates, vehicle),
    hue_aliases: catalogHueAliases(catalog.candidates, vehicle) };

  let input = reviewInput(vehicle, batch, run.evidencePages());
  if (recovery.issue) input.review_issue = recovery.issue;
  const compact = run.options.batchReviews !== false;
  const instructions = readFile(compact ? 'prompts/research_review_compact.md' : 'prompts/research_review.md') + `

MANDATORY FILTER FOR THIS REQUEST:
predominantColor = ${JSON.stringify(vehicle.predominantColor)};
normalized hue words = ${JSON.stringify(paintIdentityKey(vehicle.predominantColor))}.
If specified, exclude a hue only when this candidate's source evidence establishes a clearly unrelated visual family. A different hue word in its commercial name alone is insufficient. Read descriptions, explicit hue categories and documented undertones; keep uncertain or conflicting appearance eligible. Silver/prata/plata/argento/silber and gray/grey/cinza/gris/grigio/grau form one comparison family in both directions. Preserve the published name and normal vehicle/finish checks. Missing year does NOT cancel the requested color family.`
    + (!hueFamilies(vehicle.predominantColor).size
      ? '\nNo predominant color was specified. Review all exterior hue families; unrelated_hue is not a valid exclusion.' : '')
    + (!compact && vehicle.paintFinish ? FINISH_REVIEW_INSTRUCTIONS : '')
    + (candidate.identityType === 'manufacturer_paint_lead' ? `

MANUFACTURER PAINT LEAD: This candidate was found only after the model search yielded no model-linked named paint. A supplier's complete, manufacturer-named refinish shade is eligible as a low-confidence comparison lead if the cited product title actually names that shade and the requested hue is plausible. It does not prove application to the requested model or year. Keep vehicle/year applicability and finish unknown unless separately documented. Exclude generic coatings, unrelated makers, component-only colors and unsupported names. Product SKUs and package numbers are not vehicle paint codes. Cite only this candidate's sources.` : '');

  const baseSchema = finishReviewSchema(reviewSchema(batch), input);
  const individual = run.options.batchReviews !== false || run.routing.candidateReviewQwen !== false;
  const noHueRequested = !hueFamilies(vehicle.predominantColor).size;
  const assertHueDecision = decision => {
    if (noHueRequested && (decision === 'unrelated_hue'
      || decision?.exclude_reason === 'unrelated_hue')) {
      throw new Error('A hue exclusion requires a requested predominant color');
    }
  };
  const validateReview = value => {
    if (value.catalog_ids?.some(id => !batch[0].catalog_check.rows.some(row => row.candidate_id === id))) {
      throw new Error('Review selected an unknown catalog identity');
    }
    const parsed = individual ? individualDecision(value, candidate, vehicle) : value;
    const decision = parsed[candidate.id]?.decision || parsed[candidate.id];
    assertHueDecision(decision);
    reviewedColors(batch, finishDecisions({ [candidate.id]: decision }, input, { deferExclusions: true }));
  };

  let reviewed = await run.mainAgent(stage, individual ? individualSchema(batch[0], input)
    : communicationSchema(baseSchema, batch[0]), input,
    instructions + (compact ? '' : COMMUNICATION_INSTRUCTIONS + (individual ? INDIVIDUAL_INSTRUCTIONS : '')),
    reviewSignal, validateReview, recovery);

  const rememberCatalog = value => {
    if (!Array.isArray(value.catalog_ids)) return;
    const selected = new Set(value.catalog_ids.flatMap(id => compacted.identities.get(id) || []));
    catalog.selected = catalog.candidates.filter(row => selected.has(row.candidate_id));
    catalog.status = catalog.selected.length ? 'matched' : 'no_match';
  };
  rememberCatalog(reviewed);
  if (individual) reviewed = individualDecision(reviewed, batch[0], vehicle);

  const request = reviewed[batch[0].id];

  if (request?.request_details) {
    reviewed = { [batch[0].id]: request.decision };

    const provisionalInput = input;

    try {
      if (run.timing.remainingMs(reviewSignal) < 1200) throw new Error('Insufficient review time for targeted extraction');

      run.log('extractor_detail_request', { candidate: batch[0].name, ...request.request_details });

      const detail = await (run.options.extractDetailsFn || extractDetails)(batch[0], request.request_details,
        run.evidencePages(), vehicle, { review: run.mainAgent.bind(run), signal: reviewSignal,
          codes: catalog.selected.map(row => row.universal_code).filter(Boolean) });

      // Replace this candidate's evidence only; first-pass extraction stays intact.
      Object.assign(batch[0], detail.candidate);
      input = reviewInput(vehicle, batch, run.evidencePages());
      input.extractor_reply = { question: request.request_details.question, addedPassages: detail.passages };
      run.log('extractor_detail_reply', { candidate: batch[0].name, passages: detail.passages });
      reviewed = await run.mainAgent(`${stage}_followup`, individual ? individualSchema(batch[0], input, true)
        : finishReviewSchema(reviewSchema(batch), input), input,
        instructions + (!compact && individual ? INDIVIDUAL_INSTRUCTIONS : '')
        + '\nThis is the final decision after your targeted extraction reply. Keep unresolved facts unknown. Do not request another extraction.', reviewSignal, validateReview);

      rememberCatalog(reviewed);
      if (individual) reviewed = individualDecision(reviewed, batch[0], vehicle);
    } catch (error) {
      // Evidence IDs belong to the input used for that decision. A failed
      // follow-up must not reinterpret them against the expanded input.
      input = provisionalInput;
      reviewed = { [batch[0].id]: request.decision };
      run.warn('targeted_extraction', error);
    }
  }

  const decisions = retainCatalogHuePossibility(batch[0],
    finishDecisions(reviewed, input, { deferExclusions: true }), hueFamilies(vehicle.predominantColor));
  assertHueDecision(decisions[candidate.id]);
  reviewedColors(batch, decisions); // Validate every decision/citation first.

  return decisions;
}

module.exports = { reviewCandidate, compactCatalogRows, catalogNameExpansion, catalogHueHints,
  catalogHueAliases, retainCatalogHuePossibility };
