const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { CatalogLookup, CatalogResearch, yearEvidence } = require('../catalog_research');
const { eligibleCandidateIds, exactCatalogIdentity } = require('../database_code_agent');

test('formula layer labels do not force an exact local paint identity through a paid matcher', async () => {
  const db = new CatalogLookup();
  try {
    const result = await db.lookup({ brand: 'Toyota', name: 'Branco Lunar' });
    const exact = exactCatalogIdentity('Branco Lunar', result.candidates, 'Toyota');
    assert.ok(exact.length > 0);
    assert.ok(exact.every(row => row.universal_code === '089'));
    assert.ok(!exact.some(row => /\bII\b/.test(row.description)), 'Roman numeral versions stay distinct');
    assert.ok(!exact.some(row => row.universal_code === '027'), 'a translated name does not override a different code');
  } finally { db.close(); }
});

test('generic display lookup keeps the requested finish and does not retrieve solid rows', async () => {
  const db = new CatalogLookup();
  try {
    const result = await db.lookup({ brand: 'Honda', model: 'CG 160',
      name: 'Vermelho Perolizado', exact_name_only: true });
    assert.deepEqual(result.catalogs_queried, ['lazzumix', 'basf', 'basf_models']);
    assert.ok(result.candidates.length > 0 && result.candidates.length < 20);
    assert.ok(result.candidates.every(row => !/\b(?:LISA|LISO|SOLID)\b/i.test(row.description)));
  } finally { db.close(); }
});

test('layer metadata normalization is catalog-specific and preserves meaningful version letters', () => {
  const path = require('node:path');
  const result = JSON.parse(execFileSync('python3', ['-c', `import json
from catalog_lookup import catalog_name_tokens as tokens
print(json.dumps([tokens('Example White PRL(B)/LF', 'lazzumix'),
tokens('Example White II (E)', 'lazzumix'), tokens('Example White B', 'lazzumix'),
tokens('Example White (E)', 'basf')]))`], { encoding: 'utf8', cwd: path.resolve(__dirname, '..') }));
  assert.deepEqual(result, [['example', 'white'], ['example', 'white', 'ii'],
    ['example', 'white', 'b'], ['example', 'white', 'e']]);
});

test('unified BASF database preserves every source row and excludes supplier-only columns/codes', () => {
  const data = JSON.parse(execFileSync('python3', ['-c', `import sqlite3,json
c=sqlite3.connect('file:basf.db?mode=ro',uri=True)
print(json.dumps({'count':c.execute('select count(*) from paint_codes').fetchone()[0],
'files':c.execute('select count(*),sum(rows) from import_files').fetchone(),
'columns':[r[1] for r in c.execute('pragma table_info(paint_codes)')],
'unsafe':c.execute("select count(*) from paint_codes where universal_code in ('VW-2013','FI-7934','SK9163')").fetchone()[0],
'integrity':c.execute('pragma integrity_check').fetchone()[0]}))`], { encoding: 'utf8' }));
  assert.equal(data.count, 107111);
  assert.deepEqual(data.files, [267, 107111]);
  assert.equal(data.integrity, 'ok');
  assert.equal(data.unsafe, 0);
  assert.ok(!data.columns.some(name => /basf_code|aux|std|finder/i.test(name)));
});

test('the required catalogs retrieve precise Hyundai, Toyota and Volkswagen identities and Portuguese code bridges', async () => {
  const db = new CatalogLookup();
  try {
    for (const [brand, name, code, basfName] of [
      ['Hyundai', 'Shimmering Silver', 'N3S', 'SHIMMERING SILVER MET'],
      ['Hyundai', 'Ice White', 'WW9', 'ICE WHITE PEARL'],
      ['Toyota', 'Branco Polar', '056', 'WHITE'],
      ['Toyota', 'Super White', '040', 'SUPER WHITE'],
      ['Volkswagen', 'Branco Lotus', 'L282', 'LOTOSWEISS'],
      ['Volkswagen', 'Cinza Platinum', 'LD7X', 'PLATINUM GREY MET'],
    ]) {
      const result = await db.lookup({ brand, name, source_codes: [code] });
      assert.deepEqual(result.catalogs_queried, ['lazzumix', 'basf', 'basf_models']);
      assert.ok(result.candidates.some(row => row.catalog === 'basf' && row.universal_code === code
        && row.description === basfName), `${name}: missing BASF ${basfName}/${code}`);
      if (code !== 'WW9') assert.ok(result.candidates.some(row => row.catalog === 'lazzumix' && row.universal_code.includes(code)), name);
      assert.ok(result.candidates.every(row => !Object.keys(row).some(key => /lazzuril|basf_code|aux|std/i.test(key))));
    }
  } finally { db.close(); }
});

