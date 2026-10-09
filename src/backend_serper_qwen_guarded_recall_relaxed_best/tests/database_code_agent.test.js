const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { addDatabaseCodes, loadCandidates, runMatcherAgent, supportedCodeRow } = require('../database_code_agent');
const { sourceEvidence } = require('../paint_evidence');

test('an expanded short name keeps the source code tied to its original printed name', async () => {
  const source = { page_id: 'P1', url: 'https://paint.example/ix35', evidence: ['Hyper\n\nHYWJX/WJX'] };
  const candidate = { name: 'Hyper', aliases: ['Hyper', 'Hyper Metallic'], sources: [source] };
  const [lookup] = await loadCandidates([{ name: 'Hyper Metallic',
    source_evidence: sourceEvidence(candidate, [source]) }], { brand: 'Hyundai' });

  assert.ok(lookup.candidates.some(row => row.universal_code === 'WJX'
    && /HYPER MET/.test(row.description) && row.source_code_match));
  assert.ok(lookup.candidates.every(row => row.universal_code !== 'P2S' || !row.source_code_match));
});

test('an exact printed code excludes unsupported same-name catalog variants', async () => {
  const result = await addDatabaseCodes({ make: 'Hyundai', colors: [{ name: 'Hyper Metallic',
    source_evidence: [{ source_name: 'Hyper', passages: ['Hyper\n\nHYWJX/WJX'], paint_codes: ['WJX'] }],
  }] }, {
    brand: 'Hyundai',
    loadCandidatesFn: async () => [{ index: 0, candidates: [
      { candidate_id: 1, catalog: 'basf', description: 'HYPER MET', manufacturer: 'HYUNDAI',
        universal_code: 'WJX', complete_name_match: true, source_code_match: true },
      { candidate_id: 2, catalog: 'basf', description: 'HYPER MET', manufacturer: 'HYUNDAI',
        universal_code: 'P2S', complete_name_match: true, source_code_match: false },
    ] }],
    request: async () => { throw new Error('Exact printed identity should not need AI'); },
  });

  assert.deepEqual(result.colors[0].code_candidates.map(row => row.universal_code), ['WJX']);
});

test('one shared short component cannot attach an unrelated composite code', () => {
  const sharkskin = { name: 'Sharkskin 1', source_evidence: [{ source_name: 'Sharkskin 1 Metallic',
    passages: ['Sharkskin 1 Metallic\n9095, 47, WA9095\nWA9095'] }] };
  assert.equal(supportedCodeRow({ universal_code: '45/47/91/W',
    description: 'MED GREEN PEARL' }, sharkskin), false);
  const brightRed = { name: 'Bright Red', source_evidence: [{ passages: [
    '### Bright Red/Standard Red\n\nMfr. Color Code: WA7475/72',
  ] }] };
  assert.equal(supportedCodeRow({ universal_code: '72,WA7475',
    description: 'BRIGHT RED' }, brightRed), true);
});

test('a printed full OEM code takes precedence over a shared short catalog component', () => {
  const cherry = { name: 'Cherry Red', source_evidence: [{ passages: [
    '### Cherry Red/Medium Red Metallic\n\nMfr. Color Code: WA9088/94',
  ] }] };
  assert.equal(supportedCodeRow({ universal_code: '94/94AWA90',
    description: 'CHERRY RED PEARL', complete_name_match: true }, cherry), false);
  assert.equal(supportedCodeRow({ universal_code: '94',
    description: 'CHERRY RED', complete_name_match: true }, cherry), true);
  assert.equal(supportedCodeRow({ universal_code: 'WA9088',
    description: 'MEDIUM RED', complete_name_match: false }, cherry), true);
  const silver = { name: 'Switchblade Silver', source_evidence: [{ passages: [
    'Switchblade Silver Metallic\nGAN, WA636R',
  ] }] };
  assert.equal(supportedCodeRow({ universal_code: 'GAN',
    description: 'SWITCHBLADE SILVER', complete_name_match: true }, silver), true);
  assert.equal(supportedCodeRow({ universal_code: '17',
    description: 'SILVER MIST', complete_name_match: false }, {
    name: 'Light Slate', source_evidence: [{ passages: ['Light Slate Metallic\nWA7468/17'] }],
  }), false);
  assert.equal(supportedCodeRow({ universal_code: '703J',
    description: 'SUPERIOR BLUE', complete_name_match: true }, {
    name: 'Superior Blue', source_evidence: [{ passages: ['Superior Blue Metallic\nWA703J/22'] }],
  }), true);
  assert.equal(supportedCodeRow({ universal_code: '43WA177B',
    description: 'EMERALD GREEN', complete_name_match: true }, {
    name: 'Emerald Green', source_evidence: [{ passages: ['Emerald Green Metallic\nWA177B/43'] }],
  }), true);
});

