const test = require('node:test');
const assert = require('node:assert/strict');
const { ReviewBatcher, ReviewSlots } = require('../review_batcher');
const { requestWorkload, structuredRequest } = require('../request_envelope');
const { individualSchema } = require('../targeted_extractor');

test('independent review queues share transport slots and assemble waiting candidates together', async () => {
  const slots = new ReviewSlots(2);
  const releases = [];
  const sizes = [];
  let active = 0, peak = 0;
  const execute = async (_stage, _schema, input) => {
    peak = Math.max(peak, ++active);
    sizes.push(input.requests.length);
    if (sizes.length <= 2) await new Promise(resolve => releases.push(resolve));
    active--;
    return Object.fromEntries(input.requests.map(request => [request.id, {}]));
  };
  const first = new ReviewBatcher(execute, { size: 6, concurrency: 6, slots });
  const second = new ReviewBatcher(execute, { size: 6, concurrency: 6, slots });
  const item = { schema: {}, instructions: 'Review', input: { evidence: {} } };
  const jobs = [first.add(item)];
  first.flush();
  jobs.push(first.add(item));
  first.flush();
  for (let i = 0; i < 6; i++) {
    jobs.push(second.add(item));
    second.flush();
  }
  assert.equal(slots.active, 2);
  assert.equal(second.active, 0);
  assert.equal(second.pending.length, 6);
  releases.forEach(release => release());
  await Promise.all(jobs);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(peak, 2);
  assert.deepEqual(sizes, [1, 1, 6]);
  assert.equal(slots.active, 0);
  assert.equal(slots.waiting.size, 0);
});

test('page transport preserves complete catalog records and verbatim openings without repeated field names', () => {
  const records = [
    { description: 'Example Pearl', year: '2010-2020', market: null, model: 'Example', source_row: 10 },
    { description: 'Example Solid', year: '2015-', market: 'Brazil', model: 'Example Sport', source_row: 11 },
  ];
  const pages = records.map((catalog_record, index) => ({ id: `P${index}`, title: 'Catalog',
    opening: `Original qualification ${index}`, catalog_record, incomplete_extraction: false }));
  const items = pages.map(page => ({ schema: {}, instructions: 'Review', input: {
    vehicle: {}, candidates: [], evidence: { E1: page.opening }, pages: [page],
  } }));
  const original = structuredClone(items);
  const { input, instructions } = new ReviewBatcher(async () => {}).prepare(items);
  assert.deepEqual(items, original);
  assert.equal(Object.keys(input.sharedCatalogRecords).length, 2);
  for (const [index, page] of Object.values(input.sharedPages).entries()) {
    assert.equal(input.passages[page.opening_passage_id], pages[index].opening);
    assert.equal(page.opening, undefined);
    const values = input.sharedCatalogRecords[page.catalog_record_ref];
    assert.deepEqual(Object.fromEntries(input.recordColumns.map((column, i) => [column, values[i]])), records[index]);
    assert.equal(page.incomplete_extraction, false);
  }
  assert.match(instructions, /not selectable K catalog identities/);
});

test('redundant owned catalog rows and omitted optional detail do not invalidate paint facts', async () => {
  const candidate = { name: 'Example White', sources: [{ page_id: 'P1', evidence_ids: ['E1'] }],
    catalog_check: { rows: [1, 2, 3].map(candidate_id => ({ candidate_id, manufacturer: 'Example',
      universal_code: '040', paintFinish: ['sólido'], year: String(2000 + candidate_id) })) } };
  const input = { vehicle: { paintFinish: 'perolizado' }, candidates: [candidate], evidence: { E1: 'Example White: solid.' } };
  const batcher = new ReviewBatcher(async (_stage, _schema, transport) => ({ R1: {
    decision: 'include', source_ids: ['P1'], catalog_refs: transport.requests[0].candidates[0].catalog_check.row_refs,
    name: null, confidence: 'high', reason: 'Acabamento sólido documentado.', name_status: 'complete',
    finish_status: 'incompatible', finish_evidence_ids: ['E1'],
  } }), { size: 1, repairInvalid: false });
  const result = await batcher.add({ input, schema: individualSchema(candidate, input), instructions: 'Review' });
  assert.deepEqual(result.catalog_ids, [1, 2, 3], 'preserve every selected row, including conflicting editions');
  assert.equal(result.finish_status, 'incompatible');
  assert.equal(result.detail_question, '');
});