test('catalog years are corroboration, not an exclusive vehicle-year or finish claim', () => {
  assert.equal(yearEvidence({ year: '2011-2016' }, 2015).relation, 'within_catalog_range');
  assert.equal(yearEvidence({ year: '1981' }, 1978).relation, 'outside_catalog_range');
  assert.equal(yearEvidence({ year: '' }, 1978).relation, 'unknown');
  assert.equal(yearEvidence({ year: '1978-1981' }, 1978).vehicleYearConfirmed, false);
  assert.equal(yearEvidence({ year: '-2019' }, 2018).relation, 'unknown');
  assert.equal(yearEvidence({ year: '-2019' }, 2020).relation, 'outside_catalog_range');
  assert.equal(yearEvidence({ year: '-2019' }, 2019).start, null);
  assert.equal(yearEvidence({ year: '2019-' }, 2020).relation, 'unknown');
});

test('catalog checks run concurrently for every candidate, including no-match candidates', async () => {
  let active = 0, peak = 0;
  const lookedUp = [];
  const research = new CatalogResearch({ brand: 'Hyundai', model: 'Azera', manufacturingYear: 2017, paintFinish: 'perolizado' }, {
    signal: new AbortController().signal,
    lookup: async input => {
      lookedUp.push(input.name);
      return { catalogs_queried: ['lazzumix', 'basf', 'basf_models'], candidates: input.name === 'Unknown White' ? [] : [
        { candidate_id: -1, catalog: 'basf', description: `${input.name} PEARL`, universal_code: 'A1', year: '2015-2018', manufacturer: 'Hyundai' },
      ] };
    },
    review: async (_stage, _schema, input) => {
      active++; peak = Math.max(peak, active);
      assert.deepEqual(input.rows.map(row => row.universal_code), ['A1']);
      await new Promise(resolve => setTimeout(resolve, 10));
      active--;
      return { candidate_ids: [-1] };
    },
  });
  const candidates = ['Ice White', 'Moon White', 'Unknown White'].map(name => ({ name, sources: [] }));
  try {
    research.start(candidates);
    const results = await Promise.all(candidates.map(candidate => research.get(candidate)));
    assert.equal(lookedUp.length, 3);
    assert.equal(peak, 2);
    assert.deepEqual(results.map(result => result.status), ['matched', 'matched', 'no_match']);
    assert.equal(results[0].selected[0].finish_relation, 'compatible');
    assert.equal(results[0].selected[0].year_evidence.relation, 'within_catalog_range');
    await research.get({ ...candidates[0], sources: [{ evidence: ['new source'] }] });
    assert.equal(lookedUp.length, 3, 'later sightings reuse one research identity check');
    assert.deepEqual([...await research.selectedFor({ name: 'Ice White' })], [-1]);
    assert.deepEqual([...await research.selectedFor({ name: 'A different paint' })], []);
  } finally { research.close(); }
});

test('documented donor-brand rows remain eligible alongside proprietary paint rows', () => {
  const rows = [{ candidate_id: 1, manufacturer: 'Puma' }, { candidate_id: 2, manufacturer: 'VW' },
    { candidate_id: 3, manufacturer: 'Fiat' }];
  assert.deepEqual([...eligibleCandidateIds(rows, 'Puma', 1978)], [1]);
  const sources = [{ passages: ['Puma GTS offered Volkswagen Branco Lotus along with proprietary colors.'] }];
  assert.deepEqual([...eligibleCandidateIds(rows, 'Puma', 1978, sources)], [1, 2]);
  assert.deepEqual([...eligibleCandidateIds(rows.slice(1), 'Puma', 1978)], []);
  assert.deepEqual([...eligibleCandidateIds(rows.slice(1), 'Puma', 1978, sources)], [2]);
  assert.deepEqual([...eligibleCandidateIds(rows.slice(1), 'Puma', 1978, sources, 'Branco Lotus')], [2]);
  const navigation = [{ passages: ['Branco Blizzard', 'Toyota Corolla\n\nVolkswagen\n\nFiat'] }];
  assert.deepEqual([...eligibleCandidateIds(rows.slice(1), 'Toyota', 2018, navigation, 'Branco Blizzard')], []);
});

test('new source codes refresh cached catalog lookups while repeated sightings reuse them', async () => {
  const requests = [];
  const research = new CatalogResearch({ brand: 'Toyota', model: 'Corolla' }, {
    signal: new AbortController().signal, deferIdentity: true,
    lookup: async input => {
      requests.push(input);
      return { catalogs_queried: ['lazzumix', 'basf', 'basf_models'], candidates: [] };
    },
  });
  const candidate = { name: 'Blizzard Pearl', sources: [{ evidence: ['Blizzard Pearl'] }] };
  try {
    await research.get(candidate);
    await research.get({ ...candidate, sources: [{ evidence: ['COLOR CODE 070 - Blizzard Pearl'] }] });
    await research.get(candidate);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].source_codes, ['070']);
  } finally { research.close(); }
});

test('a missing mandatory BASF database fails explicitly', async () => {
  const db = new CatalogLookup({ basfDatabasePath: '/nonexistent/missing-basf.db' });
  try { await assert.rejects(db.ready, /unable to open database/); }
  finally { db.close(); }
});
