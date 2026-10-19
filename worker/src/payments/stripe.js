/**
 * The Stripe REST client: which environment, which key, and the calls this
 * system makes.
 *
 * NOTHING IS TAKEN FROM THE BROWSER OR FROM A WEBHOOK BODY. When a family
 * comes back from Stripe's checkout page, or Stripe tells us something
 * changed, the Worker asks Stripe directly (a fresh read) and records what
 * Stripe says, as the PayPal client does.
 *
 * ENVIRONMENTS. STRIPE_ENV is "sandbox" (default: Stripe's test mode) or
 * "live". Each has its own secret key and webhook signing secret (Worker
 * secrets), so a test payment can never activate a live place.
 *
 * API VERSION. Stripe's response shapes change between dated versions (in
 * 2025 the subscription's period end moved onto its items, and an invoice's
 * subscription into invoice.parent). Every request pins STRIPE_API_VERSION, so
 * the shapes this code reads are the shapes it gets.
 *
 * TEST OVERRIDE. STRIPE_API_BASE points the client at the stand-in the test
 * suite runs. It is honoured only for a loopback URL: from Cloudflare's edge a
 * loopback address is unreachable, so it cannot redirect a deployed Worker.
 */

import { choice } from '../lib/flags.js';
import { isLoopbackOrigin } from '../lib/csrf.js';

const BASE = 'https://api.stripe.com';
const DEFAULT_VERSION = '2026-09-30.endive';
const TIMEOUT_MS = 8000;

export function stripeEnv(env) {
  return choice(env, 'STRIPE_ENV', ['sandbox', 'live'], 'sandbox');
}

/** Everything environment-specific, in one place. */
export function stripeConfig(env) {
  const which = stripeEnv(env);
  const suffix = which === 'live' ? 'LIVE' : 'SANDBOX';
  const override = String(env.STRIPE_API_BASE || '').replace(/\/$/, '');
  const mock = override && isLoopbackOrigin(override) ? override : null;
  return {
    env: which,
    base: mock || BASE,
    mock: Boolean(mock),
    secretKey: env[`STRIPE_SECRET_KEY_${suffix}`] || '',
    webhookSecret: env[`STRIPE_WEBHOOK_SECRET_${suffix}`] || '',
    version: String(env.STRIPE_API_VERSION || DEFAULT_VERSION),
    productColumn: which === 'live' ? 'stripe_product_live' : 'stripe_product_sandbox',
  };
}

/** A key of the right kind for the environment (sk_ or rk_, test or live). */
export function stripeConfigured(env) {
  const c = stripeConfig(env);
  const kind = c.env === 'live' ? 'live' : 'test';
  return new RegExp(`^(sk|rk)_${kind}_[A-Za-z0-9]{8,}$`).test(c.secretKey);
}

/**
 * Stripe's form encoding: nested objects as a[b][c]=v, arrays as a[0][b]=v.
 * null/undefined are left out; booleans are "true"/"false".
 */
export function formEncode(params, prefix = '') {
  const parts = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === 'object') parts.push(formEncode(item, `${key}[${i}]`));
        else parts.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof v === 'object') {
      parts.push(formEncode(v, key));
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.filter(Boolean).join('&');
}

export class StripeError extends Error {
  constructor(status, body) {
    super(`stripe ${status} ${body?.error?.code || body?.error?.type || ''}`.trim());
    this.status = status;
    this.code = body?.error?.code || null;
    this.type = body?.error?.type || null;
  }
}

/**
 * One request. GETs that find nothing return null; anything else that is not
 * 2xx throws a StripeError (status and Stripe's error code, never the message,
 * which can echo request data).
 */
export async function stripeRequest(config, method, path, params = null, { idempotencyKey = null } = {}) {
  const headers = {
    Authorization: `Bearer ${config.secretKey}`,
    'Stripe-Version': config.version,
    Accept: 'application/json',
  };
  let url = `${config.base}${path}`;
  let body;
  if (method === 'GET') {
    const q = params ? formEncode(params) : '';
    if (q) url += `?${q}`;
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = params ? formEncode(params) : '';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  }
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (method === 'GET' && res.status === 404) return null;
  if (!res.ok) throw new StripeError(res.status, json);
  return json;
}

// Stripe ids, checked before they are put into a URL path.
const IDS = {
  checkout: /^cs_(test|live)_[A-Za-z0-9]{10,200}$/,
  subscription: /^sub_[A-Za-z0-9]{8,64}$/,
  invoice: /^in_[A-Za-z0-9]{8,64}$/,
  charge: /^(ch|py)_[A-Za-z0-9]{8,64}$/,
  coupon: /^[A-Za-z0-9_-]{1,100}$/,
};

export function looksLike(kind, id) {
  return IDS[kind].test(String(id || ''));
}

export async function fetchCheckoutSession(config, id) {
  if (!looksLike('checkout', id)) return null;
  return stripeRequest(config, 'GET', `/v1/checkout/sessions/${id}`);
}

export async function fetchSubscription(config, id) {
  if (!looksLike('subscription', id)) return null;
  return stripeRequest(config, 'GET', `/v1/subscriptions/${id}`);
}

export async function fetchInvoice(config, id) {
  if (!looksLike('invoice', id)) return null;
  return stripeRequest(config, 'GET', `/v1/invoices/${id}`);
}

export async function fetchCharge(config, id) {
  if (!looksLike('charge', id)) return null;
  return stripeRequest(config, 'GET', `/v1/charges/${id}`);
}

/** The latest end of a subscription's current period (period ends live on its items). */
export function periodEnd(sub) {
  const ends = (sub?.items?.data || []).map((i) => Number(i.current_period_end)).filter((n) => n > 0);
  return ends.length ? new Date(Math.max(...ends) * 1000).toISOString() : null;
}

/** The subscription an invoice belongs to (invoice.parent in current API versions). */
export function invoiceSubscription(invoice) {
  const s = invoice?.parent?.subscription_details?.subscription;
  return typeof s === 'string' ? s : s?.id || null;
}