test('batch evidence IDs are globally unambiguous and restored to candidate-local IDs', async () => {
  const items = ['One White', 'Two White'].map(name => {
    const candidate = { name, sources: [{ page_id: 'P1', evidence_ids: ['E1'] }], catalog_check: { rows: [] } };
    const input = { vehicle: { paintFinish: 'perolizado' }, candidates: [candidate], evidence: { E1: name } };
    return { input, schema: individualSchema(candidate, input), instructions: 'Review',
      validate: value => assert.deepEqual(value.finish_evidence_ids, ['E1']) };
  });
  const batcher = new ReviewBatcher(async (_stage, schema, input) => {
    assert.deepEqual(input.requests.map(request => request.candidates[0].sources[0].evidence_ids), [['E1'], ['E2']]);
    for (const request of input.requests) {
      for (const [id, evidence] of Object.entries(request.evidence)) {
        assert.equal(evidence.passage_id, id);
        assert.equal(typeof input.passages[id], 'string');
      }
    }
    assert.deepEqual(schema.properties.R2.anyOf[1].properties.finish_evidence_ids.items.enum, ['E2']);
    return Object.fromEntries(input.requests.map((request, index) => [request.id, {
      decision: 'include', source_ids: ['P1'], catalog_refs: [], name: null, confidence: 'low',
      reason: 'Paint is documented.', name_status: 'complete', detail: null,
      finish_status: 'compatible', finish_evidence_ids: [`E${index + 1}`],
    }]));
  }, { size: 2, repairInvalid: false });
  const answers = await Promise.all(items.map(item => batcher.add(item)));
  assert.deepEqual(answers.map(answer => answer.finish_evidence_ids), [['E1'], ['E1']]);
  assert.deepEqual(items[1].input.candidates[0].sources[0].evidence_ids, ['E1'], 'do not mutate stored evidence');
});

test('a sibling evidence ID cannot become a valid local citation by coincidence', async () => {
  const batcher = new ReviewBatcher(async () => Object.fromEntries(['R1', 'R2'].map(id => [id, {
    decision: 'include', source_ids: ['P1'], catalog_refs: [], name: null, confidence: 'low',
    reason: 'Paint is documented.', name_status: 'complete', detail: null,
    finish_status: 'compatible', finish_evidence_ids: ['E1'],
  }])), { size: 2, repairInvalid: false });
  const answers = await Promise.allSettled(['One White', 'Two White'].map(name => {
    const candidate = { name, sources: [{ page_id: 'P1', evidence_ids: ['E1'] }], catalog_check: { rows: [] } };
    const input = { vehicle: { paintFinish: 'perolizado' }, candidates: [candidate], evidence: { E1: name } };
    return batcher.add({ input, schema: individualSchema(candidate, input), instructions: 'Review' });
  }));
  assert.equal(answers[0].status, 'fulfilled');
  assert.equal(answers[1].status, 'rejected');
  assert.match(answers[1].reason.message, /schema/);
});

test('arrivals waiting for capacity stay together instead of freezing tiny batches', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const sizes = [];
  const batcher = new ReviewBatcher(async (_stage, _schema, input) => {
    sizes.push(input.requests.length);
    if (sizes.length === 1) await blocked;
    return Object.fromEntries(input.requests.map(request => [request.id, {}]));
  }, { size: 6, concurrency: 1 });
  const add = () => batcher.add({ schema: {}, instructions: 'Review', input: { evidence: {} } });
  const jobs = [add()];
  batcher.flush();
  for (let index = 0; index < 5; index++) {
    jobs.push(add());
    batcher.flush();
  }

  assert.equal(batcher.active, 1);
  release();
  await Promise.all(jobs);
  assert.deepEqual(sizes, [1, 5]);
});

