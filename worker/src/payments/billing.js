/**
 * Keeping PayPal subscriptions and enrollments in step.
 *
 * Every function here starts from what PayPal says NOW (paypal.js fetches it)
 * and records it; nothing is taken from a browser or an event body.
 *
 *   PayPal ACTIVE / APPROVED  -> enrollment active     (from offered / past_due)
 *   PayPal SUSPENDED          -> enrollment past_due   (from active)
 *   PayPal CANCELLED/EXPIRED  -> enrollment cancelled  (from offered / active / past_due)
 *
 * A subscription links to an enrollment by its custom_id, which is the
 * enrollment's unguessable ref, AND only if its plan is that program's plan in
 * this environment. A sandbox subscription can never activate a live place,
 * and a subscription to some other plan can never activate this one.
 *
 * ACTIVATION RE-CHECKS THE SEAT. Normally the offer is live and the seat is
 * this family's. If the offer lapsed while they were paying, the seat is only
 * theirs if the group still has room, counted in the same statement; if not,
 * the enrollment stays as it is and the subscription is flagged for staff to
 * refund — a family is never silently charged for a place they do not have.
 */

import { fetchSubscription, fetchSale, paypalConfig, toCents } from './paypal.js';
import { audit } from '../auth/staff.js';

const iso = () => new Date().toISOString();
const MEMBER_OF = `SELECT household_id FROM household_members WHERE account_id = ?1`;

/** Enrollment status a PayPal subscription status should produce, or null for "no change". */
export function enrollmentStatusFor(paypalStatus) {
  switch (paypalStatus) {
    case 'ACTIVE':
    case 'APPROVED':
      return 'active';
    case 'SUSPENDED':
      return 'past_due';
    case 'CANCELLED':
    case 'EXPIRED':
      return 'cancelled';
    default:
      return null;
  }
}

/** Offered/past-due -> active, only while the seat is still this family's. */
export async function activateEnrollment(env, enrollmentId) {
  const now = iso();
  const res = await env.DB.prepare(
    `UPDATE enrollments
        SET status = 'active', activated_at = COALESCE(activated_at, ?2), offer_expires_at = NULL, updated_at = ?2
      WHERE id = ?1 AND status IN ('offered', 'past_due') AND group_id IS NOT NULL
        AND (status = 'past_due' OR offer_expires_at > ?2 OR
             (SELECT COUNT(*) FROM enrollments e
               WHERE e.group_id = enrollments.group_id AND e.id != enrollments.id
                 AND (e.status IN ('active', 'past_due') OR (e.status = 'offered' AND e.offer_expires_at > ?2)))
             < (SELECT capacity FROM program_groups g WHERE g.id = enrollments.group_id))`
  )
    .bind(enrollmentId, now)
    .run();
  return res.meta.changes === 1;
}

async function applyStatus(env, enrollmentId, paypalStatus) {
  const target = enrollmentStatusFor(paypalStatus);
  const now = iso();
  if (target === 'active') return activateEnrollment(env, enrollmentId);
  if (target === 'past_due') {
    const res = await env.DB.prepare(
      `UPDATE enrollments SET status = 'past_due', updated_at = ?2 WHERE id = ?1 AND status = 'active'`
    ).bind(enrollmentId, now).run();
    return res.meta.changes === 1;
  }
  if (target === 'cancelled') {
    const res = await env.DB.prepare(
      `UPDATE enrollments SET status = 'cancelled', ended_at = ?2, offer_expires_at = NULL, updated_at = ?2
        WHERE id = ?1 AND status IN ('offered', 'active', 'past_due')`
    ).bind(enrollmentId, now).run();
    return res.meta.changes === 1;
  }
  return false;
}

