import { randomUUID, createHash } from 'node:crypto';
import { rows, transaction, lockControl, json } from './db.js';
import { demand } from './errors.js';
import { parse, vehicle, keySchema, idSchema } from './validation.js';
import { getSession } from './auth.js';

export const ACTIVE = ['queued', 'running', 'retry_wait'];
export const TERMINAL = ['completed', 'no_colors_found', 'partial', 'failed', 'cancelled', 'expired'];
export const billable = state => ['completed', 'no_colors_found'].includes(state);
export const availableCredits = user => Math.max(0, user.balance - user.reserved);
export const waitingMs = (job, now = Date.now()) => Number(job.waited_ms) + Math.max(0, now - new Date(job.waiting_since).getTime());
export const initialProgress = () => ({ stage: 'queued', pagesFetched: 0, browserUses: 0, aiCalls: 0, aiRunning: 0 });

export async function submitJob(pool, config, userId, input, key) {
  const payload = parse(vehicle, input);
  parse(keySchema, key);
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return transaction(pool, async db => {
    const control = await lockControl(db);
    const user = (await rows(db, 'SELECT * FROM users WHERE id=? FOR UPDATE', [userId]))[0];
    demand(user && !user.deleted_at && user.verified_at && !user.deletion_requested_at, 403, 'verification_required', 'Confirme seu e-mail antes de pesquisar.');
    const existing = (await rows(db, 'SELECT * FROM jobs WHERE user_id=? AND idempotency_key=?', [userId, key]))[0];
    if (existing) {
      demand(existing.payload_hash === hash, 409, 'idempotency_conflict', 'Esta chave já foi usada para outra pesquisa.');
      demand(!existing.history_expires_at || existing.history_expires_at > new Date(), 410, 'history_expired', 'O prazo de acesso a esta pesquisa terminou.');
      return existing.id;
    }
    const tombstone = await rows(db, 'SELECT user_id FROM job_keys WHERE user_id=? AND idempotency_key=?', [userId, key]);
    demand(!tombstone.length, 410, 'history_expired', 'Esta chave pertence a uma pesquisa cujo prazo de acesso terminou.');
    demand(!control.paused && (!control.pause_until || control.pause_until <= new Date()), 503, 'admission_paused', 'Novas pesquisas estão temporariamente pausadas.');
    const [budget] = await rows(db, 'SELECT allocated_micro_usd FROM spending_periods WHERE period=UTC_DATE()');
    demand(Number(budget?.allocated_micro_usd || 0) + config.RESEARCH_RUN_CAP_MICRO_USD <= config.DEPLOYMENT_DAILY_CAP_MICRO_USD,
      503, 'budget_exhausted', 'O limite de pesquisas deste período foi atingido.');
    const [count] = await rows(db, `SELECT COUNT(*) AS total, COALESCE(SUM(user_id=?),0) AS own
      FROM jobs WHERE state IN ('queued','running','retry_wait')`, [userId]);
    demand(count.total < config.RESEARCH_QUEUE_MAX_OUTSTANDING && count.own < config.MAX_OUTSTANDING_JOBS_PER_USER,
      429, 'queue_full', 'Há pesquisas demais em andamento. Aguarde uma conclusão.');
    demand(availableCredits(user) > 0 && user.balance >= 0, 402, 'insufficient_credits', 'Você precisa de um crédito disponível.');
    const id = randomUUID(), ref = randomUUID();
    await rows(db, 'UPDATE users SET reserved=reserved+1 WHERE id=?', [userId]);
    await rows(db, `INSERT INTO ledger(user_id,kind,balance_delta,reserved_delta,reference)
      VALUES(?,'reservation',0,1,?)`, [userId, `reserve:${ref}`]);
    await rows(db, `INSERT INTO jobs(id,user_id,idempotency_key,payload_hash,input,credit_ref,state,progress,
      created_at,waiting_since,next_attempt_at,researcher_version,run_config)
      VALUES(?,?,?,?,?,?,'queued',?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),?,?)`,
    [id, userId, key, hash, JSON.stringify(payload), ref, JSON.stringify(initialProgress()), config.RESEARCHER_VERSION,
      JSON.stringify({ executionSeconds: config.RESEARCH_JOB_TIMEOUT_SECONDS, maxAttempts: config.RESEARCH_MAX_ATTEMPTS,
        runCapMicroUsd: config.RESEARCH_RUN_CAP_MICRO_USD, searchMicroUsd: config.SEARCH_REQUEST_MICRO_USD,
        waitSeconds: config.RESEARCH_QUEUE_WAIT_TIMEOUT_SECONDS })]);
    await rows(db, 'INSERT INTO research_outbox(job_id,created_at) VALUES(?,UTC_TIMESTAMP(3))', [id]);
    await rows(db, 'INSERT INTO job_keys(user_id,idempotency_key,job_id) VALUES(?,?,?)', [userId, key, id]);
    return id;
  });
}

