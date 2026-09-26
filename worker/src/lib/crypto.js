/**
 * Tokens and keyed hashes for sign-in, sessions, invites and rate limits.
 *
 * WHY HMAC AND NOT A PASSWORD HASH. Every secret this Worker issues — a
 * sign-in link, a session id, an invite — is 32 random bytes. Guessing one is
 * hopeless, so there is nothing for a slow hash (PBKDF2, scrypt, argon2) to
 * slow down, and on the Workers free plan those would blow the 10 ms CPU limit
 * on their own. A keyed HMAC is the right tool: it keeps the database from
 * holding anything usable (a leaked table cannot sign anyone in), and the key
 * (AUTH_PEPPER, a Worker secret) never touches the database.
 *
 * Rotating AUTH_PEPPER invalidates every session, link and invite at once.
 * That is the emergency lever, documented in the runbook.
 *
 * DOMAIN SEPARATION. Every hash names its purpose, so a session id can never
 * be presented as a sign-in token or an invite, even though all three are
 * hashed with the same key.
 */

const encoder = new TextEncoder();

/** Imported HMAC key per pepper value, per isolate. Import is the costly part. */
const keys = new Map();

export class AuthConfigError extends Error {}

/** Minimum pepper length: 32 characters (e.g. `openssl rand -base64 32` gives 44). */
const MIN_PEPPER = 32;

export function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A fresh unguessable token: `bytes` random bytes, base64url (32 bytes -> 43 chars). */
export function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

/** True if the portal's signing secret is present and long enough. */
export function authConfigured(env) {
  return typeof env.AUTH_PEPPER === 'string' && env.AUTH_PEPPER.length >= MIN_PEPPER;
}

async function pepperKey(env) {
  // Fail CLOSED. Without a pepper there is no safe way to store or check a
  // secret, and "hash with an empty key" would look like it works.
  if (!authConfigured(env)) throw new AuthConfigError('AUTH_PEPPER is missing or too short');
  const cached = keys.get(env.AUTH_PEPPER);
  if (cached) return cached;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.AUTH_PEPPER),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  keys.set(env.AUTH_PEPPER, key);
  return key;
}

/**
 * HMAC-SHA256(AUTH_PEPPER, purpose || 0x00 || value), base64url.
 *
 * @param {string} purpose  e.g. 'session', 'login', 'bind', 'invite', 'rl:auth-ip'
 */
export async function keyedHash(env, purpose, value) {
  const key = await pepperKey(env);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${purpose}\u0000${value}`));
  return base64url(new Uint8Array(sig));
}

/**
 * Constant-time string comparison for values of public length (HMAC outputs).
 * Unequal lengths return false immediately; that leaks only the length, which
 * for two HMAC outputs is always the same.
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
