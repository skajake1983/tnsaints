/**
 * Paying for an event online (the Events plan, phase EV6): a camp, or a
 * tournament's entry fee, through Stripe Checkout, before the place is theirs.
 *
 * THE HOLD: a paid sign-up takes its place at once — it counts against the
 * session's size — as payment_state 'pending' for HOLD_MINUTES, while the
 * family pays on Stripe's page (card only: a bank payment takes days, longer
 * than any hold). The Checkout Session expires a minute sooner, so a payment
 * can never land after its hold has let go of the place.
 *
 * CONFIRMED BY STRIPE, NEVER BY THE BROWSER: the webhook (or the family's
 * return, or the sweep) re-reads the session from Stripe; only a complete,
 * paid session whose reference matches marks the place paid and records the
 * payment. A hold that lapses unpaid gives the place back (the hourly job) and
 * the next family on the waiting list is offered it with a pay link.
 *
 * Only the parent's (or coach's) email and the event's name go to Stripe —
 * never a child's name (the owner's rule for every payment provider).
 *
 * Online payment is chosen per event, and only once Stripe is set up and
 * Admin -> Billing has switched payments to Stripe (programs.payment_policy).
 */

import { stripeConfig, stripeConfigured, stripeRequest, fetchCheckoutSession } from '../payments/stripe.js';
import { paymentsProvider } from '../payments/stripe-billing.js';
import { randomToken } from '../lib/crypto.js';
import { audit } from '../auth/staff.js';
import { withEvent } from '../programs/evaluation.js';
import { promoteFirstWaitlisted } from '../registration.js';
import { sendEventPlaceOpened } from '../email.js';

export const HOLD_MINUTES = 35;
export const PROMOTED_HOLD_HOURS = 48;
const iso = () => new Date().toISOString();

/** May an event take payment online right now? */
export async function onlinePaymentReady(env) {
  return stripeConfigured(env) && (await paymentsProvider(env)) === 'stripe';
}

const TABLES = {
  registration: { table: 'registrations', fk: 'registration_id', email: 'parent_email', status: "status = 'confirmed'" },
  team: { table: 'event_teams', fk: 'team_id', email: 'coach_email', status: "status = 'entered'" },
};

/**
 * A Checkout Session for a held sign-up. `kind` 'registration' or 'team'.
 * @returns {Promise<{ok: true, url: string} | {ok: false, reason: string}>}
 */
export async function startEventCheckout(env, { kind, id, event, site }) {
  const t = TABLES[kind];
  if (!t) return { ok: false, reason: 'invalid' };
  if (!stripeConfigured(env)) return { ok: false, reason: 'not-configured' };
  const row = await env.DB.prepare(
    `SELECT id, ${t.email} AS email, amount_due_cents, hold_expires_at, cancel_token FROM ${t.table}
      WHERE id = ?1 AND payment_state = 'pending' AND ${t.status}`
  ).bind(id).first();
  if (!row || !row.amount_due_cents) return { ok: false, reason: 'not-payable' };
  const now = Date.now();
  const holdEnds = Date.parse(row.hold_expires_at || '');
  // Stripe's minimum is 30 minutes; the session must end before the hold does.
  const expires = Math.floor(Math.min(holdEnds - 60 * 1000, now + 24 * 60 * 60 * 1000) / 1000);
  if (!Number.isFinite(expires) || expires * 1000 < now + 30 * 60 * 1000) return { ok: false, reason: 'hold-too-short' };
  const config = stripeConfig(env);
  const ref = randomToken(18);
  const back = `${site}/?event=${encodeURIComponent(event.id)}`;
  const session = await stripeRequest(config, 'POST', '/v1/checkout/sessions', {
    mode: 'payment',
    customer_email: row.email,
    client_reference_id: ref,
    metadata: { kind: 'event', ref },
    line_items: [{ price_data: { currency: 'usd', product_data: { name: String(event.name).slice(0, 250) },
      unit_amount: Number(row.amount_due_cents) }, quantity: 1 }],
    payment_intent_data: { description: String(event.name).slice(0, 250), metadata: { ref } },
    payment_method_types: ['card'],
    expires_at: expires,
    success_url: `${back}&paid=1`,
    cancel_url: `${back}&pay=${encodeURIComponent(row.cancel_token)}`,
  }, { idempotencyKey: `event-checkout-${ref}` });
  await env.DB.prepare(
    `INSERT INTO event_checkouts (session_id, environment, event_id, ${t.fk}, ref, amount_cents, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7)`
  ).bind(session.id, config.env, event.id, row.id, ref, Number(row.amount_due_cents), iso()).run();
  return { ok: true, url: session.url };
}

/**
 * Bring an event Checkout Session in line with Stripe (the webhook, the sweep).
 * @returns {Promise<{ok: boolean, reason?: string, status?: string}>}
 */
