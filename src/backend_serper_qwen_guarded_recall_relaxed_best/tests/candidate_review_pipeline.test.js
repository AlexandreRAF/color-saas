const test = require('node:test');
const assert = require('node:assert/strict');
const { CandidateReviewPipeline, prioritizeCandidates } = require('../candidate_review_pipeline');

const candidate = () => ({ id: 'C1', name: 'Prata Switchblade', aliases: ['Prata Switchblade'],
  sources: [{ page_id: 'P1', url: 'https://paint.test/cruze', evidence: ['Cruze: Prata Switchblade'] }] });

test('unchanged evidence reuses the early review while preserving final candidate IDs', async () => {
  let calls = 0;
  const pipeline = new CandidateReviewPipeline(async color => {
    calls++;
    return { [color.id]: { action: 'include', source_ids: ['P1'], reason: 'Documented' } };
  }, { pages: [], signal: new AbortController().signal });
  pipeline.start([candidate()]);
  const final = { ...candidate(), id: 'C8' };
  const decisions = await pipeline.finish(final, 'final');
  assert.equal(calls, 1);
  assert.equal(decisions.C8.action, 'include');
  assert.equal(final.id, 'C8');
});

test('streaming sightings do not repeat AI calls; material evidence revises a stale exclusion', async () => {
  let calls = 0;
  const pipeline = new CandidateReviewPipeline(async color => {
    calls++;
    return { [color.id]: { action: color.sources[0].evidence.length === 1 ? 'exclude' : 'include' } };
  }, { pages: [], signal: new AbortController().signal });
  pipeline.start([candidate()]);
  const revised = candidate();
  revised.sources[0].evidence.push('Factory finish: metallic. OEM code 636R.');
  for (let i = 0; i < 5; i++) pipeline.start([revised]);
  const decisions = await pipeline.finish(revised, 'final');
  await pipeline.drain();
  assert.equal(calls, 2);
  assert.equal(decisions.C1.action, 'include');
});

test('direct model/year evidence is reviewed first without dropping uncertain candidates', () => {
  const general = candidate();
  general.sources[0].evidence = ['Chevrolet: Prata Switchblade'];
  const specific = { ...candidate(), name: 'Azul Eclipse', sources: [{ page_id: 'P2', url: 'https://paint.test/model',
    evidence: ['Cruze 2018 factory paint: Azul Eclipse'] }] };
  const ordered = prioritizeCandidates([general, specific], [], { model: 'Cruze', manufacturingYear: 2018 });
  assert.deepEqual(ordered, [specific, general]);
  assert.deepEqual(prioritizeCandidates([specific, general], [], {
    model: 'Cruze', manufacturingYear: 2018, predominantColor: 'prata',
  }), [general, specific], 'Requested hue has priority over a well documented different hue');
});

test('source-printed name and code rows get earlier review without excluding other shades', () => {
  const uncoded = { ...candidate(), id: 'C2', name: 'Sleek Silver', sources: [{
    page_id: 'P2', url: 'https://paint.test/ix35', evidence: ['Hyundai ix35: Sleek Silver'],
  }] };
  const coded = { ...candidate(), id: 'C3', name: 'Shimmering Silver', sources: [{
    page_id: 'P3', url: 'https://paint.test/ix35', evidence: ['COLOR CODE N3S - Shimmering Silver Metallic'],
  }] };
  const ordered = prioritizeCandidates([uncoded, coded], [], {
    model: 'ix35', predominantColor: 'prata',
  });
  assert.deepEqual(ordered, [coded, uncoded]);
  assert.equal(ordered.length, 2);
});
