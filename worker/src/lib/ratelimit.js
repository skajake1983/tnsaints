/**
 * Fixed-window rate limits in D1: one atomic upsert per limit.
 *
 * The key is an HMAC of scope + subject, so the table never holds an email
 * address or an IP. Several limits for one request (per IP and per email, per
 * 15 minutes and per day) go in one batch: one round trip, and each still
 * counts as its own query toward D1's 50-per-invocation limit.
 *
 * Fixed windows allow a burst of up to twice the limit across a window
 * boundary. For sign-in abuse that is fine — the limits exist to stop a script
 * draining the email budget or hammering one mailbox, not to be exact.
 *
 * FAILS CLOSED. If the database cannot answer, the request is refused. These
 * limits guard sending email and signing in; a D1 outage breaks both anyway,
 * and "no limit while degraded" is exactly when abuse would be cheapest.
 */

import { keyedHash } from './crypto.js';

/**
 * @param {object} env
 * @param {Array<{scope: string, subject: string, limit: number, windowSeconds: number}>} checks
 * @returns {Promise<{allowed: boolean, exceeded: string[]}>} `exceeded` names the scopes over limit
 */
export async function rateLimit(env, checks) {
  const now = Date.now();
  try {
    const statements = await Promise.all(
      checks.map(async (c) => {
        const size = c.windowSeconds * 1000;
        const start = Math.floor(now / size) * size;
        const key = await keyedHash(env, `rl:${c.scope}`, String(c.subject));
        return env.DB.prepare(
          `INSERT INTO rate_limits (key_hash, window_start, hits, expires_at)
           VALUES (?1, ?2, 1, ?3)
           ON CONFLICT (key_hash, window_start) DO UPDATE SET hits = hits + 1
           RETURNING hits`
        ).bind(key, new Date(start).toISOString(), new Date(start + size).toISOString());
      })
    );
    const results = await env.DB.batch(statements);
    const exceeded = [];
    results.forEach((r, i) => {
      const hits = Number(r.results?.[0]?.hits || 0);
      if (hits > checks[i].limit) exceeded.push(checks[i].scope);
    });
    return { allowed: exceeded.length === 0, exceeded };
  } catch (err) {
    console.error(JSON.stringify({ event: 'rate_limit_unavailable', message: err?.message }));
    return { allowed: false, exceeded: ['unavailable'] };
  }
}
