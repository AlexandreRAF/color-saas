import { rows } from './db.js';
import { equal } from './crypto.js';

export function installMetrics(app, { pool, config, counters }) {
  app.get('/internal/metrics', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!config.METRICS_TOKEN || !equal(req.get('Authorization'), `Bearer ${config.METRICS_TOKEN}`)) return res.sendStatus(404);
    const jobs = await rows(pool, `SELECT state,COUNT(*) AS count,
      COALESCE(MAX(IF(state IN ('queued','retry_wait'),waited_ms/1000+TIMESTAMPDIFF(SECOND,waiting_since,UTC_TIMESTAMP(3)),0)),0) AS age
      FROM jobs GROUP BY state`);
    const [webhooks] = await rows(pool, `SELECT COUNT(*) AS count,COALESCE(MAX(TIMESTAMPDIFF(SECOND,created_at,UTC_TIMESTAMP(3))),0) AS age
      FROM stripe_events WHERE processed_at IS NULL`);
    const [spend] = await rows(pool, 'SELECT COALESCE(SUM(allocated_micro_usd),0) AS total FROM spending_periods WHERE period=UTC_DATE()');
    const [stale] = await rows(pool, "SELECT COUNT(*) AS count FROM jobs WHERE state='running' AND heartbeat_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 10 SECOND)");
    const [mail] = await rows(pool, 'SELECT COUNT(*) AS count FROM email_outbox WHERE failed_at IS NOT NULL');
    const [reserved] = await rows(pool, 'SELECT COALESCE(SUM(reserved),0) AS count FROM users');
    const [attempts] = await rows(pool, `SELECT COUNT(*) AS total,
      COALESCE(SUM(TIMESTAMPDIFF(MICROSECOND,started_at,ended_at))/1000000,0) AS seconds,
      COALESCE(SUM(failure_code='execution_timeout'),0) AS timeouts FROM attempts`);
    const [control] = await rows(pool, 'SELECT paused,provider_failures FROM app_control WHERE id=1');
    const output = [
      `color_http_requests_total ${counters.requests}`, `color_http_errors_total ${counters.errors}`,
      `color_http_duration_seconds_total ${counters.durationMs / 1000}`,
      `color_webhook_pending ${webhooks.count}`, `color_webhook_oldest_seconds ${webhooks.age}`,
      `color_spending_allocated_micro_usd ${spend.total}`, `color_spending_daily_cap_micro_usd ${config.DEPLOYMENT_DAILY_CAP_MICRO_USD}`,
      `color_stale_heartbeats ${stale.count}`, `color_email_failed ${mail.count}`, `color_credit_reservations ${reserved.count}`,
      `color_retained_attempts ${attempts.total}`, `color_retained_execution_seconds ${attempts.seconds}`,
      `color_retained_timeouts ${attempts.timeouts}`, `color_admission_paused ${Number(control.paused)}`,
      `color_provider_failures ${control.provider_failures}`,
      ...jobs.flatMap(j => [`color_jobs{state="${j.state}"} ${j.count}`, `color_oldest_wait_seconds{state="${j.state}"} ${j.age}`]),
    ];
    res.type('text/plain').send(`${output.join('\n')}\n`);
  });
}
