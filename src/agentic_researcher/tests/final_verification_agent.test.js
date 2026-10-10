const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyFinalColors, applyChecks, excerpts, catalogEvidence } = require('../final_verification_agent');
const { RunTiming } = require('../run_timing');

const color = { name: 'Pure White', codes: ['N2'], paintFinish: ['perolizado'], sources: ['https://old.test'] };
const vehicle = { brand: 'Hyundai', model: 'Azera', country: 'Brazil' };
const quote = 'Hyundai Azera: Pure White Pearl, N2. Finish: pearlescent.';
const page = { id: 'S1', url: 'https://new.test/', text: quote };
const checks = ['name', 'vehicle', 'codes', 'paintFinish'].map(field => ({ confirmed: [field], conflicting: [], source_id: 'S1', quote }));

test('verification reuses two independent named pages without another search or download', async () => {
  const timing = new RunTiming({ pauseForCapacity: false });
  let searches = 0, reviews = 0;
  try {
    const result = await verifyFinalColors({ colors: [color] }, vehicle, {
      timing, signal: timing.deadline(1000), reuseEvidence: true,
      existingPages: ['https://one.test/', 'https://two.test/'].map(url => ({ url, status: 'ok', text: quote })),
      browse: async queries => { searches += queries.length; return queries.map(query => ({ query,
        results: [{ url: 'https://third.test/', title: 'Pure White' }] })); },
      fetchPages: async () => { throw new Error('Named independent source evidence should be reused'); },
      warn: error => assert.fail(String(error)),
      review: async () => { reviews++; return { V1: { checks: [] } }; },
    });
    assert.equal(searches, 0);
    assert.equal(reviews, 1);
    assert.equal(result.summary.colorsChecked, 1);
    assert.equal(result.summary.pagesFetched, 0);
    assert.equal(result.colors[0].verification.status, 'unverified');
  } finally { timing.close(); }
});

test('a failed split keeps reviewed sibling colors and their page accounting', async () => {
  const timing = new RunTiming({ softDeadlines: true });
  try {
    const result = await verifyFinalColors({ colors: [color, { ...color, name: 'Another White' }] }, vehicle, {
      timing, signal: timing.signal,
      research: { add() {}, flush() {}, evidence: async () => [page], drain: async () => {}, pages: [page], queries: [] },
      review: async () => { throw Object.assign(new Error('Second half unavailable'), {
        partialOutput: { V1: { checks: [] } },
      }); },
    });
    assert.equal(result.summary.colorsChecked, 1);
    assert.equal(result.summary.colorsUnchecked, 1);
    assert.equal(result.summary.pagesReviewed, 1);
    assert.equal(result.colors[0].verification.reviewed, true);
    assert.equal(result.colors[1].verification.reviewed, false);
  } finally { timing.close(); }
});

test('one correction wave can finish a larger unchecked palette using the same evidence', async () => {
  const timing = new RunTiming({ softDeadlines: true });
  const colors = Array.from({ length: 15 }, (_, index) => ({ ...color, name: `White ${index}` }));
  const attempts = new Map();
  let evidenceReads = 0;
  try {
    const result = await verifyFinalColors({ colors }, vehicle, {
      timing, signal: timing.deadline(10000), retryUnchecked: true,
      research: { add() {}, flush() {}, evidence: async () => { evidenceReads++; return [page]; },
        drain: async () => {}, pages: [page], queries: [] },
      review: async (stage, _schema, input) => {
        const seen = attempts.get(stage) || 0;
        attempts.set(stage, seen + 1);
        if (!seen) throw new Error('Temporary provider failure');
        return Object.fromEntries(input.colors.map(row => [row.id, { checks: [] }]));
      },
    });
    assert.equal(result.summary.colorsChecked, 15);
    assert.equal(result.summary.colorsUnchecked, 0);
    assert.equal([...attempts.values()].reduce((total, count) => total + count, 0), 16);
    assert.equal(evidenceReads, 30);
  } finally { timing.close(); }
});

