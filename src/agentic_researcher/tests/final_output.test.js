const test = require('node:test');
const assert = require('node:assert/strict');
const { finalOutput, outputColors, titleCase } = require('../final_output');

const paint = (name, code, sources = []) => ({ name, sources, confidence: 'low',
  universal_code: code, code_candidates: code ? [{ universal_code: code }] : [] });
const identityCount = colors => colors.reduce((sum, color) => sum + (color.variants?.length || 1), 0);

test('published pearl identity survives normalization while coat-count duplicates still merge', () => {
  const { candidateInventory, reviewedColors } = require('../candidate_inventory');
  const passage = '[`N2` ### Pure White Pearl 2005–2015 · White](https://catalog.test/paint)';
  const candidates = candidateInventory([{ id: 'P1', url: 'https://catalog.test',
    candidates: [{ name: 'Pure White Pearl', evidence: [passage] }] }]);
  const colors = reviewedColors(candidates, { C1: { action: 'include', name: null,
    confidence: 'low', source_ids: ['P1'], finishMatch: 'unknown', reason: 'Catalog entry' } });
  assert.equal(colors[0].source_evidence[0].source_name, 'Pure White Pearl');
  assert.deepEqual(colors[0].source_evidence[0].paint_codes, ['N2']);
  assert.equal(outputColors(colors)[0].name, 'Pure White');
  assert.deepEqual(outputColors(colors)[0].paintFinish, ['perolizado']);
  assert.equal(outputColors(colors)[0].finishMatch, 'unknown');
  assert.deepEqual(outputColors([paint('Hyper White', 'WC9'), paint('Hyper White Tricoat', 'WC9')])
    .map(color => color.name), ['Hyper White']);
});

test('Unicode title case is presentation only, including version words and hyphens', () => {
  assert.equal(titleCase('CINZA TITÂNIO'), 'Cinza Titânio');
  assert.equal(titleCase('STEEL-GREY II'), 'Steel-Grey Ii');
  assert.equal(titleCase('AZUL DO CÉU'), 'Azul Do Céu');
  const original = [paint('PRATA LUNAR', 'aB2', ['https://source.test/MixedCase'])];
  const copy = structuredClone(original);
  assert.deepEqual(outputColors(original), [{ ...paint('Prata Lunar', 'aB2', ['https://source.test/MixedCase']), paintFinish: ['desconhecido'] }]);
  assert.deepEqual(original, copy);
});

test('spelling duplicates with conflicting codes retain separate source-linked identities', () => {
  const result = outputColors([
    paint('PEPPER GRAY', 'Z5G', ['https://a.test']),
    { ...paint('Pepper-Grey', 'OTHER', ['https://b.test']), confidence: 'high' },
    paint('Steel Grey', 'A1'), paint('Steel Gray II', 'A2'), paint('Steel Grey 2', 'A3'),
    paint('Galaxy Pearl', 'P1'), paint('Galaxy', 'P1'),
  ]);
  assert.equal(result.length, 7);
  assert.deepEqual(result.slice(0, 2).map(color => [color.name, color.universal_code, color.sources]), [
    ['Pepper Gray', 'Z5G', ['https://a.test']],
    ['Pepper-Grey', 'OTHER', ['https://b.test']],
  ]);
});

test('a source-linked one-letter spelling variant merges only with explicit paired excerpts', () => {
  const url = 'https://paint.example/period-colors';
  const first = { ...paint('Vermelho Monte Carlo', '', [url]), source_evidence: [{ url,
    passages: ['Era o Vermelho Monte Carlo.', 'Também consta como Vermelho Mont Carlo.'] }] };
  const second = { ...paint('Vermelho Mont Carlo', '', [url]), source_evidence: [{ url,
    passages: ['Vermelho Mont Carlo - COD 0750-4330'] }] };

  const merged = outputColors([first, second]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, 'Vermelho Mont Carlo');
  assert.deepEqual(merged[0].aliases, ['Vermelho Monte Carlo']);

  assert.equal(outputColors([first, { ...second, source_evidence: [] }]).length, 2);
  assert.equal(outputColors([first, { ...second, name: 'Vermelho Monte Claro' }]).length, 2);
  assert.equal(outputColors([paint('Ash Mat', '', [url]), paint('Ash Met', '', [url])]).length, 2);
  assert.equal(outputColors([paint(first.name, 'A1', [url]), paint(second.name, 'B2', [url])]).length, 2);
});