// Caller owns control and job locks. The UNIQUE settlement row is the repeat-safety boundary.
export async function settleLocked(db, config, job, state, result = null, failureCode = null) {
  demand(TERMINAL.includes(state), 500, 'invalid_terminal_state', 'Estado inválido.');
  if (!ACTIVE.includes(job.state)) return false;
  const consume = billable(state);
  await rows(db, 'SELECT id FROM users WHERE id=? FOR UPDATE', [job.user_id]);
  await rows(db, 'INSERT INTO settlements(job_id,treatment,created_at) VALUES(?,?,UTC_TIMESTAMP(3))', [job.id, consume ? 'consumed' : 'released']);
  await rows(db, `INSERT INTO ledger(user_id,kind,balance_delta,reserved_delta,reference) VALUES(?,?,?,-1,?)`,
    [job.user_id, consume ? 'consumption' : 'release', consume ? -1 : 0, `settle:${job.credit_ref}`]);
  await rows(db, 'UPDATE users SET reserved=reserved-1,balance=balance-? WHERE id=?', [consume ? 1 : 0, job.user_id]);
  const progress = { ...json(job.progress), stage: state, aiRunning: 0 };
  await rows(db, `UPDATE jobs SET state=?,result=?,failure_code=?,progress=?,ended_at=UTC_TIMESTAMP(3),
    history_expires_at=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? DAY) WHERE id=?`,
  [state, result ? JSON.stringify(result) : null, failureCode, JSON.stringify(progress), config.HISTORY_RETENTION_DAYS, job.id]);
  return true;
}

export async function cancelJob(pool, config, userId, id) {
  return transaction(pool, async db => {
    await lockControl(db);
    const job = (await rows(db, 'SELECT * FROM jobs WHERE id=? AND user_id=? FOR UPDATE', [id, userId]))[0];
    demand(job, 404, 'not_found', 'Pesquisa não encontrada.');
    demand(!job.history_expires_at || job.history_expires_at > new Date(), 410, 'history_expired', 'O prazo de acesso terminou.');
    if (job.state === 'cancelled') return;
    demand(job.state === 'queued', 409, 'already_started', 'Só é possível cancelar antes da execução.');
    await settleLocked(db, config, job, 'cancelled');
  });
}

