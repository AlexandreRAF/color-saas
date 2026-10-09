// Replay captured Brazilian source pages, keeping web-search changes out of comparisons.
require('dotenv').config({ quiet: true });

const fs = require('node:fs');
const path = require('node:path');

const { analyzePage } = require('./page_analysis');
const { candidateInventory } = require('./candidate_inventory');
const { printedNameKey } = require('./paint_evidence');
const { nameResearchVehicle } = require('./name_research');
const { AiCost } = require('./ai_cost');
const { RunTiming } = require('./run_timing');

async function evaluate(evidencePath, outputPath, options = {}) {
  const captured = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const cost = new AiCost();
  const started = performance.now();
  const timing = new RunTiming({ maxCapacityWaitMs: options.maxCapacityWaitMs, signal: options.signal });

  try {
    const signal = timing.deadline(60000);
    const providerState = {};
    const pages = captured.pages.filter((page) => page.status === 'ok' && page.text?.trim());
    const results = await Promise.all(pages.map(async (page) => {
      const rawResponses = [];
      const vehicle = nameResearchVehicle(page, captured.vehicle);
      const result = await analyzePage(page, vehicle, { ...options, providerState,
        signal, timing, onUsage: (details) => cost.record('pageAnalysis', details),
        onDebug: (entry) => rawResponses.push(entry) });

      const before = candidateInventory([page]);
      const after = candidateInventory([{ ...page, candidates: result.candidates }]);
      const keys = new Set(after.map((candidate) => printedNameKey(candidate.name)));

      return { ...page, ...result, rawResponses, baselineNames: before.map((candidate) => candidate.name),
        missingBaselineNames: before.filter((candidate) => !keys.has(printedNameKey(candidate.name)))
          .map((candidate) => candidate.name) };
    }));

    timing.signal.throwIfAborted();

    const after = candidateInventory(results);
    const keys = new Set(after.map((candidate) => printedNameKey(candidate.name)));
    const before = candidateInventory(pages);
    const baselinePath = path.join(path.dirname(evidencePath), 'result.json');
    const approved = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')).colors || [] : [];
    const result = { vehicle: captured.vehicle, elapsedMs: performance.now() - started, timing: timing.summary(),
      cost: cost.summary(), pages: results, candidates: after,
      comparison: { baselineCandidates: before.length, candidates: after.length,
        approvedBaselineNames: approved.length,
        missingApprovedNames: approved.filter((color) => !keys.has(printedNameKey(color.name))).map((color) => color.name),
        missingBaselineNames: before.filter((candidate) => !keys.has(printedNameKey(candidate.name)))
          .map((candidate) => candidate.name) } };

    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ outputPath, elapsedMs: result.elapsedMs, timing: result.timing, cost: result.cost,
      comparison: result.comparison, failedPasses: results.reduce((sum, page) => sum + page.failures.length, 0) }, null, 2));

    return result;
  } finally { timing.close(); }
}

if (require.main === module) {
  const [evidencePath, outputPath] = process.argv.slice(2);
  if (!evidencePath || !outputPath) throw new Error('Usage: node evaluate_page_analysis.js evidence.json output.json');
  evaluate(evidencePath, outputPath).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { evaluate };
