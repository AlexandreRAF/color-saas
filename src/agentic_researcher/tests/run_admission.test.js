const test = require('node:test');
const assert = require('node:assert/strict');

const { admitRun } = require('../run_admission');
const { ModelScheduler, DEFAULT_LIMITS } = require('../model_scheduler');
const { RunTiming } = require('../run_timing');

test('production rejects excess vehicles before work and releases the active slot', async () => {
  const scheduler = new ModelScheduler({ limits: { ...DEFAULT_LIMITS,
    'network:run': { ...DEFAULT_LIMITS['network:run'], concurrency: 1 } } });
  const timing = new RunTiming({ pauseForCapacity: false });
  const options = { production: true, scheduler, admissionTimeoutMs: 15 };
  try {
    const results = await Promise.allSettled(Array.from({ length: 7 }, () =>
      admitRun(options, scheduler, timing, () => {}, {})));
    const admitted = results.filter(row => row.status === 'fulfilled');
    assert.equal(admitted.length, 1);
    assert.equal(results.filter(row => row.reason?.code === 'RUN_CAPACITY_BUSY').length, 6);
    assert.equal(scheduler.state('network:run').active, 1);
    assert.equal(scheduler.queue.length, 0);
    admitted[0].value.cancel();
    const next = await admitRun(options, scheduler, timing, () => {}, {});
    next.cancel();
    assert.equal(scheduler.state('network:run').active, 0);
  } finally { timing.close(); }
});

test('production configuration and caller cancellation fail before admission', async () => {
  const timing = new RunTiming();
  try {
    await assert.rejects(admitRun({ production: true }, null, timing, () => {}, {}),
      { code: 'PRODUCTION_CAPACITY_REQUIRED' });
    assert.equal(await admitRun({}, null, timing, () => {}, {}), null);
    timing.abort(new Error('Caller cancelled'));
    await assert.rejects(admitRun({ production: true, scheduler: true }, new ModelScheduler(), timing, () => {}, {}),
      /Caller cancelled/);
  } finally { timing.close(); }
});
