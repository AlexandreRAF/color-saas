import { createRequire } from 'node:module';
import { budgetedFetch } from './provider-budget.js';
import { updateProgress } from './research-adapter.js';

const require = createRequire(import.meta.url);
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 8192) process.exit(1);
}
const request = JSON.parse(input);
const { PRICES } = require('../agentic_researcher/ai_cost.js');
globalThis.fetch = budgetedFetch(globalThis.fetch, { capMicroUsd: request.capMicroUsd, prices: PRICES, searchMicroUsd: request.searchMicroUsd });
const { AgenticLoop } = require('../agentic_researcher/ai.js');
let snapshot = { stage: 'research', pagesFetched: 0, browserUses: 0, aiCalls: 0, aiRunning: 0 };
let lastSent = 0;
const emit = message => process.stdout.write(`${JSON.stringify(message)}\n`);
try {
  const researcher = new AgenticLoop({ debugDirectory: false, searchProvider: 'serper',
    databasePath: request.databasePath, basfDatabasePath: request.basfDatabasePath, modelDatabasePath: request.modelDatabasePath,
    targetTimeMs: Math.min(60000, request.executionSeconds * 1000), maxTimeMs: request.executionSeconds * 1000,
    targetAiCostUsd: Math.max(0.001, (request.capMicroUsd - 20 * request.searchMicroUsd) / 1e6),
    serperCostPer1000CreditsUsd: request.searchMicroUsd / 1000,
    onProgress: event => {
      snapshot = updateProgress(snapshot, event);
      snapshot.browserUses = Object.values(researcher.engineSearches).reduce((sum, n) => sum + n, 0);
      if (Date.now() - lastSent >= 500) { lastSent = Date.now(); emit({ type: 'progress', progress: snapshot }); }
    },
  });
  const result = await researcher.loop(request.input);
  emit({ type: 'result', result });
} catch (error) {
  emit({ type: 'result', result: { completion: { status: 'failed', issues: ['run_failed'] },
    error: true, errorDetails: { code: ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error.code) ? error.code : 'research_failed' } } });
}
// Release any idle provider sockets. The parent also fences the process group.
process.stdout.end(() => process.exit(0));
