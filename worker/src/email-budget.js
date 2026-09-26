/**
 * The email budget: who may spend Resend credits, and how many are left.
 *
 * Resend's free plan allows 100 emails a day and 3,000 a month, and it counts
 * RECIPIENTS, not API calls. Everything that sends goes through reserveSend()
 * first, which is how the Worker keeps a busy afternoon from starving the
 * messages that matter.
 *
 * LANES. Every send names a lane, and the lane decides how far into the day's
 * budget it may reach:
 *
 *   auth     sign-in links. The whole day and the whole month. A parent who
 *            cannot sign in cannot do anything else, so nothing may starve it.
 *   alert    staff notifications and time-critical family notices (the roster
 *            digest, registration and cancellation alerts, waitlist promotion,
 *            staff invites). Everything except the auth reserve.
 *   bulk     decision batches. Same ceiling as alert; a batch that runs out
 *            simply resumes tomorrow.
 *   receipt  confirmations and offers to families. Stops earliest, leaving
 *            EMAIL_ALERT_RESERVE (and the auth reserve) for the lanes above.
 *
 * With L = EMAIL_DAILY_LIMIT, A = EMAIL_AUTH_RESERVE, R = EMAIL_ALERT_RESERVE:
 *   auth L · alert L−A · bulk L−A · receipt L−max(R, A)
 * and every lane except auth also stops at EMAIL_MONTHLY_LIMIT minus
 * EMAIL_MONTHLY_AUTH_RESERVE.
 *
 * A is 0 until the parent portal ships, which makes these ceilings exactly the
 * ones in force before lanes existed. Raising it is a decision (plan item O11):
 * it takes that many credits a day away from alerts and batches.
 *
 * ONE STATEMENT PER RESERVATION. The batch drain already spends five or six D1
 * queries per message, ten messages per call, against a hard 50-query limit per
 * invocation. So the daily ceiling, the monthly ceiling and the increment are a
 * single conditional upsert: a refused send changes nothing and costs one query.
 * The earlier version incremented first and compared second, so every refusal
 * still burned a credit and a stalled day drifted further past its limit.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The monthly guard looks back this many days, today included.
 *
 * Resend meters by month, and whether that is the calendar month or a billing
 * period anchored on the sign-up date is not something to guess at. A rolling
 * 31-day window caps every month of either kind, because no month is longer.
 * It is slightly stricter at the turn of a calendar month; at a few emails a
 * day that never binds.
 */
const MONTH_WINDOW_DAYS = 31;

export const LANES = ['auth', 'alert', 'bulk', 'receipt'];

/**
 * A non-negative integer setting, or `fallback` when it is unset or unreadable.
 *
 * Not `parseInt(x) || fallback`: zero is falsy, and that exact expression once
 * turned EMAIL_DAILY_LIMIT=0 ("sending off") into a limit of 100.
 */
function count(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Every budget number, read in one place. Pure — tested directly. */
export function budgetLimits(env) {
  const daily = count(env.EMAIL_DAILY_LIMIT, 100);
  const authReserve = count(env.EMAIL_AUTH_RESERVE, 0);
  const alertReserve = count(env.EMAIL_ALERT_RESERVE, 25);
  const monthly = count(env.EMAIL_MONTHLY_LIMIT, 3000);
  const monthlyAuthReserve = count(env.EMAIL_MONTHLY_AUTH_RESERVE, 150);

  return {
    daily,
    monthly,
    lanes: {
      auth: { daily, monthly },
      alert: { daily: daily - authReserve, monthly: monthly - monthlyAuthReserve },
      bulk: { daily: daily - authReserve, monthly: monthly - monthlyAuthReserve },
      receipt: {
        daily: daily - Math.max(alertReserve, authReserve),
        monthly: monthly - monthlyAuthReserve,
      },
    },
  };
}

function laneLimits(env, lane) {
  const limits = budgetLimits(env).lanes[lane];
  // A typo here would otherwise send against no ceiling at all.
  if (!limits) throw new TypeError(`Unknown email lane: ${lane}`);
  return limits;
}

/**
 * Credits a message costs: one per address. Never less than one, so a malformed
 * recipient list can under-send but never under-count.
 */
export function recipientCount(to) {
  return Array.isArray(to) ? Math.max(1, to.length) : 1;
}

/** Resend's counter is UTC-based, so the budget is keyed the same way. */
function utcDay(offsetDays = 0) {
  return new Date(Date.now() - offsetDays * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Reserve `recipients` credits in `lane`, or refuse without changing anything.
 *
 * @returns {Promise<boolean>} true if the send may go ahead
 */
export async function reserveSend(env, { lane, recipients = 1 }) {
  const limits = laneLimits(env, lane);
  const n = Math.max(1, Math.floor(recipients));
  const today = utcDay();
  const windowStart = utcDay(MONTH_WINDOW_DAYS - 1);

  try {
    // INSERT ... SELECT needs its WHERE clause for SQLite to parse the upsert,
    // and here it carries the real conditions. No row back means refused.
    const row = await env.DB.prepare(
      `INSERT INTO email_budget (day, sent)
       SELECT ?1, ?3
        WHERE ?3 <= ?2
          AND (SELECT COALESCE(SUM(sent), 0) FROM email_budget WHERE day >= ?4) + ?3 <= ?5
       ON CONFLICT(day) DO UPDATE SET sent = sent + ?3
        WHERE sent + ?3 <= ?2
          AND (SELECT COALESCE(SUM(sent), 0) FROM email_budget WHERE day >= ?4) + ?3 <= ?5
       RETURNING sent`
    )
      .bind(today, limits.daily, n, windowStart, limits.monthly)
      .first();

    if (!row) {
      console.warn(JSON.stringify({ event: 'email_budget_refused', lane, recipients: n }));
      return false;
    }
    return true;
  } catch (err) {
    // Bookkeeping must never be the reason an alert goes unsent.
    console.error('Email budget check failed, sending anyway:', err?.message);
    return true;
  }
}

/**
 * Give back credits reserved by reserveSend() for a send that did not happen.
 * Floored at zero so it can never go negative.
 */
export async function refundSend(env, { recipients = 1 } = {}) {
  const n = Math.max(1, Math.floor(recipients));
  try {
    await env.DB.prepare(`UPDATE email_budget SET sent = MAX(0, sent - ?2) WHERE day = ?1`)
      .bind(utcDay(), n)
      .run();
  } catch (err) {
    console.error('Email budget refund failed:', err?.message);
  }
}

/**
 * What a lane can still spend, for showing BEFORE a send (the batch preflight).
 * One query: today's spend and the monthly window's in the same pass.
 */
export async function budgetStatus(env, lane) {
  const limits = laneLimits(env, lane);
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN day = ?1 THEN sent END), 0) AS used_today,
            COALESCE(SUM(sent), 0) AS used_window
       FROM email_budget
      WHERE day >= ?2`
  )
    .bind(utcDay(), utcDay(MONTH_WINDOW_DAYS - 1))
    .first();

  const usedToday = Number(row?.used_today || 0);
  const usedWindow = Number(row?.used_window || 0);
  return {
    limit: Math.max(0, limits.daily),
    used: usedToday,
    remaining: Math.max(0, Math.min(limits.daily - usedToday, limits.monthly - usedWindow)),
  };
}
