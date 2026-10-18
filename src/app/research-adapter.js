import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { safeUrl } from './validation.js';

const text = (value, max = 300) => typeof value === 'string' ? value.slice(0, max) : '';
const list = value => Array.isArray(value) ? value : [];
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const confidences = { high: 3, medium: 2, low: 1, unknown: 0 };

export function classifyResult(raw) {
  if (!raw || typeof raw !== 'object') return { state: 'failed', code: 'invalid_research_output', retryable: false };
  const colors = list(raw.colors).slice(0, 500).filter(c => c && text(c.name)).map(c => ({
    name: text(c.name), codes: list(c.codes).filter(v => typeof v === 'string').map(v => text(v, 80)).slice(0, 30),
    paintFinish: (Array.isArray(c.paintFinish) ? c.paintFinish : [c.paintFinish]).filter(v => typeof v === 'string').map(v => text(v, 60)),
    confidence: Object.hasOwn(confidences, c.confidence) ? c.confidence : 'unknown',
    sources: list(c.sources).filter(v => typeof v === 'string').map(safeUrl).filter(Boolean).slice(0, 40),
    applicabilityScope: text(c.applicabilityScope, 80) || 'unknown',
    uncertainty: { unknown: list(c.verification?.unknown).map(v => text(v, 80)).slice(0, 20),
      conflicting: list(c.verification?.conflicting).map(v => text(v, 80)).slice(0, 20),
      status: text(c.verification?.status, 60) || 'unverified' },
  }));
  colors.sort((a, b) => confidences[b.confidence] - confidences[a.confidence]);
  const complete = raw.completion?.status === 'complete' && Array.isArray(raw.completion?.issues)
    && raw.completion.issues.length === 0;
  const usable = colors.length > 0 && colors.every(c => c.sources.length > 0)
    && colors.length === list(raw.colors).length;
  // The current engine reports empty palettes as partial. A future explicit
  // successful-empty contract can be consumed without guessing from an array.
  const genuineEmpty = raw.completion?.status === 'no_colors_found'
    && raw.research?.status === 'complete' && raw.research?.discoveryCoverage?.needsExpansion === false
    && list(raw.colors).length === 0 && !raw.error;
  const state = raw.error ? (colors.length ? 'partial' : 'failed')
    : complete && usable ? 'completed' : genuineEmpty ? 'no_colors_found'
      : raw.completion?.status === 'partial' || colors.length ? 'partial' : 'failed';
  const known = raw.billing?.knownCostUsd;
  const retryable = state === 'failed' && ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'CAPACITY_DISCONNECTED', 'MODEL_ROUTE_TIMEOUT']
    .includes(raw.errorDetails?.code);
  return { state, retryable, code: state === 'failed' ? 'research_failed' : null,
    knownCostMicroUsd: Number.isFinite(known) && known >= 0 ? Math.ceil(known * 1e6) : null,
    costComplete: raw.billing?.status === 'complete',
    result: { colors, issues: list(raw.completion?.issues).map(v => text(v, 80)).slice(0, 50),
      progress: { pagesFetched: count(raw.pagesFetched), browserUses: count(raw.browserUses?.total),
        aiCalls: count(raw.modelRequests?.total), aiRunning: 0 } } };
}

export function updateProgress(snapshot, event) {
  const next = { ...snapshot };
  if (event.event === 'page_fetch_complete' && event.status === 'ok') next.pagesFetched++;
  if (event.event === 'model_route_start') { next.aiCalls++; next.aiRunning++; }
  if (['model_route_complete', 'model_route_fallback'].includes(event.event)) next.aiRunning = Math.max(0, next.aiRunning - 1);
  if (event.event === 'search_start') next.browserUses += Array.isArray(event.queries) ? event.queries.length : 1;
  if (event.event === 'model_route_start') next.stage = ['candidateReview', 'verification', 'databaseMatcher'].includes(event.kind) ? event.kind : 'research';
  return next;
}

const childPath = fileURLToPath(new URL('./research-child.js', import.meta.url));
const providerKeys = ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'SERPER_API_KEY', 'CAPACITY_SOCKET',
  'OPENAI_MODEL', 'OPENAI_SERVICE_TIER', 'OPENROUTER_MODEL', 'QWEN_MODEL'];

export async function runResearch(job, { signal, onProgress, env = process.env, catalogs = {}, childScript = childPath } = {}) {
  const seconds = Math.max(1, Math.ceil((new Date(job.execution_deadline).getTime() - Date.now()) / 1000));
  const childEnv = { PATH: env.PATH, PYTHONDONTWRITEBYTECODE: '1', NODE_ENV: 'production',
    ...Object.fromEntries(providerKeys.filter(k => env[k]).map(k => [k, env[k]])) };
  return new Promise((resolve, reject) => {
    // GNU timeout survives a killed worker and kills the entire process group,
    // including catalog subprocesses. Recovery waits beyond this absolute bound.
    const child = spawn('timeout', ['--signal=KILL', `${seconds}s`, process.execPath, childScript],
      { detached: true, env: childEnv, stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '', output, bytes = 0, failed = false;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') failed = true; } };
    const abort = () => { failed = true; kill(); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('error', reject);
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) { failed = true; kill(); return; }
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          const message = JSON.parse(line);
          if (message.type === 'progress') onProgress?.(message.progress);
          if (message.type === 'result') output = message.result;
        } catch { failed = true; kill(); }
      }
    });
    child.on('close', code => {
      signal?.removeEventListener('abort', abort);
      kill();
      if (failed || code !== 0 || !output) resolve({ state: 'failed', retryable: false,
        code: signal?.aborted ? 'worker_interrupted' : 'execution_timeout' });
      else resolve(classifyResult(output));
    });
    child.stdin.end(JSON.stringify({ input: job.input, executionSeconds: Math.min(seconds, 100),
      capMicroUsd: Math.floor(job.run_config.runCapMicroUsd / job.run_config.maxAttempts),
      searchMicroUsd: job.run_config.searchMicroUsd,
      databasePath: catalogs.LAZZUMIX_DATABASE_PATH, basfDatabasePath: catalogs.BASF_DATABASE_PATH,
      modelDatabasePath: catalogs.BASF_MODELS_DATABASE_PATH }));
  });
}