export async function acquireJob(pool, config, id) {
  return transaction(pool, async db => {
    const control = await lockControl(db);
    const job = (await rows(db, 'SELECT * FROM jobs WHERE id=? FOR UPDATE', [id]))[0];
    if (!job || !['queued', 'retry_wait'].includes(job.state)) return null;
    const runConfig = json(job.run_config);
    if (waitingMs(job) >= runConfig.waitSeconds * 1000) {
      await settleLocked(db, config, job, 'expired', null, 'queue_timeout');
      return null;
    }
    if (control.paused || control.pause_until > new Date() || job.next_attempt_at > new Date()) return null;
    const [running] = await rows(db, "SELECT COUNT(*) AS total FROM jobs WHERE state='running'");
    // This extra gate protects the cap while Redis is being restored. Old executions
    // retain their slot until their external kill deadline and fencing margin pass.
    if (running.total >= config.AGENT_CONCURRENCY) return null;
    const cap = Math.floor(runConfig.runCapMicroUsd / runConfig.maxAttempts);
    await rows(db, 'INSERT IGNORE INTO spending_periods(period) VALUES(UTC_DATE())');
    const budget = await rows(db, `UPDATE spending_periods SET allocated_micro_usd=allocated_micro_usd+?
      WHERE period=UTC_DATE() AND allocated_micro_usd+?<=?`, [cap, cap, config.DEPLOYMENT_DAILY_CAP_MICRO_USD]);
    if (!budget.affectedRows) return null;
    const attempt = randomUUID();
    const deadline = new Date(Date.now() + runConfig.executionSeconds * 1000);
    await rows(db, `UPDATE jobs SET state='running',attempt_id=?,attempts=attempts+1,heartbeat_at=UTC_TIMESTAMP(3),
      execution_deadline=?,waited_ms=?,progress=JSON_SET(progress,'$.stage','running') WHERE id=?`,
    [attempt, deadline, waitingMs(job), id]);
    await rows(db, `INSERT INTO attempts(id,job_id,number,started_at,deadline,reserved_cost_micro_usd)
      VALUES(?,?,?,UTC_TIMESTAMP(3),?,?)`, [attempt, id, job.attempts + 1, deadline, cap]);
    return { ...job, input: json(job.input), run_config: runConfig, attempt_id: attempt, execution_deadline: deadline, attempts: job.attempts + 1 };
  });
}

export async function finishAttempt(pool, config, id, attemptId, outcome) {
  return transaction(pool, async db => {
    await lockControl(db);
    const job = (await rows(db, 'SELECT * FROM jobs WHERE id=? FOR UPDATE', [id]))[0];
    if (!job || job.state !== 'running' || job.attempt_id !== attemptId) return false;
    const late = job.execution_deadline <= new Date();
    const result = late ? { state: 'failed', code: 'execution_timeout', retryable: false } : outcome;
    const runConfig = json(job.run_config);
    await rows(db, `UPDATE attempts SET ended_at=UTC_TIMESTAMP(3),known_cost_micro_usd=?,cost_complete=?,failure_code=? WHERE id=?`,
      [outcome.knownCostMicroUsd ?? null, Boolean(outcome.costComplete), result.code || null, attemptId]);
    if (result.state === 'failed') {
      await rows(db, `UPDATE app_control SET provider_failures=provider_failures+1,
        pause_until=IF(provider_failures>=?,DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND),pause_until) WHERE id=1`,
      [config.PROVIDER_FAILURE_THRESHOLD, config.PROVIDER_PAUSE_SECONDS]);
    } else if (billable(result.state)) await rows(db, 'UPDATE app_control SET provider_failures=0 WHERE id=1');
    if (result.retryable && job.attempts < runConfig.maxAttempts) {
      const delay = Math.min(60000, 1000 * 2 ** job.attempts) + Math.floor(Math.random() * 1000);
      await rows(db, `UPDATE jobs SET state='retry_wait',waiting_since=UTC_TIMESTAMP(3),next_attempt_at=?,
        failure_code=?,progress=JSON_SET(progress,'$.stage','retry_wait','$.aiRunning',0) WHERE id=?`,
      [new Date(Date.now() + delay), result.code || 'transient_failure', id]);
      await rows(db, 'UPDATE research_outbox SET dispatched_at=NULL WHERE job_id=?', [id]);
    } else await settleLocked(db, config, job, result.state, result.result, result.code);
    return true;
  });
}

export async function recoverJobs(pool, config) {
  const candidates = await rows(pool, `SELECT id FROM jobs WHERE state IN ('queued','retry_wait')
    OR (state='running' AND execution_deadline<DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 10 SECOND)) LIMIT 500`);
  for (const { id } of candidates) {
    await transaction(pool, async db => {
      await lockControl(db);
      const job = (await rows(db, 'SELECT * FROM jobs WHERE id=? FOR UPDATE', [id]))[0];
      if (!job || !ACTIVE.includes(job.state)) return;
      if (job.state === 'running') {
        if (job.execution_deadline.getTime() + 10000 > Date.now()) return;
        await rows(db, "UPDATE attempts SET ended_at=UTC_TIMESTAMP(3),failure_code='worker_interrupted' WHERE id=? AND ended_at IS NULL", [job.attempt_id]);
        if (job.attempts < json(job.run_config).maxAttempts) {
          await rows(db, `UPDATE jobs SET state='retry_wait',waiting_since=UTC_TIMESTAMP(3),next_attempt_at=UTC_TIMESTAMP(3),
            progress=JSON_SET(progress,'$.stage','retry_wait','$.aiRunning',0) WHERE id=?`, [id]);
          await rows(db, 'UPDATE research_outbox SET dispatched_at=NULL WHERE job_id=?', [id]);
        } else await settleLocked(db, config, job, 'failed', null, 'worker_interrupted');
      } else if (waitingMs(job) >= json(job.run_config).waitSeconds * 1000) {
        await settleLocked(db, config, job, 'expired', null, 'queue_timeout');
      }
    });
  }
}