test('a solid catalog variant cannot supply a metallic published paint code', () => {
  const royal = { name: 'Royal Blue', source_evidence: [{ source_name: 'Royal Blue Metallic',
    passages: ['Royal Blue Metallic 1992 S10'] }] };
  assert.equal(supportedCodeRow({ universal_code: '030',
    description: 'AZUL ROYAL LISO', complete_name_match: false }, royal), false);
  assert.equal(supportedCodeRow({ universal_code: '20Z',
    description: 'ROYAL BLAU LISA', complete_name_match: false }, royal), false);
  assert.equal(supportedCodeRow({ universal_code: 'G4C',
    description: 'ROYAL SOLID BLUE/CL', complete_name_match: false }, royal), true,
  'Solid inside a distinctive name is not a catalog finish suffix');
  assert.equal(supportedCodeRow({ universal_code: 'A1',
    description: 'ROYAL BLUE MET', complete_name_match: true }, royal), true);
});

test('matcher output cannot assign a partial composite code to an unrelated paint', async () => {
  const result = await addDatabaseCodes({ make: 'Chevrolet', colors: [{ name: 'Sharkskin 1',
    source_evidence: [{ source_name: 'Sharkskin 1 Metallic',
      passages: ['Sharkskin 1 Metallic\n9095, 47, WA9095\nWA9095'] }],
  }] }, {
    apiKey: 'test',
    loadCandidatesFn: async () => [{ index: 0, candidates: [{ candidate_id: 1,
      catalog: 'lazzumix', description: 'MED GREEN PEARL', manufacturer: 'CHEVROLET',
      universal_code: '45/47/91/W', complete_name_match: false, source_code_match: true,
    }] }],
    request: async () => modelResponse([{ index: 0, candidate_ids: [1] }]),
  });
  assert.equal(result.colors.length, 1);
  assert.equal(result.colors[0].name, 'Sharkskin 1');
  assert.deepEqual(result.colors[0].code_candidates, []);
});

test('an exact catalog name cannot hide a conflicting longer OEM code', async () => {
  const result = await addDatabaseCodes({ make: 'Chevrolet', colors: [{ name: 'Cherry Red',
    source_evidence: [{ passages: ['### Cherry Red/Medium Red Metallic\nMfr. Color Code: WA9088/94'] }],
  }] }, {
    apiKey: 'test',
    loadCandidatesFn: async () => [{ index: 0, candidates: [{ candidate_id: 1,
      catalog: 'lazzumix', description: 'CHERRY RED PEARL', manufacturer: 'GM',
      universal_code: '94/94AWA90', complete_name_match: true, source_code_match: true,
    }] }],
    request: async () => modelResponse([{ index: 0, candidate_ids: [1] }]),
  });
  assert.equal(result.colors[0].name, 'Cherry Red');
  assert.deepEqual(result.colors[0].code_candidates, []);
});

function modelResponse(matches) {
  return { ok: true, json: async () => ({ status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ matches }) }] }] }) };
}

test('exact locally checked name/make/source-code identities do not need another model call', async () => {
  const result = await addDatabaseCodes({ make: 'Hyundai', colors: [{ name: 'Shimmering Silver' }] }, {
    loadCandidatesFn: async () => [{ index: 0, candidates: [{ candidate_id: -1, catalog: 'basf',
      description: 'SHIMMERING SILVER MET', manufacturer: 'HYUNDAI', year: '2011-2016', universal_code: 'N3S',
      complete_name_match: true, source_code_match: true }] }],
    request: async () => { throw new Error('Exact identity should not use AI'); },
  });
  assert.equal(result.colors[0].universal_code, 'N3S');
  assert.equal(result.colors[0].code_candidates[0].catalog_evidence[0].catalog, 'basf');
});

