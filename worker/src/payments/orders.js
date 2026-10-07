/**
 * One-time payments: PayPal Orders (v2), for programs billed once — camps,
 * clinics, tournaments.
 *
 * SERVER-CREATED. The browser never names a price. The pay page asks this
 * Worker to create the order, and the amount comes from the program's row.
 * The order carries the enrollment's unguessable ref as custom_id and the
 * program's name as its description — never a child's name.
 *
 * CAPTURE VERIFIED. When the family approves in PayPal's window, the page asks
 * this Worker to capture. Before capturing it re-reads the order from PayPal
 * and checks the ref, the amount, the currency and that it is this enrollment's
 * order; after, it checks the capture COMPLETED for exactly the price. Only
 * then is the place made active and the payment recorded. If the family
 * closes the tab after approving, the PAYMENT.CAPTURE.COMPLETED webhook does
 * the same from PayPal's own state (webhook.js), and the daily sweep catches
 * anything both missed.
 *
 * SEAT RE-CHECKED, as for subscriptions (billing.js): if the hold lapsed and
 * the group filled while they paid, the payment is recorded and flagged for
 * staff to refund — never silently kept for a place they do not have.
 *
 * Idempotent: orders are created with a PayPal-Request-Id derived from the
 * enrollment and its offer, captures with one derived from the order; a
 * payment is unique on its capture id.
 */

import { paypalConfig, toCents, createPaypalOrder, fetchPaypalOrder, capturePaypalOrder, fetchPaypalRefund } from './paypal.js';
import { activateEnrollment, flagNoSeat } from './billing.js';

const iso = () => new Date().toISOString();
const MEMBER_OF = `SELECT household_id FROM household_members WHERE account_id = ?1`;
const ORDER_ID = /^[A-Z0-9]{10,40}$/;

const money = (cents) => (cents / 100).toFixed(2);

/** The family's offered (or held) enrollment for this ref, with its program's one-time price. */
async function payableEnrollment(env, accountId, ref) {
  return env.DB.prepare(
    `SELECT e.id, e.ref, e.status, e.offer_expires_at, e.offered_at, e.household_id, e.group_id,
            p.id AS program_id, p.name AS program_name, p.billing, p.price_cents, p.currency
       FROM enrollments e JOIN programs p ON p.id = e.program_id
      WHERE e.ref = ?2 AND e.household_id IN (${MEMBER_OF})`
  ).bind(accountId, ref).first();
}

/**
 * Create (or return the existing) PayPal order for an offered place.
 * @returns {Promise<{ok: true, orderId: string} | {ok: false, reason: 'not-found'|'not-offered'|'not-one-time'|'paypal'}>}
 */
export async function createOrderForPortal(env, accountId, ref) {
  const e = await payableEnrollment(env, accountId, ref);
  if (!e) return { ok: false, reason: 'not-found' };
  if (e.billing !== 'one_time' || !Number.isInteger(e.price_cents) || e.price_cents <= 0) return { ok: false, reason: 'not-one-time' };
  if (e.status !== 'offered' || !e.offer_expires_at || Date.parse(e.offer_expires_at) <= Date.now()) {
    return { ok: false, reason: 'not-offered' };
  }
  const config = paypalConfig(env);
  const body = {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: 'place',
      custom_id: e.ref,
      // The program, never the child.
      description: String(e.program_name).slice(0, 120),
      amount: { currency_code: e.currency || 'USD', value: money(e.price_cents) },
    }],
    application_context: { shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW', brand_name: 'Tennessee Saints' },
  };
  let order;
  try {
    // Same offer, same order: a double click or a reload gets the order already made.
    order = await createPaypalOrder(env, body, `order-${e.id}-${e.offered_at}`);
  } catch (err) {
    console.error(JSON.stringify({ event: 'paypal_order_create_failed', message: err?.message }));
    return { ok: false, reason: 'paypal' };
  }
  if (!order?.id || !ORDER_ID.test(order.id)) return { ok: false, reason: 'paypal' };
  await env.DB.prepare(
    `INSERT INTO paypal_orders (order_id, environment, enrollment_id, amount_cents, currency, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (environment, order_id) DO UPDATE SET status = excluded.status`
  ).bind(order.id, config.env, e.id, e.price_cents, e.currency || 'USD', String(order.status || 'CREATED'), iso()).run();
  return { ok: true, orderId: order.id };
}