test('six independent decisions share one request and deduplicate verbatim passages', async () => {
  let calls = 0;
  const batcher = new ReviewBatcher(async (_stage, schema, input) => {
    calls++;
    assert.equal(schema.required.length, 6);
    assert.equal(Object.keys(input.passages).length, 1);
    return Object.fromEntries(input.requests.map(request => [request.id, { name: request.candidates[0].name }]));
  }, { size: 6 });
  const values = await Promise.all(Array.from({ length: 6 }, (_, i) => batcher.add({
    schema: { type: 'object' }, instructions: 'Review each paint',
    input: { candidates: [{ name: `Paint ${i}` }], evidence: { E1: 'Original paint table' } },
    validate: value => assert.equal(value.name, `Paint ${i}`),
  })));
  assert.equal(calls, 1);
  assert.equal(values.length, 6);
});

test('catalog transport shares rows while preserving each candidate allowed identities', async () => {
  const common = { candidate_id: 10, description: 'Paint One', universal_code: 'A1', years: ['2018'] };
  const separate = { candidate_id: 20, description: 'Paint Two', universal_code: 'B2', years: ['2019'] };
  const batcher = new ReviewBatcher(async (_stage, _schema, input) => {
    assert.equal(Object.keys(input.sharedCatalogRows).length, 2);
    assert.deepEqual(input.requests.map(request => request.candidates[0].catalog_check.row_refs),
      [['K1'], ['K1', 'K2']]);
    const restore = ref => Object.fromEntries(input.catalogColumns.map((key, index) =>
      [key, input.sharedCatalogRows[ref][index]]));
    const { candidate_id: firstId, ...first } = common;
    const { candidate_id: secondId, ...second } = separate;
    assert.deepEqual(restore('K1'), first);
    assert.deepEqual(restore('K2'), second);
    return { R1: {}, R2: {} };
  }, { size: 2 });

  await Promise.all([[common], [common, separate]].map(rows => batcher.add({
    schema: {}, instructions: 'Review', input: { candidates: [{ catalog_check: { rows } }], evidence: {} },
  })));
  assert.equal(common.candidate_id, 10);
});

test('short catalog references round-trip to original IDs and cannot borrow sibling rows', async () => {
  const candidate = { name: 'Example Silver', sources: [{ page_id: 'P1' }],
    catalog_check: { rows: [{ candidate_id: -100123, description: 'EXAMPLE SILVER' }] } };
  const input = { vehicle: {}, candidates: [candidate], evidence: { E1: 'Example Silver' } };
  const batcher = new ReviewBatcher(async (_stage, schema) => {
    const objectSchema = schema.properties.R1.anyOf[1];
    assert.deepEqual(objectSchema.properties.catalog_refs.items.enum, ['K1']);
    return { R1: { decision: 'include', catalog_refs: ['K1'], source_ids: ['P1'],
      name: null, confidence: 'low', reason: 'Fonte vincula o modelo.', name_status: 'complete', detail: null } };
  });
  const answer = await batcher.add({ input, schema: individualSchema(candidate, input), instructions: 'Review' });

  assert.deepEqual(answer.catalog_ids, [-100123]);
  assert.equal(answer.catalog_refs, undefined);
});

test('batch size counts full transport and still shares repeated evidence', async () => {
  let calls = 0;
  const passage = 'Verbatim source passage. '.repeat(40);
  const row = { candidate_id: 1, description: 'Catalog description '.repeat(40) };
  const batcher = new ReviewBatcher(async (_stage, _schema, input) => {
    calls++;
    assert.equal(input.requests.length, 4);
    assert.equal(Object.keys(input.passages).length, 1);
    return Object.fromEntries(input.requests.map(request => [request.id, {}]));
  }, { size: 4, maxChars: 16000 });

  await Promise.all(Array.from({ length: 4 }, () => batcher.add({ schema: {}, instructions: 'Review',
    input: { evidence: { E1: passage }, candidates: [{ catalog_check: { rows: [row] } }] },
  })));
  assert.equal(calls, 1);
});