test('a large final palette limits its own review transports under concurrent load', async () => {
  const timing = new RunTiming({ softDeadlines: true });
  const colors = Array.from({ length: 30 }, (_, index) => ({ ...color, name: `White ${index}` }));
  let active = 0, peak = 0;
  try {
    const result = await verifyFinalColors({ colors }, vehicle, {
      timing, signal: timing.deadline(10000),
      research: { add() {}, flush() {}, evidence: async () => [page],
        drain: async () => {}, pages: [page], queries: [] },
      review: async (_stage, _schema, input) => {
        peak = Math.max(peak, ++active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active--;
        return Object.fromEntries(input.colors.map(row => [row.id, { checks: [] }]));
      },
    });
    assert.equal(result.summary.colorsChecked, 30);
    assert.equal(peak, 4);
  } finally { timing.close(); }
});

test('only grounded verification citations are appended, preserving original data', () => {
  const original = structuredClone(color);
  const result = applyChecks(color, checks, [page], vehicle);
  assert.deepEqual(result.sources, ['https://old.test', 'https://new.test/']);
  assert.equal(result.verification.status, 'confirmed');
  assert.deepEqual(color, original);
  for (const invalid of [
    { ...checks[0], source_id: 'hallucinated' },
    { ...checks[0], quote: 'Invented Pure White evidence' },
    { ...checks[0], quote: 'Finish: pearlescent.' },
  ]) {
    const checked = applyChecks(color, [invalid], [page], vehicle);
    assert.deepEqual(checked.sources, color.sources);
    assert.equal(checked.verification.status, 'unverified');
  }
});

test('contradictions stay explicit and never delete colors or overwrite their codes', () => {
  const conflicting = { id: 'S2', url: 'https://conflict.test/', text: 'Pure White N2. Finish: solid.' };
  const result = applyChecks(color, [...checks, { source_id: 'S2', quote: conflicting.text,
    confirmed: [], conflicting: ['paintFinish'] }], [page, conflicting], vehicle);
  assert.equal(result.verification.status, 'conflicting');
  assert.deepEqual(result.verification.conflicting, ['paintFinish']);
  assert.ok(!result.verification.confirmed.includes('paintFinish'));
  assert.deepEqual(result.codes, ['N2']);
});

test('the model cannot confirm pearl using a separately labelled solid specification', () => {
  const solid = { ...page, text: 'Pure White N2. Finish: solid.' };
  const result = applyChecks(color, [{ ...checks[3], quote: solid.text }], [solid], vehicle);
  assert.equal(result.verification.status, 'unverified');
});

test('a published name suffix cannot confirm finish or contradict the same base name', () => {
  const row = { ...page, text: 'Pure White Pearl N2' };
  const result = applyChecks(color, [{ source_id: 'S1', quote: row.text,
    confirmed: ['name', 'paintFinish'], conflicting: ['name'] }], [row], vehicle);
  assert.equal(result.verification.status, 'partial');
  assert.deepEqual(result.verification.confirmed, ['name']);
  assert.deepEqual(result.verification.conflicting, []);
});

test('a quote establishing one code cannot confirm all alternatives', () => {
  const result = applyChecks({ ...color, codes: ['N2', 'NW'] }, [{ ...checks[2] }], [page], vehicle);
  assert.equal(result.verification.status, 'unverified');
});

test('catalog suffix evidence verifies finish without inventing a web source or vehicle-year confirmation', async () => {
  const timing = new RunTiming({ pauseForCapacity: false });
  try {
    const result = await verifyFinalColors({ colors: [color] }, { ...vehicle, manufacturingYear: 2010 }, {
      timing, signal: timing.deadline(1000), browse: async () => [], fetchPages: async () => [],
      catalogColors: [{ name: color.name, code_candidates: [{ catalog_evidence: [{
        catalog: 'basf', description: 'PURE WHITE PEARL', manufacturer: 'HYUNDAI', year: '2005-2015', universal_code: 'N2',
      }] }] }],
      review: async (_stage, _schema, input) => {
        const record = input.pages.find(page => page.catalog === 'basf');
        assert.match(record.text, /Finish: perolizado/);
        return { V1: { checks: [{ confirmed: ['name', 'codes', 'paintFinish', 'year', 'vehicle'], conflicting: [],
          source_id: record.id, evidence_ids: [1] }] } };
      },
    });
    assert.equal(result.summary.colorsChecked, 1);
    assert.deepEqual(result.colors[0].verification.confirmed, ['name', 'codes', 'paintFinish']);
    assert.deepEqual(result.colors[0].verification.unknown, ['vehicle', 'year']);
    assert.deepEqual(result.colors[0].verification.catalogs, ['basf']);
    assert.deepEqual(result.colors[0].sources, color.sources);
    assert.equal(result.summary.pagesReviewed, 0);
    assert.equal(result.summary.catalogRecordsReviewed, 1);
  } finally { timing.close(); }
});

test('verification compacts repeated catalog editions while preserving names, years and distinct finishes', () => {
  const row = { catalog: 'basf', manufacturer: 'HYUNDAI', description: 'PURE WHITE PEARL', universal_code: 'N2' };
  const records = [2005, 2006, 2010].map(year => ({ ...row, year: String(year) }));
  records.push({ ...row, description: 'PURE WHITE SOLID', year: '2011' });
  const evidence = catalogEvidence(color, [{ name: color.name, code_candidates: [{ catalog_evidence: records }] }]);
  assert.equal(evidence.length, 2);
  assert.match(evidence[0].text, /2005; 2006; 2010/);
  assert.match(evidence[0].text, /Finish: perolizado/);
  assert.match(evidence[1].text, /Finish: sólido/);
});

test('separate agent searches finalized colors, fetches pages and verifies quotes', async () => {
  const timing = new RunTiming({ pauseForCapacity: false });
  const queried = [], fetched = [], calls = [];
  try {
    const result = await verifyFinalColors({ colors: [color] }, vehicle, {
      timing, signal: timing.deadline(5000),
      browse: async queries => { queried.push(...queries); return [{ results: [{ url: page.url,
        title: 'Hyundai Azera Pure White paint N2' }] }]; },
      fetchPages: async urls => { fetched.push(...urls); return [{ ...page, status: 'ok' }]; },
      review: async (stage, _schema, input) => {
        calls.push(stage);
        assert.equal(input.colors[0].name, 'Pure White');
        assert.equal(input.pages[0].text, `1| ${quote}`);
        return { V1: { checks } };
      },
    });
    assert.match(queried[0], /Pure White.*N2/);
    assert.deepEqual(new Set(fetched), new Set([...color.sources.map(url => new URL(url).href), page.url]));
    assert.deepEqual(calls, ['final_verification_V1']);
    assert.equal(result.summary.status, 'complete');
    assert.equal(result.pages[0].verification, true);
    assert.deepEqual(result.colors[0].sources, [...color.sources, page.url]);
  } finally { timing.close(); }
});

test('deadline and provider failures preserve all initial colors as unverified', async () => {
  const timing = new RunTiming({ pauseForCapacity: false });
  try {
    const result = await verifyFinalColors({ colors: [color, { ...color, name: 'Moon White' }] }, vehicle, {
      timing, signal: timing.deadline(1000),
      browse: async () => { throw new Error('Search unavailable'); },
      fetchPages: async () => { throw new Error('Must not fetch'); },
      review: async () => { throw new Error('Must not review snippets'); },
    });
    assert.equal(result.colors.length, 2);
    assert.ok(result.colors.every(color => color.verification.status === 'unverified'));
    assert.equal(result.summary.status, 'partial');
  } finally { timing.close(); }
});

test('cached fetched text can be checked without another fetch or duplicate citation', async () => {
  const timing = new RunTiming({ pauseForCapacity: false });
  try {
    const result = await verifyFinalColors({ colors: [{ ...color, sources: [page.url] }] }, vehicle, {
      timing, signal: timing.deadline(1000), existingPages: [{ ...page, status: 'ok' }],
      browse: async () => [{ results: [{ url: page.url }, { url: page.url }] }],
      fetchPages: async () => { throw new Error('Already fetched'); },
      review: async () => ({ V1: { checks } }),
    });
    assert.deepEqual(result.colors[0].sources, [page.url]);
    assert.equal(result.pages.length, 0);
  } finally { timing.close(); }
});

test('verification waits for newly fetched search evidence before reviewing', async () => {
  const timing = new RunTiming({ pauseForCapacity: false });
  let searchDone = false;
  try {
    const result = await verifyFinalColors({ colors: [color] }, vehicle, {
      timing, signal: timing.deadline(5000),
      browse: async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        searchDone = true;
        return [{ results: [{ url: page.url }] }];
      },
      fetchPages: async () => [{ ...page, status: 'ok' }],
      review: async () => {
        assert.equal(searchDone, true);
        return { V1: { checks } };
      },
    });
    assert.equal(result.colors[0].verification.status, 'confirmed');
  } finally { timing.close(); }
});