test('VW paint-code prefix spelling combines one identical published paint name', () => {
  const variants = [
    paint('Reflexsilber Metallic', 'LA7W', ['https://catalog.example']),
    paint('REFLEXSILBER METALLIC', 'A7W', ['https://shop.example']),
  ];
  const combined = outputColors(variants, { manufacturer: 'Volkswagen' });

  assert.equal(combined.length, 1);
  assert.deepEqual(new Set(combined[0].code_candidates.map(row => row.universal_code)), new Set(['LA7W', 'A7W']));
  assert.deepEqual(new Set(combined[0].sources), new Set(['https://catalog.example', 'https://shop.example']));
  assert.equal(identityCount(outputColors(variants, { manufacturer: 'Hyundai' })), 2);
  assert.equal(identityCount(outputColors([paint('Reflexsilber Metallic', 'LA7W'),
    paint('Reflexsilber Metallic', 'LB7W')], { manufacturer: 'Volkswagen' })), 2);
});

test('prefers a researched Portuguese equivalent only with compatible full name and unambiguous code', () => {
  const result = outputColors([
    paint('PLATINUM GREY', 'LD7X', ['https://international.test']),
    paint('CINZA PLATINUM', 'LD7X', ['https://brasil.test']),
    paint('Gray Titanium', 'TAK'), paint('Cinza Titanium', 'Y6G'),
    paint('Moonlight Silver', 'LR5S'), paint('Prata Lunar', 'LR5S'),
    paint('Steel Grey II', 'ZAR'), paint('Cinza Steel', 'ZAR'),
    paint('Shimmering Silver', 'N3S'),
  ]);
  assert.equal(result.length, 8);
  assert.equal(result[0].name, 'Cinza Platinum');
  assert.deepEqual(new Set(result[0].sources), new Set(['https://brasil.test', 'https://international.test']));
  assert.deepEqual(result[0].aliases, ['Platinum Grey']);
  assert.deepEqual(result[0].code_candidates, [{ universal_code: 'LD7X' }]);
  assert.ok(result.some((color) => color.name === 'Shimmering Silver'));
  assert.ok(result.some((color) => color.name === 'Gray Titanium'));
  assert.ok(result.some((color) => color.name === 'Cinza Titanium'));
});

test('a translated full name may merge a subset of matching OEM codes without losing either code', () => {
  const english = { ...paint('Switchblade Silver', 'GAN', ['https://en.test']),
    code_candidates: [{ universal_code: 'GAN' }, { universal_code: 'WA636R' }] };
  const portuguese = paint('Prata Switchblade', 'WA636R', ['https://br.test']);
  const colors = outputColors([english, portuguese]);
  assert.equal(colors.length, 1);
  assert.equal(colors[0].name, 'Prata Switchblade');
  assert.deepEqual(colors[0].code_candidates.map(row => row.universal_code).sort(), ['GAN', 'WA636R']);
  assert.deepEqual(new Set(colors[0].sources), new Set(['https://en.test', 'https://br.test']));
});

test('GM and Chevrolet catalog manufacturers do not split the same translated paint', () => {
  const english = { ...paint('Switchblade Silver Pearl', 'GAN', ['https://en.test']),
    code_candidates: [
      { universal_code: 'GAN', manufacturer: 'CHEVROLET', description: 'SWITCHBLADE SILVER M/CL' },
      { universal_code: 'WA636R', manufacturer: 'GENERAL MOTORS', description: 'SWITCHBLADE SILVER MET' },
    ] };
  const portuguese = { ...paint('Prata Switchblade', 'WA636R', ['https://br.test']),
    code_candidates: [{ universal_code: 'WA636R', manufacturer: 'GM', description: 'PRATA SWITCHBLADE' }] };
  const colors = outputColors([english, portuguese]);
  assert.equal(colors.length, 1);
  assert.equal(colors[0].name, 'Prata Switchblade');
  assert.deepEqual(colors[0].code_candidates.map(row => row.universal_code).sort(),
    ['GAN', 'WA636R']);
  assert.deepEqual(colors[0].paintFinish, ['metálico', 'perolizado']);
});

test('ambiguous codes and multiple local equivalents remain separate', () => {
  const foreign = { ...paint('Silver Imperial', ''),
    code_candidates: [{ universal_code: 'A1' }, { universal_code: 'B2' }] };
  assert.equal(outputColors([foreign, paint('Prata Imperial', 'A1')]).length, 2);
  assert.equal(outputColors([paint('Silver Imperial', 'A1'), paint('Prata Imperial', 'A1'),
    paint('Imperial Prata', 'A1')]).length, 3);
});