test('invalid candidate does not discard correctly reviewed siblings', async () => {
  const batcher = new ReviewBatcher(async () => ({ R1: { valid: true }, R2: { valid: false } }));
  const results = await Promise.allSettled([1, 2].map(() => batcher.add({
    schema: {}, instructions: 'Review', input: { evidence: {} },
    validate: value => assert.equal(value.valid, true),
  })));
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
});

test('cancelled queued requests send no model request', async () => {
  const controller = new AbortController();
  const batcher = new ReviewBatcher(async () => { throw new Error('Must not call model'); });
  const result = batcher.add({ signal: controller.signal, schema: {}, input: { evidence: {} } });
  controller.abort(new Error('Cancelled'));
  await assert.rejects(result, /Cancelled/);
});

test('an explicit exclusion in an object is never expanded into inclusion', async () => {
  const batcher = new ReviewBatcher(async () => ({ R1: {
    decision: 'unrelated_hue', reason: 'Azul documentado; a consulta pede prata.',
    source_ids: ['P1'], catalog_ids: [], detail: null, name: null, confidence: 'high',
  } }));
  const value = await batcher.add({
    schema: { properties: { action: {} } }, instructions: 'Review',
    input: { vehicle: {}, candidates: [{}], evidence: {} },
  });
  assert.equal(value.action, 'exclude');
  assert.equal(value.exclusion, 'unrelated_hue');
});

test('exclusion transport requires short verdicts while uncertain candidates keep full decisions', async () => {
  const inputs = ['Documented Red', 'Prata Shark'].map(name => {
    const candidate = { name, sources: [{ page_id: 'P1' }], catalog_check: { rows: [] } };
    const input = { vehicle: { predominantColor: 'cinza' }, candidates: [candidate],
      evidence: { E1: `${name}: published appearance and model evidence` } };
    return { input, schema: individualSchema(candidate, input), instructions: 'Review each candidate' };
  });
  const batcher = new ReviewBatcher(async (_stage, schema) => {
    assert.ok(schema.properties.R1.anyOf[0].enum.includes('unrelated_hue'));
    assert.deepEqual(schema.properties.R1.anyOf[1].properties.decision.enum, ['include']);
    return { R1: 'unrelated_hue', R2: { decision: 'include', source_ids: ['P1'], catalog_refs: [],
      name: null, confidence: 'low', reason: 'Aparência cinza/prata; nome não exclui.',
      name_status: 'complete', detail: null } };
  }, { size: 2 });
  const result = await Promise.all(inputs.map(input => batcher.add(input)));
  assert.equal(result[0].action, 'exclude');
  assert.equal(result[1].action, 'include');
  assert.deepEqual(result[1].source_ids, ['P1']);
});

test('large exclusion batches retain a decision for every original candidate', async () => {
  let calls = 0;
  const batcher = new ReviewBatcher(async (_stage, _schema, input) => {
    calls++;
    return Object.fromEntries(input.requests.map(request => [request.id, 'unrelated_hue']));
  }, { size: 24, maxChars: 85000, concurrency: 4 });
  const answers = await Promise.all(Array.from({ length: 240 }, (_, index) => batcher.add({
    schema: { properties: { action: {} } }, instructions: 'Read evidence before exclusion',
    input: { vehicle: {}, candidates: [{ name: `Paint ${index}` }], evidence: { E1: 'Visual family evidence' } },
  })));
  assert.equal(calls, 10);
  assert.equal(answers.length, 240);
  assert.ok(answers.every(answer => answer.action === 'exclude'));
});