test('a stalled verification model is cancelled at the shared deadline', async () => {
  const timing = new RunTiming({ pauseForCapacity: false });
  let reviewed = false;
  try {
    const result = await verifyFinalColors({ colors: [color] }, vehicle, {
      timing, signal: timing.deadline(80), existingPages: [{ ...page, status: 'ok' }],
      browse: async () => assert.fail('No search near the deadline'),
      fetchPages: async () => [{ ...page, status: 'ok' }],
      review: async (_stage, _schema, _input, _instructions, signal) => new Promise((resolve, reject) => {
        reviewed = true;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    });
    assert.equal(result.colors[0].verification.status, 'unverified');
    assert.equal(reviewed, true);
    assert.ok(timing.summary().totalMs < 500);
  } finally { timing.close(); }
});

test('slow or failed new searches still allow an independent check of fetched evidence', async () => {
  const timing = new RunTiming({ pauseForCapacity: false });
  try {
    let searches = 0;
    const result = await verifyFinalColors({ colors: [color] }, vehicle, {
      timing, signal: timing.deadline(5000), existingPages: [{ ...page, status: 'ok' }],
      browse: async () => { searches++; throw new Error('Engine unavailable'); },
      fetchPages: async () => { throw new Error('Already fetched'); },
      review: async () => ({ V1: { checks } }),
    });
    assert.equal(searches, 1);
    assert.equal(result.summary.pagesFetched, 0);
    assert.equal(result.summary.pagesReviewed, 1);
    assert.equal(result.colors[0].verification.status, 'confirmed');
    assert.ok(result.colors[0].sources.includes(page.url));
  } finally { timing.close(); }
});

test('grouped searches cover every color with separate evidence, including the last small batch', async () => {
  const timing = new RunTiming({ pauseForCapacity: false });
  const colors = Array.from({ length: 9 }, (_, i) => ({ name: `Silver Variant ${i}`, codes: [],
    sources: [`https://catalog.test/${i}`], paintFinish: ['desconhecido'] }));
  const existingPages = colors.map((color, i) => ({ url: color.sources[0], status: 'ok',
    text: `Hyundai Azera ${color.name}` }));
  const queries = [], reviewed = [];
  try {
    const result = await verifyFinalColors({ colors }, vehicle, {
      timing, signal: timing.deadline(5000), existingPages,
      browse: async input => { queries.push(...input); return []; },
      fetchPages: async () => { throw new Error('Use the cached source'); },
      review: async (_stage, schema, input) => {
        assert.deepEqual(schema.required, input.colors.map(color => color.id));
        return Object.fromEntries(input.colors.map(color => {
          reviewed.push(color.name);
          const source = input.pages.find(page => color.source_ids.includes(page.id));
          assert.ok(source.text.includes(color.name));
          return [color.id, { checks: [{ confirmed: ['name', 'vehicle'], conflicting: [],
            source_id: source.id, evidence_ids: [1] }] }];
        }));
      },
    });
    assert.equal(queries.length, Math.ceil(colors.length / 3));
    for (const color of colors) assert.ok(queries.some(query => query.includes(`"${color.name}"`)));
    assert.deepEqual(new Set(reviewed), new Set(colors.map(color => color.name)));
    assert.equal(result.summary.colorsChecked, 9);
    assert.equal(result.summary.colorsUnchecked, 0);
    assert.equal(result.summary.coverage, 'complete');
    assert.equal(result.summary.colorsConfirmed, 9);
  } finally { timing.close(); }
});

test('a slow evidence group does not occupy the only final model slot', async () => {
  const timing = new RunTiming({ pauseForCapacity: false });
  const colors = Array.from({ length: 4 }, (_, index) => ({ ...color, name: `Named White ${index + 1}` }));
  const starts = [];
  let releaseFirst;
  const firstReady = new Promise(resolve => { releaseFirst = resolve; });
  const fallback = setTimeout(() => releaseFirst(), 200);

  try {
    const result = await verifyFinalColors({ colors }, vehicle, {
      timing, signal: timing.deadline(1000), reviewConcurrency: 1,
      research: {
        add() {}, flush() {}, drain: async () => {}, pages: [], queries: [],
        evidence: async candidate => {
          if (['Named White 1', 'Named White 2'].includes(candidate.name)) await firstReady;
          return [{ url: 'https://paint.test/', status: 'ok', text: `${candidate.name} Hyundai Azera` }];
        },
      },
      review: async (stage, _schema, input) => {
        starts.push(stage);
        if (stage === 'final_verification_V3') releaseFirst();
        return Object.fromEntries(input.colors.map(candidate => [candidate.id, { checks: [] }]));
      },
    });

    assert.deepEqual(starts, ['final_verification_V3', 'final_verification_V1']);
    assert.equal(result.summary.colorsChecked, 4);
  } finally {
    clearTimeout(fallback);
    timing.close();
  }
});

test('large final palettes batch reviews while checking every individual color', async () => {
  const timing = new RunTiming({ pauseForCapacity: false });
  let active = 0, peak = 0, calls = 0;
  const colors = Array.from({ length: 25 }, (_, index) => ({ ...color, name: `Named White ${index}` }));
  const existing = { ...page, status: 'ok', text: colors.map(color => `${color.name}: N2`).join('\n') };
  try {
    const result = await verifyFinalColors({ colors }, vehicle, {
      timing, signal: timing.deadline(2000), existingPages: [existing],
      browse: async () => [], fetchPages: async () => [],
      review: async (_stage, _schema, input) => {
        calls++;
        assert.ok(input.colors.length <= 6);
        peak = Math.max(peak, ++active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active--;
        return Object.fromEntries(input.colors.map(color => [color.id, { checks: [] }]));
      },
    });
    assert.equal(calls, 5);
    assert.equal(peak, 4);
    assert.equal(result.summary.colorsChecked, 25);
    assert.equal(result.summary.colorsUnchecked, 0);
  } finally { timing.close(); }
});

test('very large palettes use four-color transports and four bounded review slots', async () => {
  const timing = new RunTiming({ pauseForCapacity: false });
  const colors = Array.from({ length: 74 }, (_, index) => ({ ...color, name: `Named White ${index}` }));
  const existing = { ...page, status: 'ok', text: colors.map(item => `${item.name}: N2`).join('\n') };
  let calls = 0, active = 0, peak = 0;
  try {
    const result = await verifyFinalColors({ colors }, vehicle, {
      timing, signal: timing.deadline(3000), existingPages: [existing],
      browse: async () => [], fetchPages: async () => [],
      review: async (_stage, _schema, input) => {
        calls++;
        assert.ok(input.colors.length <= 4);
        peak = Math.max(peak, ++active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active--;
        return Object.fromEntries(input.colors.map(item => [item.id, { checks: [] }]));
      },
    });
    assert.equal(calls, 19);
    assert.equal(peak, 4);
    assert.equal(result.summary.colorsChecked, 74);
    assert.equal(result.summary.colorsUnchecked, 0);
  } finally { timing.close(); }
});

test('a completed review distinguishes unknown facts from colors never reviewed', async () => {
  const timing = new RunTiming({ pauseForCapacity: false });
  try {
    const result = await verifyFinalColors({ colors: [color] }, vehicle, {
      timing, signal: timing.deadline(1000), existingPages: [{ ...page, status: 'ok' }],
      browse: async () => [], fetchPages: async () => [],
      review: async () => ({ V1: { checks: [] } }),
    });
    assert.equal(result.summary.coverage, 'complete');
    assert.equal(result.summary.colorsChecked, 1);
    assert.equal(result.summary.colorsConfirmed, 0);
    assert.equal(result.summary.status, 'partial');
    assert.equal(result.colors[0].verification.reviewed, true);
    assert.equal(result.colors[0].verification.status, 'unverified');
    assert.deepEqual(result.colors[0].verification.unknown, ['name', 'vehicle', 'codes', 'paintFinish']);
  } finally { timing.close(); }
});

test('omitted colors cannot be reported as completed reviews', async () => {
  for (const answer of [{}, { V1: {} }]) {
    const timing = new RunTiming({ pauseForCapacity: false });
    try {
      const result = await verifyFinalColors({ colors: [color] }, vehicle, {
        timing, signal: timing.deadline(1000), existingPages: [{ ...page, status: 'ok' }],
        browse: async () => [], fetchPages: async () => [], review: async () => answer,
      });
      assert.equal(result.summary.coverage, 'incomplete');
      assert.equal(result.summary.colorsUnchecked, 1);
      assert.equal(result.colors[0].verification.reviewed, false);
      assert.deepEqual(result.colors[0].sources, color.sources);
    } finally { timing.close(); }
  }
});

test('an invalid citation leaves that fact unknown without losing valid checks in the same review', async () => {
  const timing = new RunTiming({ pauseForCapacity: false });
  const warnings = [];
  try {
    const result = await verifyFinalColors({ colors: [color] }, vehicle, {
      timing, signal: timing.deadline(1000), existingPages: [{ ...page, status: 'ok' }],
      browse: async () => [], fetchPages: async () => [], warn: stage => warnings.push(stage),
      review: async () => ({ V1: { checks: [checks[0], {
        confirmed: ['vehicle'], conflicting: [], source_id: 'S1', quote: 'Invented vehicle applicability',
      }] } }),
    });
    assert.equal(result.colors[0].verification.reviewed, true);
    assert.deepEqual(result.colors[0].verification.confirmed, ['name']);
    assert.ok(result.colors[0].verification.unknown.includes('vehicle'));
    assert.ok(warnings.includes('verification_citation'));
  } finally { timing.close(); }
});

test('excerpt budgets retain evidence for the last color in a long palette', () => {
  const colors = ['Sleek Silver', 'Diamond Silver', 'Shimmering Silver', 'Titanium Silver']
    .map(name => ({ name, codes: [] }));
  const text = colors.map(color => `${'padding '.repeat(2000)}${color.name} Finish: metallic.`).join('\n');
  const excerpt = excerpts(text, colors);
  for (const color of colors) assert.ok(excerpt.includes(`${color.name} Finish: metallic.`));
  assert.ok(excerpt.length <= 6000);
});
