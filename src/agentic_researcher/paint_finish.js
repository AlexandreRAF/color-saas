// Optical effect, surface sheen and coat count are separate constraints.
const normalize = text => String(text || '').normalize('NFKD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
const TERMS = {
  pearl: /\b(?:pearl|pearlescent|pearlized|pearlised|perolizad[oa]|perlad[oa]|nacre)\b/,
  metallic: /\b(?:metallic|metallics|metalic[oa]|metalizad[oa])\b/,
  solid: /\b(?:solid|solids|solid[oa]|lis[oa])\b/,
  matte: /\b(?:matte|matt|fosc[oa]|mate)\b/,
  satin: /\b(?:satin|acetinad[oa]|satinad[oa])\b/,
  gloss: /\b(?:gloss|glossy|brilhante|alto brilho)\b/,
  tricoat: /\b(?:tri ?coat|three coat|3 coat|tri ?camada)\b/,
};

const LOCAL = { pearl: 'perolizado', metallic: 'metálico', solid: 'sólido',
  matte: 'fosco', satin: 'acetinado', gloss: 'brilhante', tricoat: 'tricamada' };
const ENGLISH = { pearl: 'pearlescent', metallic: 'metallic', solid: 'solid',
  matte: 'matte', satin: 'satin', gloss: 'gloss', tricoat: 'tricoat' };

function signals(text) {
  // "High Solid" describes a product's solids content, not a solid-color
  // finish. Supplier product descriptions commonly use it for metallic paint.
  const value = normalize(text).replace(/\b(?:high|low|medium)\s+solids?\b/g, ' ');

  // Do not turn negated or alternative/product-range descriptions into proof.
  if (Object.values(TERMS).some(pattern => new RegExp(
    `\\b(?:not|non|without|nao|sem)\\s+(?:(?:a|um|uma|efeito|acabamento|effect|finish)\\s+){0,2}${pattern.source}`,
  ).test(value))) return new Set();

  return new Set(Object.entries(TERMS).filter(([, pattern]) => pattern.test(value)).map(([key]) => key));
}

function normalizePaintFinish(value) {
  if (value == null || (typeof value === 'string'
    && ['', 'unknown', 'not specified', 'n/a', 'nao informado', 'não informado'].includes(value.trim().toLowerCase()))) return null;
  if (typeof value !== 'string' || value.trim().length > 100) throw new Error('paintFinish must be a string of at most 100 characters');

  const text = value.trim(), key = normalize(text);
  const match = Object.keys(TERMS).find(type => TERMS[type].test(key)
    && key.replace(TERMS[type], '').trim() === '');

  return match ? LOCAL[match] : text;
}

function finishSearchTerms(value, language = 'en') {
  if (!value) return '';
  const found = [...signals(value)];
  return found.length ? found.map(key => (language === 'pt' ? LOCAL : ENGLISH)[key]).join(' ') : value;
}

function finishRelation(text, requested) {
  const wanted = signals(requested), found = signals(text);

  if (!wanted.size || !found.size) return 'unknown';

  // Multiple effects can coexist. Metallic alone cannot disprove pearl.
  if (found.has('solid') && (found.has('pearl') || found.has('metallic'))) return 'unknown';

  const sheens = ['matte', 'satin', 'gloss'];

  if (sheens.filter(key => found.has(key)).length > 1) return 'unknown';
  if ((wanted.has('pearl') || wanted.has('metallic')) && found.has('solid')) return 'incompatible';
  if (wanted.has('solid') && (found.has('pearl') || found.has('metallic'))) return 'incompatible';
  if (sheens.some(key => wanted.has(key) && sheens.some(other => other !== key && found.has(other)))) return 'incompatible';

  return [...wanted].every(key => found.has(key)) ? 'compatible' : 'unknown';
}

function combineFinishRelations(relations) {
  const known = new Set(relations.filter(value => value && value !== 'unknown'));
  if (known.has('conflict') || (known.has('compatible') && known.has('incompatible'))) return 'conflict';
  return known.has('incompatible') ? 'incompatible' : known.has('compatible') ? 'compatible' : 'unknown';
}

// A canonical name may have lost a finish suffix. Remove the FULL published
// aliases before assessing descriptors, so that suffix cannot become new proof.
// Keep passages/rows separate: a neighboring catalog entry is not this paint.
function candidateFinishRelation(candidate, passages, requested) {
  const names = [...new Set([candidate.name, ...(candidate.aliases || [])].map(normalize))]
    .filter(Boolean).sort((a, b) => b.length - a.length);
  const relations = passages.flatMap(passage => passage.replace(/https?:\/\/[^\s)]+/g, '').split(/[,;\r\n]+/))
    .flatMap(line => {
      let text = normalize(line);

      if (!names.some(name => text.includes(name))) return [];

      for (const name of names) text = text.replaceAll(name, '');

      // A palette sentence can contain another paint's marketing name (for
      // example a Satin shade). It is not a finish specification for this row.
      if (/\b(?:cores|colors|colours|palette|paleta)\b/.test(text)
        && !/\b(?:finish|acabamento|effect|efeito|type|tipo)\s*[:=]/.test(text)) return [];

      // Generic product ranges cannot establish an individual paint's finish.
      if (/\b(?:available in|our paints?|we offer|range of|disponivel em)\b/.test(text)) return [];

      return [finishRelation(text, requested)];
    });

  return combineFinishRelations(relations);
}