/** Does PayPal's order match this enrollment and its price? */
function orderMatches(order, enrollment, priceCents, currency) {
  const unit = order?.purchase_units?.[0];
  return Boolean(unit) && unit.custom_id === enrollment.ref &&
    toCents(unit.amount?.value) === priceCents && (unit.amount?.currency_code || '') === currency;
}

/** The completed capture in an order, if any. */
function completedCapture(order) {
  return (order?.purchase_units?.[0]?.payments?.captures || []).find((c) => c.status === 'COMPLETED') || null;
}

/**
 * Capture, or — if PayPal says it was already captured (the page and the
 * webhook raced) or the call failed after PayPal acted — read the order again
 * and use its completed capture. Throws only if PayPal cannot be reached at all.
 */
async function captureOrRead(env, orderId) {
  try {
    const captured = await capturePaypalOrder(env, orderId, `capture-${orderId}`);
    const done = completedCapture(captured);
    if (done) return done;
  } catch (err) {
    console.warn(JSON.stringify({ event: 'paypal_capture_retry', message: err?.message }));
  }
  return completedCapture(await fetchPaypalOrder(env, orderId));
}

/**
 * Record a completed capture and make the place active (seat re-checked).
 * @returns {Promise<'active'|'no-seat'|'recorded'>}
 */