test('a source code alone cannot bypass the final identity agent', async () => {
  let calls = 0;
  const result = await addDatabaseCodes({ make: 'Hyundai', colors: [{ name: 'Moon White' }] }, {
    apiKey: 'test', loadCandidatesFn: async () => [{ index: 0, candidates: [{ candidate_id: -1, catalog: 'basf',
      description: 'DIFFERENT WHITE PEARL', manufacturer: 'HYUNDAI', year: '2011-2016', universal_code: 'A1',
      complete_name_match: false, source_code_match: true }] }],
    request: async () => { calls++; return modelResponse([{ index: 0, candidate_ids: [] }]); },
  });
  assert.equal(calls, 1);
  assert.equal(result.colors[0].universal_code, '');
});

test('a complete Portuguese name receives its unique catalog code even without an AI identity selection', async () => {
  const result = await addDatabaseCodes({ make: 'Toyota', colors: [{ name: 'Branco Lunar',
    source_evidence: [{ passages: ['Toyota Corolla Branco Lunar'], source_name: 'Branco Lunar' }] }] }, {
    loadCandidatesFn: async () => [{ index: 0, candidates: [{ candidate_id: 1, catalog: 'lazzumix',
      description: 'BRANCO LUNAR PEROL', manufacturer: 'TOYOTA', universal_code: '089',
      complete_name_match: true, source_code_match: false, catalog_identity_confirmed: false }] }],
    request: async () => { throw new Error('Unambiguous catalog reconciliation should not call a model'); },
  });
  assert.equal(result.colors[0].universal_code, '089');
});

test('a reviewed complete name can reuse a unique same-manufacturer code without a printed web code', async () => {
  for (const ambiguous of [false, true]) {
    let calls = 0;
    const rows = [{ candidate_id: 1, catalog: 'lazzumix', description: 'MOON WHITE PRL',
      manufacturer: 'TOYOTA', year: '2018', universal_code: 'A1', complete_name_match: true,
      catalog_identity_confirmed: true, source_code_match: false }];
    if (ambiguous) rows.push({ ...rows[0], candidate_id: 2, universal_code: 'A2', catalog_identity_confirmed: false });
    const result = await addDatabaseCodes({ make: 'Toyota', colors: [{ name: 'Moon White' }] }, {
      apiKey: 'test', loadCandidatesFn: async () => [{ index: 0, candidates: rows }],
      request: async () => { calls++; return modelResponse([{ index: 0, candidate_ids: [] }]); },
    });
    assert.equal(calls, ambiguous ? 1 : 0);
    assert.equal(result.colors[0].universal_code, ambiguous ? '' : 'A1');
  }
});

test('a previously reviewed catalog alias requires fresh source-code and same-maker agreement', async () => {
  for (const [manufacturer, sourceCode, expected] of [['TOYOTA', true, '070'], ['VW', true, ''], ['TOYOTA', false, '']]) {
    let calls = 0;
    const result = await addDatabaseCodes({ make: 'Toyota', colors: [{ name: 'Branco Lunar' }] }, {
      apiKey: 'test', loadCandidatesFn: async () => [{ index: 0, candidates: [{ candidate_id: -1, catalog: 'basf',
        description: 'WHITE PEARL CRYSTAL SHINE', manufacturer, year: '2002-2025', universal_code: '070',
        catalog_identity_confirmed: true, source_code_match: sourceCode }] }],
      request: async () => { calls++; return modelResponse([{ index: 0, candidate_ids: [] }]); },
    });
    assert.equal(result.colors[0].universal_code, expected);
    assert.equal(calls, expected || manufacturer === 'VW' ? 0 : 1);
  }
});