test('rich batches obey the smaller payload bound without truncating any evidence', async () => {
  const seen = [];
  let calls = 0;
  const batcher = new ReviewBatcher(async (stage, schema, input, instructions) => {
    calls++;
    assert.ok(requestWorkload(structuredRequest(stage, schema, input, instructions)).totalChars <= 35000);
    seen.push(...Object.values(input.passages));
    return Object.fromEntries(input.requests.map(request => [request.id, { checked: true }]));
  }, { size: 8, maxChars: 35000 });
  const evidence = Array.from({ length: 8 }, (_, index) => `${index}: ${'Verbatim paint evidence. '.repeat(300)}`);
  await Promise.all(evidence.map(text => batcher.add({ schema: {}, instructions: 'Review',
    input: { candidates: [], evidence: { E1: text } },
  })));
  assert.equal(calls, 3);
  assert.deepEqual(seen, evidence);
});

test('a schema-invalid child is repaired without repeating its valid sibling', async () => {
  let calls = 0;
  const batcher = new ReviewBatcher(async () => {
    calls++;
    return calls === 1 ? { R1: { ok: true }, R2: { ok: 'invalid' } } : { ok: false };
  }, { size: 2 });
  const values = await Promise.all([1, 2].map(() => batcher.add({
    instructions: 'Review independently', input: { evidence: {} },
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
  })));
  assert.deepEqual(values, [{ ok: true }, { ok: false }]);
  assert.equal(calls, 2);
});

test('hue triage still routes every uncertain candidate through its full review', async () => {
  let calls = 0;
  const batcher = new ReviewBatcher(async (_stage, schema, input) => {
    calls++;
    if (input.triage) {
      assert.ok(schema.properties.R1.enum.includes('review'));
      return { R1: 'unrelated_hue', R2: 'review' };
    }
    assert.equal(input.candidates[0].name, 'Blue Silver');
    return { action: 'include', reason: 'Silver paint with a blue undertone.', catalog_ids: [] };
  }, { triage: true, size: 2 });
  const values = await Promise.all(['Red Paint', 'Blue Silver'].map(name => batcher.add({
    schema: { properties: { action: {} } }, instructions: 'Review each paint',
    input: { vehicle: {}, candidates: [{ name }], evidence: {} },
  })));
  assert.equal(calls, 2);
  assert.equal(values[0].exclusion, 'unrelated_hue');
  assert.equal(values[1].action, 'include');
});

test('uncertain triage decisions share one full review without individual request bursts', async () => {
  let calls = 0;
  const repair = new ReviewBatcher(async (_stage, _schema, input) => {
    calls++;
    assert.equal(input.requests.length, 6);
    assert.ok(input.requests.every(request => request.review_issue));
    return Object.fromEntries(input.requests.map(request => [request.id, { reviewed: true }]));
  }, { size: 6, repairInvalid: false });
  const triage = new ReviewBatcher(async (_stage, _schema, input) => {
    calls++;
    return Object.fromEntries(input.requests.map(request => [request.id, 'review']));
  }, { size: 6, triage: true, repairBatcher: repair });
  const result = await Promise.all(Array.from({ length: 6 }, () => triage.add({
    input: { evidence: {}, candidates: [] }, instructions: 'Review every candidate',
    schema: { type: 'object', properties: { reviewed: { type: 'boolean' } }, required: ['reviewed'] },
    validate: value => assert.equal(value.reviewed, true),
  })));
  assert.equal(calls, 2);
  assert.equal(result.length, 6);
});

test('a failed repair batch terminates without recursively generating more requests', async () => {
  let calls = 0;
  const repair = new ReviewBatcher(async () => { calls++; return {}; }, { repairInvalid: false });
  const batcher = new ReviewBatcher(async () => { calls++; return {}; }, { repairBatcher: repair });
  await assert.rejects(batcher.add({ input: { evidence: {} }, schema: { type: 'object' },
    instructions: 'Review' }), /schema/);
  assert.equal(calls, 2);
});

