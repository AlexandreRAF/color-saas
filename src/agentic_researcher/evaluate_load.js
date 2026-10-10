'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });
const { startCapacityServer } = require('./capacity_server');
const { runSuite } = require('./vehicle_test_runner');
const { cases } = require('./evaluate_vehicles');

function parseLoadArgs(args) {
  const options = { levels: [1, 2, 4, 7], repeat: 2 };
  for (const arg of args) {
    if (arg === '--help') return { help: true };
    if (/^--levels=[1247](?:,[1247])*$/.test(arg)) options.levels = [...new Set(arg.slice(9).split(',').map(Number))];
    else if (/^--repeat=[1-3]$/.test(arg)) options.repeat = Number(arg.slice(9));
    else throw new Error('Use --levels=1,2,4,7 and --repeat=1..3');
  }
  return options;
}

function evaluateWorker(label, directory, socketPath) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'vehicle_worker.js'), [label, directory], {
      env: { ...process.env, CAPACITY_SOCKET: socketPath }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    let result;
    const timeout = setTimeout(() => child.kill('SIGTERM'), 300000);
    child.on('message', message => { result = message; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (result?.result) resolve(result.result);
      else reject(new Error(result?.error || `Vehicle worker exited: ${signal || code}`));
    });
  });
}

async function runLoad(options) {
  const directory = path.resolve(__dirname, '..', 'tmp', 'catalog-load-evaluation', `load-${Date.now()}`);
  fs.mkdirSync(directory, { recursive: true });
  const socketDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-capacity-'));
  const socketPath = process.env.CAPACITY_SOCKET || path.join(socketDirectory, 'broker.sock');
  const server = process.env.CAPACITY_SOCKET ? null : await startCapacityServer(socketPath);
  const results = [];
  try {
    for (const concurrency of options.levels) {
      console.log(`\nLoad level ${concurrency}; ${options.repeat} rounds of all ${Object.keys(cases).length} vehicles.`);
      const result = await runSuite({ labels: Object.keys(cases), repeat: options.repeat, concurrency }, {
        directory: path.join(directory, `concurrency-${concurrency}`),
        evaluate: (label, caseDirectory) => evaluateWorker(label, caseDirectory, socketPath),
      });
      results.push(result);
      fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({ options, results }, null, 2));
      console.log(JSON.stringify({ concurrency, metrics: result.metrics, cost: result.estimatedCostUsd }));
    }
  } finally {
    await server?.close();
    fs.rmSync(socketDirectory, { recursive: true, force: true });
  }
  return { directory, results };
}

module.exports = { parseLoadArgs, evaluateWorker, runLoad };
if (require.main === module) {
  Promise.resolve().then(() => parseLoadArgs(process.argv.slice(2))).then(options => {
    if (options.help) {
      console.log('Paid load test: node backend_serper_qwen_guarded/evaluate_load.js --levels=1,2,4,7 --repeat=2');
      return;
    }
    return runLoad(options).then(result => {
      console.log(`Load reports: ${result.directory}`);
      if (result.results.some(suite => suite.failed)) process.exitCode = 1;
    });
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
