/**
 * A family deleting its own data, automatically (owner, 2026-10-20): the
 * guardian who set the family up asks from the Account page; it happens
 * GRACE_DAYS later unless they cancel first or staff place a legal hold.
 *
 * ASKING (portal/privacy.js) needs a recent sign-in and the owner role. The
 * request is scheduled at once (data_requests.purge_after) and an email
 * confirms the date, so a request made from a borrowed or stolen session is
 * seen by the mailbox owner while it can still be cancelled. Every guardian
 * sees the date on the family page; only the owner can cancel.
 *
 * THE PURGE is the hourly job (jobs/runner.js), one family per run, so its
 * query count is fixed (PURGE_QUERIES) and it never shares a run with a second
 * family. It does not run while a legal hold is on the family, one of its
 * children, its CRM contact or one of its evaluation registrations; it
 * re-checks that, and that the request is still scheduled, inside the same
 * transaction that deletes (the first statement fails the batch otherwise).
 *
 * WHAT GOES: every guardian's sign-in (account, sessions, Google link, sign-in
 * links) unless they also belong to another family; the family's members,
 * invitations, emergency contacts; its children's medical answers, school,
 * grade and shirt size; places (ended or withdrawn; a Stripe subscription is
 * cancelled first, and the purge waits if that cannot be done); its CRM
 * records (anonymized, as retention does); its evaluation registrations'
 * contact, emergency and medical details, coaches' notes and feedback, and the
 * text of messages sent about them.
 *
 * WHAT STAYS, as the family is told when they ask: signed waivers
 * (consent_records, and an evaluation registration's own signed releases) and
 * payment records, with the child's name and date of birth so a waiver still
 * says whose it is. Retention (privacy/retention.js) removes those when their
 * periods end. A child with neither keeps no name at all. Donation records are
 * never touched (tax records; see governance). The account, family and child
 * rows themselves remain as empty markers ('deleted'), because the records
 * that stay point at them.
 *
 * PAYPAL cannot be cancelled from here: the family's old Join-page PayPal
 * subscriptions are listed on Admin -> Privacy, and in the daily brief, until
 * staff cancel them in PayPal and say so.
 *
 * Counts only, in the request's result_counts and the audit log.
 */

import { audit } from '../auth/staff.js';
import { stripeConfig, stripeConfigured, stripeRequest, fetchSubscription, looksLike } from '../payments/stripe.js';

export const GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN = `('received', 'verified', 'scheduled')`;
const LIVE = `('applied', 'waitlist', 'offered', 'active', 'past_due')`;
const LIVE_SUB = `('incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'paused')`;

// Every D1 statement the purge can make, including the email's budget
// reservation and refund. The job runner gives it at least this many.
export const PURGE_QUERIES = 39;

/** A legal hold touching the family a request names (`subject` is the SQL for its subject_id). */
export function heldSql(subject) {
  const players = `(SELECT p.id FROM players p WHERE CAST(p.household_id AS TEXT) = ${subject})`;
  return `EXISTS (SELECT 1 FROM legal_holds lh WHERE lh.released_at IS NULL AND (
      (lh.subject_type = 'household' AND CAST(lh.subject_id AS TEXT) = ${subject})
   OR (lh.subject_type = 'player' AND lh.subject_id IN ${players})
   OR (lh.subject_type = 'crm_contact' AND lh.subject_id IN
         (SELECT c.id FROM crm_contacts c WHERE CAST(c.household_id AS TEXT) = ${subject}))
   OR (lh.subject_type = 'registration' AND lh.subject_id IN
         (SELECT r.id FROM registrations r WHERE r.player_id IN ${players}))))`;
}

/** The family an account belongs to (its first), with its role there; null if none. */
async function membership(env, accountId) {
  return env.DB.prepare(
    `SELECT m.household_id, m.role FROM household_members m
       JOIN households h ON h.id = m.household_id AND h.status = 'active'
      WHERE m.account_id = ?1 ORDER BY m.created_at LIMIT 1`
  ).bind(accountId).first();
}

const subjectOf = (accountId, m) => (m ? String(m.household_id) : `account:${accountId}`);

/**
 * For the Account and family pages: may this account ask (or cancel), and the
 * open request for its family (or the account alone), if any.
 * @returns {Promise<{owner:boolean, pending:null|{id:number,status:string,purgeAfter:string|null}}>}
 */