test('coating suffix duplicates merge after matching, preserving sources and the published suffix', () => {
  const original = [paint('Hyper White Tricoat', 'WC9', ['https://supplier.test']),
    { ...paint('HYPER WHITE', 'WC9', ['https://catalog.test']), confidence: 'high' },
    paint('Hyper White Tri-Coat', 'WC9', ['https://third.test'])];
  const copy = structuredClone(original);
  for (const colors of [original, [...original].reverse()]) {
    const result = outputColors(colors);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'Hyper White');
    assert.deepEqual(result[0].paintFinish, ['tricamada']);
    assert.equal(result[0].confidence, 'high');
    assert.equal(result[0].universal_code, 'WC9');
    assert.deepEqual(new Set(result[0].sources), new Set(original.flatMap(c => c.sources)));
  }
  assert.deepEqual(original, copy);
});

test('coating deduplication requires matching codes and never removes distinctive words', () => {
  assert.equal(outputColors([paint('Branco Polar Tricamada', 'A1'), paint('Branco Polar', 'A1')]).length, 1);
  assert.equal(outputColors([paint('Ruby Red Three-Coat', 'R1'), paint('Ruby Red', 'R1')]).length, 1);
  for (const colors of [
    [paint('Hyper White', 'WC9'), paint('Hyper White II Tricoat', 'WC9')],
    [paint('Hyper White', 'WC9'), paint('Hyper White Pearl Tricoat', 'WC9')],
    [paint('Ice White', 'WW7'), paint('Diamond White Tricoat', 'WW7')],
  ]) assert.equal(identityCount(outputColors(colors)), 2);
  assert.equal(identityCount(outputColors([paint('Hyper White', 'WC9'), paint('Hyper White Tricoat', 'WW2')])), 2);
  for (const colors of [
    [paint('Hyper White', ''), paint('Hyper White Tricoat', '')],
    [paint('Hyper White Tricoat', ''), { ...paint('Hyper White', ''),
      code_candidates: [{ universal_code: 'WC9' }, { universal_code: 'WW2' }] }],
  ]) assert.equal(outputColors(colors).length, 1);
});

test('a coating label moves to the standardized finish field', () => {
  assert.equal(outputColors([paint('Hyper White Tricoat', 'WC9')])[0].name, 'Hyper White');
  assert.deepEqual(outputColors([paint('Hyper White Tricoat', 'WC9')])[0].paintFinish, ['tricamada']);
});

test('Pearlcoat is a finish suffix and does not duplicate its base identity', () => {
  const colors = outputColors([paint('White Crystal', 'AJ'), paint('White Crystal Pearlcoat', 'AJ')]);
  assert.equal(colors.length, 1);
  assert.equal(colors[0].name, 'White Crystal');
  assert.deepEqual(colors[0].paintFinish, ['perolizado']);
});

test('a printed Perol suffix shares its coded paint identity with the base name', () => {
  const colors = outputColors([paint('Vermelho Ópera', 'LQ3Z', ['https://year.example']),
    paint('Vermelho Ópera Perol', 'LQ3Z', ['https://palette.example'])]);

  assert.equal(colors.length, 1);
  assert.equal(colors[0].name, 'Vermelho Ópera');
  assert.deepEqual(colors[0].paintFinish, ['perolizado']);
  assert.deepEqual(colors[0].sources.sort(), ['https://palette.example', 'https://year.example']);
});

test('a published Portuguese accent survives an unaccented duplicate', () => {
  const colors = outputColors([paint('Vermelho Opera', 'LQ3Z'), paint('Vermelho Ópera', 'LQ3Z')]);

  assert.deepEqual(colors.map(color => color.name), ['Vermelho Ópera']);
});

test('final output moves sourced suffixes into standardized finish labels', () => {
  const { candidateInventory, reviewedColors } = require('../candidate_inventory');
  for (const [name, base, finishes] of [
    ['Shimmering Silver Metallic', 'Shimmering Silver', ['metálico']],
    ['Pure White Pearl', 'Pure White', ['perolizado']],
    ['Hyper White Tricoat', 'Hyper White', ['tricamada']],
    ['Branco Aurora Perolizado Tricamada', 'Branco Aurora', ['perolizado', 'tricamada']],
    ['Night Black Matte', 'Night Black', ['fosco']],
    ['Ruby Red Solid', 'Ruby Red', ['sólido']],
  ]) {
    const candidates = candidateInventory([{ id: 'P1', url: 'https://catalog.test',
      candidates: [{ name, evidence: [name] }] }]);
    const colors = reviewedColors(candidates, { C1: { action: 'include', name: null,
      confidence: 'low', source_ids: ['P1'], reason: 'Published name' } });
    assert.equal(outputColors(colors)[0].name, base);
    assert.deepEqual(outputColors(colors)[0].paintFinish, finishes);
  }
});