/** Record PayPal's view of a subscription (no link changes). Returns the stored row. */
async function recordSubscription(env, config, sub, source) {
  const now = iso();
  const customId = String(sub.custom_id || '') || null;
  await env.DB.prepare(
    `INSERT INTO billing_subscriptions (paypal_subscription_id, environment, plan_id, status, custom_id, source,
                                        next_billing_at, last_payment_at, last_synced_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?9)
     ON CONFLICT (environment, paypal_subscription_id) DO UPDATE SET
       plan_id = excluded.plan_id, status = excluded.status, custom_id = excluded.custom_id,
       next_billing_at = excluded.next_billing_at, last_payment_at = excluded.last_payment_at,
       last_synced_at = excluded.last_synced_at, updated_at = excluded.updated_at`
  )
    .bind(sub.id, config.env, sub.plan_id || null, String(sub.status || 'UNKNOWN'), customId,
      customId === 'joinpage' ? 'joinpage' : source,
      sub.billing_info?.next_billing_time || null, sub.billing_info?.last_payment?.time || null, now)
    .run();
  return env.DB.prepare(
    `SELECT id, enrollment_id, household_id FROM billing_subscriptions WHERE environment = ?1 AND paypal_subscription_id = ?2`
  )
    .bind(config.env, sub.id)
    .first();
}

/** The enrollment a subscription's custom_id names, if its plan is that program's plan here. */
async function enrollmentForRef(env, config, sub) {
  const ref = String(sub.custom_id || '');
  if (!ref || ref === 'joinpage') return null;
  return env.DB.prepare(
    `SELECT e.id, e.household_id, e.status FROM enrollments e JOIN programs p ON p.id = e.program_id
      WHERE e.ref = ?1 AND p.${config.planColumn} = ?2`
  )
    .bind(ref, sub.plan_id || '')
    .first();
}

/** Tie a stored subscription to an enrollment, once. False if already tied elsewhere. */
async function link(env, billingId, enrollment, linkedBy) {
  try {
    const res = await env.DB.prepare(
      `UPDATE billing_subscriptions SET enrollment_id = ?2, household_id = ?3, linked_by = ?4, linked_at = ?5, updated_at = ?5
        WHERE id = ?1 AND (enrollment_id IS NULL OR enrollment_id = ?2)`
    )
      .bind(billingId, enrollment.id, enrollment.household_id, linkedBy, iso())
      .run();
    return res.meta.changes === 1;
  } catch {
    // The unique index: this enrollment already has another live subscription.
    return false;
  }
}

/**
 * Re-read a subscription from PayPal and bring everything in line with it.
 * Used by the webhook, the nightly sweep and staff re-sync.
 * @returns {Promise<{ok: boolean, reason?: string, enrollmentId?: number, activated?: boolean}>}
 */
export async function syncSubscription(env, subscriptionId, { source = 'webhook' } = {}) {
  const config = paypalConfig(env);
  const sub = await fetchSubscription(env, subscriptionId);
  if (!sub) return { ok: false, reason: 'unknown' };
  const row = await recordSubscription(env, config, sub, source);
  let enrollmentId = row?.enrollment_id ? Number(row.enrollment_id) : null;

  // The family closed the tab before the page could confirm: link by custom_id.
  if (!enrollmentId) {
    const enrollment = await enrollmentForRef(env, config, sub);
    if (enrollment && (await link(env, row.id, enrollment, 'paypal:custom_id'))) enrollmentId = Number(enrollment.id);
  }
  if (!enrollmentId) return { ok: true, reason: 'unlinked' };

  const changed = await applyStatus(env, enrollmentId, sub.status);
  if (enrollmentStatusFor(sub.status) === 'active' && !changed) {
    const now = await env.DB.prepare(`SELECT status FROM enrollments WHERE id = ?1`).bind(enrollmentId).first();
    if (now && now.status !== 'active') {
      // Paid, but no seat to give (the offer lapsed and the group filled).
      await flagNoSeat(env, sub.id, enrollmentId);
    }
  }
  return { ok: true, enrollmentId, activated: changed && enrollmentStatusFor(sub.status) === 'active' };
}

export async function flagNoSeat(env, subscriptionId, enrollmentId) {
  console.error(JSON.stringify({ event: 'billing_paid_without_seat', enrollment: enrollmentId }));
  await audit(env, {
    actor: 'system:paypal',
    action: 'billing.paid_without_seat',
    subjectType: 'enrollment',
    subjectId: enrollmentId,
    detail: { subscription: subscriptionId },
  });
}