test('concurrent vehicle review batches never share evidence or decisions', async () => {
  const run = marker => {
    const batcher = new ReviewBatcher(async (_stage, _schema, input) => {
      assert.deepEqual(Object.values(input.passages), [marker]);
      await new Promise(resolve => setImmediate(resolve));
      return Object.fromEntries(input.requests.map(request => [request.id, { vehicle: marker }]));
    }, { size: 4 });
    return Promise.all(Array.from({ length: 4 }, () => batcher.add({
      input: { evidence: { E1: marker } }, instructions: 'Review', schema: { type: 'object' },
      validate: value => assert.equal(value.vehicle, marker),
    })));
  };
  const [first, second] = await Promise.all([run('Vehicle A'), run('Vehicle B')]);
  assert.ok(first.every(value => value.vehicle === 'Vehicle A'));
  assert.ok(second.every(value => value.vehicle === 'Vehicle B'));
});

test('timeout splits only unfinished candidates and continues after the failed route', async () => {
  const sent = [];
  const batcher = new ReviewBatcher(async (_stage, _schema, input, _instructions, _signal, _validate, routing) => {
    sent.push({ names: input.requests.map(row => row.candidates[0].name), routing });
    if (sent.length === 1) throw Object.assign(new Error('Timeout'), {
      code: 'MODEL_ROUTE_TIMEOUT', routeId: 'openrouter:qwen/qwen3.5-flash-02-23',
      partialOutput: { R1: { ok: true }, R2: { ok: 'invalid' } },
    });
    return Object.fromEntries(input.requests.map(row => [row.id, { ok: true }]));
  }, { size: 4 });
  const answers = await Promise.all(['One', 'Two', 'Three', 'Four'].map(name => batcher.add({
    instructions: 'Review', input: { candidates: [{ name }], evidence: { E1: name } },
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    validate: value => assert.equal(value.ok, true),
  })));
  assert.equal(answers.length, 4);
  assert.deepEqual(sent.map(row => row.names), [['One', 'Two', 'Three', 'Four'], ['Two', 'Three'], ['Four']]);
  assert.ok(sent.slice(1).every(row => row.routing.startAfter === 'openrouter:qwen/qwen3.5-flash-02-23'
    && row.routing.splitOnTimeout === false));
});

test('split recovery is bounded and retains successful siblings when one half fails', async () => {
  let calls = 0;
  const batcher = new ReviewBatcher(async (_stage, _schema, input) => {
    calls++;
    if (calls === 1 || input.requests[0].candidates[0].name === 'Three') {
      throw Object.assign(new Error('Timeout'), { code: 'MODEL_ROUTE_TIMEOUT', routeId: 'qwen' });
    }
    return Object.fromEntries(input.requests.map(row => [row.id, { ok: true }]));
  }, { size: 4 });
  const answers = await Promise.allSettled(['One', 'Two', 'Three', 'Four'].map(name => batcher.add({
    schema: { type: 'object', required: ['ok'] }, instructions: 'Review',
    input: { candidates: [{ name }], evidence: {} },
  })));
  assert.equal(calls, 3);
  assert.deepEqual(answers.map(answer => answer.status), ['fulfilled', 'fulfilled', 'rejected', 'rejected']);
});

test('long schemas and instructions count toward the batch limit; single evidence is never cut', async () => {
  const item = { instructions: 'Full instructions '.repeat(300),
    input: { candidates: [], evidence: { E1: 'Unchanged evidence' } },
    schema: { type: 'object', properties: { ok: { type: 'boolean', description: 'Schema context '.repeat(200) } }, required: ['ok'] } };
  const sizes = [];
  const batcher = new ReviewBatcher(async (stage, schema, input, instructions) => {
    sizes.push(input.requests.length);
    assert.equal(input.passages.E1, 'Unchanged evidence');
    assert.ok(requestWorkload(structuredRequest(stage, schema, input, instructions)).totalChars <= batcher.maxChars);
    return Object.fromEntries(input.requests.map(row => [row.id, { ok: true }]));
  }, { size: 3 });
  batcher.maxChars = batcher.prepare([item]).workload.totalChars + 10;
  await Promise.all([item, item, item].map(value => batcher.add(value)));
  assert.deepEqual(sizes, [1, 1, 1]);
});