export async function syncEventCheckout(env, sessionId) {
  const config = stripeConfig(env);
  const known = await env.DB.prepare(
    `SELECT * FROM event_checkouts WHERE session_id = ?1 AND environment = ?2`
  ).bind(sessionId, config.env).first();
  if (!known) return { ok: false, reason: 'unknown' };
  const session = await fetchCheckoutSession(config, sessionId);
  if (!session || session.client_reference_id !== known.ref) return { ok: false, reason: 'mismatch' };
  if (session.status === 'expired') {
    await env.DB.prepare(`UPDATE event_checkouts SET status = 'expired' WHERE session_id = ?1 AND status = 'open'`).bind(sessionId).run();
    return { ok: true, status: 'expired' };
  }
  if (session.status !== 'complete' || session.payment_status !== 'paid') return { ok: true, status: 'open' };
  const now = iso();
  const kind = known.registration_id ? 'registration' : 'team';
  const t = TABLES[kind];
  const rowId = known.registration_id || known.team_id;
  const pi = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
  const [done, place] = await env.DB.batch([
    env.DB.prepare(`UPDATE event_checkouts SET status = 'complete', completed_at = COALESCE(completed_at, ?2) WHERE session_id = ?1`)
      .bind(sessionId, now),
    // Paid in time: the place is theirs. (A lapsed hold is handled below.)
    env.DB.prepare(`UPDATE ${t.table} SET payment_state = 'paid', hold_expires_at = NULL WHERE id = ?1 AND payment_state = 'pending'
                     AND ${t.status}`).bind(rowId),
  ]);
  if (pi) {
    await env.DB.prepare(
      `INSERT INTO payments (paypal_transaction_id, environment, provider, ${kind === 'registration' ? 'registration_id' : 'event_team_id'},
                             amount_cents, currency, kind, status, paid_at, created_at)
       VALUES (?1, ?2, 'stripe', ?3, ?4, ?5, 'one_time', 'paid', ?6, ?6)
       ON CONFLICT (environment, paypal_transaction_id) DO NOTHING`
    ).bind(pi, config.env, rowId, Number(session.amount_total) || 0, String(session.currency || 'usd').toUpperCase(), now).run();
  }
  if (!place.meta?.changes) {
    const state = await env.DB.prepare(`SELECT payment_state FROM ${t.table} WHERE id = ?1`).bind(rowId).first();
    if (state?.payment_state !== 'paid') {
      // Paid after the hold let the place go: staff refund it, or find room.
      console.error(JSON.stringify({ event: 'event_paid_without_place', kind, id: rowId }));
      await audit(env, { actor: 'system:stripe', action: 'billing.paid_without_seat', subjectType: kind === 'registration'
        ? 'registration' : 'event_team', subjectId: rowId, detail: { checkout: sessionId } });
      return { ok: false, reason: 'no-place' };
    }
  }
  return { ok: Boolean(done), status: 'complete' };
}

/**
 * The hourly job: holds that lapsed unpaid give their place back; the next
 * family waiting for that session is offered it (a new, longer hold), and a
 * team waiting for that division likewise. Each one moved up is told, with
 * the pay link -- only while EVENT_EMAILS_ENABLED is "true", which
 * sendEventPlaceOpened checks. Bounded per run: at most HOLDS_PER_RUN of each,
 * at most HOLD_QUERIES queries in all (the job runner's minQueries).
 * @returns {Promise<{released: number, offered: number, told: number}>}
 */
export async function expireEventHolds(env, { limit = HOLDS_PER_RUN } = {}) {
  const now = iso();
  const { results } = await env.DB.prepare(
    `SELECT id, event_id, session_time FROM registrations
      WHERE payment_state = 'pending' AND hold_expires_at < ?1 AND status = 'confirmed' LIMIT ?2`
  ).bind(now, limit).all();
  let released = 0;
  let offered = 0;
  let told = 0;
  for (const r of results || []) {
    const res = await env.DB.prepare(
      `UPDATE registrations SET status = 'cancelled', payment_state = 'expired', cancelled_at = ?2,
              cancel_reason = 'Payment not completed in time'
        WHERE id = ?1 AND payment_state = 'pending' AND status = 'confirmed'`
    ).bind(r.id, now).run();
    if (!res.meta?.changes) continue;
    released += 1;
    const ev = await withEvent(env, r.event_id);
    const next = await promoteFirstWaitlisted(ev, r.session_time);
    if (!next) continue;
    offered += 1;
    const sent = await sendEventPlaceOpened(ev, { to: next.parent_email, name: next.player_name, session: next.session_time,
      cancelToken: next.cancel_token, holdUntil: next.hold_expires_at || null });
    if (sent.ok) told += 1;
  }
  const teams = await env.DB.prepare(
    `UPDATE event_teams SET status = 'withdrawn', payment_state = 'expired', updated_at = ?1
      WHERE id IN (SELECT id FROM event_teams WHERE payment_state = 'pending' AND hold_expires_at < ?1 AND status = 'entered' LIMIT ?2)
     RETURNING id`
  ).bind(now, limit).all();
  for (const t of teams.results || []) {
    released += 1;
    const next = await promoteTeam(env, t.id);
    if (!next) continue;
    offered += 1;
    if ((await tellPromotedTeam(env, next)).ok) told += 1;
  }
  return { released, offered, told };
}

