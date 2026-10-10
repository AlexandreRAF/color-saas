const test = require('node:test');
const assert = require('node:assert/strict');
const { CodeMatchPipeline } = require('../code_match_pipeline');

test('approved colors start matching before final collection and are billed once', async () => {
  let release;
  const started = new Promise(resolve => { release = resolve; });
  const calls = [];
  const pipeline = new CodeMatchPipeline(async colors => {
    calls.push(colors);
    release();
    return colors.map(color => ({ ...color, universal_code: 'N3S' }));
  });
  const colors = [{ name: 'Shimmering Silver', sources: ['https://catalog.test'] }];
  pipeline.start(colors);
  await started;
  pipeline.start(structuredClone(colors));
  assert.equal((await pipeline.finish(colors))[0].universal_code, 'N3S');
  assert.equal(calls.length, 1);
});

test('changed source evidence or finish gets a new match, including previously excluded colors', async () => {
  const calls = [];
  const pipeline = new CodeMatchPipeline(async colors => {
    calls.push(colors);
    return colors.filter(color => color.finishMatch !== 'incompatible');
  });
  const original = { name: 'White Pearl', finishMatch: 'incompatible', sources: ['https://a.test'] };
  pipeline.start([original]);
  assert.deepEqual(await pipeline.finish([original]), []);
  const final = { ...original, finishMatch: 'unknown', sources: [...original.sources, 'https://b.test'] };
  assert.deepEqual(await pipeline.finish([final]), [final]);
  assert.equal(calls.length, 2);
});

test('final selection removes obsolete speculative colors and waits for their usage', async () => {
  let completed = false;
  const pipeline = new CodeMatchPipeline(async colors => {
    await new Promise(resolve => setTimeout(resolve, 5));
    completed = true;
    return colors;
  });
  pipeline.start([{ name: 'Removed Alias' }]);
  assert.deepEqual(await pipeline.finish([]), []);
  assert.ok(completed);
});

test('match errors are observed and draining settles all work', async () => {
  const pipeline = new CodeMatchPipeline(async () => { throw new Error('Matcher failed'); });
  pipeline.start([{ name: 'Silver Mist' }]);
  await assert.rejects(pipeline.finish([{ name: 'Silver Mist' }]), /Matcher failed/);
  assert.equal((await pipeline.drain())[0].status, 'rejected');
});

test('matching coverage distinguishes a completed no-match from exhausted retries', async () => {
  const colors = [{ name: 'No Catalog Rows' }, { name: 'Unfinished Match' }];
  const pipeline = new CodeMatchPipeline(async input => {
    const result = input.map(color => ({ ...color, universal_code: '' }));
    Object.defineProperty(result, 'incompleteNames', { value: ['Unfinished Match'] });
    return result;
  });
  await pipeline.finish(colors);
  assert.deepEqual(pipeline.coverage(colors), { total: 2, completed: 1, incomplete: 1,
    incompleteNames: ['Unfinished Match'] });
});

test('same-name paints retain their own matched evidence and code', async () => {
  const colors = [
    { name: 'Summit White', sources: ['https://first.test'] },
    { name: 'Summit White', sources: ['https://second.test'] },
  ];
  const pipeline = new CodeMatchPipeline(async input => input.map((color, index) => ({
    ...color, universal_code: index ? 'WA8624' : 'GAZ',
  })));
  const result = await pipeline.finish(colors);
  assert.deepEqual(result.map(color => color.universal_code), ['GAZ', 'WA8624']);
  assert.deepEqual(result.map(color => color.sources[0]), ['https://first.test', 'https://second.test']);
});
