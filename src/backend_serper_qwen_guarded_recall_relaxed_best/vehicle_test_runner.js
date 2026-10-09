'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { cases, evaluate } = require('./evaluate_vehicles');
const { createLimiter } = require('./runtime');

const HELP = `Live vehicle tests (paid Serper/model APIs).

npm --prefix backend_serper_qwen_guarded run test:vehicles
npm --prefix backend_serper_qwen_guarded run test:vehicles -- ix35 azera
npm --prefix backend_serper_qwen_guarded run test:vehicles -- --concurrency=2

No vehicle arguments means all nine cases, run sequentially.
Options: --repeat=1..3, --concurrency=1..7, --json (JSONL stdout), --list, --help.
Concurrent cases share the same process-wide model capacity limits.
Exit status: 0 when every case passes; 1 when any case fails.
Reports: tmp/catalog-vehicle-evaluation/suite-*/summary.json
Passing checks confirm minimum reference coverage, not full palette accuracy.`;

function parseArgs(args) {
  const selected = [];
  let repeat = 1, concurrency = 1, json = false, help = false, list = false;

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--list') list = true;
    else if (arg === '--json') json = true;
    else if (/^--repeat=[1-3]$/.test(arg)) repeat = Number(arg.slice(9));
    else if (arg.startsWith('--repeat')) throw new Error('--repeat must be 1, 2 or 3');
    else if (/^--concurrency=[1-7]$/.test(arg)) concurrency = Number(arg.split('=')[1]);
    else if (arg.startsWith('--concurrency')) throw new Error('--concurrency must be between 1 and 7');
    else if (arg === 'all' || Object.hasOwn(cases, arg)) selected.push(arg);
    else throw new Error(`Unknown argument: ${arg}. Use --help or --list.`);
  }

  if (selected.includes('all') && selected.length > 1) throw new Error('Use all or individual vehicle names, not both');

  return { labels: !selected.length || selected[0] === 'all' ? Object.keys(cases) : [...new Set(selected)],
    repeat, concurrency, json, help, list };
}

function failedChecks(result) {
  return Object.entries(result.acceptance.checks).filter(([, passed]) => !passed).map(([name]) => name);
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
}

function summarize(results, expectedRuns, directory) {
  const costs = results.map(result => result.cost).filter(Number.isFinite);
  const upperBounds = results.map(result => result.costUpperBound).filter(Number.isFinite);

  return { backend: path.basename(__dirname), directory,
    completed: results.length === expectedRuns, expectedRuns, runsCompleted: results.length,
    passed: results.filter(result => result.acceptance.passed).length,
    failed: results.filter(result => !result.acceptance.passed).length,
    estimatedCostUsd: Number(costs.reduce((sum, cost) => sum + cost, 0).toFixed(6)),
    upperBoundCostUsd: upperBounds.length === results.length
      ? Number(upperBounds.reduce((sum, cost) => sum + cost, 0).toFixed(6)) : null,
    runsWithoutCost: results.length - costs.length,
    metrics: {
      totalTimeMs: { median: percentile(results.map(row => row.endToEndMs ?? row.timeMs), 0.5),
        p95: percentile(results.map(row => row.endToEndMs ?? row.timeMs), 0.95) },
      processingTimeMs: { median: percentile(results.map(row => row.timeMs), 0.5),
        p95: percentile(results.map(row => row.timeMs), 0.95) },
      queueWaitMs: { median: percentile(results.map(row => row.queueWaitMs || 0), 0.5),
        p95: percentile(results.map(row => row.queueWaitMs || 0), 0.95) },
      referencePasses: results.filter(row => row.acceptance.checks?.referenceFound
        && row.acceptance.checks?.pearl070Found !== false).length,
      completeReviews: results.filter(row => row.acceptance.checks?.everyCandidateReviewed
        && row.acceptance.checks?.everyFinalColorReviewed !== false
        && row.acceptance.checks?.omissionReviewComplete).length,
      modelCalls: results.reduce((sum, row) => sum + (row.modelCalls || 0), 0),
      inputTokens: results.reduce((sum, row) => sum + (row.byModel || []).reduce((n, model) => n + model.inputTokens, 0), 0),
      outputTokens: results.reduce((sum, row) => sum + (row.byModel || []).reduce((n, model) => n + model.outputTokens, 0), 0),
      fallbacks: results.reduce((sum, row) => sum + (row.modelFallbacks || 0), 0),
      capacityBypasses: results.reduce((sum, row) => sum + (row.capacityBypasses || 0), 0),
      searchRetries: results.reduce((sum, row) => sum + (row.searchRetries || 0), 0),
    }, results };
}