test('finish reaches the matcher and incompatible database rows cannot leak into output codes', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'finish-db-'));
  const databasePath = path.join(directory, 'paints.db');
  try {
    execFileSync('python3', ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute('CREATE TABLE paint_codes (id INTEGER, description TEXT, year INTEGER, manufacturer TEXT, universal_code TEXT)')
c.executemany('INSERT INTO paint_codes VALUES (?,?,?,?,?)', [(1,'MOON WHITE SOLID',2020,'HYUNDAI','S1'),(2,'MOON WHITE PEARL',2020,'HYUNDAI','P1'),(3,'MOON WHITE',2020,'HYUNDAI','U1')])
c.commit()`, databasePath]);
    const result = await addDatabaseCodes({ make: 'Hyundai', paintFinish: 'perolizado', colors: [{ name: 'Moon White' }] }, {
      databasePath, apiKey: 'test', request: async (_url, options) => {
        const body = JSON.parse(options.body), input = JSON.parse(body.input);
        assert.equal(input.vehicle.paintFinish, 'perolizado');
        assert.match(body.instructions, /paintFinish/);
        assert.deepEqual(input.colors[0].db_candidates.map(row => row.candidate_id), [1, 2, 3]);
        assert.deepEqual(input.colors[0].db_candidates.map(row => row.finish_relation), ['incompatible', 'compatible', 'unknown']);
        return modelResponse([{ index: 0, candidate_ids: [1, 2, 3] }]);
      },
    });
    assert.deepEqual(result.colors[0].code_candidates.map(row => row.universal_code), ['P1', 'U1']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('resolved abbreviations keep their own source-name association during code retrieval', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'serper-db-'));
  const databasePath = path.join(directory, 'paints.db');
  try {
    execFileSync('python3', ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute('CREATE TABLE paint_codes (id INTEGER, description TEXT, year INTEGER, manufacturer TEXT, universal_code TEXT)')
c.execute('INSERT INTO paint_codes VALUES (1,"POWDER WHITE PEARL",2007,"HYUNDAI","N2")')
c.commit()`, databasePath]);
    const result = await addDatabaseCodes({ make: 'Hyundai', colors: [{ name: 'Powder White Pearl',
      source_evidence: [{ source_name: 'powder-p.-white-p.', url: 'https://supplier.test',
        passages: ['### powder-p.-white-p. - N2'] }],
    }] }, { databasePath, apiKey: 'test', request: async (_url, options) => {
      const input = JSON.parse(JSON.parse(options.body).input);
      assert.equal(input.colors[0].db_candidates[0].source_code_match, true);
      return modelResponse([{ index: 0, candidate_ids: [1] }]);
    } });
    assert.equal(result.colors[0].universal_code, 'N2');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('indexed whole-word lookup preserves translations, versions and make preferences', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'serper-db-'));
  const databasePath = path.join(directory, 'paints.db');
  try {
    execFileSync('python3', ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute('CREATE TABLE paint_codes (id INTEGER, description TEXT, year INTEGER, manufacturer TEXT, universal_code TEXT)')
c.executemany('INSERT INTO paint_codes VALUES (?,?,?,?,?)', [(1,'Prata Lunar Met',2020,'Honda','H1'),(2,'Lunar Silver II',2020,'Honda','H2'),(3,'Lunar Silver',2020,'Toyota','T1'),(4,'Lunarish Silver',2020,'Honda','BAD')])
c.commit()`, databasePath]);
    let calls = 0;
    const response = await addDatabaseCodes({ colors: [{ name: 'Lunar Silver' }, { name: 'Lunar Silver II' }] }, {
      databasePath, brand: 'Honda', year: 2020, apiKey: 'test', model: 'test',
      request: async (url, options) => {
        assert.equal(JSON.parse(options.body).model, calls === 0 ? 'gpt-6-luna' : 'gpt-5.6-luna');
        const input = JSON.parse(JSON.parse(options.body).input);
        assert.deepEqual(input.colors[0].db_candidates.map((row) => row.candidate_id), [1, 2]);
        assert.deepEqual(input.colors[1].db_candidates.map((row) => row.candidate_id), [2]);
        // A real but less applicable other-make row must still be rejected by application code.
        return modelResponse([{ index: 0, candidate_ids: calls++ === 0 ? [3] : [] }, { index: 1, candidate_ids: [2] }]);
      },
    });
    assert.deepEqual(response.colors.map((color) => color.universal_code), ['', 'H2']);
    assert.equal(calls, 1); // Preserve the valid sibling without repeating it.
    assert.deepEqual(response._databaseCodeAgentIncompleteNames, ['Lunar Silver']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('retrieves translated and misspelled names, keeps source codes and prefers exact full names', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'serper-db-'));
  const databasePath = path.join(directory, 'paints.db');
  try {
    execFileSync('python3', ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute('CREATE TABLE paint_codes (id INTEGER, description TEXT, year INTEGER, manufacturer TEXT, universal_code TEXT)')
c.executemany('INSERT INTO paint_codes VALUES (?,?,?,?,?)', [(1,'SHIMMERING SILVER MET',2010,'HYUNDAI','N3S'),(2,'SHIMMERING SLV MET',2022,'HYUNDAI','MTS'),(3,'SHIMERING SILVER MET',2014,'HYUNDAI','N35'),(4,'CINZA TITANIO MET',2013,'HYUNDAI','Y6G'),(5,'GRAY TITANIUM MET',2013,'HYUNDAI','TAK'),(6,'TITANIUM GRAY MET',2011,'HYUNDAI','N5S')])
c.commit()`, databasePath]);
    const result = await addDatabaseCodes({ make: 'Hyundai', year: 2022, colors: [
      { name: 'Shimmering Silver', source_evidence: [{ url: 'https://a.test', passages: ['N3S - Shimmering Silver Metallic'] }] },
      { name: 'Cinza Titanium', source_evidence: [{ url: 'https://b.test', passages: ['Cinza Titanium', 'Y6G - Metálica'] }] },
      { name: 'Titanium Gray' },
    ] }, { databasePath, apiKey: 'test', model: 'test', request: async (url, options) => {
      const input = JSON.parse(JSON.parse(options.body).input);
      assert.deepEqual(input.colors[0].db_candidates.map((row) => row.candidate_id), [1, 2, 3]);
      assert.equal(input.colors[0].db_candidates[0].source_code_match, true);
      assert.equal(input.colors[0].source_evidence[0].passages[0], 'N3S - Shimmering Silver Metallic');
      assert.ok(input.colors[1].db_candidates.some((row) => row.candidate_id === 4 && row.source_code_match));
      return modelResponse([{ index: 0, candidate_ids: [1] }, { index: 1, candidate_ids: [4] },
        { index: 2, candidate_ids: [5, 6] }]);
    } });
    assert.deepEqual(result.colors.map((color) => color.universal_code), ['N3S', 'Y6G', 'N5S']);
    assert.deepEqual(result.colors[2].code_candidates.map((row) => row.universal_code), ['N5S']);
    assert.equal(result.colors[0].code_candidates[0].year, 2010);
    await assert.rejects(addDatabaseCodes({ colors: [{ name: 'Shimmering Silver' }] }, {
      databasePath, apiKey: 'test', model: 'test', request: async () => modelResponse([]),
    }), /every color index/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('matcher retries transient errors and rejects incomplete output', async () => {
  let calls = 0;
  const result = await runMatcherAgent({ colors: [] }, { apiKey: 'test', model: 'test', request: async () => {
    calls++;
    return calls === 1 ? { ok: false, status: 503, json: async () => ({}) } : modelResponse([]);
  } });
  assert.equal(calls, 2);
  assert.deepEqual(result.result.matches, []);
  await assert.rejects(runMatcherAgent({ colors: [] }, { apiKey: 'test', model: 'test',
    request: async () => ({ ok: true, json: async () => ({ status: 'incomplete' }) }),
  }), /did not complete/);
});

test('one failed matcher batch keeps the codes found by successful batches', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'serper-db-'));
  const databasePath = path.join(directory, 'paints.db');
  try {
    execFileSync('python3', ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute('CREATE TABLE paint_codes (id INTEGER, description TEXT, year INTEGER, manufacturer TEXT, universal_code TEXT)')
c.executemany('INSERT INTO paint_codes VALUES (?,?,?,?,?)', [(i+1,f'Sample Shade {i}',2020,'Test',f'C{i}') for i in range(9)])
c.commit()`, databasePath]);
    const result = await addDatabaseCodes({ make: 'Test', colors: Array.from({ length: 9 }, (_, index) => ({ name: `Sample Shade ${index}` })) }, {
      databasePath, apiKey: 'test', model: 'test', request: async (url, options) => {
        const input = JSON.parse(JSON.parse(options.body).input);
        if (input.colors[0].index === 4) return { ok: false, status: 400, json: async () => ({ error: 'Unavailable' }) };
        return modelResponse(input.colors.map((color) => ({ index: color.index, candidate_ids: [color.index + 1] })));
      },
    });
    assert.deepEqual(result.colors.map((color) => color.universal_code), ['C0', 'C1', 'C2', 'C3', '', '', '', '', 'C8']);
    assert.equal(result._databaseCodeAgentWarnings.length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
