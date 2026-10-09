const { finishRelation, combineFinishRelations } = require('./paint_finish');

// These are catalog suffixes, not rules for arbitrary web text. Slash annotations
// (CL, LF, LG, EC, etc.) and layer labels do not establish the finished effect.
const SUFFIXES = {
  pearl: /^(?:pearl|pearlescent|prl|perol|perolizad[oa]|perleffekt|mica)$/,
  metallic: /^(?:met|metallic|metalic[oa]|metalizad[oa]|metalleffekt)$/,
  solid: /^(?:lis|lis[oa]|solid|solid[oa])$/,
  matte: /^(?:mat|matte|matt|fosc[oa])$/,
  satin: /^(?:satin|acetinad[oa]|satinad[oa])$/,
  gloss: /^(?:gloss|glossy|brilhante)$/,
  tricoat: /^(?:tricoat|tricamada)$/,
};

function catalogFinishRelation(description, requested) {
  const text = String(description || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const words = text.split('/')[0].replace(/\([^)]*\)/g, ' ').match(/[a-z0-9]+/g) || [];
  const effects = [];

  while (words.length) {
    const word = words.pop();

    if (/^(?:base|efeito|b|e|ii|iii|iv|lf|lg|cl)$/.test(word)) continue;

    const effect = Object.keys(SUFFIXES).find(key => SUFFIXES[key].test(word));

    if (!effect) break;

    effects.push(effect);
  }

  // A combined solid/effect label is conflicting, not a definite mismatch.
  if (effects.includes('solid') && effects.some(effect => ['pearl', 'metallic'].includes(effect))) return 'conflict';
  if (['matte', 'satin', 'gloss'].filter(effect => effects.includes(effect)).length > 1) return 'conflict';

  // A solid base layer is not proof that the complete paint system is solid.
  if (effects.includes('solid') && /\(\s*(?:base|b)\s*\)|\bbase\b/.test(text)) return 'unknown';

  return finishRelation(effects.join(' '), requested);
}

function catalogFinishEvidence(row, requested) {
  const evidence = new Map();

  for (const description of [row.description, ...(row.finish_descriptions || [])]) {
    const relation = catalogFinishRelation(description, requested);
    if (relation !== 'unknown' && !evidence.has(relation)) evidence.set(relation, description);
  }

  return { relation: combineFinishRelations([...evidence.keys()]),
    evidence: [...evidence].map(([relation, description]) => ({ relation, description })) };
}

// Called only after the matcher establishes name/code identity. A retrieval lead
// alone must never remove a color. Failed/empty matches retain unknown candidates.
function applyMatchedFinish(color, alternatives, requested, onExcluded = () => {}) {
  if (!requested) return { ...color, code_candidates: alternatives };

  const web = color._finishRelations || [color.finishMatch === 'confirmed' ? 'compatible'
    : color.finishMatch === 'incompatible' ? 'incompatible' : 'unknown'];
  const decisions = alternatives.map(row => ({ row,
    relation: combineFinishRelations([...web, row.finish_relation || 'unknown']) }));
  const kept = decisions.filter(entry => entry.relation !== 'incompatible');
  const relation = alternatives.length ? (kept.length
    ? kept.every(entry => entry.relation === 'compatible') ? 'compatible' : 'unknown'
    : 'incompatible') : combineFinishRelations(web);

  if (relation === 'incompatible') {
    onExcluded({ name: color.name, reason: 'incompatible_finish', requested,
      web, codes: decisions.map(({ row, relation }) => ({ code: row.universal_code,
        relation, evidence: row.finish_evidence || [] })) });
    return null;
  }

  return { ...color, _finishRelations: web, finishMatch: relation === 'compatible' ? 'confirmed' : 'unknown',
    ...(relation !== 'compatible' && { confidence: 'low' }),
    code_candidates: kept.map(({ row }) => row) };
}

module.exports = { catalogFinishRelation, catalogFinishEvidence, applyMatchedFinish };