export async function deletionStatus(env, accountId) {
  const m = await membership(env, accountId);
  const row = await env.DB.prepare(
    `SELECT id, status, purge_after FROM data_requests
      WHERE kind = 'deletion' AND subject_id = ?1 AND status IN ${OPEN} ORDER BY id DESC LIMIT 1`
  ).bind(subjectOf(accountId, m)).first();
  return {
    owner: !m || m.role === 'owner',
    pending: row ? { id: Number(row.id), status: row.status, purgeAfter: row.purge_after } : null,
  };
}

/** "Tuesday, October 27": the day a deletion happens, Central. */
export function deletionDay(iso) {
  return new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric' });
}

/**
 * Schedule this account's family for deletion GRACE_DAYS from now. Owner only;
 * an account with no family deletes just itself. Asking twice changes nothing.
 * @returns {Promise<{result:'scheduled'|'exists'|'not-owner', id?:number, purgeAfter?:string, subject?:string}>}
 */
export async function scheduleDeletion(env, { accountId, now = new Date() }) {
  const m = await membership(env, accountId);
  if (m && m.role !== 'owner') return { result: 'not-owner' };
  const subject = subjectOf(accountId, m);
  const purgeAfter = new Date(now.getTime() + GRACE_DAYS * DAY_MS).toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO data_requests (kind, subject_type, subject_id, requested_by, status, verification, purge_after,
                                created_at, updated_at)
     SELECT 'deletion', 'household', ?1, ?2, 'scheduled', 'recent_sign_in', ?3, ?4, ?4
      WHERE NOT EXISTS (SELECT 1 FROM data_requests WHERE kind = 'deletion' AND subject_id = ?1 AND status IN ${OPEN})
     RETURNING id`
  ).bind(subject, `account:${accountId}`, purgeAfter, now.toISOString()).first();
  if (!row) return { result: 'exists', subject };
  return { result: 'scheduled', id: Number(row.id), purgeAfter, subject };
}

/** Cancel the open request for this account's family. Owner only. */
export async function cancelDeletion(env, { accountId, now = new Date() }) {
  const m = await membership(env, accountId);
  if (m && m.role !== 'owner') return { result: 'not-owner' };
  const nowIso = now.toISOString();
  const row = await env.DB.prepare(
    `UPDATE data_requests SET status = 'cancelled', updated_at = ?3, completed_at = ?3, completed_by = ?2
      WHERE kind = 'deletion' AND subject_id = ?1 AND status IN ${OPEN}
     RETURNING id`
  ).bind(subjectOf(accountId, m), `account:${accountId}`, nowIso).first();
  return row ? { result: 'cancelled', id: Number(row.id) } : { result: 'none' };
}

/**
 * Cancel the family's live Stripe subscriptions, now. Anything we cannot
 * cancel blocks the purge: our record of a subscription still charging must
 * not be deleted out from under it.
 * @returns {Promise<{cancelled:number, blocked?:string}>}
 */
async function cancelStripe(env, subs) {
  if (!subs.length) return { cancelled: 0 };
  if (!stripeConfigured(env)) return { cancelled: 0, blocked: 'stripe-not-configured' };
  const config = stripeConfig(env);
  let cancelled = 0;
  for (const s of subs) {
    if (s.environment !== config.env || !looksLike('subscription', s.subscription_id)) {
      return { cancelled, blocked: 'stripe-other-environment' };
    }
    try {
      await stripeRequest(config, 'DELETE', `/v1/subscriptions/${s.subscription_id}`, null,
        { idempotencyKey: `family-deletion-${s.subscription_id}` });
    } catch {
      // Already cancelled (or gone) is what we wanted; anything else waits.
      let now;
      try { now = await fetchSubscription(config, s.subscription_id); } catch { now = undefined; }
      if (!(now === null || now?.status === 'canceled')) return { cancelled, blocked: 'stripe-cancel-failed' };
    }
    cancelled += 1;
  }
  return { cancelled };
}

/** The statements that delete one family, in order. `H` the family (or -1), `A` the accounts to remove. */
function purgeStatements(env, { requestId, H, A, nowIso, stripeCancelled }) {
  // Each statement binds exactly what it names: D1 refuses a statement whose
  // highest ?N differs from the number of values bound.
  const s = (sql, ...args) => env.DB.prepare(sql).bind(...args);
  const ACCTS = `(SELECT value FROM json_each(?2))`;
  const EMAILS = `(SELECT email_norm FROM accounts WHERE id IN ${ACCTS})`;
  const PLAYERS = `(SELECT id FROM players WHERE household_id = ?1 OR (household_id IS NULL AND parent_email_norm IN ${EMAILS}))`;
  const REGS = `(SELECT id FROM registrations WHERE player_id IN ${PLAYERS} OR parent_email_norm IN ${EMAILS})`;
  const CONTACTS = `(SELECT id FROM crm_contacts WHERE household_id = ?1 OR account_id IN ${ACCTS} OR email_norm IN ${EMAILS})`;
  const accts = JSON.stringify(A);
  const both = (sql) => s(sql, H, accts);
  return [
    // 0. Still scheduled and still not held, or the whole batch fails ('stop' breaks the status CHECK).
    s(`UPDATE data_requests SET status = CASE WHEN status = 'scheduled' AND NOT ${heldSql('data_requests.subject_id')}
                                          THEN 'completed' ELSE 'stop' END,
              completed_at = ?2, completed_by = 'system:deletion', updated_at = ?2
        WHERE id = ?1`, requestId, nowIso),
    // Places end (or are withdrawn); the subscriptions cancelled above are recorded as such.
    s(`UPDATE enrollments SET status = CASE WHEN status IN ('active', 'past_due') THEN 'ended' ELSE 'cancelled' END,
              ended_at = COALESCE(ended_at, ?2), updated_at = ?2
        WHERE household_id = ?1 AND status IN ${LIVE}`, H, nowIso),
    s(`UPDATE stripe_subscriptions SET status = 'canceled', cancel_at_period_end = 0, updated_at = ?2
        WHERE household_id = ?1 AND status IN ${LIVE_SUB} AND ?3 > 0`, H, nowIso, stripeCancelled),
    s(`DELETE FROM player_medical WHERE player_id IN (SELECT id FROM players WHERE household_id = ?1)`, H),
    s(`DELETE FROM household_emergency_contacts WHERE household_id = ?1`, H),
    s(`DELETE FROM household_invites WHERE household_id = ?1`, H),
    // Invitations other families sent these people, not yet accepted.
    s(`DELETE FROM household_invites WHERE invited_email_norm IN ${EMAILS.replace('?2', '?1')} AND accepted_at IS NULL`, accts),
    // Evaluations: coaches' notes and feedback, and what was sent, then the registration's details.
    both(`DELETE FROM eval_feedback WHERE registration_id IN ${REGS} OR player_id IN ${PLAYERS}`),
    both(`DELETE FROM eval_notes_internal WHERE registration_id IN ${REGS} OR player_id IN ${PLAYERS}`),
    both(`DELETE FROM parent_feedback WHERE player_id IN ${PLAYERS}
            OR parent_message_id IN (SELECT id FROM parent_messages WHERE registration_id IN ${REGS})`),
    both(`UPDATE parent_messages SET subject = '(removed)', body_html = '', body_text = '', reply_token = NULL, last_error = NULL,
                 send_state = CASE WHEN send_state IN ('draft', 'queued', 'failed') THEN 'skipped' ELSE send_state END
           WHERE registration_id IN ${REGS} OR player_id IN ${PLAYERS}`),
    both(`UPDATE registrations SET parent_name = '', parent_email = '', parent_email_norm = 'deleted:' || id, phone = '',
                 school = '', emergency_contact_name = '', emergency_contact_phone = '', medical_notes = NULL,
                 highlight_link = NULL, player_notes = NULL, ip_hash = NULL
           WHERE id IN ${REGS}`),
    // Event sign-ups that aren't a place (the Events plan): interest, and a
    // team entered by one of these guardians.
    both(`DELETE FROM event_interest WHERE parent_email_norm IN ${EMAILS} OR player_id IN ${PLAYERS}`),
    both(`DELETE FROM event_teams WHERE coach_email_norm IN ${EMAILS}`),
    // Invitations sent to these guardians keep only their hash (an unsubscribe still works).
    s(`UPDATE event_invitations SET email = NULL, email_norm = NULL, name = NULL WHERE email_norm IN ${EMAILS.replace('?2', '?1')}`, accts),
    // CRM, as retention anonymizes a lead (privacy/retention.js); contacts last, since the others find them.
    both(`UPDATE crm_prospect_players SET name = '', school = NULL, position = NULL
           WHERE contact_id IN ${CONTACTS} OR player_id IN ${PLAYERS}`),
    both(`UPDATE crm_inquiries SET fields = '{}', message = NULL, ip_hash = NULL WHERE contact_id IN ${CONTACTS} OR household_id = ?1`),
    both(`UPDATE crm_activities SET body = NULL WHERE contact_id IN ${CONTACTS} OR household_id = ?1`),
    both(`UPDATE crm_tasks SET title = '(removed)', status = CASE WHEN status = 'open' THEN 'cancelled' ELSE status END
           WHERE contact_id IN ${CONTACTS} OR household_id = ?1`),
    s(`UPDATE crm_opportunities SET closed_at = COALESCE(closed_at, ?3)
        WHERE contact_id IN ${CONTACTS} OR household_id = ?1 OR player_id IN ${PLAYERS}`, H, accts, nowIso),
    s(`DELETE FROM crm_household_meta WHERE household_id = ?1`, H),
    s(`UPDATE crm_contacts SET status = 'anonymized', name = NULL, email = NULL, email_norm = NULL, phone = NULL, phone_norm = NULL,
              organization = NULL, owner_email = NULL, household_id = NULL, account_id = NULL, updated_at = ?3
        WHERE id IN ${CONTACTS}`, H, accts, nowIso),
    // Children: a waiver or a payment keeps the name and date of birth, nothing else.
    s(`UPDATE players SET
              display_name = CASE WHEN ${KEEPS_NAME} THEN display_name ELSE '(removed)' END,
              name_norm = CASE WHEN ${KEEPS_NAME} THEN name_norm ELSE 'deleted:' || id END,
              date_of_birth = CASE WHEN ${KEEPS_NAME} THEN date_of_birth ELSE NULL END,
              parent_email_norm = 'deleted:' || id, grade = NULL, grade_level = NULL, grade_school_year = NULL,
              school = NULL, shirt_size = NULL, updated_at = ?3
        WHERE id IN ${PLAYERS}`, H, accts, nowIso),
    s(`DELETE FROM household_members WHERE household_id = ?1`, H),
    s(`UPDATE households SET status = 'deleted', display_name = NULL, updated_at = ?2 WHERE id = ?1`, H, nowIso),
    // Sign-ins, then the accounts themselves (the markers keep no email or name).
    s(`DELETE FROM sessions WHERE account_id IN ${ACCTS.replace('?2', '?1')}`, accts),
    s(`DELETE FROM account_identities WHERE account_id IN ${ACCTS.replace('?2', '?1')}`, accts),
    s(`DELETE FROM auth_login_tokens WHERE email_norm IN ${EMAILS.replace('?2', '?1')}`, accts),
    s(`UPDATE accounts SET status = 'deleted', email = '', email_norm = 'deleted:' || id, display_name = NULL,
              last_login_at = NULL, updated_at = ?2
        WHERE id IN ${ACCTS.replace('?2', '?1')}`, accts, nowIso),
  ];
}

// A child whose name a kept record still needs: a signed waiver, an
// evaluation registration (its own signed releases), or a payment.
const KEEPS_NAME = `(EXISTS (SELECT 1 FROM consent_records c WHERE c.player_id = players.id)
  OR EXISTS (SELECT 1 FROM registrations r WHERE r.player_id = players.id)
  OR EXISTS (SELECT 1 FROM payments pay JOIN enrollments e ON e.id = pay.enrollment_id WHERE e.player_id = players.id))`;

// Which statement's changes each count reports (by position in purgeStatements).
const COUNTS = {
  places: 1, medical: 3, emergencyContacts: 4, evaluationNotes: 8, registrations: 11, eventInterest: 12, eventTeams: 13,
  invitations: 14, crmContacts: 21, children: 22, guardians: 23, sessions: 25, accounts: 28,
};

/**
 * The hourly job: delete the next family whose grace period is over.
 * `send` emails the guardian who asked (email.js sendDeletionDone).
 * @returns {Promise<{result:'none'|'blocked'|'skipped'|'deleted', reason?:string, counts?:object}>}
 */
export async function purgeNext(env, { now = new Date(), send = null } = {}) {
  const nowIso = now.toISOString();
  const req = await env.DB.prepare(
    `SELECT r.id, r.subject_id, r.requested_by FROM data_requests r
      WHERE r.kind = 'deletion' AND r.status = 'scheduled' AND r.purge_after IS NOT NULL AND r.purge_after <= ?1
        AND NOT ${heldSql('r.subject_id')}
      ORDER BY r.updated_at LIMIT 1`
  ).bind(nowIso).first();
  if (!req) return { result: 'none' };

  const requestId = Number(req.id);
  const H = /^\d{1,12}$/.test(req.subject_id) ? Number(req.subject_id) : -1;
  const own = /^account:(\d{1,12})$/.exec(req.subject_id);
  const requester = /^account:(\d{1,12})$/.exec(req.requested_by);
  const [members, asker, subs, paypalJoin, paypalApi] = await env.DB.batch([
    // Who goes: each guardian, unless they also belong to another family.
    env.DB.prepare(
      `SELECT m.account_id, EXISTS (SELECT 1 FROM household_members o JOIN households oh ON oh.id = o.household_id
                                     WHERE o.account_id = m.account_id AND o.household_id != ?1 AND oh.status = 'active') AS elsewhere
         FROM household_members m WHERE m.household_id = ?1`
    ).bind(H),
    env.DB.prepare(`SELECT email FROM accounts WHERE id = ?1 AND status = 'active'`).bind(requester ? Number(requester[1]) : -1),
    env.DB.prepare(`SELECT subscription_id, environment FROM stripe_subscriptions WHERE household_id = ?1 AND status IN ${LIVE_SUB}`).bind(H),
    env.DB.prepare(
      `SELECT outside_reference FROM enrollments
        WHERE household_id = ?1 AND billed_outside = 'paypal_join' AND paypal_cancelled_at IS NULL AND outside_reference IS NOT NULL`
    ).bind(H),
    env.DB.prepare(
      `SELECT paypal_subscription_id FROM billing_subscriptions WHERE household_id = ?1 AND status NOT IN ('CANCELLED', 'EXPIRED')`
    ).bind(H),
  ]);
  const A = own
    ? [Number(own[1])]
    : (members.results || []).filter((m) => !Number(m.elsewhere)).map((m) => Number(m.account_id));
  const to = asker.results?.[0]?.email || null;
  const paypal = [...(paypalJoin.results || []).map((r) => r.outside_reference),
    ...(paypalApi.results || []).map((r) => r.paypal_subscription_id)];

  const stripe = await cancelStripe(env, subs.results || []);
  if (stripe.blocked) {
    // Waits, and goes to the back of the queue; staff see why on Admin -> Privacy.
    await env.DB.prepare(`UPDATE data_requests SET result_counts = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'scheduled'`)
      .bind(requestId, JSON.stringify({ blocked: stripe.blocked, stripe_cancelled: stripe.cancelled }), nowIso).run();
    return { result: 'blocked', reason: stripe.blocked };
  }

  let out;
  try {
    out = await env.DB.batch(purgeStatements(env, { requestId, H, A, nowIso, stripeCancelled: stripe.cancelled }));
  } catch (err) {
    // Cancelled or held in the moment since the read: nothing was changed.
    console.error(JSON.stringify({ event: 'deletion_stopped', request: requestId, message: String(err?.message || '').slice(0, 120) }));
    return { result: 'skipped' };
  }
  const counts = Object.fromEntries(Object.entries(COUNTS).map(([k, i]) => [k, out[i]?.meta?.changes || 0]));
  counts.stripeCancelled = stripe.cancelled;
  counts.paypalToCancel = paypal.length;

  const mail = to && send ? await send(env, { to }) : null;
  counts.emailed = Boolean(mail?.ok);
  await env.DB.prepare(`UPDATE data_requests SET result_counts = ?2 WHERE id = ?1`)
    .bind(requestId, JSON.stringify({ ...counts, paypal_to_cancel: paypal })).run();
  await audit(env, { actor: 'system', action: 'privacy.deleted', subjectType: 'data_request', subjectId: requestId, detail: counts });
  return { result: 'deleted', counts };
}

/** Admin -> Privacy: deleted families whose old PayPal subscription is still to be cancelled by hand. */
export async function deletedFamiliesPaypal(env) {
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.outside_reference, e.household_id FROM enrollments e
       JOIN households h ON h.id = e.household_id AND h.status = 'deleted'
      WHERE e.billed_outside = 'paypal_join' AND e.paypal_cancelled_at IS NULL AND e.outside_reference IS NOT NULL
      ORDER BY e.id`
  ).all();
  return results || [];
}
