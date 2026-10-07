/**
 * The scheduled job runner (src/jobs/runner.js), against real SQL.
 *
 * Runs on Node's built-in SQLite with the real schema and migrations
 * (tests/_d1_fake.mjs), so the clock and the query count are under the test's
 * control and no dev server is needed. Proved: each job runs once per hour or
 * day however often the cron fires; the daily emails wait for 8 AM Central;
 * no run ever passes the query budget; work cut off by the budget, a failure
 * or a crash is picked up again; and the meter refuses BEFORE D1 is touched.
 *
 *   node --no-warnings tests/test_jobs.mjs
 */
import { fakeD1, checker } from './_d1_fake.mjs';
import { runJobs, meteredDb, centralClock, JOBS, QUERY_BUDGET, BudgetExhausted } from '../src/jobs/runner.js';

const check = checker();
// 9 AM Central (CDT, UTC-5) on 2026-10-07; 7 AM the same day.
const NINE = new Date('2026-10-07T14:00:00Z');
const SEVEN = new Date('2026-10-07T12:00:00Z');
const quiet = { ROSTER_DIGEST_ENABLED: 'false' }; // no email, no PayPal: nothing leaves the process

const rows = async (DB, job) =>
  (await DB.prepare(`SELECT job, run_key, status, detail FROM job_runs ${job ? 'WHERE job = ?1' : ''} ORDER BY job`)
    .bind(...(job ? [job] : [])).all()).results;

console.log('\n=== the clock ===');
check('Central date and hour, across daylight saving',
  JSON.stringify([centralClock(NINE), centralClock(new Date('2026-12-07T14:00:00Z'))]) ===
    JSON.stringify([{ date: '2026-10-07', hour: 9 }, { date: '2026-12-07', hour: 8 }]),
  [centralClock(NINE), centralClock(new Date('2026-12-07T14:00:00Z'))]);

console.log('\n=== the real jobs, run by the hourly cron ===');
{
  const DB = fakeD1();
  const early = await runJobs({ ...quiet, DB }, { now: SEVEN });
  check('at 7 AM the daily emails are not due yet; the rest run',
    early['staff-brief'] === 'not-yet' && early['roster-digest'] === 'not-yet' &&
      early['expire-offers'] === 'done' && early['auth-cleanup'] === 'done', early);
  const first = await runJobs({ ...quiet, DB }, { now: NINE });
  check('at 9 AM the emails and the hourly jobs run; daily jobs done at 7 AM are not repeated',
    first['staff-brief'] === 'done' && first['roster-digest'] === 'done' && first['expire-offers'] === 'done' &&
      first['inquiry-ip-expiry'] === 'already-done' && first['job-runs-housekeeping'] === 'already-done', first);
  const keys = Object.fromEntries((await rows(DB)).filter((r) => r.run_key.includes('T09') || !r.run_key.includes('T'))
    .map((r) => [r.job, r.run_key]));
  check('hourly jobs are keyed to the hour, daily jobs to the day',
    keys['expire-offers'] === '2026-10-07T09' && keys['staff-brief'] === '2026-10-07', keys);
  const again = await runJobs({ ...quiet, DB }, { now: new Date(NINE.getTime() + 20 * 60000) });
  check('the cron firing again in the same hour runs nothing twice',
    Object.values(again).every((s) => s === 'already-done'), again);
  const ten = await runJobs({ ...quiet, DB }, { now: new Date(NINE.getTime() + 60 * 60000) });
  check('the next hour: hourly jobs run again, daily ones do not',
    ten['expire-offers'] === 'done' && ten['paypal-sweep'] === 'done' && ten['staff-brief'] === 'already-done', ten);
  const brief = (await rows(DB, 'staff-brief'))[0];
  check('detail holds counts and outcomes only', brief && JSON.parse(brief.detail).result === 'disabled', brief);
}