async function settle(env, config, row, capture) {
  const cents = toCents(capture.amount?.value);
  const now = iso();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO payments (paypal_transaction_id, environment, enrollment_id, household_id, amount_cents, currency, kind,
                             status, paid_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'one_time', 'completed', ?7, ?8)
       ON CONFLICT (environment, paypal_transaction_id) DO NOTHING`
    ).bind(capture.id, config.env, row.enrollment_id, row.household_id, cents, String(capture.amount?.currency_code || 'USD'),
      capture.create_time || now, now),
    env.DB.prepare(
      `UPDATE paypal_orders SET status = 'COMPLETED', captured_at = COALESCE(captured_at, ?3), capture_id = ?4
        WHERE environment = ?1 AND order_id = ?2`
    ).bind(config.env, row.order_id, now, capture.id),
  ]);
  if (row.enrollment_status === 'active') return 'recorded';
  if (await activateEnrollment(env, row.enrollment_id)) return 'active';
  await flagNoSeat(env, `order:${row.order_id}`, row.enrollment_id);
  return 'no-seat';
}

/**
 * The pay page's "approved": capture this family's order, after checking it.
 * @returns {Promise<{ok: true} | {ok: false, reason: 'not-found'|'mismatch'|'unknown'|'declined'|'no-seat'|'paypal'}>}
 */
export async function captureForPortal(env, accountId, ref, orderId) {
  if (!ORDER_ID.test(String(orderId || ''))) return { ok: false, reason: 'unknown' };
  const config = paypalConfig(env);
  const row = await env.DB.prepare(
    `SELECT o.order_id, o.enrollment_id, o.amount_cents, o.currency, e.ref, e.status AS enrollment_status, e.household_id
       FROM paypal_orders o JOIN enrollments e ON e.id = o.enrollment_id
      WHERE o.environment = ?2 AND o.order_id = ?3 AND e.ref = ?4 AND e.household_id IN (${MEMBER_OF})`
  ).bind(accountId, config.env, orderId, ref).first();
  if (!row) return { ok: false, reason: 'not-found' };

  let order;
  try {
    order = await fetchPaypalOrder(env, orderId);
  } catch {
    return { ok: false, reason: 'paypal' };
  }
  if (!order) return { ok: false, reason: 'unknown' };
  if (!orderMatches(order, row, row.amount_cents, row.currency)) {
    console.warn(JSON.stringify({ event: 'paypal_order_mismatch', enrollment: row.enrollment_id }));
    return { ok: false, reason: 'mismatch' };
  }
  let capture = completedCapture(order);
  if (!capture) {
    if (order.status !== 'APPROVED') return { ok: false, reason: 'declined' };
    try {
      capture = await captureOrRead(env, orderId);
    } catch {
      return { ok: false, reason: 'paypal' };
    }
    if (!capture) return { ok: false, reason: 'declined' };
  }
  if (toCents(capture.amount?.value) !== row.amount_cents) {
    console.error(JSON.stringify({ event: 'paypal_capture_amount_mismatch', enrollment: row.enrollment_id }));
    return { ok: false, reason: 'mismatch' };
  }
  const result = await settle(env, config, row, capture);
  return result === 'no-seat' ? { ok: false, reason: 'no-seat' } : { ok: true };
}

/**
 * From a webhook or the sweep: re-read an order from PayPal and settle it if
 * it has a completed capture for its enrollment's price. Never trusts the
 * event body for anything but which order to read.
 * @returns {Promise<{ok: boolean, result?: string}>}
 */
export async function syncOrder(env, orderId) {
  if (!ORDER_ID.test(String(orderId || ''))) return { ok: false };
  const config = paypalConfig(env);
  const row = await env.DB.prepare(
    `SELECT o.order_id, o.enrollment_id, o.amount_cents, o.currency, e.ref, e.status AS enrollment_status, e.household_id
       FROM paypal_orders o JOIN enrollments e ON e.id = o.enrollment_id
      WHERE o.environment = ?1 AND o.order_id = ?2`
  ).bind(config.env, orderId).first();
  if (!row) return { ok: false };
  const order = await fetchPaypalOrder(env, orderId);
  if (!order || !orderMatches(order, row, row.amount_cents, row.currency)) return { ok: false };
  const capture = completedCapture(order);
  if (!capture || toCents(capture.amount?.value) !== row.amount_cents) return { ok: false };
  return { ok: true, result: await settle(env, config, row, capture) };
}

/**
 * CHECKOUT.ORDER.APPROVED: the family approved in PayPal's window but the page
 * never asked us to capture (tab closed, connection dropped). Capture it here,
 * after the same checks the page's request gets — re-read from PayPal, ref,
 * amount, currency, and only an order this Worker created.
 * @returns {Promise<{ok: boolean, result?: string}>}
 */
export async function captureFromWebhook(env, orderId) {
  if (!ORDER_ID.test(String(orderId || ''))) return { ok: false };
  const config = paypalConfig(env);
  const row = await env.DB.prepare(
    `SELECT o.order_id, o.enrollment_id, o.amount_cents, o.currency, e.ref, e.status AS enrollment_status, e.household_id
       FROM paypal_orders o JOIN enrollments e ON e.id = o.enrollment_id
      WHERE o.environment = ?1 AND o.order_id = ?2`
  ).bind(config.env, orderId).first();
  if (!row) return { ok: false };
  const order = await fetchPaypalOrder(env, orderId);
  if (!order || !orderMatches(order, row, row.amount_cents, row.currency)) return { ok: false };
  let capture = completedCapture(order);
  if (!capture) {
    if (order.status !== 'APPROVED') return { ok: false };
    capture = await captureOrRead(env, orderId);
  }
  if (!capture || toCents(capture.amount?.value) !== row.amount_cents) return { ok: false };
  return { ok: true, result: await settle(env, config, row, capture) };
}

/** A refund of a one-time payment, re-read from PayPal and recorded as a negative payment. */
export async function recordOrderRefund(env, refundId) {
  const config = paypalConfig(env);
  const refund = await fetchPaypalRefund(env, refundId);
  if (!refund || refund.status !== 'COMPLETED') return { ok: false };
  const captureId = (refund.links || []).find((l) => l.rel === 'up')?.href?.split('/').pop();
  const paid = captureId
    ? await env.DB.prepare(`SELECT enrollment_id, household_id FROM payments WHERE environment = ?1 AND paypal_transaction_id = ?2`)
      .bind(config.env, captureId).first()
    : null;
  const cents = toCents(refund.amount?.value);
  if (cents === null) return { ok: false };
  await env.DB.prepare(
    `INSERT INTO payments (paypal_transaction_id, environment, enrollment_id, household_id, amount_cents, currency, kind,
                           status, paid_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'refund', 'completed', ?7, ?8)
     ON CONFLICT (environment, paypal_transaction_id) DO NOTHING`
  ).bind(refund.id, config.env, paid?.enrollment_id ?? null, paid?.household_id ?? null, -Math.abs(cents),
    String(refund.amount?.currency_code || 'USD'), refund.create_time || iso(), iso()).run();
  return { ok: true };
}

/** Daily: re-read orders approved or created in the last day that never settled. Bounded. */
export async function sweepOrders(env, limit = 3) {
  const config = paypalConfig(env);
  if (!config.clientId || !config.clientSecret) return 0;
  const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT order_id FROM paypal_orders WHERE environment = ?1 AND status != 'COMPLETED' AND created_at >= ?2
      ORDER BY created_at LIMIT ?3`
  ).bind(config.env, since, limit).all();
  let n = 0;
  for (const r of results || []) {
    try {
      if ((await syncOrder(env, r.order_id)).ok) n += 1;
    } catch (err) {
      console.error(JSON.stringify({ event: 'paypal_order_sweep_failed', message: err?.message }));
    }
  }
  return n;
}
