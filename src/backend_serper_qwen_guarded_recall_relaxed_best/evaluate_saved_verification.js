'use strict';

// Paid model-only diagnostic. Searches and downloads are disabled; this cannot
// establish fresh-search precision or end-to-end latency.
const fs = require('node:fs');
const path = require('node:path');

const { AgenticLoop } = require('./ai');
const { RunTiming } = require('./run_timing');
const { pipelineDeadlines } = require('./research_deadlines');
const { verifyFinalColors } = require('./final_verification_agent');

async function replay(directory, output, elapsedMs = 40000) {
  const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
  const evidence = read('evidence.json');
  const original = read('result.json');
  const response = read('initial-response.json');
  if (!response.colors?.length) throw new Error('Saved run has no final colors');
  const events = [];
  const run = new AgenticLoop({ debugDirectory: `${output}.debug`, onProgress: event => events.push(event) });
  const timing = run.timing = new RunTiming({ pauseForCapacity: false, targetTimeMs: 50000 });
  timing.started -= elapsedMs;
  const { signals } = pipelineDeadlines(timing, 50000);
  const started = performance.now();
  try {
    const verified = await verifyFinalColors(response, evidence.vehicle, {
      timing, signal: signals.verification, searchSignal: signals.verificationSearch,
      browse: async () => [], fetchPages: async () => [],
      existingPages: evidence.pages, catalogColors: original.colors,
      modelCatalogPages: evidence.catalogPages || [], reuseEvidence: true,
      review: run.mainAgent.bind(run), warn: run.warn.bind(run), log: run.log.bind(run),
    });
    const result = { kind: 'saved_final_palette_live_model_replay', source: path.resolve(directory),
      assumedProcessingMs: elapsedMs, verificationTimeMs: Math.round(performance.now() - started),
      browserUses: 0, cost: run.cost.summary(0.06), modelRequests: run.retrievalSummary().modelRequests,
      ...verified, events, warnings: run.warnings };
    fs.writeFileSync(output, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, colors: undefined, pages: undefined, events: undefined,
      warnings: run.warnings.length }, null, 2));
    return result;
  } finally { timing.abort(new Error('Replay finished')); timing.close(); }
}

if (require.main === module) {
  const [flag, directory, output, elapsed = '40000'] = process.argv.slice(2);
  const elapsedMs = Number(elapsed);
  if (flag !== '--live-models' || !directory || !output || !Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= 48000) {
    console.error('Usage: node evaluate_saved_verification.js --live-models savedRunDirectory output.json [assumedProcessingMs=40000]');
    process.exitCode = 1;
  } else replay(directory, output, elapsedMs).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { replay };
