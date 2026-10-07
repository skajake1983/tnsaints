/**
 * The scheduled job runner.
 *
 * WHY. A free-plan Worker invocation may make 50 D1 queries (each statement in
 * a batch counts). The cron used to start every job at once, sharing that
 * allowance with no one counting: the PayPal sweep alone can use it all once
 * there are a few dozen subscriptions, and whatever ran out first failed
 * half-way with nothing recorded.
 *
 * HOW.
 *   - The cron fires every hour. Each job says how often it is due (hourly or
 *     daily, by the Central-time clock) and, optionally, not before which hour.
 *   - Jobs run one at a time, in the order below: cheap and family-facing
 *     first, the reconciliation sweep last.
 *   - Every D1 call a job makes is counted against one budget (45, leaving
 *     headroom under 50). A job that would exceed it is stopped there and
 *     recorded as 'partial'; the next run picks it up. Jobs are written to
 *     resume by doing the next bounded slice of work, never by remembering
 *     where they were.
 *   - A job is CLAIMED by writing its (job, run_key) row first, so an
 *     overlapping or retried trigger can never run it twice. A 'partial' or
 *     'failed' run, or one stuck 'running' for half an hour, is taken again.
 *   - job_runs.detail holds counts only — never names, emails or message text.
 *
 * Email and PayPal calls are subrequests, not D1 queries; each job bounds its
 * own (the sweep re-reads at most SWEEP_PER_RUN subscriptions).
 */

import { cleanupExpiredAuth } from '../auth/cleanup.js';
import { expireOffers } from '../programs/enrollment.js';
import { sweepSubscriptions } from '../payments/billing.js';
import { sweepOrders } from '../payments/orders.js';
import { expireInquiryIpHashes } from '../crm/intake.js';
import { runStaffBrief } from './brief.js';
import { sendRosterDigest, sendStaffBriefEmail } from '../email.js';
import { reconcileCrm, RECONCILE_STEPS } from '../crm/reconcile.js';
import { runRetention, RULES as RETENTION_RULES } from '../privacy/retention.js';

export const QUERY_BUDGET = 45;
const STALE_MS = 30 * 60 * 1000;
const SWEEP_PER_RUN = 3;
const KEEP_RUNS_DAYS = 60;

export class BudgetExhausted extends Error {
  constructor() {
    super('query budget exhausted');
    this.name = 'BudgetExhausted';
  }
}

/**
 * env.DB, counting. Every first/run/all/raw is one query; a batch is one per
 * statement. Past the limit it throws BudgetExhausted BEFORE touching D1.
 */
export function meteredDb(db, budget) {
  const charge = (n) => {
    if (budget.used + n > budget.limit) throw new BudgetExhausted();
    budget.used += n;
  };
  const wrap = (stmt) => ({
    __raw: stmt,
    bind: (...args) => wrap(stmt.bind(...args)),
    first: (col) => { charge(1); return col === undefined ? stmt.first() : stmt.first(col); },
    run: () => { charge(1); return stmt.run(); },
    all: () => { charge(1); return stmt.all(); },
    raw: (opts) => { charge(1); return stmt.raw(opts); },
  });
  return {
    prepare: (sql) => wrap(db.prepare(sql)),
    batch: (stmts) => {
      charge(stmts.length);
      return db.batch(stmts.map((s) => s.__raw || s));
    },
  };
}

/** Central-time date and hour: the clock the academy runs on. */
export function centralClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type) => parts.find((p) => p.type === type).value;
  return { date: `${part('year')}-${part('month')}-${part('day')}`, hour: Number(part('hour')) };
}

/**
 * The jobs, in the order they run. `run(env)` gets an env whose DB is metered;
 * it returns { status, detail } or nothing (done).
 */
export const JOBS = [
  {
    // Lapsed seat offers back to the waiting list (their seats are already free).
    name: 'expire-offers', cadence: 'hourly', minQueries: 1,
    run: async (env) => ({ detail: { expired: await expireOffers(env) } }),
  },
  {
    // Spent sign-in links, OIDC flows, rate-limit windows and old sessions, bounded per run.
    name: 'auth-cleanup', cadence: 'hourly', minQueries: 4,
    run: async (env) => {
      const r = await cleanupExpiredAuth(env);
      return r ? { detail: r } : { status: 'failed' };
    },
  },
  {
    // One staff email a day, only when there is something to do.
    name: 'staff-brief', cadence: 'daily', notBeforeHour: 8, minQueries: 16,
    run: async (env) => {
      const r = await runStaffBrief(env, sendStaffBriefEmail);
      // Not sent because the provider failed or the day's allowance is gone:
      // try again next hour. Disabled or nothing to say: done for today.
      const status = r.reason === 'error' || r.reason === 'budget' ? 'failed' : 'done';
      return { status, detail: { result: r.reason } };
    },
  },
  {
    // The evaluation roster digest, while an evaluation is running (ROSTER_DIGEST_ENABLED).
    name: 'roster-digest', cadence: 'daily', notBeforeHour: 8, minQueries: 4,
    run: async (env) => {
      await sendRosterDigest(env, { reason: 'scheduled' });
    },
  },
  {
    // Inquiries keep a salted IP hash for 30 days, for rate limiting only.
    name: 'inquiry-ip-expiry', cadence: 'daily', minQueries: 1,
    run: async (env) => ({ detail: { cleared: await expireInquiryIpHashes(env) } }),
  },
  {
    // The CRM catching up with the portal: leads linked to families, cards
    // moved by evaluations and academy places (crm/reconcile.js). Fixed size.
    name: 'crm-reconcile', cadence: 'daily', minQueries: RECONCILE_STEPS.length,
    run: async (env) => ({ detail: await reconcileCrm(env) }),
  },
  {
    // Re-read the PayPal subscriptions we have heard least about. Webhooks are
    // the main path; this catches anything they missed, a few an hour.
    name: 'paypal-sweep', cadence: 'hourly', minQueries: 6,
    run: async (env) => ({
      detail: { synced: await sweepSubscriptions(env, SWEEP_PER_RUN), orders: await sweepOrders(env, SWEEP_PER_RUN) },
    }),
  },
  {
    // Retention (privacy/retention.js): counts every day; removes only when
    // RETENTION_MODE is "enforce". Its report is on Admin -> Privacy.
    name: 'retention', cadence: 'daily', minQueries: RETENTION_RULES.length * 2 + 2,
    run: async (env) => {
      const r = await runRetention(env);
      return { detail: { mode: r.mode, due: Object.fromEntries(r.rules.map((x) => [x.key, x.due])), removed: r.removed } };
    },
  },
  {
    // This table's own history, bounded.
    name: 'job-runs-housekeeping', cadence: 'daily', minQueries: 1,
    run: async (env) => {
      const cutoff = new Date(Date.now() - KEEP_RUNS_DAYS * 86400000).toISOString();
      const r = await env.DB.prepare(
        `DELETE FROM job_runs WHERE rowid IN (SELECT rowid FROM job_runs WHERE started_at < ?1 LIMIT 500)`
      ).bind(cutoff).run();
      return { detail: { removed: r.meta?.changes || 0 } };
    },
  },
];

