/**
 * Email magic-link sign-in for parents.
 *
 * REQUEST  POST /auth/email       -> always "check your email"
 * LAND     GET  /auth/email/verify#t=...   inert page, parent presses Continue
 * VERIFY   POST /auth/email/verify         -> session, or "is this you?"
 *
 * What each step defends against:
 *
 *   Enumeration. The request answers identically whether or not the address
 *   has an account, and the email itself goes out after the response
 *   (waitUntil), so response time does not reveal it either. While signup is
 *   closed, an unknown address gets nothing at all.
 *
 *   Budget draining and mailbox flooding. Turnstile, a honeypot, and limits per
 *   IP (20 / 15 min, 100 / day) and per address (3 / 15 min, 8 / day). The
 *   email goes in the `auth` lane, the one lane allowed into the last credits
 *   of the day.
 *
 *   Link interception. The token is 256 random bits, stored only as an HMAC,
 *   single-use, 15 minutes. It travels in the URL fragment, which is never
 *   sent to a server, logged, or leaked in a Referer.
 *
 *   Scanner prefetch. The landing page never signs in by being opened.
 *
 *   Login CSRF. The request sets a browser-binding cookie; a link opened in a
 *   different browser names the account and asks before signing in.
 */

import { randomToken, keyedHash, safeEqual } from '../lib/crypto.js';
import { rateLimit } from '../lib/ratelimit.js';
import { flag } from '../lib/flags.js';
import { normEmail } from './access.js';
import { audit } from './staff.js';
import { createSession, readCookie, hostCookie, clearedCookie } from './session.js';
import { verifyTurnstile, turnstileEnabled } from '../turnstile.js';
import { clientIp } from '../http.js';
import { sendSignInLink } from '../email.js';
import {
  signInPage,
  checkEmailPage,
  tooManyPage,
  confirmPage,
  linkProblemPage,
  redirect,
} from '../portal/auth-pages.js';

export const BIND_COOKIE = '__Host-tns_bind';
const LINK_MINUTES = 15;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
// Deliberately loose: the real test of an address is whether mail arrives.
const EMAIL_SHAPE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/;

const iso = (ms) => new Date(ms).toISOString();

/** Where links in emails point. PORTAL_ORIGIN overrides locally; production derives it. */
export function portalOrigin(env) {
  if (env.PORTAL_ORIGIN) return String(env.PORTAL_ORIGIN).replace(/\/$/, '');
  return `https://${String(env.PORTAL_HOSTNAME || 'portal.tnsaints.com').trim().toLowerCase()}`;
}

/**
 * May this address be sent a sign-in link? Pure, so the rule is tested directly.
 * An existing active account: yes. Disabled or deleted: no. No account: only
 * while self-signup is open (PORTAL_SIGNUP_ENABLED exactly "true").
 */
export function mayReceiveLink(account, env) {
  if (account) return account.status === 'active';
  return flag(env, 'PORTAL_SIGNUP_ENABLED', false);
}

/** "j•••@gmail.com": enough for the owner to recognise, useless to a shoulder-surfer. */
export function maskEmail(emailNorm) {
  const [local, domain] = String(emailNorm).split('@');
  if (!domain) return '•••';
  return `${local.length > 1 ? local[0] : ''}•••@${domain}`;
}

function signInOptions(env) {
  return {
    siteKey: env.TURNSTILE_SITE_KEY || '',
    turnstile: turnstileEnabled(env),
    signupOpen: flag(env, 'PORTAL_SIGNUP_ENABLED', false),
  };
}

export function renderSignIn(env, rc, extra = {}) {
  return signInPage(rc, { ...signInOptions(env), ...extra });
}

