/**
 * Parent sessions: the cookie, the row behind it, and its lifetime.
 *
 * THE COOKIE. `__Host-tns_session`, HttpOnly, Secure, SameSite=Lax, Path=/,
 * no Domain. The __Host- prefix makes the browser enforce the last three: the
 * cookie is pinned to portal.tnsaints.com exactly, is never sent to api.* or
 * admin.*, and nothing on another subdomain can set or overwrite it (which is
 * how session fixation across subdomains would otherwise work).
 *
 * THE ROW. Only HMAC(AUTH_PEPPER, 'session', id) is stored. A copy of the
 * sessions table signs nobody in.
 *
 * LIFETIME. 14 days idle, 30 days absolute, both tunable. The idle clock is
 * pushed forward at most once an hour, so browsing does not write to D1 on
 * every page. Every sign-in issues a brand-new id (no fixation), and an account
 * keeps at most 10 live sessions — the oldest are revoked.
 *
 * "RECENT SIGN-IN". Export, deletion, invites, removing a guardian and claiming
 * a subscription need the person to have actually proved who they are within
 * the last 12 hours, not merely to hold a 3-week-old cookie.
 */

import { randomToken, keyedHash } from '../lib/crypto.js';

export const SESSION_COOKIE = '__Host-tns_session';
const MAX_SESSIONS = 10;
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

function bounded(value, fallback, min, max) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

export function sessionSettings(env) {
  return {
    idleMs: bounded(env.SESSION_IDLE_DAYS, 14, 1, 60) * DAY_MS,
    maxMs: bounded(env.SESSION_MAX_DAYS, 30, 1, 90) * DAY_MS,
    recentMs: bounded(env.RECENT_AUTH_HOURS, 12, 1, 72) * 60 * 60 * 1000,
  };
}

/** Read one cookie by name from the request. Returns null if absent or malformed. */
export function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return TOKEN_SHAPE.test(value) ? value : null;
    }
  }
  return null;
}

/** A __Host- cookie. The prefix requires Secure, Path=/ and no Domain. */
export function hostCookie(name, value, maxAgeSeconds) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}

export function clearedCookie(name) {
  return `${name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** "Safari on iPhone" — enough for a device list, nothing like a fingerprint. */
export function deviceLabel(userAgent) {
  const ua = String(userAgent || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'Chromebook'
    : /Linux/.test(ua) ? 'Linux' : 'unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Chrome|CriOS/.test(ua) ? 'Chrome'
    : /Safari/.test(ua) ? 'Safari' : 'Browser';
  return `${browser} on ${os}`;
}

/**
 * Start a session for an account that has just proved who it is.
 * @returns {Promise<{ cookie: string, idHash: string }>} the Set-Cookie value
 */
export async function createSession(env, { accountId, method, request }) {
  const { idleMs, maxMs } = sessionSettings(env);
  const id = randomToken(32);
  const idHash = await keyedHash(env, 'session', id);
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sessions (id_hash, account_id, auth_method, auth_at, created_at, last_seen_at,
                             idle_expires_at, absolute_expires_at, device_label)
       VALUES (?1, ?2, ?3, ?4, ?4, ?4, ?5, ?6, ?7)`
    ).bind(idHash, accountId, method, iso(now), iso(Math.min(now + idleMs, now + maxMs)), iso(now + maxMs),
      deviceLabel(request.headers.get('User-Agent'))),
    // Keep the newest MAX_SESSIONS; revoke the rest.
    env.DB.prepare(
      `UPDATE sessions SET revoked_at = ?2
        WHERE account_id = ?1 AND revoked_at IS NULL
          AND id_hash NOT IN (SELECT id_hash FROM sessions
                               WHERE account_id = ?1 AND revoked_at IS NULL
                               ORDER BY created_at DESC LIMIT ${MAX_SESSIONS})`
    ).bind(accountId, iso(now)),
    env.DB.prepare(`UPDATE accounts SET last_login_at = ?2, updated_at = ?2 WHERE id = ?1`).bind(accountId, iso(now)),
  ]);

  return { cookie: hostCookie(SESSION_COOKIE, id, maxMs / 1000), idHash };
}

/**
 * The signed-in account for this request, or null.
 * @returns {Promise<null | {accountId: number, email: string, displayName: string|null,
 *   idHash: string, authMethod: string, recentAuth: boolean}>}
 */
export async function loadSession(env, request, ctx) {
  const id = readCookie(request, SESSION_COOKIE);
  if (!id) return null;
  const idHash = await keyedHash(env, 'session', id);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();

  const row = await env.DB.prepare(
    `SELECT s.account_id, s.auth_method, s.auth_at, s.last_seen_at, s.absolute_expires_at,
            a.email, a.display_name
       FROM sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.id_hash = ?1 AND s.revoked_at IS NULL
        AND s.idle_expires_at > ?2 AND s.absolute_expires_at > ?2
        AND a.status = 'active'`
  )
    .bind(idHash, now)
    .first();
  if (!row) return null;

  const { idleMs, recentMs } = sessionSettings(env);
  if (nowMs - Date.parse(row.last_seen_at) > TOUCH_INTERVAL_MS) {
    const idle = Math.min(nowMs + idleMs, Date.parse(row.absolute_expires_at));
    const touch = env.DB.prepare(
      `UPDATE sessions SET last_seen_at = ?2, idle_expires_at = ?3 WHERE id_hash = ?1`
    ).bind(idHash, now, new Date(idle).toISOString()).run();
    if (ctx?.waitUntil) ctx.waitUntil(touch.catch(() => {}));
    else await touch.catch(() => {});
  }

  return {
    accountId: Number(row.account_id),
    email: row.email,
    displayName: row.display_name,
    idHash,
    authMethod: row.auth_method,
    recentAuth: nowMs - Date.parse(row.auth_at) <= recentMs,
  };
}

export async function revokeSession(env, idHash) {
  await env.DB.prepare(`UPDATE sessions SET revoked_at = ?2 WHERE id_hash = ?1 AND revoked_at IS NULL`)
    .bind(idHash, new Date().toISOString())
    .run();
}
