/**
 * "Sign in with Google" for parents (OpenID Connect, authorization code + PKCE).
 *
 * START     POST /auth/google/start      -> 303 to Google
 * CALLBACK  GET  /auth/google/callback   -> session, or a plain explanation
 *
 * A parent who signs in with Google costs no email at all, which is the point:
 * Resend's free tier is the tightest limit this design has.
 *
 * WHAT IS CHECKED, AND WHY EACH MATTERS
 *
 *   state    random, stored hashed, bound to a short-lived __Host- cookie on
 *            the browser that started. A callback carrying someone else's state
 *            (login CSRF: signing a victim into the attacker's account) fails.
 *   PKCE     S256. The verifier is DERIVED from that cookie and AUTH_PEPPER,
 *            never stored, so a database read alone cannot finish a flow.
 *   nonce    random, stored hashed, must come back inside the signed ID token,
 *            so a token minted for another sign-in cannot be replayed here.
 *   ID token verified with jose against Google's published keys: RS256 only,
 *            issuer, audience = our client id, expiry. `azp`, if present, must
 *            be our client id too.
 *   email    must be verified by Google.
 *
 * WHO GETS WHICH ACCOUNT. Identities are keyed by Google's stable `sub`, never
 * by the email claim: a Workspace address can be deleted and re-issued to a
 * different person, and the new owner would otherwise inherit the old owner's
 * children. An existing link wins. Without one, Google's word about an email
 * address is accepted only where Google is AUTHORITATIVE for it — a @gmail.com
 * address, or a Workspace account whose hosted domain (`hd`) matches the
 * address's domain. For anyone else (a Google account on a non-Google address,
 * which Google may never have verified in the way that matters), the parent
 * signs in with an email link first and then connects Google from the portal.
 * That proves they control the mailbox before Google is tied to it, which stops
 * pre-account hijacking: an attacker cannot create a Google account on a
 * family's address and walk into their household.
 *
 * The account's email is never changed from Google's claims, and Google's
 * access token is discarded unused.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { randomToken, keyedHash, safeEqual, base64url } from '../lib/crypto.js';
import { flag } from '../lib/flags.js';
import { isLoopbackOrigin } from '../lib/csrf.js';
import { normEmail } from './access.js';
import { audit } from './staff.js';
import { createSession, readCookie, hostCookie, clearedCookie } from './session.js';
import { portalOrigin, mayCreateAccount } from './magic.js';
import { redirect, googleProblemPage } from '../portal/auth-pages.js';

export const FLOW_COOKIE = '__Host-tns_oidc';
const FLOW_MINUTES = 10;

const GOOGLE = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  jwks: 'https://www.googleapis.com/oauth2/v3/certs',
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
};

const jwksCache = new Map();
function jwksFor(url) {
  let set = jwksCache.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url), { cooldownDuration: 30_000, timeoutDuration: 5_000 });
    jwksCache.set(url, set);
  }
  return set;
}

/**
 * Google's endpoints — or, in local development only, a mock provider.
 *
 * GOOGLE_OIDC_BASE is honoured only when it is a loopback URL AND the request
 * came through the local dev door. Set in production by mistake, it is ignored:
 * an override that could point sign-in at another server must not be reachable
 * from configuration alone.
 */
export function providerFor(env, { isDev }) {
  const base = String(env.GOOGLE_OIDC_BASE || '').replace(/\/$/, '');
  if (base && isDev && isLoopbackOrigin(base)) {
    return { authorize: `${base}/authorize`, token: `${base}/token`, jwks: `${base}/certs`, issuers: [base] };
  }
  return GOOGLE;
}

export function googleConfigured(env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) && flag(env, 'GOOGLE_SIGNIN_ENABLED', false);
}

/**
 * Is Google authoritative for this address? Pure, so it is tested directly.
 * gmail.com (and googlemail.com) addresses are Google's own mailboxes; a
 * Workspace account is authoritative for its own hosted domain.
 */