const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

function finishReviewSchema(schema, input) {
  if (!input.vehicle.paintFinish) return schema;

  return object(Object.fromEntries(Object.entries(schema.properties).map(([id, decision]) => {
    const candidate = input.candidates.find(candidate => candidate.id === id);
    const ids = [...new Set(candidate.sources.flatMap(source => source.evidence_ids))];

    return [id, { anyOf: decision.anyOf.map(branch => {
      if (!branch.properties?.action && !branch.properties?.alias_of) return branch;
      return object({ ...branch.properties,
        finish_status: { type: 'string', enum: ['compatible', 'unknown', 'incompatible'] },
        finish_evidence_ids: { type: 'array', items: { type: 'string', enum: ids } } });
    }) }];
  })));
}

// Finish decisions use the same evidence
// dictionary and the same model call, with literal citation checks in code.
function finishDecisions(result, input, { deferExclusions = false } = {}) {
  if (!input.vehicle.paintFinish) return result;

  return Object.fromEntries(input.candidates.map(candidate => {
    const row = result[candidate.id];

    if (typeof row === 'string' || row?.exclude_reason) return [candidate.id, row];

    const allowed = new Set(candidate.sources.flatMap(source => source.evidence_ids));

    if (!row || !['compatible', 'unknown', 'incompatible'].includes(row.finish_status)
      || !Array.isArray(row.finish_evidence_ids)
      || row.finish_evidence_ids.some(id => !allowed.has(id) || !input.evidence[id])) {
      throw new Error(`Invalid paint-finish evidence for ${candidate.id}`);
    }

    if (row.finish_status !== 'unknown' && !row.finish_evidence_ids.length) {
      throw new Error(`Missing paint-finish evidence for ${candidate.id}`);
    }

    const text = row.finish_evidence_ids.map(id => input.evidence[id]).join('\n')
      .replace(/https?:\/\/[^\s)]+/g, '');

    if (row.finish_status !== 'unknown' && ![candidate.name, ...(candidate.aliases || [])]
      .some(name => normalize(text).includes(normalize(name)))) {
      throw new Error(`Paint-finish evidence must include the candidate name for ${candidate.id}`);
    }

    // A finish word embedded in a distinctive name (e.g. Ivory Pearl) or URL
    // does not prove its finish. A separately printed descriptor still can.
    const supported = candidateFinishRelation(candidate,
      row.finish_evidence_ids.map(id => input.evidence[id]), input.vehicle.paintFinish);
    const sourceRelations = candidate.sources.map(source => candidateFinishRelation(candidate,
      source.evidence_ids.map(id => input.evidence[id]), input.vehicle.paintFinish));
    const conflictingSources = combineFinishRelations(sourceRelations) === 'conflict';
    const status = !conflictingSources && row.finish_status === supported ? supported : 'unknown';

    if (status === 'incompatible' && !deferExclusions) return [candidate.id, { exclude_reason: 'incompatible_finish',
      reason: `Acabamento incompatível com ${input.vehicle.paintFinish}; evidências: ${row.finish_evidence_ids.join(', ')}.` }];

    const { finish_status, finish_evidence_ids, ...decision } = row;

    return [candidate.id, { ...decision,
      finishMatch: status === 'compatible' ? 'confirmed' : status,
      ...(deferExclusions && { _finishRelations: conflictingSources ? ['compatible', 'incompatible'] : [status] }),
      ...(status === 'unknown' && decision.action === 'include' && { confidence: 'low' }) }];
  }));
}

const FINISH_REVIEW_INSTRUCTIONS = `
The vehicle's paintFinish is an additional constraint. First exclude unrelated vehicle/hue/non-paint candidates using the ordinary exclusion response; no finish assessment is needed for them. For otherwise plausible include/alias decisions, return finish_status and finish_evidence_ids. Do NOT use an ordinary exclusion solely for finish: incompatible finish is handled through these two fields.
Check the candidate's own documented finish, using its evidence dictionary IDs. Cite every needed name/code row and finish statement. Never borrow a neighboring paint's finish or a seller's generic product-range description. Marketing words alone are not definitive finish specifications. Compatible requires evidence; unknown finish stays included at low confidence when otherwise applicable. Incompatible requires explicit contradictory finish evidence. Mixed/conflicting reports are unknown, not automatic exclusion. Never require positive proof of the requested finish as a condition for inclusion. Finish exclusions are finalized programmatically after database identity matching and cross-checking.
Aliases preserve the full published names before normalization. A finish word removed from an alias is still part of that name, not independent finish evidence. Do not confirm a shortened name just because its longer alias contains Pearl, Metallic or Solid. Keep the complete source identity and printed code distinct from other paints sharing the shorter name; let the database cross-check establish finish when the page has no separate specification.
Perolizado means pearl/pearlescent; metálico means metallic; sólido means solid; fosco means matte; acetinado means satin; brilhante means gloss. Optical effect and sheen are separate: pearl can also be matte. Metallic can coexist with pearl. Tricoat describes coat count and does not by itself establish pearl. Never infer finish from white/silver hue, the requested input, or a code alone. Do not invent finish words in paint names.`;

module.exports = { normalizePaintFinish, finishSearchTerms, finishRelation,
  combineFinishRelations, candidateFinishRelation, finishReviewSchema, finishDecisions, FINISH_REVIEW_INSTRUCTIONS };