// Sequential by default; explicit concurrency measures contention through the
// shared scheduler without multiplying provider limits in separate processes.
async function runSuite(options, dependencies = {}) {
  const evaluateCase = dependencies.evaluate || evaluate;
  const log = dependencies.log || console.log;
  const directory = dependencies.directory || path.resolve(__dirname, '..', 'tmp',
    'catalog-vehicle-evaluation', `suite-${Date.now()}-${randomUUID().slice(0, 8)}`);
  const results = [];
  const expectedRuns = options.labels.length * options.repeat;
  const summaryFile = path.join(directory, 'summary.json');
  const progressFile = path.join(directory, 'summary.jsonl');

  fs.mkdirSync(directory, { recursive: true });
  const save = () => {
    const summary = { ...summarize(results, expectedRuns, directory), concurrency: options.concurrency || 1 };
    fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + '\n');
    return summary;
  };

  save();
  if (!options.json) log(`Running ${expectedRuns} live cases. Reports: ${directory}`);

  const jobs = options.labels.flatMap(label => Array.from({ length: options.repeat }, (_, index) =>
    ({ label, iteration: index + 1 })));
  const submittedAt = performance.now();
  const limit = createLimiter(options.concurrency || 1);
  await Promise.all(jobs.map(({ label, iteration }, index) => limit(async () => {
    const startedAt = performance.now();
    const queueWaitMs = Math.round(startedAt - submittedAt);
    const caseDirectory = path.join(directory, `${label}-${iteration}`);
    if (!options.json) log(`[${index + 1}/${expectedRuns}] ${label} (run ${iteration})…`);

    let result;
    try {
      result = { ...await evaluateCase(label, caseDirectory), iteration };
    } catch (error) {
      result = { label, iteration, error: error instanceof Error ? error.message : String(error),
        acceptance: { passed: false, checks: { completed: false } }, colors: [] };
      fs.mkdirSync(caseDirectory, { recursive: true });
      fs.writeFileSync(path.join(caseDirectory, 'error.json'), JSON.stringify(result, null, 2) + '\n');
    }

    result.queueWaitMs = queueWaitMs;
    result.endToEndMs = Math.round(performance.now() - submittedAt);
    results.push(result);
    fs.appendFileSync(progressFile, JSON.stringify(result) + '\n');
    save();

    if (options.json) {
      log(JSON.stringify({ ...result, report: summaryFile }));
      return;
    }

    const seconds = Number.isFinite(result.timeMs) ? `${(result.timeMs / 1000).toFixed(1)}s` : 'time unknown';
    const cost = Number.isFinite(result.cost) ? `$${result.cost.toFixed(4)}` : 'cost unknown';
    log(`  ${result.acceptance.passed ? 'PASS' : 'FAIL'} | ${seconds} | ${cost} | ${result.colors?.length || 0} colors`);
    if (!result.acceptance.passed) log(`  Failed: ${failedChecks(result).join(', ')}${result.error ? ` — ${result.error}` : ''}`);
    if (result.completion?.status === 'partial') {
      log(`  Evidence limitations: ${(result.completion.issues || []).join(', ')}`);
    }
    if (result.verification?.status === 'partial') log('  Final verification is partial; some facts remain unresolved.');
    if (result.browserUses?.failed) log(`  Failed browser uses: ${result.browserUses.failed}/${result.browserUses.total}`);
    if (result.searchCache?.HIT) log(`  Search cache hits: ${result.searchCache.HIT}; this is not an uncached benchmark.`);
  })));

  const summary = save();
  if (!options.json) {
    log(`\n${summary.passed}/${expectedRuns} passed; ${summary.failed} failed. Estimated AI + search total: $${summary.estimatedCostUsd.toFixed(4)}.`);
    if (summary.runsWithoutCost) log(`Cost unavailable for ${summary.runsWithoutCost} runs; the total is incomplete.`);
    log(`Full colors, checks and diagnostics: ${summaryFile}`);
    log('Passing checks confirm minimum reference coverage, not full palette accuracy.');
  }

  return summary;
}

async function main(args) {
  // Validate every argument before starting any paid work.
  const options = parseArgs(args);
  if (options.help) { console.log(HELP); return 0; }
  if (options.list) { console.log(Object.keys(cases).join('\n')); return 0; }

  const summary = await runSuite(options);
  return summary.failed ? 1 : 0;
}

module.exports = { percentile, parseArgs, summarize, runSuite, main };
