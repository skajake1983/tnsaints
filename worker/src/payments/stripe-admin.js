/**
 * Staff's side of Stripe (Admin -> Billing, billing:manage).
 *
 *   - Which provider new payments use (the switch the owner flips at launch).
 *   - Families moving from the old Join page: the last day their PayPal
 *     payments cover (which unlocks "move your payment" on their family page),
 *     and, once they have moved, the PayPal subscriptions staff must cancel.
 *   - A place's scholarship (percent off the monthly fee), which re-prices the
 *     family's Stripe subscriptions from their next invoice.
 *
 * Every change is audited with identifiers only.
 */

import { stripeConfig, stripeConfigured } from './stripe.js';
import { paymentsProvider, syncDiscounts } from './stripe-billing.js';

const LIVE_SUB = `('incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'paused')`;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const iso = () => new Date().toISOString();

function realDate(s) {
  if (!DATE.test(String(s))) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Everything the Stripe part of the Billing page shows. */
export async function stripeOverview(env) {
  const config = stripeConfig(env);
  const [provider, lists] = await Promise.all([
    paymentsProvider(env),
    env.DB.batch([
      // Moved to Stripe, PayPal not yet cancelled.
      env.DB.prepare(
        `SELECT e.id, e.outside_reference, h.display_name AS family_name, p.display_name AS child_name, s.status, s.current_period_end
           FROM enrollments e
           JOIN stripe_subscriptions s ON s.enrollment_id = e.id AND s.environment = ?1 AND s.status IN ${LIVE_SUB}
           JOIN households h ON h.id = e.household_id JOIN players p ON p.id = e.player_id
          WHERE e.billed_outside = 'paypal_join' AND e.paypal_cancelled_at IS NULL
          ORDER BY h.display_name, p.display_name`
      ).bind(config.env),
      // Still on the old Join page and not yet moved.
      env.DB.prepare(
        `SELECT e.id, e.outside_reference, e.outside_paid_through, h.display_name AS family_name, p.display_name AS child_name
           FROM enrollments e JOIN households h ON h.id = e.household_id JOIN players p ON p.id = e.player_id
          WHERE e.billed_outside = 'paypal_join' AND e.status IN ('active', 'past_due')
            AND NOT EXISTS (SELECT 1 FROM stripe_subscriptions s WHERE s.enrollment_id = e.id AND s.status IN ${LIVE_SUB})
          ORDER BY e.outside_paid_through IS NOT NULL, h.display_name, p.display_name`
      ),
      // Stripe subscriptions by status.
      env.DB.prepare(
        `SELECT status, COUNT(*) AS n FROM stripe_subscriptions WHERE environment = ?1 GROUP BY status`
      ).bind(config.env),
    ]),
  ]);
  const counts = Object.fromEntries((lists[2].results || []).map((r) => [r.status, Number(r.n)]));
  return {
    provider,
    env: config.env,
    configured: stripeConfigured(env),
    webhookReady: Boolean(config.webhookSecret),
    toCancel: lists[0].results || [],
    toMove: lists[1].results || [],
    counts,
  };
}

/** One place's billing, for its page. */
export async function placeBilling(env, enrollmentId) {
  const config = stripeConfig(env);
  const [place, subs, payments] = await env.DB.batch([
    env.DB.prepare(
      `SELECT e.id, e.ref, e.status, e.household_id, e.program_id, e.scholarship_percent, e.billed_outside, e.outside_reference,
              e.outside_paid_through, e.paypal_cancelled_at, p.display_name AS child_name, h.display_name AS family_name,
              pr.name AS program_name, pr.billing, pr.price_cents, g.name AS group_name
         FROM enrollments e JOIN players p ON p.id = e.player_id JOIN households h ON h.id = e.household_id
         JOIN programs pr ON pr.id = e.program_id LEFT JOIN program_groups g ON g.id = e.group_id
        WHERE e.id = ?1`
    ).bind(enrollmentId),
    env.DB.prepare(
      `SELECT subscription_id, status, cancel_at_period_end, current_period_end, coupon_id, last_synced_at
         FROM stripe_subscriptions WHERE enrollment_id = ?1 AND environment = ?2 ORDER BY created_at DESC LIMIT 5`
    ).bind(enrollmentId, config.env),
    env.DB.prepare(
      `SELECT amount_cents, kind, status, paid_at, provider FROM payments WHERE enrollment_id = ?1 ORDER BY paid_at DESC LIMIT 12`
    ).bind(enrollmentId),
  ]);
  const row = place.results?.[0];
  return row ? { place: row, subscriptions: subs.results || [], payments: payments.results || [] } : null;
}

/**
 * Save a place's billing settings: scholarship percent (blank removes it) and,
 * for an old Join-page place, the last day PayPal covers.
 * @returns {Promise<{result: 'saved'|'invalid', householdId?: number, scholarshipChanged?: boolean}>}
 */
export async function savePlaceBilling(env, enrollmentId, form) {
  const rawPct = String(form.get('scholarship_percent') ?? '').trim();
  const pct = rawPct === '' ? null : Number(rawPct);
  if (pct !== null && !(Number.isInteger(pct) && pct >= 1 && pct <= 100)) return { result: 'invalid' };
  const rawDate = String(form.get('outside_paid_through') ?? '').trim();
  if (rawDate && !realDate(rawDate)) return { result: 'invalid' };
  const before = await env.DB.prepare(`SELECT household_id, scholarship_percent, billed_outside FROM enrollments WHERE id = ?1`)
    .bind(enrollmentId).first();
  if (!before) return { result: 'invalid' };
  if (rawDate && before.billed_outside !== 'paypal_join') return { result: 'invalid' };
  await env.DB.prepare(
    `UPDATE enrollments SET scholarship_percent = ?2,
            outside_paid_through = CASE WHEN billed_outside = 'paypal_join' THEN ?3 ELSE outside_paid_through END,
            updated_at = ?4 WHERE id = ?1`
  ).bind(enrollmentId, pct, rawDate || null, iso()).run();
  const scholarshipChanged = (before.scholarship_percent ?? null) !== pct;
  if (scholarshipChanged && stripeConfigured(env)) await syncDiscounts(env, before.household_id);
  return { result: 'saved', householdId: before.household_id, scholarshipChanged };
}

/** Staff cancelled this family's old PayPal subscription. */
export async function markPaypalCancelled(env, enrollmentId) {
  const res = await env.DB.prepare(
    `UPDATE enrollments SET paypal_cancelled_at = ?2, updated_at = ?2
      WHERE id = ?1 AND billed_outside = 'paypal_join' AND paypal_cancelled_at IS NULL`
  ).bind(enrollmentId, iso()).run();
  return Boolean(res.meta?.changes);
}

/** For the daily brief: families who moved to Stripe whose PayPal is still running. */
export async function paypalToCancel(env) {
  const config = stripeConfig(env);
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM enrollments e
      WHERE e.billed_outside = 'paypal_join' AND e.paypal_cancelled_at IS NULL
        AND EXISTS (SELECT 1 FROM stripe_subscriptions s WHERE s.enrollment_id = e.id AND s.environment = ?1 AND s.status IN ${LIVE_SUB})`
  ).bind(config.env).first();
  return Number(row?.n || 0);
}
