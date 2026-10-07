/**
 * POST /api/paypal/webhook — PayPal telling us something changed.
 *
 * VERIFIED HERE, NOT BY ASKING PAYPAL. PayPal signs
 *     <transmission id>|<transmission time>|<our webhook id>|<CRC-32 of the raw body>
 * with the private key of a certificate it publishes. We fetch that
 * certificate ONLY from PayPal's own API hosts over HTTPS (never a URL the
 * sender chose freely), pin the algorithm to SHA256withRSA, and verify. No
 * subrequest in the steady state (the certificate is cached per isolate) and
 * under two milliseconds of CPU.
 *
 * Or, with PAYPAL_WEBHOOK_VERIFY = "postback", by asking PayPal's
 * verify-webhook-signature API: one call per event, for the day self-checking
 * breaks on PayPal's side. The same header checks come first either way, and
 * no setting skips the signature.
 *
 * AND THEN NOT TRUSTED ANYWAY. A verified event only tells us WHICH
 * subscription or sale to look at; its state is re-read from PayPal
 * (billing.js). So a replayed, reordered or somehow-forged event can only cause
 * a harmless re-read.
 *
 * Idempotent: each event id is recorded once (paypal_events, identifiers
 * only — the payload carries the payer's name, email and address and is never
 * stored). A failure answers 500 and PayPal retries for up to three days;
 * PAYPAL_WEBHOOK_ENABLED="false" answers 503 for the same reason: lossless.
 */

import { importX509 } from 'jose';
import { crc32 } from '../lib/crc32.js';
import { flag, choice } from '../lib/flags.js';
import { readBytesCapped, BodyTooLarge } from '../lib/body.js';
import { paypalConfig, paypalConfigured, certUrlAllowed, verifyWebhookByPostback } from './paypal.js';
import { syncSubscription, recordSale } from './billing.js';
import { syncOrder, captureFromWebhook, recordOrderRefund } from './orders.js';

const MAX_BODY = 64 * 1024;
const certs = new Map();

function plain(status, text) {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function certKey(url) {
  const cached = certs.get(url);
  if (cached) return cached;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`cert ${res.status}`);
  const pem = await res.text();
  if (!pem.includes('BEGIN CERTIFICATE') || pem.length > 20000) throw new Error('cert format');
  const key = await importX509(pem, 'RS256');
  certs.set(url, key);
  return key;
}

/** The signature headers, checked the same way whichever method verifies them. */
function signatureFields(headers, config) {
  const fields = {
    id: headers.get('paypal-transmission-id'),
    time: headers.get('paypal-transmission-time'),
    sig: headers.get('paypal-transmission-sig'),
    certUrl: headers.get('paypal-cert-url'),
    algo: headers.get('paypal-auth-algo'),
  };
  if (Object.values(fields).some((v) => !v)) return { ok: false, reason: 'missing-headers' };
  if (fields.algo !== 'SHA256withRSA') return { ok: false, reason: 'algorithm' };
  if (!config.webhookId) return { ok: false, reason: 'no-webhook-id' };
  if (!certUrlAllowed(fields.certUrl, config)) return { ok: false, reason: 'cert-host' };
  return { ok: true, fields };
}

/**
 * Self-verification ("self", the default).
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function verifyPaypalSignature(headers, bodyBytes, config) {
  const checked = signatureFields(headers, config);
  if (!checked.ok) return checked;
  const { id, time, sig, certUrl } = checked.fields;
  let key;
  try {
    key = await certKey(certUrl);
  } catch {
    return { ok: false, reason: 'cert-unavailable' };
  }
  let signature;
  try {
    signature = base64ToBytes(sig);
  } catch {
    return { ok: false, reason: 'signature-format' };
  }
  const message = new TextEncoder().encode(`${id}|${time}|${config.webhookId}|${crc32(bodyBytes)}`);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, message);
  return valid ? { ok: true } : { ok: false, reason: 'signature' };
}

/**
 * Asking PayPal ("postback"). The body must be a UTF-8 JSON object, because it
 * is placed into PayPal's request as-is (paypal.js explains why).
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function verifyByPostback(headers, bodyBytes, config) {
  const checked = signatureFields(headers, config);
  if (!checked.ok) return checked;
  let raw;
  try {
    // fatal: invalid UTF-8 is refused, not silently replaced (which would
    // change the bytes PayPal checks). ignoreBOM: a BOM is kept, and then
    // fails the parse below, rather than being stripped unseen.
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bodyBytes);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'body-format' };
  } catch {
    return { ok: false, reason: 'body-format' };
  }
  try {
    const good = await verifyWebhookByPostback(config, checked.fields, raw);
    return good ? { ok: true } : { ok: false, reason: 'signature' };
  } catch {
    return { ok: false, reason: 'postback-unavailable' };
  }
}

/** PAYPAL_WEBHOOK_VERIFY: "self" unless exactly "postback". */
export function webhookVerifyMode(env) {
  return choice(env, 'PAYPAL_WEBHOOK_VERIFY', ['self', 'postback'], 'self');
}