/** POST /auth/email */
export async function requestLink(env, ctx, request, rc, form) {
  const typed = String(form.get('email') || '').trim();
  const emailNorm = normEmail(typed);

  if (!EMAIL_SHAPE.test(emailNorm) || emailNorm.length > 254) {
    return renderSignIn(env, rc, {
      email: typed,
      status: 400,
      errors: [{ id: 'email', message: 'Enter an email address like name@example.com' }],
    });
  }

  // A filled honeypot gets the normal answer and nothing else. Telling a bot
  // which field gave it away teaches it to leave that field alone.
  if (String(form.get('company') || '').trim()) {
    return checkEmailPage(rc);
  }

  const ip = clientIp(request);
  const human = await verifyTurnstile(form.get('cf-turnstile-response'), ip, env);
  if (!human.ok) {
    return renderSignIn(env, rc, {
      email: typed,
      status: 400,
      errors: [{ id: 'email', message: "We couldn't confirm you're not a robot. Please try again." }],
    });
  }

  const limits = await rateLimit(env, [
    { scope: 'signin-ip-15m', subject: ip, limit: 20, windowSeconds: 15 * 60 },
    { scope: 'signin-ip-day', subject: ip, limit: 100, windowSeconds: 24 * 60 * 60 },
    { scope: 'signin-email-15m', subject: emailNorm, limit: 3, windowSeconds: 15 * 60 },
    { scope: 'signin-email-day', subject: emailNorm, limit: 8, windowSeconds: 24 * 60 * 60 },
  ]);
  // Over the per-IP limit (or limits unavailable): say so; that reveals nothing
  // about any account. Over the per-ADDRESS limit: answer exactly as usual and
  // send nothing, so the limit cannot be used to probe an address either.
  if (limits.exceeded.some((s) => s.startsWith('signin-ip') || s === 'unavailable')) {
    return tooManyPage(rc);
  }

  // Reuse this browser's binding if it already asked in the last 15 minutes,
  // so two requests from one tab do not strand the first link.
  const bind = readCookie(request, BIND_COOKIE) || randomToken(32);
  const cookies = [hostCookie(BIND_COOKIE, bind, LINK_MINUTES * 60)];

  if (!limits.exceeded.length) {
    const account = await env.DB.prepare(`SELECT id, email, status FROM accounts WHERE email_norm = ?1`)
      .bind(emailNorm)
      .first();
    if (mayReceiveLink(account, env)) {
      const token = randomToken(32);
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO auth_login_tokens (token_hash, email_norm, purpose, binding_hash, created_at, expires_at)
         VALUES (?1, ?2, 'login', ?3, ?4, ?5)`
      )
        .bind(
          await keyedHash(env, 'login', token),
          emailNorm,
          await keyedHash(env, 'bind', bind),
          iso(now),
          iso(now + LINK_MINUTES * 60 * 1000)
        )
        .run();
      const url = `${portalOrigin(env)}${rc.url('/auth/email/verify')}#t=${token}`;
      ctx.waitUntil(
        sendSignInLink(env, { to: account?.email || typed, url, minutes: LINK_MINUTES }).then((r) => {
          if (!r.ok) {
            console.error(JSON.stringify({ event: 'signin_link_not_sent', budget: Boolean(r.budget) }));
          }
        })
      );
    }
  }

  return checkEmailPage(rc, cookies);
}

/** POST /auth/email/verify */
export async function verifyLink(env, ctx, request, rc, form) {
  const token = String(form.get('t') || '');
  if (!TOKEN_SHAPE.test(token)) return linkProblemPage(rc);

  const limits = await rateLimit(env, [
    { scope: 'verify-ip-15m', subject: clientIp(request), limit: 30, windowSeconds: 15 * 60 },
  ]);
  if (!limits.allowed) return tooManyPage(rc);

  const tokenHash = await keyedHash(env, 'login', token);
  const now = iso(Date.now());
  const row = await env.DB.prepare(
    `SELECT email_norm, binding_hash FROM auth_login_tokens
      WHERE token_hash = ?1 AND purpose = 'login' AND consumed_at IS NULL AND expires_at > ?2`
  )
    .bind(tokenHash, now)
    .first();
  if (!row) return linkProblemPage(rc);

  const bind = readCookie(request, BIND_COOKIE);
  const sameBrowser = Boolean(bind && row.binding_hash && safeEqual(await keyedHash(env, 'bind', bind), row.binding_hash));
  if (!sameBrowser && form.get('confirm') !== '1') {
    return confirmPage(rc, token, maskEmail(row.email_norm));
  }

  // Single use, enforced by the database: of two simultaneous presses, one wins.
  const consumed = await env.DB.prepare(
    `UPDATE auth_login_tokens SET consumed_at = ?2
      WHERE token_hash = ?1 AND consumed_at IS NULL AND expires_at > ?2`
  )
    .bind(tokenHash, now)
    .run();
  if (consumed.meta.changes !== 1) return linkProblemPage(rc);

  let account = await env.DB.prepare(`SELECT id, status FROM accounts WHERE email_norm = ?1`)
    .bind(row.email_norm)
    .first();
  let created = false;
  if (!account) {
    // The link was issued while signup was open. Re-check: closing signup
    // must also stop links already in flight.
    if (!flag(env, 'PORTAL_SIGNUP_ENABLED', false)) return linkProblemPage(rc);
    await env.DB.prepare(
      `INSERT INTO accounts (email, email_norm, created_at, updated_at) VALUES (?1, ?1, ?2, ?2)
       ON CONFLICT (email_norm) DO NOTHING`
    )
      .bind(row.email_norm, now)
      .run();
    account = await env.DB.prepare(`SELECT id, status FROM accounts WHERE email_norm = ?1`)
      .bind(row.email_norm)
      .first();
    created = true;
  }
  if (!account || account.status !== 'active') return linkProblemPage(rc);

  await env.DB.prepare(
    `INSERT INTO account_identities (account_id, provider, subject, created_at, last_used_at)
     VALUES (?1, 'email', ?2, ?3, ?3)
     ON CONFLICT (provider, subject) DO UPDATE SET last_used_at = excluded.last_used_at`
  )
    .bind(account.id, row.email_norm, now)
    .run();

  const { cookie } = await createSession(env, { accountId: account.id, method: 'email', request });
  ctx.waitUntil(
    audit(env, {
      actor: `account:${account.id}`,
      action: 'portal.signin',
      detail: { method: 'email', new_account: created, same_browser: sameBrowser },
    })
  );
  return redirect(rc.url('/'), [cookie, clearedCookie(BIND_COOKIE)]);
}
