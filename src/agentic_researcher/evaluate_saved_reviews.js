'use strict';

// Paid model replay, ZERO web searches. Measures review scheduling against a
// saved inventory; it is not a fresh-search or end-to-end latency benchmark.
const fs = require('node:fs');
const path = require('node:path');

const { AgenticLoop } = require('./ai');
const { RunTiming } = require('./run_timing');
const { pipelineDeadlines } = require('./research_deadlines');
const { CatalogResearch } = require('./catalog_research');
const { CandidateReviewPipeline, prioritizeCandidates } = require('./candidate_review_pipeline');
const { reviewInventory } = require('./review_stage');
const { repairUnreviewed } = require('./completion_review');

async function replay(filename, output, elapsedMs = 18000, names = []) {
  const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const events = [];
  const run = new AgenticLoop({ debugDirectory: `${output}.debug`,
    onProgress: event => events.push(event),
    browseFn: async () => { throw new Error('Search is disabled in saved-review replay'); } });
  run.vehicle = saved.vehicle;
  run.pages = saved.pages;
  run.catalogPages = saved.catalogPages || [];
  const candidates = prioritizeCandidates(run.candidates(), run.evidencePages(), saved.vehicle)
    .filter(candidate => !names.length || names.includes(candidate.name));
  if (!candidates.length) throw new Error('No saved candidates match the replay selection');
  // Local lookups normally overlap discovery. Warm them before simulating the
  // start of review, and report that wall time separately.
  const prepared = performance.now();
  run.catalogs = new CatalogResearch(saved.vehicle, { deferIdentity: true,
    signal: AbortSignal.timeout(15000), warn: run.warn.bind(run), log: run.log.bind(run) });
  try {
    run.catalogs.start(candidates);
    await run.catalogs.drain();
    const catalogPreparationMs = Math.round(performance.now() - prepared);
    const timing = run.timing = new RunTiming({ pauseForCapacity: false, targetTimeMs: 50000 });
    timing.started -= elapsedMs;
    const { signals } = pipelineDeadlines(timing, 50000);
    run.reviewSignal = signals.review;
    run.repairSignal = signals.repair;
    run.reviewPipeline = new CandidateReviewPipeline((candidate, stage) =>
      run.reviewCandidate(candidate, saved.vehicle, run.reviewSignal, stage), {
      signal: run.reviewSignal, pages: () => run.evidencePages(), onEvent: run.log.bind(run) });
    const started = performance.now();
    const state = await reviewInventory(run, saved.vehicle, candidates);
    run.routing.budget.finishReviews();
    const repair = await repairUnreviewed(run, saved.vehicle, candidates, state);
    const result = { kind: 'saved_inventory_live_model_replay', source: path.resolve(filename),
      assumedDiscoveryMs: elapsedMs, catalogPreparationMs, reviewTimeMs: Math.round(performance.now() - started),
      browserUses: 0, candidates: candidates.length, reviewed: state.reviewedCandidates.length,
      selectedNames: names,
      unreviewed: state.unreviewedCandidates, repair, colors: state.colors,
      failures: [...state.failures].filter(([id]) => !Object.hasOwn(state.decisions, id))
        .map(([id, error]) => ({ id, message: error.message, code: error.code, stage: error.reviewStage })),
      cost: run.cost.summary(0.06), modelRequests: run.retrievalSummary().modelRequests,
      events,
      warnings: run.warnings };
    fs.writeFileSync(output, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, events: undefined, colors: result.colors.map(color => color.name),
      warnings: result.warnings.length, unreviewed: result.unreviewed.length }, null, 2));
    return result;
  } finally {
    run.timing?.abort(new Error('Replay finished'));
    await run.reviewPipeline?.drain();
    await run.catalogs.drain();
    run.catalogs.close();
    run.timing?.close();
  }
}

if (require.main === module) {
  const [flag, filename, output, elapsed = '18000', ...names] = process.argv.slice(2);
  const elapsedMs = Number(elapsed);
  if (flag !== '--live-models' || !filename || !output || !Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= 34000) {
    console.error('Usage: node evaluate_saved_reviews.js --live-models evidence.json output.json [assumedDiscoveryMs=18000] [paint names...]');
    process.exitCode = 1;
  } else replay(filename, output, elapsedMs, names).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { replay };
