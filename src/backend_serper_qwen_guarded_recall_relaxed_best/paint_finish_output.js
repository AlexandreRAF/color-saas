const { candidateFinishRelation, finishRelation } = require('./paint_finish');
const { catalogFinishRelation } = require('./lazzumix_finish');
const { stripPaintFinish } = require('./paint_name');

const FINISHES = ['sólido', 'metálico', 'perolizado', 'fosco', 'acetinado', 'brilhante', 'tricamada'];
const FINISH_WORDS = new Set(['solid', 'solido', 'solida', 'metallic', 'metalico', 'metalica',
  'metalizado', 'metalizada', 'met', 'pearlescent', 'perolizado', 'perolizada', 'pearl',
  'prl', 'matte', 'mate', 'fosco', 'fosca', 'satin', 'acetinado', 'acetinada',
  'gloss', 'brilhante', 'tricoat', 'tricamada']);

const words = text => String(text || '').normalize('NFKD').replace(/\p{M}/gu, '')
  .toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

// Some brochures put the finish in the cell immediately below the paint name.
// Accept only a complete name followed by a standalone finish cell, so a
// neighboring color's description cannot be borrowed.
function adjacentFinishRelations(candidate, passages, finish) {
  const names = new Set([candidate.name, ...(candidate.aliases || [])]
    .map(name => words(name).join(' ')).filter(Boolean));

  return passages.flatMap(passage => {
    const lines = String(passage).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const relations = [];

    for (let index = 0; index < lines.length - 1; index++) {
      if (!names.has(words(lines[index]).join(' '))) continue;
      const descriptor = words(lines[index + 1]);
      if (descriptor.length && descriptor.every(word => FINISH_WORDS.has(word))) {
        relations.push(finishRelation(lines[index + 1], finish));
      }
    }

    return relations;
  });
}

// Presentation only: never infer a paint's finish from the requested input.
// This field reports normalized source/catalog descriptors. A published suffix
// can supply a descriptor, but never upgrades the separate finishMatch verdict.
function outputPaintFinish(colors) {
  const found = new Set();
  let conflict = false;

  for (const color of colors) {
    const sources = color.source_evidence || [];
    const names = [color.name, ...sources.map(source => source.source_name).filter(Boolean)];
    const candidate = { name: color.name, aliases: names };
    const rows = color.code_candidates || [];

    for (const finish of FINISHES) {
      const relations = [
        ...sources.map(source => candidateFinishRelation(candidate, source.passages || [], finish)),
        ...sources.flatMap(source => adjacentFinishRelations(candidate, source.passages || [], finish)),
        ...rows.flatMap(row => [row.description, ...(row.finish_evidence || []).map(item => item.description),
          ...(row.catalog_evidence || []).map(item => item.description)]
          .filter(Boolean).map(description => catalogFinishRelation(description, finish))),
      ];

      if (relations.includes('conflict')) conflict = true;

      if (relations.includes('compatible')) {
        found.add(finish);
        if (relations.includes('incompatible')) conflict = true;
      }
    }

    for (const name of names) {
      const suffix = name.slice(stripPaintFinish(name).length).toLowerCase();

      for (const finish of FINISHES) if (finishRelation(suffix, finish) === 'compatible'
        || catalogFinishRelation(name, finish) === 'compatible') found.add(finish);
      if (/\bpearlcoat\b/.test(suffix)) found.add('perolizado');

      if (/\b(?:tri[ -]?coat|three[ -]coat|3[ -]coat|tri[ -]?camada|tri[ -]?capa)s?\b/.test(suffix)) found.add('tricamada');
      if (/\b(?:bi[ -]?coat|two[ -]coat|2[ -]coat|bi[ -]?camada|bi[ -]?capa)s?\b/.test(suffix)) found.add('bicamada');
    }
  }

  if (found.has('sólido') && (found.has('metálico') || found.has('perolizado'))) conflict = true;
  if (['fosco', 'acetinado', 'brilhante'].filter(finish => found.has(finish)).length > 1) conflict = true;
  if (found.has('bicamada') && found.has('tricamada')) conflict = true;
  if (conflict) return ['conflitante'];

  return found.size ? [...FINISHES, 'bicamada'].filter(finish => found.has(finish)) : ['desconhecido'];
}

module.exports = { outputPaintFinish };