const runKeyFor = (job, clock) => (job.cadence === 'hourly' ? `${clock.date}T${String(clock.hour).padStart(2, '0')}` : clock.date);

/**
 * Run whatever is due. Returns a summary per job (also logged).
 * @param {object} env
 * @param {{now?: Date, jobs?: Array, budget?: number}} [options]
 */
export async function runJobs(env, { now = new Date(), jobs = JOBS, budget = QUERY_BUDGET } = {}) {
  const total = { used: 0, limit: budget };
  const db = meteredDb(env.DB, total);
  const clock = centralClock(now);
  const nowIso = now.toISOString();
  const staleIso = new Date(now.getTime() - STALE_MS).toISOString();
  const summary = {};

  // One read for everything already recorded for this hour and today.
  const due = jobs.filter((j) => j.notBeforeHour === undefined || clock.hour >= j.notBeforeHour);
  const keys = [...new Set(due.map((j) => runKeyFor(j, clock)))];
  let known = new Map();
  try {
    const { results } = await db
      .prepare(`SELECT job, run_key, status, started_at FROM job_runs WHERE run_key IN (SELECT value FROM json_each(?1))`)
      .bind(JSON.stringify(keys))
      .all();
    known = new Map((results || []).map((r) => [`${r.job}|${r.run_key}`, r]));
  } catch (err) {
    console.error(JSON.stringify({ event: 'jobs_read_failed', message: err?.message }));
    return summary;
  }

  for (const job of jobs) {
    if (!due.includes(job)) { summary[job.name] = 'not-yet'; continue; }
    const runKey = runKeyFor(job, clock);
    const prior = known.get(`${job.name}|${runKey}`);
    if (prior && (prior.status === 'done' || (prior.status === 'running' && prior.started_at >= staleIso))) {
      summary[job.name] = prior.status === 'done' ? 'already-done' : 'running-elsewhere';
      continue;
    }
    // Claim + finish need two queries of their own; the job needs its minimum.
    if (total.limit - total.used < job.minQueries + 2) { summary[job.name] = 'deferred'; continue; }

    let claimed;
    try {
      const res = await db.prepare(
        `INSERT INTO job_runs (job, run_key, status, started_at) VALUES (?1, ?2, 'running', ?3)
         ON CONFLICT (job, run_key) DO UPDATE SET status = 'running', started_at = excluded.started_at,
                                                  finished_at = NULL, detail = NULL
          WHERE job_runs.status IN ('partial', 'failed')
             OR (job_runs.status = 'running' AND job_runs.started_at < ?4)`
      ).bind(job.name, runKey, nowIso, staleIso).run();
      claimed = (res.meta?.changes || 0) === 1;
    } catch (err) {
      summary[job.name] = 'claim-failed';
      console.error(JSON.stringify({ event: 'job_claim_failed', job: job.name, message: err?.message }));
      continue;
    }
    if (!claimed) { summary[job.name] = 'taken'; continue; }

    // The job's share: what is left, less the one query that records the outcome.
    const share = { used: 0, limit: total.limit - total.used - 1 };
    let status = 'done';
    let detail = null;
    try {
      const result = await job.run({ ...env, DB: meteredDb(env.DB, share) });
      status = result?.status || 'done';
      detail = result?.detail || null;
    } catch (err) {
      status = err instanceof BudgetExhausted ? 'partial' : 'failed';
      detail = status === 'failed' ? { error: String(err?.message || 'error').slice(0, 120) } : null;
    }
    total.used += share.used;

    try {
      await db.prepare(`UPDATE job_runs SET status = ?3, finished_at = ?4, detail = ?5 WHERE job = ?1 AND run_key = ?2`)
        .bind(job.name, runKey, status, new Date().toISOString(), detail ? JSON.stringify(detail) : null)
        .run();
    } catch (err) {
      // Left 'running': taken again once stale. Better than a second try now.
      console.error(JSON.stringify({ event: 'job_finish_failed', job: job.name, message: err?.message }));
    }
    summary[job.name] = status;
  }

  console.log(JSON.stringify({ event: 'jobs_run', clock: `${clock.date}T${clock.hour}`, queries: total.used, summary }));
  return summary;
}
