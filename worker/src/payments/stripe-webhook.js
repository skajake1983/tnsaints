/**
 * POST /api/stripe/webhook (api host): Stripe telling us something changed.
 *
 * VERIFIED: the Stripe-Signature header is "t=<unix>,v1=<hex>[,v1=...]"; the
 * signed text is "<t>.<raw body>"; the signature is HMAC-SHA256 with the
 * endpoint's signing secret, in hex; an event older than five minutes is
 * refused (Stripe's own library, checked 2026-10-18). Compared in constant time.
 *
 * TRUSTED FOR NOTHING BUT "LOOK AT THIS": the event says which checkout,
 * subscription, invoice or charge to look at; everything is re-read from
 * Stripe (stripe-billing.js). A forged or replayed event can only cause a
 * harmless re-read.
 *
 * IDEMPOTENT: each event id is recorded (identifiers only; the body holds the
 * payer's name and email and is never stored) and processed once. A failure
 * answers 500, and Stripe retries for three days.
 *
 * STRIPE_WEBHOOK_ENABLED is the kill switch: off, the endpoint answers 503 and
 * Stripe keeps the events to retry, so nothing is lost.
 */

import { flag } from '../lib/flags.js';
import { readBytesCapped, BodyTooLarge } from '../lib/body.js';
import { safeEqual } from '../lib/crypto.js';
import { stripeConfig, stripeConfigured } from './stripe.js';
import { syncCheckout, syncSubscription, recordInvoice, recordRefund } from './stripe-billing.js';

const MAX_BODY = 512 * 1024;
const TOLERANCE_SECONDS = 300;

function plain(status, text) {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** @returns {Promise<{ok: true} | {ok: false, reason: string}>} */
export async function verifyStripeSignature(header, bodyBytes, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret) return { ok: false, reason: 'no-secret' };
  let t = null;
  const signatures = [];
  for (const part of String(header || '').split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't' && /^\d{1,12}$/.test(v)) t = Number(v);
    if (k === 'v1' && /^[0-9a-f]{64}$/.test(v)) signatures.push(v);
  }
  if (t === null || !signatures.length) return { ok: false, reason: 'header' };
  if (nowSec - t > TOLERANCE_SECONDS) return { ok: false, reason: 'stale' };
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prefix = new TextEncoder().encode(`${t}.`);
  const signed = new Uint8Array(prefix.length + bodyBytes.length);
  signed.set(prefix, 0);
  signed.set(bodyBytes, prefix.length);
  const expected = hex(await crypto.subtle.sign('HMAC', key, signed));
  return signatures.some((s) => safeEqual(s, expected)) ? { ok: true } : { ok: false, reason: 'signature' };
}

async function processEvent(env, event) {
  const type = String(event.type || '');
  const id = String(event.data?.object?.id || '');
  if (type.startsWith('checkout.session.')) {
    return (await syncCheckout(env, id)).ok ? 'synced' : 'ignored';
  }
  if (type.startsWith('customer.subscription.')) {
    return (await syncSubscription(env, id)).ok ? 'synced' : 'ignored';
  }
  if (type === 'invoice.paid' || type === 'invoice.payment_failed' || type === 'invoice.payment_action_required') {
    const r = await recordInvoice(env, id);
    if (r.ok && r.subscriptionId) await syncSubscription(env, r.subscriptionId);
    return r.ok ? 'synced' : 'ignored';
  }
  if (type === 'charge.refunded') {
    return (await recordRefund(env, id)).ok ? 'synced' : 'ignored';
  }
  return 'ignored';
}

export async function handleStripeWebhook(request, env) {
  if (!flag(env, 'STRIPE_WEBHOOK_ENABLED', false)) return plain(503, 'paused');
  const config = stripeConfig(env);
  if (!stripeConfigured(env) || !config.webhookSecret) {
    console.error(JSON.stringify({ event: 'stripe_webhook_misconfigured', env: config.env }));
    return plain(503, 'not configured');
  }

  let bytes;
  try {
    bytes = await readBytesCapped(request, MAX_BODY);
  } catch (err) {
    if (err instanceof BodyTooLarge) return plain(413, 'too large');
    throw err;
  }
  const verified = await verifyStripeSignature(request.headers.get('Stripe-Signature'), bytes, config.webhookSecret);
  if (!verified.ok) {
    console.warn(JSON.stringify({ event: 'stripe_webhook_rejected', reason: verified.reason }));
    return plain(400, 'rejected');
  }

  let event;
  try {
    event = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return plain(400, 'bad json');
  }
  const eventId = String(event.id || '');
  if (!/^evt_[A-Za-z0-9]{8,80}$/.test(eventId)) return plain(400, 'bad event id');
  // A test-mode event at the live endpoint, or the reverse: acknowledged, not acted on.
  if (Boolean(event.livemode) !== (config.env === 'live')) return plain(200, 'other mode');

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO stripe_events (event_id, environment, event_type, object_id, received_at)
     VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (event_id) DO NOTHING`
  ).bind(eventId, config.env, String(event.type || '').slice(0, 80),
    String(event.data?.object?.id || '').slice(0, 120) || null, now).run();
  const seen = await env.DB.prepare(`SELECT processed_at, outcome FROM stripe_events WHERE event_id = ?1`).bind(eventId).first();
  if (seen?.processed_at && seen.outcome !== 'error') return plain(200, 'duplicate');

  try {
    const outcome = await processEvent(env, event);
    await env.DB.prepare(`UPDATE stripe_events SET processed_at = ?2, outcome = ?3, error = NULL WHERE event_id = ?1`)
      .bind(eventId, new Date().toISOString(), outcome).run();
    return plain(200, outcome);
  } catch (err) {
    await env.DB.prepare(`UPDATE stripe_events SET processed_at = ?2, outcome = 'error', error = ?3 WHERE event_id = ?1`)
      .bind(eventId, new Date().toISOString(), String(err?.message || 'error').slice(0, 200)).run();
    console.error(JSON.stringify({ event: 'stripe_webhook_failed', message: err?.message }));
    return plain(500, 'retry');
  }
}