const matchedPaint = (name, code, description, sources = []) => ({ ...paint(name, code, sources),
  code_candidates: [{ universal_code: code, description, manufacturer: 'Example' }] });

test('matched hue and finish evidence merges descriptor omissions and prefers the complete published name', () => {
  for (const [short, complete, description] of [
    ['Pure Pearl Tricoat', 'Pure Pearl White', 'WHITE PEARL (BASE)/CL'],
    ['Ruby Pearl Tricoat', 'Ruby Red Pearl', 'RED PEARL'],
    ['Lunar Metallic', 'Lunar Silver Metallic', 'SILVER MET'],
    ['Polar Tricamada', 'Polar Branco Perolizado', 'BRANCO PEROLIZADO'],
    ['Galaxy', 'Galaxy Pearl', 'BLUE PEARL'],
  ]) {
    const original = [matchedPaint(short, 'A1', description, ['https://short.test']),
      matchedPaint(complete, 'A1', description, ['https://complete.test'])];
    const copy = structuredClone(original);
    for (const entries of [original, [...original].reverse()]) {
      const result = outputColors(entries);
      assert.equal(result.length, 1, short);
      assert.equal(result[0].name, require('../paint_name').completePaintName(complete));
      assert.deepEqual(new Set(result[0].sources), new Set(['https://short.test', 'https://complete.test']));
      assert.deepEqual(result[0].code_candidates, [{ universal_code: 'A1' }]);
    }
    assert.deepEqual(original, copy);
  }
});

test('same code never overrides conflicting hues, finishes, versions, makes or distinctive names', () => {
  for (const [a, b] of [
    ['Pure Pearl White', 'Pure Pearl Blue'], ['Ruby Red Matte', 'Ruby Red Metallic'],
    ['Pure Pearl II', 'Pure Pearl White'], ['Ice White', 'Diamond White'],
    ['Pure Pearl', 'Pure Pearl White'],
  ]) {
    // The last pair has no evidence establishing the missing white descriptor.
    assert.equal(identityCount(outputColors([matchedPaint(a, 'A1', 'BLUE PEARL'),
      matchedPaint(b, 'A1', 'WHITE PEARL')])), 2, `${a} / ${b}`);
  }
  const a = matchedPaint('Pure Pearl Tricoat', 'A1', 'WHITE PEARL');
  const b = matchedPaint('Pure Pearl White', 'A1', 'WHITE PEARL');
  b.code_candidates[0].manufacturer = 'Other';
  assert.equal(outputColors([a, b]).length, 2);
});

test('explicit two-name source aliases share one paint; unrelated same-code names remain separate', () => {
  const passage = '### Bright Red/Standard Red\n\nMfr. Color Code: WA7475/72';
  const shared = { url: 'https://colors.test', passages: [passage] };
  const result = outputColors([
    { ...matchedPaint('Bright Red', '72,WA7475', 'BRIGHT RED'), source_evidence: [shared] },
    { ...matchedPaint('Standard Red', '72,WA7475', 'BRIGHT RED'), source_evidence: [shared] },
    matchedPaint('Sharkskin 1', '72,WA7475', 'MED GREEN PEARL'),
  ]);
  assert.equal(result.length, 2);
  assert.deepEqual(result.find(color => color.name === 'Bright Red').aliases, ['Standard Red']);
  assert.ok(result.some(color => color.name === 'Sharkskin 1'));
});

test('redundant translated hue words merge only with an identical code set', () => {
  const same = ['GAZ', 'WA8624'];
  const color = name => ({ ...paint(name, '', ['https://colors.test']),
    code_candidates: same.map(universal_code => ({ universal_code,
      description: 'BRANCO SUMMIT', manufacturer: 'GM' })) });
  const result = outputColors([color('Branco Summit White'), color('Branco Summit')]);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Branco Summit');
  assert.deepEqual(new Set(result[0].code_candidates.map(row => row.universal_code)), new Set(same));
});