export const HOLDS_PER_RUN = 2;
// Per family: release, the event, promote (2), email (2). Per team: promote,
// the division, the event, email (2). Plus the two first statements.
export const HOLD_QUERIES = 2 + HOLDS_PER_RUN * 6 + HOLDS_PER_RUN * 5;

/**
 * After a team leaves its division (withdrew, or its payment hold lapsed):
 * the longest-waiting team takes the place, if there is room. What it owes is
 * set as for a team entered directly: held for PROMOTED_HOLD_HOURS while it
 * pays online, or owed at check-in. Returns the team moved up, or null.
 */
export async function promoteTeam(env, teamId) {
  const policy = `(SELECT CASE WHEN p.billing != 'free' AND COALESCE(p.price_cents, 0) > 0 THEN p.payment_policy END
                     FROM programs p WHERE p.id = event_teams.event_id)`;
  const hold = new Date(Date.now() + PROMOTED_HOLD_HOURS * 60 * 60 * 1000).toISOString();
  return env.DB.prepare(
    `UPDATE event_teams
        SET status = 'entered', updated_at = ?2,
            payment_state = CASE ${policy} WHEN 'online' THEN 'pending' WHEN 'at_check_in' THEN 'at_check_in' ELSE payment_state END,
            hold_expires_at = CASE WHEN ${policy} = 'online' THEN ?3 ELSE hold_expires_at END,
            amount_due_cents = CASE WHEN ${policy} IN ('online', 'at_check_in')
                                    THEN (SELECT p.price_cents FROM programs p WHERE p.id = event_teams.event_id)
                                    ELSE amount_due_cents END
      WHERE id = (SELECT w.id FROM event_teams w JOIN event_teams gone ON gone.id = ?1
                   WHERE w.group_id = gone.group_id AND w.status = 'waitlist' ORDER BY w.created_at, w.id LIMIT 1)
        AND (SELECT COUNT(*) FROM event_teams e JOIN event_teams gone ON gone.id = ?1
              WHERE e.group_id = gone.group_id AND e.status = 'entered')
            < (SELECT g.capacity FROM program_groups g JOIN event_teams gone ON gone.id = ?1 WHERE g.id = gone.group_id)
     RETURNING id, event_id, group_id, team_name, coach_email, cancel_token, payment_state, hold_expires_at`
  ).bind(teamId, iso(), hold).first();
}

/** The coach of a team moved up is told, in the event's words (EVENT_EMAILS_ENABLED only). */
export async function tellPromotedTeam(env, team) {
  const group = await env.DB.prepare(`SELECT name FROM program_groups WHERE id = ?1`).bind(team.group_id).first();
  const ev = await withEvent(env, team.event_id);
  return sendEventPlaceOpened(ev, { to: team.coach_email, name: team.team_name, session: group?.name || 'your', team: true,
    cancelToken: team.cancel_token, holdUntil: team.payment_state === 'pending' ? team.hold_expires_at : null });
}

/** A family paying for a place they were offered (a pay link): a fresh Checkout Session. */
export async function payLinkCheckout(env, { eventId, token, site }) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return { ok: false, reason: 'invalid' };
  const [reg, team] = await env.DB.batch([
    env.DB.prepare(`SELECT id FROM registrations WHERE cancel_token = ?1 AND event_id = ?2 AND payment_state = 'pending'
                     AND status = 'confirmed' AND hold_expires_at > ?3`).bind(token, eventId, iso()),
    env.DB.prepare(`SELECT id FROM event_teams WHERE cancel_token = ?1 AND event_id = ?2 AND payment_state = 'pending'
                     AND status = 'entered' AND hold_expires_at > ?3`).bind(token, eventId, iso()),
  ]);
  const r = reg.results?.[0];
  const t = team.results?.[0];
  if (!r && !t) return { ok: false, reason: 'not-payable' };
  const ev = await withEvent(env, eventId);
  return startEventCheckout(env, { kind: r ? 'registration' : 'team', id: (r || t).id, event: { id: eventId, name: ev.EVENT_LABEL }, site });
}
