'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const backend = path.resolve(__dirname, '..');
const root = path.resolve(backend, '..');
const files = fs.readdirSync(__dirname).filter(name => name.endsWith('.test.js')).sort();
const groupSize = 5;
let passed = 0;

for (let start = 0; start < files.length; start += groupSize) {
  const group = files.slice(start, start + groupSize);
  const result = spawnSync(process.execPath,
    ['--test', '--test-concurrency=1', '--test-reporter=tap',
      ...group.map(name => path.join(backend, 'tests', name))],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const count = Number(/# pass (\d+)/.exec(output)?.[1] || 0);

  if (result.status !== 0 || result.error) {
    process.stderr.write(`Test group ${Math.floor(start / groupSize) + 1} failed: ${group.join(', ')}\n`);
    process.stderr.write(output || String(result.error));
    process.exit(1);
  }

  passed += count;
  process.stdout.write(`Passed ${count} tests: ${group.join(', ')}\n`);
}

process.stdout.write(`Passed ${passed} tests across ${files.length} files.\n`);