test('missing or conflicting matched descriptors do not justify a missing hue', () => {
  const complete = matchedPaint('Pure Pearl White', 'N2', 'WHITE PEARL');
  for (const ambiguous of [paint('Pure Pearl Tricoat', 'N2'),
    { ...paint('Pure Pearl Tricoat', 'N2'), code_candidates: [
      { universal_code: 'N2', description: 'WHITE PEARL' },
      { universal_code: 'N2', description: 'BLUE PEARL' },
    ] },
    matchedPaint('Pure Pearl Tricoat', 'OTHER', 'WHITE PEARL')]) {
    assert.equal(outputColors([ambiguous, complete]).length, 2);
  }
});

test('keeps names, every code, URLs, usage and timing without mutating the detailed result', () => {
  const detailed = {
    make: 'Example', model: 'Model', year: 2020, market: 'Brazil', runId: 'run',
    colors: [{ name: 'Complete Silver', paintFinish: ['desconhecido'], confidence: 'low', sources: ['https://a.test'],
      evidence: 'Applicability explanation', source_evidence: [{ passages: ['Full passage'] }],
      universal_code: '', code_candidates: [
        { universal_code: 'A1', description: 'Database description', year: 2010 },
        { universal_code: 'B2', description: 'Other description', year: 2015 },
      ] }],
    tokenUsage: { totalTokens: 50 }, tokenUsageByAgent: { main: { totalTokens: 50 } },
    modelCalls: { main: 2 }, browserUses: { serper: 10 }, pagesFetched: 25,
    totalTimeMs: 35000, totalTimeByStageMs: { research: 24000 },
    research: { status: 'partial', candidatesReviewed: 4,
      unreviewedCandidates: [{ id: 'C4', name: 'Unreviewed Blue' }],
      unresolvedNames: [{ name: 'Short', sources: ['https://b.test'], reason: 'Ambiguous', source_evidence: [] }],
      warnings: [{ stage: 'extraction', message: 'Long failure details' },
        { stage: 'extraction', message: 'Another failure' }],
    },
  };
  const original = structuredClone(detailed);
  const result = finalOutput(detailed, { format: 'expanded' });
  assert.deepEqual(result.colors, [{ name: 'Complete Silver', paintFinish: ['desconhecido'], confidence: 'low', sources: ['https://a.test'],
    universal_code: '', code_candidates: [{ universal_code: 'A1' }, { universal_code: 'B2' }] }]);
  for (const field of ['tokenUsage', 'tokenUsageByAgent', 'modelCalls', 'browserUses',
    'pagesFetched', 'totalTimeMs', 'totalTimeByStageMs']) assert.deepEqual(result[field], detailed[field]);
  assert.deepEqual(result.research.unresolvedNames, [{ name: 'Short', sources: ['https://b.test'] }]);
  assert.deepEqual(result.research.unreviewedCandidates, [{ name: 'Unreviewed Blue' }]);
  assert.deepEqual(result.research.reviewCoverage, { total: 5, reviewed: 4, unreviewed: 1 });
  assert.deepEqual(result.research.warnings, [{ stage: 'extraction', count: 2 }]);
  assert.deepEqual(detailed, original);
});

test('error responses preserve the error and run identifier with compact warnings', () => {
  assert.deepEqual(finalOutput({ error: 'No supported candidates', runId: 'run', warnings: [
    { stage: 'search', message: 'Details stored in debug output' },
  ] }, { format: 'expanded' }), { error: 'No supported candidates', runId: 'run', warnings: [{ stage: 'search', count: 1 }] });
});

test('compact v3 includes per-color URLs, all code options, unresolved sources, usage and time', () => {
  const result = { make: 'Volkswagen', model: 'Gol', year: 2015, market: 'Brazil', runId: 'test',
    colors: [paint('PRATA LUNAR', 'aB1', ['https://a.test', 'https://b.test']),
      { ...paint('CINZA PLATINUM', '', ['https://b.test']),
        code_candidates: [{ universal_code: 'LD7X' }, { universal_code: '2R2R' }] }],
    tokenUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    cost: { estimatedCostUsd: 0.03 }, totalTimeMs: 32123.45,
    research: { status: 'partial', warnings: [], unreviewedCandidates: [{ name: 'BLUE SKY' }],
      unresolvedNames: [{ name: 'HYPER', sources: ['https://b.test', 'https://c.test'] }] } };
  const original = structuredClone(result);
  const compact = finalOutput(result);
  assert.equal(compact.formatVersion, 3);
  assert.equal(compact.sources, undefined);
  assert.deepEqual(compact.colors[0], { name: 'Prata Lunar', paintFinish: ['desconhecido'], codes: ['aB1'], confidence: 'low',
    sources: ['https://a.test', 'https://b.test'] });
  assert.deepEqual(compact.colors[1].sources, ['https://b.test']);
  assert.deepEqual(compact.colors[1].codes, ['LD7X', '2R2R']);
  assert.deepEqual(compact.research.unresolvedNames, [{ name: 'Hyper', sources: ['https://b.test', 'https://c.test'] }]);
  assert.deepEqual(compact.research.unreviewedNames, ['Blue Sky']);
  assert.equal(compact.usage.estimatedCostUsd, 0.03);
  assert.equal(compact.usage.totalTokens, 120);
  assert.deepEqual(compact.usage.byModel, []);
  assert.equal(compact.timeMs, 32123);
  assert.deepEqual(result, original);
});

