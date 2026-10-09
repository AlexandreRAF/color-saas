'use strict';

// Explicit paid benchmark. Never imported by tests/run_suite.js.
const fs = require('node:fs');
const path = require('node:path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const { AgenticLoop } = require('../ai');
const { cases } = require('./non_car_live_cases');

const HELP = `Live non-car benchmark (paid Serper and model APIs).

  npm --prefix backend_serper_qwen_guarded run test:non-cars -- --list
  npm --prefix backend_serper_qwen_guarded run test:non-cars -- --run marcopolo-paradiso
  npm --prefix backend_serper_qwen_guarded run test:non-cars -- --run all

Runs are sequential. --run is required to start paid work.
Reports go to tmp/non-car-live/<UTC timestamp>/ inside this backend.`;

function summary(label, result) {
  const checks = {
    returnedColor: (result.colors || []).length > 0,
    fetchedResearchPage: (result.pagesFetched || 0) > 0,
    didNotFail: result.completion?.status !== 'failed' && !result.error,
  };

  return {
    label,
    vehicle: cases[label],
    runId: result.runId,
    timeMs: result.timeMs,
    costUpperBoundUsd: result.totalUpperBoundUsd ?? null,
    browserUses: result.browserUses,
    pagesFetched: result.pagesFetched,
    fetchErrors: result.fetchErrors,
    completion: result.completion,
    error: result.error,
    checks,
    passed: Object.values(checks).every(Boolean),
    colors: (result.colors || []).map(color => ({ name: color.name, codes: color.codes,
      paintFinish: color.paintFinish, applicabilityScope: color.applicabilityScope })),
  };
}

async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--list') {
    console.log(Object.keys(cases).join('\n'));
    return 0;
  }
  if (!args.length || args.includes('--help')) {
    console.log(HELP);
    return 0;
  }
  if (args[0] !== '--run' || args.length < 2 || args.slice(1).some(label => label !== 'all' && !cases[label])) {
    throw new Error(`Choose --run all or one or more labels from --list.\n${HELP}`);
  }

  const labels = args[1] === 'all' ? Object.keys(cases) : [...new Set(args.slice(1))];
  if (args.includes('all') && args.length !== 2) throw new Error('Use all alone.');

  const directory = path.resolve(__dirname, '..', 'tmp', 'non-car-live',
    new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(directory, { recursive: true });
  const results = [];

  for (const label of labels) {
    const events = [];
    const loop = new AgenticLoop({ onProgress: event => events.push(event) });
    let result;

    try {
      result = await loop.loop(cases[label]);
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error),
        completion: { status: 'failed', issues: ['unexpected_exception'] } };
    }

    fs.writeFileSync(path.join(directory, `${label}.json`), JSON.stringify(result, null, 2) + '\n');
    fs.writeFileSync(path.join(directory, `${label}-events.json`), JSON.stringify(events, null, 2) + '\n');
    results.push(summary(label, result));
    fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(results, null, 2) + '\n');
    console.log(`${label}: ${results.at(-1).passed ? 'PASS' : 'FAIL'}, ${result.completion?.status || 'failed'}, ${(result.colors || []).length} colors, ${result.timeMs ?? '?'} ms`);
  }

  console.log(`Saved ${results.length} runs to ${directory}`);
  return results.some(result => !result.passed) ? 1 : 0;
}

module.exports = { summary, main };

if (require.main === module) main().then(code => { process.exitCode = code; })
  .catch(error => { console.error(error.message); process.exitCode = 1; });