export function publicJob(job) {
  return { id: job.id, state: job.state, input: json(job.input), progress: json(job.progress),
    result: json(job.result), failureCode: job.failure_code, createdAt: job.created_at,
    endedAt: job.ended_at, historyExpiresAt: job.history_expires_at,
    credit: ACTIVE.includes(job.state) ? 'reserved' : billable(job.state) ? 'consumed' : 'released' };
}

export async function ownedJob(pool, userId, id) {
  const job = (await rows(pool, 'SELECT * FROM jobs WHERE id=? AND user_id=?', [id, userId]))[0];
  demand(job, 404, 'not_found', 'Pesquisa não encontrada.');
  demand(!job.history_expires_at || job.history_expires_at > new Date(), 410, 'history_expired', 'O prazo de acesso a esta pesquisa terminou.');
  return publicJob(job);
}

export function installJobs(app, { pool, config, auth, rate }) {
  app.post('/api/jobs', auth, rate('research', 30, 60), async (req, res) => {
    const id = await submitJob(pool, config, req.user.id, req.body, req.get('Idempotency-Key'));
    res.status(202).location(`/api/jobs/${id}`).json({ id, statusUrl: `/api/jobs/${id}` });
  });
  app.get('/api/jobs', auth, async (req, res) => {
    const page = /^\d{1,6}$/.test(req.query.page || '1') ? Number(req.query.page || 1) : 0;
    demand(page >= 1 && page <= 10000, 400, 'invalid_page', 'Página inválida.');
    const found = await rows(pool, `SELECT * FROM jobs WHERE user_id=? AND (history_expires_at IS NULL
      OR history_expires_at>UTC_TIMESTAMP(3)) ORDER BY created_at DESC,id DESC LIMIT 21 OFFSET ${(page - 1) * 20}`, [req.user.id]);
    res.json({ jobs: found.slice(0, 20).map(publicJob), page, hasMore: found.length > 20 });
  });
  app.get('/api/jobs/:id', auth, async (req, res) => res.json(await ownedJob(pool, req.user.id, parse(idSchema, req.params.id))));
  app.get('/api/jobs/:id/download', auth, async (req, res) => {
    const job = await ownedJob(pool, req.user.id, parse(idSchema, req.params.id));
    res.attachment(`pesquisa-${job.id}.json`).json(job);
  });
  app.post('/api/jobs/:id/cancel', auth, async (req, res) => {
    await cancelJob(pool, config, req.user.id, parse(idSchema, req.params.id));
    res.sendStatus(204);
  });
  app.get('/api/jobs/:id/events', auth, rate('events', 60, 60), async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const first = await ownedJob(pool, req.user.id, id);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'private, no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write(`retry: 5000\nevent: snapshot\ndata: ${JSON.stringify(first)}\n\n`);
    let timer, lifetime, closed = false;
    const close = () => { closed = true; clearTimeout(timer); clearTimeout(lifetime); res.end(); };
    req.on('close', close);
    const poll = async () => {
      if (closed) return;
      try {
        if (!await getSession(pool, config, req.rawSession)) return close();
        const current = await ownedJob(pool, req.user.id, id);
        if (!res.write(`event: snapshot\ndata: ${JSON.stringify(current)}\n\n: heartbeat\n\n`)) return close();
      } catch { return close(); }
      timer = setTimeout(poll, 3000);
    };
    timer = setTimeout(poll, 3000);
    lifetime = setTimeout(close, 5 * 60000);
    lifetime.unref();
  });
}