test('model usage combines stages and tiers without double-counting cached input', () => {
  const entries = [
    { stage: 'main', provider: 'openai', model: 'gpt-6-luna', serviceTier: 'default',
      calls: 2, inputTokens: 100, cachedInputTokens: 30, outputTokens: 20, estimatedCostUsd: 0.00002 },
    { stage: 'pageAnalysis', provider: 'openai', model: 'gpt-6-luna', serviceTier: 'fast',
      calls: 3, inputTokens: 200, cachedInputTokens: 50, outputTokens: 40, estimatedCostUsd: 0.000071 },
    { stage: 'databaseMatcher', provider: 'openai', model: 'gpt-6-luna', serviceTier: 'default',
      calls: 1, inputTokens: 50, outputTokens: 10, estimatedCostUsd: 0.00001 },
    { stage: 'pageAnalysis', provider: 'gemini', model: 'gemini-3.5-flash-lite',
      calls: 4, inputTokens: 300, outputTokens: 60, estimatedCostUsd: 0.00024 },
  ];
  const result = { colors: [], research: { status: 'complete' }, cost: { entries } };
  const original = structuredClone(result);
  assert.deepEqual(finalOutput(result).usage.byModel, [
    { provider: 'openai', model: 'gpt-6-luna', calls: 6,
      inputTokens: 350, cachedInputTokens: 80, outputTokens: 70,
      totalTokens: 420, estimatedCostUsd: 0.000101, knownCostUsd: 0.000101 },
    { provider: 'gemini', model: 'gemini-3.5-flash-lite', calls: 4,
      inputTokens: 300, cachedInputTokens: 0, outputTokens: 60,
      totalTokens: 360, estimatedCostUsd: 0.00024, knownCostUsd: 0.00024 },
  ]);
  assert.deepEqual(result, original);
});

test('error output retains per-model usage and does not treat unknown costs as zero', () => {
  const entry = { provider: 'openai', model: 'example', calls: 1,
    inputTokens: 10, outputTokens: 2, estimatedCostUsd: 0.00001 };
  for (const unknown of [{ estimatedCostUsd: null }, {}, { missingUsage: 1, estimatedCostUsd: 0 }]) {
    const result = finalOutput({ error: 'Research failed', cost: { entries: [
      entry, { provider: 'openai', model: 'example', calls: 1, ...unknown }, entry,
    ] } });
    assert.equal(result.error, 'Research failed');
    assert.equal(result.usage.byModel.length, 1);
    assert.equal(result.usage.byModel[0].estimatedCostUsd, null);
    assert.equal(result.usage.byModel[0].totalTokens, 24);
    assert.equal(result.usage.byModel[0].calls, 3);
    if (unknown.missingUsage) assert.equal(result.usage.byModel[0].missingUsage, 1);
  }
});

test('both output formats keep retrieval counters and list all page statuses last', () => {
  const retrieval = {
    browserUses: { total: 5, brave: 5, serper: 0, nameClarification: 1 },
    pageFetchAttempts: 2, pagesFetched: 1, fetchErrors: 1, pagesWithoutText: 0, pagesPending: 0,
    fetchedPages: [{ url: 'https://ok.test', status: 'ok' },
      { url: 'https://failed.test', status: 'error', error: 'HTTP 404' }],
  };
  for (const format of ['compact', 'expanded']) {
    for (const error of [undefined, 'Research failed']) {
      const result = { colors: [], research: { status: 'complete' }, ...retrieval, ...(error && { error }) };
      const original = structuredClone(result);
      const output = finalOutput(result, { format });
      for (const key of Object.keys(retrieval)) assert.deepEqual(output[key], retrieval[key]);
      assert.equal(Object.keys(output).at(-1), 'fetchedPages');
      assert.deepEqual(result, original);
    }
  }
});
