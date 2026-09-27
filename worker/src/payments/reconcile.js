/**
 * Staff reconciliation: PayPal subscriptions the system cannot place by itself.
 *
 * Who ends up here:
 *   - families who subscribed on the old Join page, before the portal (their
 *     custom_id is "joinpage", or nothing at all);
 *   - anyone flagged "paid but no seat" (billing.js), who needs a refund or a
 *     place;
 *   - subscriptions staff paste in by hand (PayPal has no "list all" API).
 *
 * Linking a subscription to a child creates or updates that child's academy
 * enrollment in a chosen group — with the same atomic seat check as an offer —
 * and ties the subscription to it. A child placed this way has signed nothing
 * through the portal; the family page asks a guardian to sign the waiver.
 *
 * Payer details shown during a lookup are fetched live from PayPal and never
 * stored.
 */

import { randomToken } from '../lib/crypto.js';
import { fetchSubscription, paypalConfig } from './paypal.js';
import { syncSubscription } from './billing.js';

const iso = () => new Date().toISOString();
const LIVE = `('applied', 'waitlist', 'offered', 'active', 'past_due')`;
const SEAT_FREE = (groupParam, nowParam, selfExpr) => `(SELECT COUNT(*) FROM enrollments e
    WHERE e.group_id = ${groupParam} AND e.id != ${selfExpr}
      AND (e.status IN ('active', 'past_due') OR (e.status = 'offered' AND e.offer_expires_at > ${nowParam})))
  < (SELECT capacity FROM program_groups WHERE id = ${groupParam} AND status = 'active')`;

/** Subscriptions tied to no enrollment, newest first. */
export async function listUnlinked(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, paypal_subscription_id, environment, status, plan_id, source, custom_id, created_at, last_synced_at
       FROM billing_subscriptions WHERE enrollment_id IS NULL
      ORDER BY created_at DESC LIMIT 200`
  ).all();
  return results || [];
}

/** Enrollments that were paid for but had no seat to give (from the audit trail). */
export async function listPaidWithoutSeat(env) {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT e.id, e.status, p.display_name AS child_name, h.display_name AS family_name, a.at
       FROM audit_log a
       JOIN enrollments e ON e.id = CAST(a.subject_id AS INTEGER)
       JOIN players p ON p.id = e.player_id
       JOIN households h ON h.id = e.household_id
      WHERE a.action = 'billing.paid_without_seat' AND e.status != 'active'
      ORDER BY a.at DESC LIMIT 50`
  ).all();
  return results || [];
}

/**
 * What PayPal says about a subscription right now, for a staff member to look
 * at. Includes the payer's name and email so staff can recognise the family;
 * none of it is written anywhere.
 */
export async function lookup(env, subscriptionId) {
  const sub = await fetchSubscription(env, subscriptionId);
  if (!sub) return null;
  const name = sub.subscriber?.name ? `${sub.subscriber.name.given_name || ''} ${sub.subscriber.name.surname || ''}`.trim() : '';
  return {
    id: sub.id,
    status: sub.status,
    planId: sub.plan_id,
    customId: sub.custom_id || '',
    payerName: name,
    payerEmail: sub.subscriber?.email_address || '',
    startTime: sub.start_time || sub.create_time || '',
    nextBilling: sub.billing_info?.next_billing_time || '',
    lastPayment: sub.billing_info?.last_payment?.amount?.value || '',
  };
}

/** Record a pasted subscription (links itself only if its custom_id names a place). */
export async function importSubscription(env, subscriptionId) {
  return syncSubscription(env, subscriptionId, { source: 'admin_paste' });
}

/** Children on the portal, for the "link to" picker: family, child, current academy status. */
export async function linkableChildren(env) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.display_name, h.display_name AS family_name,
            (SELECT e.status FROM enrollments e WHERE e.player_id = p.id AND e.program_id = 'academy'
               AND e.status IN ${LIVE} LIMIT 1) AS academy_status
       FROM players p JOIN households h ON h.id = p.household_id AND h.status = 'active'
      ORDER BY h.display_name, p.display_name`
  ).all();
  return results || [];
}

/**
 * Tie an unlinked subscription to a child's academy place in `groupId`.
 * Reuses the child's live enrollment if there is one; otherwise creates one.
 * The seat is checked in the same statement that takes it.
 * @returns {Promise<'linked'|'full'|'state'>}
 */
export async function linkToChild(env, { billingId, playerId, groupId, staffEmail }) {
  const config = paypalConfig(env);
  const billing = await env.DB.prepare(
    `SELECT id, status FROM billing_subscriptions WHERE id = ?1 AND enrollment_id IS NULL AND environment = ?2`
  )
    .bind(billingId, config.env)
    .first();
  if (!billing) return 'state';
  const now = iso();
  const live = await env.DB.prepare(
    `SELECT id FROM enrollments WHERE player_id = ?1 AND program_id = 'academy' AND status IN ${LIVE}`
  )
    .bind(playerId)
    .first();

  let enrollmentId;
  if (live) {
    const res = await env.DB.prepare(
      `UPDATE enrollments
          SET status = 'active', group_id = ?2, offer_expires_at = NULL, activated_at = COALESCE(activated_at, ?3),
              decided_by = ?4, decided_at = ?3, updated_at = ?3
        WHERE id = ?1 AND ${SEAT_FREE('?2', '?3', 'enrollments.id')}`
    )
      .bind(live.id, groupId, now, staffEmail)
      .run();
    if (res.meta.changes !== 1) return 'full';
    enrollmentId = Number(live.id);
  } else {
    const ref = randomToken(16);
    const row = await env.DB.prepare(
      `INSERT INTO enrollments (ref, player_id, household_id, program_id, group_id, status, applied_at, activated_at,
                                decided_by, decided_at, created_by, created_at, updated_at)
       SELECT ?1, p.id, p.household_id, 'academy', ?3, 'active', ?4, ?4, ?5, ?4, ?5, ?4, ?4
         FROM players p
        WHERE p.id = ?2 AND p.household_id IS NOT NULL AND ${SEAT_FREE('?3', '?4', '0')}
       RETURNING id`
    )
      .bind(ref, playerId, groupId, now, staffEmail)
      .first();
    if (!row) return 'full';
    enrollmentId = Number(row.id);
  }

  const linked = await env.DB.prepare(
    `UPDATE billing_subscriptions
        SET enrollment_id = ?2, household_id = (SELECT household_id FROM enrollments WHERE id = ?2),
            linked_by = ?3, linked_at = ?4, updated_at = ?4
      WHERE id = ?1 AND enrollment_id IS NULL`
  )
    .bind(billingId, enrollmentId, staffEmail, now)
    .run();
  return linked.meta.changes === 1 ? 'linked' : 'state';
}