export function googleIsAuthoritative(claims) {
  const email = normEmail(claims.email);
  const domain = email.split('@')[1] || '';
  if (!domain || !(claims.email_verified === true || claims.email_verified === 'true')) return false;
  if (domain === 'gmail.com' || domain === 'googlemail.com') return true;
  return typeof claims.hd === 'string' && claims.hd.toLowerCase() === domain;
}

async function pkceVerifier(env, flowCookie) {
  return keyedHash(env, 'pkce', flowCookie); // 43 chars of [A-Za-z0-9_-]: a valid RFC 7636 verifier
}

async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

function redirectUri(env, rc) {
  return `${portalOrigin(env)}${rc.url('/auth/google/callback')}`;
}

/**
 * POST /auth/google/start. `mode` is 'signin', or 'link' when a signed-in
 * parent is connecting Google to their account.
 */
export async function startGoogle(env, request, rc, { isDev, mode = 'signin' }) {
  const provider = providerFor(env, { isDev });
  const flowCookie = randomToken(32);
  const state = randomToken(32);
  const nonce = randomToken(32);
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO auth_oidc_flows (state_hash, nonce_hash, binding_hash, return_to, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  )
    .bind(
      await keyedHash(env, 'oidc-state', state),
      await keyedHash(env, 'oidc-nonce', nonce),
      await keyedHash(env, 'oidc-bind', flowCookie),
      mode === 'link' ? 'link' : 'signin',
      new Date(now).toISOString(),
      new Date(now + FLOW_MINUTES * 60 * 1000).toISOString()
    )
    .run();

  const url = new URL(provider.authorize);
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(env, rc),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: await pkceChallenge(await pkceVerifier(env, flowCookie)),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();

  return redirect(url.toString(), [hostCookie(FLOW_COOKIE, flowCookie, FLOW_MINUTES * 60)]);
}

