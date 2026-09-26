/**
 * Daily removal of sign-in rows that can no longer be used.
 *
 * Expired links, abandoned Google sign-ins, spent rate-limit windows, and
 * sessions a week past expiry or revocation. None of them can sign anyone in,
 * so keeping them only grows the table and the blast radius of a leak.
 *
 * Bounded: at most 500 rows per table per run (4 queries), so a backlog is
 * worked down over several days rather than blowing one invocation's budget.
 * Runs from the existing daily cron until the job runner (plan F1) exists.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 500;

export async function cleanupExpiredAuth(env) {
  const now = new Date().toISOString();
  const dayAgo = new Date(Date.now() - DAY_MS).toISOString();
  const weekAgo = new Date(Date.now() - 7 * DAY_MS).toISOString();
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM auth_login_tokens WHERE rowid IN
           (SELECT rowid FROM auth_login_tokens WHERE expires_at < ?1 LIMIT ${BATCH})`
      ).bind(dayAgo),
      env.DB.prepare(
        `DELETE FROM auth_oidc_flows WHERE rowid IN
           (SELECT rowid FROM auth_oidc_flows WHERE expires_at < ?1 LIMIT ${BATCH})`
      ).bind(dayAgo),
      env.DB.prepare(
        `DELETE FROM rate_limits WHERE rowid IN
           (SELECT rowid FROM rate_limits WHERE expires_at < ?1 LIMIT ${BATCH})`
      ).bind(now),
      env.DB.prepare(
        `DELETE FROM sessions WHERE rowid IN
           (SELECT rowid FROM sessions
             WHERE absolute_expires_at < ?1 OR idle_expires_at < ?1 OR revoked_at < ?1
             LIMIT ${BATCH})`
      ).bind(weekAgo),
    ]);
    const [tokens, flows, limits, sessions] = results.map((r) => r.meta?.changes || 0);
    console.log(JSON.stringify({ event: 'auth_cleanup', tokens, flows, limits, sessions }));
    return { tokens, flows, limits, sessions };
  } catch (err) {
    console.error(JSON.stringify({ event: 'auth_cleanup_failed', message: err?.message }));
    return null;
  }
}
