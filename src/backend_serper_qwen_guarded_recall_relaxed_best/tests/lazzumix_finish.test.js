const test = require('node:test');
const assert = require('node:assert/strict');
const { catalogFinishRelation, catalogFinishEvidence, applyMatchedFinish } = require('../lazzumix_finish');
const { finishResearchQueries } = require('../finish_research');
const { loadCandidates, addDatabaseCodes } = require('../database_code_agent');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');

test('Lazzumix suffixes parse punctuation and layer annotations without guessing unknown suffixes', () => {
  for (const description of ['BRANCO AURORA PEROL', 'AURORA WHITE PRL.(E)/CL',
    'AURORA WHITE PRL/LF(E)', 'BRANCO AURORA PEROLIZADO', 'AURORA WHITE PEARL II/CL']) {
    assert.equal(catalogFinishRelation(description, 'perolizado'), 'compatible', description);
  }
  for (const description of ['BRANCO FROTA LISA/CL', 'BRANCO FROTA LISO', 'FLEET WHITE LIS/LF/CL']) {
    assert.equal(catalogFinishRelation(description, 'perolizado'), 'incompatible', description);
  }
  for (const description of ['ICE WHITE(BASE)/EC', 'WHITE (EFEITO)/EC', 'WHITE TRICOAT',
    'WHITE/PE', 'WHITE/LF/LG/CL', 'WHITE PE(B)/LF/CL', 'METAL WHITE', 'PEARL RIVER', 'WHITE LISA (BASE)']) {
    assert.equal(catalogFinishRelation(description, 'perolizado'), 'unknown', description);
  }
  assert.equal(catalogFinishRelation('CINZA TITANIUM MET/CL', 'sólido'), 'incompatible');
  assert.equal(catalogFinishRelation('CINZA TITANIUM MET/CL', 'perolizado'), 'unknown');
  assert.equal(catalogFinishRelation('PRETO AURORA PEROL FOSCO', 'perolizado fosco'), 'compatible');
  assert.equal(catalogFinishRelation('PRETO AURORA FOSCO', 'brilhante'), 'incompatible');
  assert.equal(catalogFinishRelation('PRETO AURORA GLOSS', 'fosco'), 'incompatible');
  assert.equal(catalogFinishRelation('PRETO AURORA GLOSS MATTE', 'fosco'), 'conflict');
});

test('same-code finish evidence fills omissions but keeps conflicting descriptions unresolved', () => {
  const row = { description: 'ICE WHITE(BASE)/EC', finish_descriptions: ['DIAMOND WHITE PEROL', 'DIAMOND WHITE PRL.(E)/CL'] };
  assert.equal(catalogFinishEvidence(row, 'perolizado').relation, 'compatible');
  row.finish_descriptions.push('WHITE LISA');
  assert.equal(catalogFinishEvidence(row, 'perolizado').relation, 'conflict');
  assert.equal(catalogFinishEvidence({ description: 'WHITE LISA PEARL' }, 'perolizado').relation, 'conflict');
});

test('only confirmed mismatches are removed; unknowns, conflicts and missing matches remain', () => {
  const color = { name: 'Sample White', finishMatch: 'unknown', confidence: 'low' };
  const row = relation => ({ universal_code: relation, finish_relation: relation });
  assert.equal(applyMatchedFinish(color, [row('incompatible')], 'perolizado'), null);
  for (const relation of ['unknown', 'conflict', 'compatible']) {
    assert.ok(applyMatchedFinish(color, [row(relation)], 'perolizado'));
  }
  assert.ok(applyMatchedFinish(color, [], 'perolizado'));
  const mixed = applyMatchedFinish(color, [row('incompatible'), row('unknown'), row('compatible')], 'perolizado');
  assert.deepEqual(mixed.code_candidates.map(row => row.universal_code), ['unknown', 'compatible']);
  assert.equal(mixed.finishMatch, 'unknown');
  for (const [web, db] of [['confirmed', 'incompatible'], ['incompatible', 'compatible']]) {
    const conflict = applyMatchedFinish({ ...color, finishMatch: web }, [row(db)], 'perolizado');
    assert.equal(conflict.finishMatch, 'unknown');
    assert.equal(applyMatchedFinish(conflict, conflict.code_candidates, 'perolizado').finishMatch, 'unknown');
  }
});