console.log('\n=== never past the budget ===');
{
  const DB = fakeD1();
  const before = DB.stats.queries;
  await runJobs({ ...quiet, DB }, { now: NINE });
  const used = DB.stats.queries - before;
  check(`a full run of the real jobs stays within ${QUERY_BUDGET} queries`, used <= QUERY_BUDGET, used);

  // Synthetic jobs: one cheap, one greedy, one after it.
  const jobs = [
    { name: 'cheap', cadence: 'hourly', minQueries: 1, run: async (env) => { await env.DB.prepare('SELECT 1').first(); } },
    {
      name: 'greedy', cadence: 'hourly', minQueries: 1,
      run: async (env) => { for (let i = 0; i < 100; i += 1) await env.DB.prepare('SELECT 1').first(); },
    },
    { name: 'after', cadence: 'hourly', minQueries: 1, run: async () => {} },
  ];
  const DB2 = fakeD1();
  const start = DB2.stats.queries;
  const r = await runJobs({ DB: DB2 }, { now: NINE, jobs, budget: 20 });
  const spent = DB2.stats.queries - start;
  check('a job that wants more than is left is stopped and recorded as partial', r.greedy === 'partial', r);
  check('and what comes after it waits for the next run', r.after === 'deferred', r);
  check('the whole run used no more than the budget', spent <= 20, spent);
  const resumed = await runJobs({ DB: DB2 }, { now: new Date(NINE.getTime() + 5 * 60000), jobs: [jobs[0], jobs[2]], budget: 20 });
  check('a deferred job runs on the next trigger; a finished one does not run again',
    resumed.after === 'done' && resumed.cheap === 'already-done', resumed);
  const retaken = await runJobs({ DB: DB2 }, { now: new Date(NINE.getTime() + 6 * 60000),
    jobs: [{ ...jobs[1], run: async () => {} }], budget: 20 });
  check('a partial job is taken up again and can finish', retaken.greedy === 'done', retaken);
}

console.log('\n=== failures and overlaps ===');
{
  const DB = fakeD1();
  const boom = [{ name: 'boom', cadence: 'daily', minQueries: 1, run: async () => { throw new Error('provider down: SECRET-ish text'); } }];
  const r = await runJobs({ DB }, { now: NINE, jobs: boom });
  const row = (await rows(DB, 'boom'))[0];
  check('a job that throws is recorded as failed, with a short reason', r.boom === 'failed' && row.status === 'failed'
    && JSON.parse(row.detail).error.length <= 120, row);
  const retry = await runJobs({ DB }, { now: new Date(NINE.getTime() + 60 * 60000), jobs: [{ ...boom[0], run: async () => {} }] });
  check('a failed daily job is tried again on the next run', retry.boom === 'done', retry);

  await DB.prepare(`INSERT INTO job_runs (job, run_key, status, started_at) VALUES ('busy', '2026-10-07', 'running', ?1)`)
    .bind(new Date(NINE.getTime() - 5 * 60000).toISOString()).run();
  let ran = 0;
  const busy = [{ name: 'busy', cadence: 'daily', minQueries: 1, run: async () => { ran += 1; } }];
  const overlap = await runJobs({ DB }, { now: NINE, jobs: busy });
  check('a job another invocation is running right now is left alone', overlap.busy === 'running-elsewhere' && ran === 0, overlap);
  const later = await runJobs({ DB }, { now: new Date(NINE.getTime() + 40 * 60000), jobs: busy });
  check('one stuck "running" for over half an hour is taken over', later.busy === 'done' && ran === 1, later);
}

console.log('\n=== housekeeping ===');
{
  const DB = fakeD1();
  await DB.prepare(`INSERT INTO job_runs (job, run_key, status, started_at) VALUES ('old', '2026-06-01', 'done', '2026-06-01T13:00:00.000Z')`).run();
  await DB.prepare(`INSERT INTO job_runs (job, run_key, status, started_at) VALUES ('recent', '2026-09-30', 'done', '2026-09-30T13:00:00.000Z')`).run();
  await runJobs({ ...quiet, DB }, { now: NINE, jobs: JOBS.filter((j) => j.name === 'job-runs-housekeeping') });
  const left = (await rows(DB)).map((r) => r.job);
  check('runs older than 60 days are cleared; recent ones kept', !left.includes('old') && left.includes('recent'), left);
}

console.log('\n=== the meter itself ===');
{
  const DB = fakeD1();
  const budget = { used: 0, limit: 3 };
  const m = meteredDb(DB, budget);
  await m.prepare('SELECT 1').first();
  let refused = false;
  const before = DB.stats.queries;
  try {
    await m.batch([m.prepare('SELECT 1'), m.prepare('SELECT 2'), m.prepare('SELECT 3')]);
  } catch (err) {
    refused = err instanceof BudgetExhausted;
  }
  check('a batch counts one per statement, and is refused before it reaches the database',
    refused && DB.stats.queries === before && budget.used === 1, { used: budget.used });
  const ok = await m.batch([m.prepare('SELECT 1 AS a'), m.prepare('SELECT 2 AS a')]);
  check('within budget it runs normally', ok[1].results[0].a === 2 && budget.used === 3, budget);
}

check.finish();
