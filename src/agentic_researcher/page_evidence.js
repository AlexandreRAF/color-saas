// Small numbered source units avoid generating the same quotations repeatedly.
// Every nonblank source character remains available; no relevance filtering occurs.
function evidenceUnits(text) {
  return text.split(/\r?\n/).flatMap((line) => {
    const units = [];
    let rest = line.trim();

    while (rest.length > 500) {
      const boundary = rest.lastIndexOf(' ', 500);
      const nextSpace = rest.indexOf(' ', 500);
      const end = boundary > 250 ? boundary : nextSpace === -1 ? rest.length : nextSpace;

      units.push(rest.slice(0, end));
      rest = rest.slice(end).trimStart();
    }

    if (rest) units.push(rest);

    return units;
  });
}

function restoreEvidence(candidate, units, breakBefore = -1) {
  const ids = candidate.evidence_ids;

  if (!Array.isArray(ids) || !ids.length
    || ids.some((id) => !Number.isInteger(id) || id < 1 || id > units.length)) return null;

  // Join adjacent units so a long name or applicability statement can cross a boundary.
  const passages = [];
  let previous = -1;

  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    if (id === previous + 1 && id !== breakBefore) passages[passages.length - 1] += `\n${units[id - 1]}`;
    else passages.push(units[id - 1]);
    previous = id;
  }

  return { name: candidate.name, evidence: passages };
}

function visibleUnit(unit) {
  return unit.replace(/https?:\/\/[^\s)]+/g, '[link]');
}

function extractionUnitLimit(text) {
  const units = evidenceUnits(text);
  const paintRows = units.filter(unit => /\b(?:silver|prata|gr[ae]y|cinza|white|branc[oa]|black|pret[oa]|red|vermelh[oa]|blue|azul|green|verde|yellow|amarel[oa]|gold|dourad[oa]|beige|bege|brown|marrom|metallic|pearl|perolizad[oa])\b/i.test(unit)).length;
  // Dense paint tables need short outputs. Navigation-heavy pages and prose
  // keep the character limit so short navigation lines do not multiply calls.
  return paintRows >= 24 && paintRows / units.length >= 0.25 ? 96 : Infinity;
}

function referenceSegments(text, maxChars = 12000, maxUnits = Infinity) {
  if (!Number.isFinite(maxChars) || maxChars < 1
    || maxUnits !== Infinity && (!Number.isInteger(maxUnits) || maxUnits < 1)) {
    throw new Error('Source segment limits must be positive');
  }
  const all = evidenceUnits(text);
  const groups = [];
  let start = 0;

  while (start < all.length) {
    let end = start;
    let size = 0;

    while (end < all.length && end - start < maxUnits
      && (end === start || size + visibleUnit(all[end]).length < maxChars)) {
      size += visibleUnit(all[end]).length + 8;
      end++;
    }

    groups.push(all.slice(start, end));

    if (end === all.length) break;

    // Overlap whole units; never split a word, code or table row between requests.
    let next = end;
    let overlap = 0;

    while (next > start + 1 && end - next < 12 && overlap < 800) overlap += visibleUnit(all[--next]).length + 8;

    start = next;
  }

  let contextEnd = 0;
  let contextSize = 0;

  while (contextEnd < all.length && contextEnd < 32 && contextSize < 1200) contextSize += all[contextEnd++].length;

  const context = all.slice(0, contextEnd);

  return groups.map((group, index) => {
    const units = index ? [...context, ...group] : group;
    return { units, text: units.map((unit, id) => `${id + 1}| ${visibleUnit(unit)}`).join('\n'),
      sourceText: group.join('\n'), breakBefore: index ? context.length + 1 : -1 };
  });
}

const referenceSchema = {
  type: 'object', additionalProperties: false, required: ['candidates'],
  properties: { candidates: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['name', 'evidence_ids'],
    properties: {
      name: { type: 'string', description: 'Entire published paint name, preserving all distinctive words.' },
      evidence_ids: { type: 'array', items: { type: 'integer' },
        description: 'Source unit IDs for the name, adjacent paint code, model/year scope and any limitations or exclusions.' },
    },
  } } },
};

module.exports = { evidenceUnits, restoreEvidence, referenceSchema, referenceSegments, extractionUnitLimit };