/**
 * The pay page's confirmation: a family says "I approved subscription I-...".
 * Everything is checked against PayPal and against this account's own
 * household before a place is marked paid.
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function approveFromPortal(env, accountId, ref, subscriptionId) {
  const config = paypalConfig(env);
  const enrollment = await env.DB.prepare(
    `SELECT e.id, e.household_id, e.status, e.ref, p.${config.planColumn} AS plan_id
       FROM enrollments e JOIN programs p ON p.id = e.program_id
      WHERE e.ref = ?2 AND e.household_id IN (${MEMBER_OF})`
  )
    .bind(accountId, ref)
    .first();
  if (!enrollment) return { ok: false, reason: 'not-found' };

  const sub = await fetchSubscription(env, subscriptionId);
  if (!sub) return { ok: false, reason: 'unknown' };
  if (sub.custom_id !== enrollment.ref || !enrollment.plan_id || sub.plan_id !== enrollment.plan_id ||
      !['ACTIVE', 'APPROVED'].includes(sub.status)) {
    console.warn(JSON.stringify({ event: 'billing_approve_mismatch', enrollment: enrollment.id }));
    return { ok: false, reason: 'mismatch' };
  }

  const row = await recordSubscription(env, config, sub, 'portal');
  if (row.enrollment_id && Number(row.enrollment_id) !== Number(enrollment.id)) return { ok: false, reason: 'taken' };
  if (!(await link(env, row.id, enrollment, `account:${accountId}`))) return { ok: false, reason: 'taken' };

  if (enrollment.status === 'active') return { ok: true };
  if (await activateEnrollment(env, enrollment.id)) return { ok: true };
  await flagNoSeat(env, sub.id, enrollment.id);
  return { ok: false, reason: 'no-seat' };
}

/**
 * Record one payment (a PayPal "sale"), re-read from PayPal. The first payment
 * that equals the program's setup fee is recorded as the setup fee; the rest
 * as monthly payments. Idempotent on the transaction id.
 */
export async function recordSale(env, saleId) {
  const config = paypalConfig(env);
  const sale = await fetchSale(env, saleId);
  if (!sale) return { ok: false, reason: 'unknown' };
  const cents = toCents(sale.amount?.total);
  if (cents === null) return { ok: false, reason: 'amount' };
  const subscriptionId = String(sale.billing_agreement_id || '');
  const billing = subscriptionId
    ? await env.DB.prepare(
        `SELECT b.id, b.enrollment_id, b.household_id, p.setup_fee_cents,
                (SELECT COUNT(*) FROM payments x WHERE x.billing_subscription_id = b.id) AS prior
           FROM billing_subscriptions b
           LEFT JOIN enrollments e ON e.id = b.enrollment_id
           LEFT JOIN programs p ON p.id = e.program_id
          WHERE b.environment = ?1 AND b.paypal_subscription_id = ?2`
      ).bind(config.env, subscriptionId).first()
    : null;
  const kind = billing && Number(billing.prior) === 0 && billing.setup_fee_cents !== null &&
    Number(billing.setup_fee_cents) === cents ? 'setup_fee' : 'recurring';
  const now = iso();
  await env.DB.prepare(
    `INSERT INTO payments (paypal_transaction_id, environment, billing_subscription_id, enrollment_id, household_id,
                           amount_cents, currency, kind, status, paid_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT (environment, paypal_transaction_id) DO UPDATE SET status = excluded.status`
  )
    .bind(sale.id, config.env, billing?.id ?? null, billing?.enrollment_id ?? null, billing?.household_id ?? null,
      cents, String(sale.amount?.currency || 'USD'), kind, String(sale.state || 'unknown'),
      sale.create_time || now, now)
    .run();
  return { ok: true, subscriptionId };
}

/** Nightly: re-read the subscriptions we have heard least about. Bounded. */
export async function sweepSubscriptions(env, limit = 10) {
  const config = paypalConfig(env);
  if (!config.clientId || !config.clientSecret) return 0;
  const { results } = await env.DB.prepare(
    `SELECT paypal_subscription_id FROM billing_subscriptions
      WHERE environment = ?1 AND status NOT IN ('CANCELLED', 'EXPIRED')
      ORDER BY last_synced_at IS NOT NULL, last_synced_at LIMIT ?2`
  )
    .bind(config.env, limit)
    .all();
  let n = 0;
  for (const r of results || []) {
    try {
      await syncSubscription(env, r.paypal_subscription_id, { source: 'webhook' });
      n += 1;
    } catch (err) {
      console.error(JSON.stringify({ event: 'billing_sweep_failed', message: err?.message }));
    }
  }
  return n;
}
