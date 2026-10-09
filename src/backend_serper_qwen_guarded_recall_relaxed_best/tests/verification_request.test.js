const test = require('node:test');
const assert = require('node:assert/strict');
const { verificationRequest, subset } = require('../verification_request');
const { requestWorkload, structuredRequest } = require('../request_envelope');

const child = { type: 'object', properties: { checks: { type: 'array' } }, required: ['checks'] };
const schema = { type: 'object', properties: { V1: child, V2: child, V3: child, V4: child },
  required: ['V1', 'V2', 'V3', 'V4'] };
const input = { vehicle: {}, colors: ['V1', 'V2', 'V3', 'V4'].map((id, i) => ({ id, source_ids: [`S${i + 1}`] })),
  pages: [1, 2, 3, 4].map(id => ({ id: `S${id}`, text: `Exact evidence ${id}` })) };
const timeout = partialOutput => Object.assign(new Error('Timeout'), {
  code: 'MODEL_ROUTE_TIMEOUT', routeId: 'openrouter:qwen/qwen3.5-flash-02-23', partialOutput,
});

test('verification timeout retains completed colors and splits only remaining colors', async () => {
  const sent = [];
  const result = await verificationRequest(async (_stage, childSchema, data, _prompt, routing) => {
    sent.push(data.colors.map(color => color.id));
    if (sent.length === 1) throw timeout({ V1: { checks: [] }, V2: { checks: 'invalid' } });
    assert.equal(routing.startAfter, 'openrouter:qwen/qwen3.5-flash-02-23');
    assert.equal(routing.splitOnTimeout, false);
    assert.deepEqual(data.pages.map(page => page.id), data.colors.flatMap(color => color.source_ids));
    assert.deepEqual(childSchema.required, data.colors.map(color => color.id));
    return Object.fromEntries(data.colors.map(color => [color.id, { checks: [] }]));
  }, 'final_verification_V1', schema, input, 'Verify');
  assert.deepEqual(sent, [['V1', 'V2', 'V3', 'V4'], ['V2', 'V3'], ['V4']]);
  assert.deepEqual(Object.keys(result), ['V1', 'V2', 'V3', 'V4']);
});

test('verification split preserves successful siblings when the other half fails', async () => {
  let calls = 0;
  await assert.rejects(verificationRequest(async (_stage, _schema, data) => {
    calls++;
    if (calls === 1) throw timeout({});
    if (data.colors[0].id === 'V3') throw new Error('Provider unavailable');
    return { V1: { checks: [] }, V2: { checks: [] } };
  }, 'final_verification_V1', schema, input, 'Verify'), error => {
    assert.deepEqual(error.partialOutput, { V1: { checks: [] }, V2: { checks: [] } });
    assert.deepEqual(error.completedIds, ['V1', 'V2']);
    return true;
  });
  assert.equal(calls, 3);
});

test('large verification batches split before sending and retain complete source texts', async () => {
  const large = { ...input, pages: input.pages.map(page => ({ ...page, text: page.text.repeat(1800) })) };
  const seen = [];
  await verificationRequest(async (stage, childSchema, data, instructions) => {
    assert.ok(requestWorkload(structuredRequest(stage, childSchema, data, instructions)).totalChars <= 60000);
    seen.push(...data.pages);
    return Object.fromEntries(data.colors.map(color => [color.id, { checks: [] }]));
  }, 'final_verification_V1', schema, large, 'Verify');
  assert.deepEqual(seen, large.pages);
});

test('omission subsets preserve original evidence IDs and every owned source', () => {
  const omissionSchema = { properties: { reconsiderations: { items: { properties: {
    candidate_id: { enum: ['C1', 'C2'] },
  } } } } };
  const omitted = { candidates: [
    { id: 'C1', sources: [{ page_id: 'P1', evidence_ids: ['E1', 'E2'] }] },
    { id: 'C2', sources: [{ page_id: 'P2', evidence_ids: ['E2', 'E3'] }] },
  ], evidence: { E1: 'One', E2: 'Shared', E3: 'Three' }, pages: [{ id: 'P1' }, { id: 'P2' }] };
  const result = subset(omissionSchema, omitted, [omitted.candidates[1]]);
  assert.deepEqual(result.input.evidence, { E2: 'Shared', E3: 'Three' });
  assert.deepEqual(result.input.pages, [{ id: 'P2' }]);
  assert.deepEqual(result.schema.properties.reconsiderations.items.properties.candidate_id.enum, ['C2']);
  assert.deepEqual(omissionSchema.properties.reconsiderations.items.properties.candidate_id.enum, ['C1', 'C2']);
});
