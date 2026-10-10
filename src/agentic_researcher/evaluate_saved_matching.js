'use strict';

// Paid model-only diagnostic. No browser or fetch dependency is imported.
const fs = require('node:fs');
const path = require('node:path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });
const { runMatcherAgent } = require('./database_code_agent');
const { RunTiming } = require('./run_timing');
const { AiCost } = require('./ai_cost');

async function replay(filename, output, qwen = false) {
  const payload = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!payload.colors?.length || payload.colors.some(color => !Array.isArray(color.db_candidates))) {
    throw new Error('Expected a saved matcher input with catalog candidates');
  }
  const timing = new RunTiming({ pauseForCapacity: false, targetTimeMs: 12000 });
  const cost = new AiCost(), events = [];
  try {
    const result = await runMatcherAgent(payload, {
      timing, signal: timing.deadlineAt(12000), modelRouting: { matcherQwen: qwen },
      onWait: event => events.push(event),
      onProgress: (event, details) => {
        if (event === 'database_matcher_usage') cost.record('databaseMatcher', details);
      },
    });
    const report = { kind: 'saved_matching_live_model_replay', source: path.resolve(filename),
      qwenFirst: qwen, browserUses: 0, timeMs: timing.summary().totalMs, cost: cost.summary(0.06),
      incompleteIndices: result.incompleteIndices,
      decisions: payload.colors.map(color => ({ name: color.color,
        rows: color.db_candidates.filter(row => result.result.matches.find(match => match.index === color.index)
          ?.candidate_ids.includes(row.candidate_id)) })), events };
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, decisions: report.decisions.map(row => ({ name: row.name,
      codes: [...new Set(row.rows.map(record => record.universal_code))] })), events: undefined }, null, 2));
    return report;
  } catch (error) {
    const report = { kind: 'saved_matching_live_model_replay', source: path.resolve(filename),
      qwenFirst: qwen, browserUses: 0, timeMs: timing.summary().totalMs, cost: cost.summary(0.06),
      error: error.message, events };
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, events: undefined }, null, 2));
    return report;
  } finally { timing.abort(new Error('Replay finished')); timing.close(); }
}

if (require.main === module) {
  const [flag, filename, output, mode = '--gpt'] = process.argv.slice(2);
  if (flag !== '--live-models' || !filename || !output || !['--gpt', '--qwen'].includes(mode)) {
    console.error('Usage: node evaluate_saved_matching.js --live-models input.json output.json [--gpt|--qwen]');
    process.exitCode = 1;
  } else replay(filename, output, mode === '--qwen')
    .then(result => { if (result.error || result.incompleteIndices?.length) process.exitCode = 1; })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { replay };
