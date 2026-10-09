const test = require('node:test');
const assert = require('node:assert/strict');
const { extractDetails, communicationSchema, individualSchema, individualDecision } = require('../targeted_extractor');
const { matchesSchema } = require('../model_router');
const { reviewSchema } = require('../candidate_inventory');
const { pageRequest } = require('../qwen_page');

const candidate = { id: 'C1', name: 'Ice White', sources: [{ page_id: 'P1', url: 'https://paint.test', evidence: ['Ice White'] }] };
const pages = [{ id: 'P1', url: 'https://paint.test', status: 'ok', text: 'Hyundai Azera: Ice White WW9. Acabamento: perolizado.' }];

test('individual review uses a simple complete schema and preserves the extractor request and provisional decision', () => {
  const schema = individualSchema(candidate, { evidence: { E1: pages[0].text } });
  const value = { catalog_ids: [], action: 'include', name: null, confidence: 'low', source_ids: ['P1'], reason: 'Documented paint',
    name_status: 'complete', exclusion: 'none', finish_status: 'unknown', finish_evidence_ids: [],
    detail_question: 'Find the separate finish specification', detail_page_ids: ['P1'] };
  assert.ok(matchesSchema(value, schema));
  const decision = individualDecision(value, candidate, { paintFinish: 'perolizado' });
  assert.equal(decision.C1.decision.finish_status, 'unknown');
  assert.equal(decision.C1.request_details.question, value.detail_question);
  assert.ok(!matchesSchema({ action: 'include' }, schema));
  assert.ok(!matchesSchema(value, individualSchema(candidate, { evidence: {} }, true)));
});

test('main reviewer can ask for a targeted detail and receives only literal evidence for that candidate', async () => {
  const schema = communicationSchema(reviewSchema([candidate]), candidate);
  assert.ok(schema.properties.C1.anyOf.some(branch => branch.properties?.request_details));
  const result = await extractDetails(candidate, { question: 'Confirm the separate finish specification', page_ids: ['P1'] }, pages, {}, {
    signal: new AbortController().signal, review: async (stage, _schema, input, _instructions, _signal, validate) => {
      assert.equal(stage, 'extract_details_C1');
      assert.match(input.question, /finish/);
      const result = { passages: [{ page_id: 'P1', quote: pages[0].text }] };
      validate(result);
      assert.throws(() => validate({ passages: [{ page_id: 'P1', quote: 'Ice White is solid' }] }), /unsupported/);
      assert.throws(() => validate({ passages: [{ page_id: 'invented', quote: pages[0].text }] }), /unsupported/);
      return result;
    },
  });
  assert.equal(result.passages, 1);
  assert.ok(result.candidate.sources[0].evidence.includes(pages[0].text));
  assert.deepEqual(candidate.sources[0].evidence, ['Ice White']);
});

test('a finish claim without web citations stays unknown without discarding the paint identity', () => {
  for (const finish_status of ['compatible', 'incompatible']) {
    const decision = individualDecision({ action: 'include', name: null, confidence: 'low', source_ids: ['P1'],
      reason: 'Catalog identity is known; web finish is unspecified', name_status: 'complete', exclusion: 'none',
      finish_status, finish_evidence_ids: [], detail_question: '', detail_page_ids: [],
    }, candidate, { paintFinish: 'perolizado' });
    assert.equal(decision.C1.finish_status, 'unknown');
    assert.equal(decision.C1.action, 'include');
    assert.deepEqual(decision.C1.source_ids, ['P1']);
  }
});

test('Qwen catalog and verification prompts never inherit page-extraction response instructions', () => {
  for (const name of ['catalog_check_1', 'final_verification_V1', 'extract_details_C1']) {
    const body = pageRequest({ instructions: 'Use the provided task.', input: '{}',
      text: { format: { name, schema: { type: 'object', properties: { result: { type: 'string' } } } } } });
    assert.match(body.messages[0].content, /Use the provided task/);
    assert.doesNotMatch(body.messages[0].content, /Return only.*candidates|no named paints/);
  }
});
