/**
 * The PayPal REST client: which environment, which credentials, and the two
 * reads this system trusts — a subscription and a sale, fetched fresh.
 *
 * NOTHING IS TAKEN FROM THE BROWSER OR FROM A WEBHOOK BODY. When a family
 * approves a subscription, or PayPal tells us something changed, the Worker
 * asks PayPal directly and records what PayPal says. A forged, replayed or
 * out-of-order message can therefore only cause a harmless re-read.
 *
 * ENVIRONMENTS. PAYPAL_ENV is "sandbox" (default: test money) or "live". Each
 * has its own client id (a var), secret (a Worker secret), webhook id and plan
 * id, so a sandbox subscription can never activate a live enrollment.
 *
 * TEST OVERRIDE. PAYPAL_API_BASE points the client at the mock provider the
 * test suite runs. It is honoured only for a loopback URL: from Cloudflare's
 * edge a loopback address is unreachable, so the override cannot redirect a
 * deployed Worker anywhere — at worst it fails closed.
 */

import { choice } from '../lib/flags.js';
import { isLoopbackOrigin } from '../lib/csrf.js';

const BASES = { sandbox: 'https://api-m.sandbox.paypal.com', live: 'https://api-m.paypal.com' };
const TIMEOUT_MS = 8000;

/** Hosts a webhook's signing certificate may be fetched from, per environment. */
const CERT_HOSTS = {
  sandbox: new Set(['api.sandbox.paypal.com', 'api-m.sandbox.paypal.com']),
  live: new Set(['api.paypal.com', 'api-m.paypal.com']),
};

export function paypalEnv(env) {
  return choice(env, 'PAYPAL_ENV', ['sandbox', 'live'], 'sandbox');
}

/** Everything environment-specific, in one place. */
export function paypalConfig(env) {
  const which = paypalEnv(env);
  const suffix = which === 'live' ? 'LIVE' : 'SANDBOX';
  const override = String(env.PAYPAL_API_BASE || '').replace(/\/$/, '');
  const mock = override && isLoopbackOrigin(override) ? override : null;
  return {
    env: which,
    base: mock || BASES[which],
    mock: Boolean(mock),
    clientId: env[`PAYPAL_CLIENT_ID_${suffix}`] || '',
    clientSecret: env[`PAYPAL_CLIENT_SECRET_${suffix}`] || '',
    webhookId: env[`PAYPAL_WEBHOOK_ID_${suffix}`] || '',
    planColumn: which === 'live' ? 'paypal_plan_id_live' : 'paypal_plan_id_sandbox',
  };
}

/** May a certificate be fetched from this URL for this environment? */
export function certUrlAllowed(url, config) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!u.pathname.startsWith('/v1/notifications/certs/')) return false;
  if (config.mock) return u.origin === new URL(config.base).origin;
  return u.protocol === 'https:' && CERT_HOSTS[config.env].has(u.hostname) && !u.port && !u.username && !u.password;
}

export function paypalConfigured(env) {
  const c = paypalConfig(env);
  return Boolean(c.clientId && c.clientSecret);
}

/** One OAuth token per environment+credential, per isolate, refreshed early. */
const tokens = new Map();

async function accessToken(config) {
  const key = `${config.base}|${config.clientId}`;
  const cached = tokens.get(key);
  if (cached && cached.expires > Date.now()) return cached.token;
  const res = await fetch(`${config.base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`paypal oauth ${res.status}`);
  const body = await res.json();
  if (!body.access_token) throw new Error('paypal oauth: no token');
  // Refresh a few minutes early; PayPal tokens last about nine hours.
  const lifetime = Math.max(60, Number(body.expires_in || 3600) - 300) * 1000;
  tokens.set(key, { token: body.access_token, expires: Date.now() + lifetime });
  return body.access_token;
}

async function get(config, path) {
  const res = await fetch(`${config.base}${path}`, {
    headers: { Authorization: `Bearer ${await accessToken(config)}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`paypal ${path.split('/')[3] || 'api'} ${res.status}`);
  return res.json();
}

const SUBSCRIPTION_ID = /^I-[A-Z0-9]{6,40}$/;
const SALE_ID = /^[A-Z0-9]{6,40}$/;

/** A subscription as PayPal has it now, or null if PayPal does not know it. */
export async function fetchSubscription(env, id) {
  if (!SUBSCRIPTION_ID.test(String(id || ''))) return null;
  return get(paypalConfig(env), `/v1/billing/subscriptions/${id}`);
}

/** A sale (one payment) as PayPal has it now, or null. */
export async function fetchSale(env, id) {
  if (!SALE_ID.test(String(id || ''))) return null;
  return get(paypalConfig(env), `/v1/payments/sale/${id}`);
}

/**
 * PayPal amounts are decimal STRINGS ("40.00"). Parse to integer cents
 * exactly, never through a float. Returns null for anything malformed.
 */
export function toCents(value) {
  const m = /^(-)?(\d{1,7})(?:\.(\d{1,2}))?$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const cents = Number(m[2]) * 100 + Number((m[3] || '0').padEnd(2, '0'));
  return m[1] ? -cents : cents;
}