test('catalog lookup crosses exact manufacturer/code rows only, then filters matched identities', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'lazzumix-finishes-'));
  const databasePath = path.join(directory, 'paints.db');
  try {
    execFileSync('python3', ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute('CREATE TABLE paint_codes (id INTEGER, description TEXT, year INTEGER, manufacturer TEXT, universal_code TEXT)')
c.executemany('INSERT INTO paint_codes VALUES (?,?,?,?,?)', [
 (1,'NOBLE WHITE',2017,'HYUNDAI','NW'), (2,'BLANCO LISO/EC',2000,'HYUNDAI','NW'),
 (3,'ICE WHITE(BASE)/EC',2017,'HYUNDAI','WW7'), (4,'DIAMOND WHITE PEROL',2016,'HYUNDAI','WW7'),
 (5,'MYSTERY WHITE',2017,'HYUNDAI','U1'), (6,'OTHER WHITE LISA',2017,'KIA','U1'),
 (7,'MYSTERY WHITE LISA',2017,'HYUNDAI','U1/P2'),
 (8,'CONFLICT WHITE LISA',2017,'HYUNDAI','C1'), (9,'CONFLICT WHITE PRL',2017,'HYUNDAI','C1')])
c.commit()`, databasePath]);
    const names = ['Noble White', 'Ice White', 'Mystery White', 'Conflict White', 'Missing White'];
    const colors = names.map(name => ({ name, finishMatch: 'unknown' }));
    const rows = await loadCandidates(colors, { databasePath, paintFinish: 'perolizado' });
    assert.deepEqual(rows[2].candidates.find(row => row.candidate_id === 5).finish_descriptions, ['MYSTERY WHITE']);
    let debug;
    const result = await addDatabaseCodes({ make: 'Hyundai', paintFinish: 'perolizado', colors }, {
      apiKey: 'test', databasePath, onDebug: (name, data) => { if (name === 'database-matching') debug = data; },
      request: async (_url, options) => {
        const input = JSON.parse(JSON.parse(options.body).input);
        const matches = input.colors.map(color => ({ index: color.index,
          candidate_ids: [[1], [3], [5], [8], []][color.index] }));
        return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify({ matches }) }] }] }) };
      },
    });
    assert.deepEqual(result.colors.map(color => [color.name, color.finishMatch]), [
      ['Ice White', 'confirmed'], ['Mystery White', 'unknown'], ['Conflict White', 'unknown'], ['Missing White', 'unknown'],
    ]);
    assert.equal(result.colors[0].universal_code, 'WW7');
    assert.equal(debug.finishExclusions[0].name, 'Noble White');
    assert.match(debug.finishExclusions[0].codes[0].evidence[0].description, /LISO/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('finish clarification reuses two searches only for unresolved relevant leads', async () => {
  const vehicle = { brand: 'Hyundai', model: 'Azera', paintFinish: 'perolizado', predominantColor: 'branco' };
  const candidates = ['Known White', 'Unknown White', 'Conflict White', 'Extra White', 'Solid White', 'Dark Black'].map(name => ({
    name, sources: [{ evidence: [`${name} - A1`] }],
  }));
  const queries = await finishResearchQueries(candidates, vehicle, { loadCandidates: async leads => {
    assert.equal(leads.length, 5);
    return leads.map((lead, index) => ({ index, candidates: [{ manufacturer: 'Hyundai', source_code_match: true,
      description: ['Known White PRL', 'Unknown White', 'Conflict White PRL', 'Extra White', 'Solid White LISA'][index],
      ...(index === 2 && { finish_descriptions: ['Conflict White LISA'] }),
    }] }));
  } });
  assert.equal(queries.length, 2);
  assert.match(queries[0], /"Unknown White" OR "A1"/);
  assert.match(queries[1], /"Conflict White" OR "A1"/);
  assert.deepEqual(await finishResearchQueries(candidates, { ...vehicle, paintFinish: null }), []);
});