/** GET /auth/google/callback */
export async function finishGoogle(env, ctx, request, rc, { isDev, session }) {
  const params = new URL(request.url).searchParams;
  const clearFlow = clearedCookie(FLOW_COOKIE);
  const problem = (kind) => googleProblemPage(rc, kind, [clearFlow]);

  if (params.get('error')) return problem('cancelled');
  const state = params.get('state') || '';
  const code = params.get('code') || '';
  const flowCookie = readCookie(request, FLOW_COOKIE);
  if (!state || !code || !flowCookie) return problem('expired');

  const now = new Date().toISOString();
  const stateHash = await keyedHash(env, 'oidc-state', state);
  const flow = await env.DB.prepare(
    `SELECT nonce_hash, binding_hash, return_to FROM auth_oidc_flows
      WHERE state_hash = ?1 AND consumed_at IS NULL AND expires_at > ?2`
  )
    .bind(stateHash, now)
    .first();
  if (!flow) return problem('expired');
  // The state must come back to the browser that started the flow.
  if (!safeEqual(await keyedHash(env, 'oidc-bind', flowCookie), flow.binding_hash)) return problem('expired');

  const consumed = await env.DB.prepare(
    `UPDATE auth_oidc_flows SET consumed_at = ?2 WHERE state_hash = ?1 AND consumed_at IS NULL`
  )
    .bind(stateHash, now)
    .run();
  if (consumed.meta.changes !== 1) return problem('expired');

  const provider = providerFor(env, { isDev });
  let claims;
  try {
    const res = await fetch(provider.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        code,
        code_verifier: await pkceVerifier(env, flowCookie),
        grant_type: 'authorization_code',
        redirect_uri: redirectUri(env, rc),
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`token endpoint ${res.status}`);
    const tokens = await res.json();
    // tokens.access_token is deliberately never read.
    const { payload } = await jwtVerify(String(tokens.id_token || ''), jwksFor(provider.jwks), {
      algorithms: ['RS256'],
      issuer: provider.issuers,
      audience: env.GOOGLE_CLIENT_ID,
      clockTolerance: 30,
    });
    claims = payload;
  } catch (err) {
    // The class of failure, never the token or the code.
    console.warn(JSON.stringify({ event: 'google_signin_rejected', code: err?.code || err?.name || 'unknown' }));
    return problem('failed');
  }

  if (!claims.nonce || !safeEqual(await keyedHash(env, 'oidc-nonce', String(claims.nonce)), flow.nonce_hash)) {
    console.warn(JSON.stringify({ event: 'google_signin_rejected', code: 'nonce' }));
    return problem('failed');
  }
  if (claims.azp && claims.azp !== env.GOOGLE_CLIENT_ID) {
    console.warn(JSON.stringify({ event: 'google_signin_rejected', code: 'azp' }));
    return problem('failed');
  }
  if (!(claims.email_verified === true || claims.email_verified === 'true')) return problem('unverified');
  const sub = String(claims.sub || '');
  if (!sub) return problem('failed');

  const linked = await env.DB.prepare(
    `SELECT a.id, a.status FROM account_identities i JOIN accounts a ON a.id = i.account_id
      WHERE i.provider = 'google' AND i.subject = ?1`
  )
    .bind(sub)
    .first();

  // Connecting Google to the account that is signed in right now.
  if (flow.return_to === 'link') {
    if (!session) return problem('expired');
    if (linked && Number(linked.id) !== session.accountId) return problem('taken');
    if (!linked) await addGoogleIdentity(env, session.accountId, sub, now);
    ctx.waitUntil(audit(env, { actor: `account:${session.accountId}`, action: 'portal.google_linked' }));
    return redirect(rc.url('/'), [clearFlow]);
  }

  let accountId = linked && linked.status === 'active' ? Number(linked.id) : null;
  let how = 'identity';
  if (linked && !accountId) return problem('failed'); // disabled account

  if (!accountId) {
    if (!googleIsAuthoritative(claims)) return problem('use-email');
    const emailNorm = normEmail(claims.email);
    let account = await env.DB.prepare(`SELECT id, status FROM accounts WHERE email_norm = ?1`)
      .bind(emailNorm)
      .first();
    if (!account) {
      if (!(await mayCreateAccount(env, emailNorm))) return problem('no-account');
      await env.DB.prepare(
        `INSERT INTO accounts (email, email_norm, display_name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4) ON CONFLICT (email_norm) DO NOTHING`
      )
        .bind(String(claims.email).trim(), emailNorm, typeof claims.name === 'string' ? claims.name.slice(0, 100) : null, now)
        .run();
      account = await env.DB.prepare(`SELECT id, status FROM accounts WHERE email_norm = ?1`).bind(emailNorm).first();
      how = 'created';
    } else {
      how = 'linked';
    }
    if (!account || account.status !== 'active') return problem('failed');
    accountId = Number(account.id);
    await addGoogleIdentity(env, accountId, sub, now);
  } else {
    await env.DB.prepare(
      `UPDATE account_identities SET last_used_at = ?2 WHERE provider = 'google' AND subject = ?1`
    )
      .bind(sub, now)
      .run();
  }

  const { cookie } = await createSession(env, { accountId, method: 'google', request });
  ctx.waitUntil(
    audit(env, { actor: `account:${accountId}`, action: 'portal.signin', detail: { method: 'google', how } })
  );
  return redirect(rc.url('/'), [cookie, clearFlow]);
}

async function addGoogleIdentity(env, accountId, sub, now) {
  await env.DB.prepare(
    `INSERT INTO account_identities (account_id, provider, subject, created_at, last_used_at)
     VALUES (?1, 'google', ?2, ?3, ?3) ON CONFLICT (provider, subject) DO NOTHING`
  )
    .bind(accountId, sub, now)
    .run();
}