/** Check a webhook's signature by the configured method. */
export function verifyWebhook(env, headers, bodyBytes, config) {
  return webhookVerifyMode(env) === 'postback'
    ? verifyByPostback(headers, bodyBytes, config)
    : verifyPaypalSignature(headers, bodyBytes, config);
}

async function processEvent(env, event) {
  const type = String(event.event_type || '');
  const resource = event.resource || {};
  if (type.startsWith('BILLING.SUBSCRIPTION.')) {
    const r = await syncSubscription(env, resource.id, { source: 'webhook' });
    return r.ok ? 'synced' : 'ignored';
  }
  if (type.startsWith('PAYMENT.SALE.')) {
    // Refund and reversal events carry the refund; the sale is what we re-read.
    const saleId = type === 'PAYMENT.SALE.REFUNDED' || type === 'PAYMENT.SALE.REVERSED'
      ? resource.sale_id || resource.id : resource.id;
    const r = await recordSale(env, saleId);
    if (r.ok && r.subscriptionId) await syncSubscription(env, r.subscriptionId, { source: 'webhook' });
    return r.ok ? 'synced' : 'ignored';
  }
  // One-time payments (payments/orders.js). Each re-reads PayPal; the event
  // only says which order or refund to look at.
  if (type === 'CHECKOUT.ORDER.APPROVED') {
    return (await captureFromWebhook(env, resource.id)).ok ? 'synced' : 'ignored';
  }
  if (type === 'PAYMENT.CAPTURE.COMPLETED') {
    return (await syncOrder(env, resource.supplementary_data?.related_ids?.order_id)).ok ? 'synced' : 'ignored';
  }
  if (type === 'PAYMENT.CAPTURE.REFUNDED') {
    return (await recordOrderRefund(env, resource.id)).ok ? 'synced' : 'ignored';
  }
  return 'ignored';
}

export async function handlePaypalWebhook(request, env) {
  if (!flag(env, 'PAYPAL_WEBHOOK_ENABLED', false)) return plain(503, 'paused');
  const config = paypalConfig(env);
  if (!paypalConfigured(env) || !config.webhookId) {
    console.error(JSON.stringify({ event: 'paypal_webhook_misconfigured', env: config.env }));
    return plain(503, 'not configured');
  }

  let bytes;
  try {
    bytes = await readBytesCapped(request, MAX_BODY);
  } catch (err) {
    if (err instanceof BodyTooLarge) return plain(413, 'too large');
    throw err;
  }
  const verified = await verifyWebhook(env, request.headers, bytes, config);
  if (!verified.ok) {
    // Could not check (PayPal's certificate or API unreachable): 503, and
    // PayPal sends it again. Checked and wrong: 400.
    console.warn(JSON.stringify({
      event: 'paypal_webhook_rejected', reason: verified.reason, mode: webhookVerifyMode(env),
    }));
    return verified.reason.endsWith('-unavailable') ? plain(503, 'try again') : plain(400, 'rejected');
  }

  let event;
  try {
    event = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return plain(400, 'bad json');
  }
  const eventId = String(event.id || '');
  if (!/^WH-[A-Za-z0-9-]{6,80}$/.test(eventId)) return plain(400, 'bad event id');

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO paypal_events (event_id, environment, event_type, resource_id, received_at)
     VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (event_id) DO NOTHING`
  )
    .bind(eventId, config.env, String(event.event_type || '').slice(0, 80),
      String(event.resource?.id || '').slice(0, 80) || null, now)
    .run();
  const seen = await env.DB.prepare(`SELECT processed_at, outcome FROM paypal_events WHERE event_id = ?1`)
    .bind(eventId)
    .first();
  if (seen?.processed_at && seen.outcome !== 'error') return plain(200, 'duplicate');

  try {
    const outcome = await processEvent(env, event);
    await env.DB.prepare(`UPDATE paypal_events SET processed_at = ?2, outcome = ?3, error = NULL WHERE event_id = ?1`)
      .bind(eventId, new Date().toISOString(), outcome)
      .run();
    return plain(200, outcome);
  } catch (err) {
    await env.DB.prepare(`UPDATE paypal_events SET processed_at = ?2, outcome = 'error', error = ?3 WHERE event_id = ?1`)
      .bind(eventId, new Date().toISOString(), String(err?.message || 'error').slice(0, 200))
      .run();
    console.error(JSON.stringify({ event: 'paypal_webhook_failed', message: err?.message }));
    // PayPal retries a 5xx, so a transient failure loses nothing.
    return plain(500, 'retry');
  }
}
