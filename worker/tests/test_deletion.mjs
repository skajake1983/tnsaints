/**
 * A family deleting its own data (src/privacy/deletion.js), against real SQL
 * on Node's SQLite, with the clock moved past the grace period.
 *
 * Proved: only the owner may ask or cancel; nothing happens before the grace
 * period ends, or while a legal hold is on the family or one of its children,
 * or while a Stripe subscription cannot be cancelled; then one run cancels
 * Stripe billing and removes every guardian's sign-in, the children's
 * details, medical answers, emergency contacts, invitations, CRM and
 * evaluation details — and keeps the signed waivers and payments, with the
 * child's name and date of birth only; a guardian who also belongs to another
 * family keeps their account; another family is untouched; old PayPal
 * subscriptions are listed for staff; counts only are recorded; it fits its
 * query budget; every statement binds exactly what it names (D1's rule).
 *
 *   node --no-warnings tests/test_deletion.mjs
 */
import { fakeD1, checker } from './_d1_fake.mjs';
import { meteredDb } from '../src/jobs/runner.js';
import {
  scheduleDeletion, cancelDeletion, deletionStatus, purgeNext, deletedFamiliesPaypal, PURGE_QUERIES, GRACE_DAYS,
} from '../src/privacy/deletion.js';

const check = checker();
const T0 = new Date('2026-10-20T15:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const later = (days) => new Date(T0.getTime() + days * DAY);
const HASH = 'a'.repeat(64);
const DB = fakeD1();
const run = (sql, ...a) => DB.raw.prepare(sql).run(...a);
const get = (sql, ...a) => DB.raw.prepare(sql).get(...a);
const all = (sql, ...a) => DB.raw.prepare(sql).all(...a);
const id = (r) => Number(r.lastInsertRowid);
const at = T0.toISOString();

// D1 refuses a statement whose highest ?N differs from the values bound. The
// fake does not, so this does, for every statement the code prepares.
const misbound = [];
const strict = (db) => ({
  ...db,
  prepare: (sql) => {
    const highest = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
    const guard = (st) => ({
      ...st,
      bind: (...args) => {
        if (args.length !== highest) misbound.push({ sql: sql.replace(/\s+/g, ' ').slice(0, 90), highest, bound: args.length });
        return guard(st.bind(...args));
      },
    });
    return guard(db.prepare(sql));
  },
});

// Stripe, stood in for: DELETE /v1/subscriptions/:id cancels.
const stripeCalls = [];
let stripeFails = false;
globalThis.fetch = async (url, init = {}) => {
  stripeCalls.push(`${init.method || 'GET'} ${new URL(url).pathname}`);
  if (stripeFails) return new Response(JSON.stringify({ error: { type: 'api_error' } }), { status: 500 });
  const sub = new URL(url).pathname.split('/').pop();
  return new Response(JSON.stringify({ id: sub, object: 'subscription', status: 'canceled' }), { status: 200 });
};
const STRIPE = { STRIPE_SECRET_KEY_SANDBOX: 'sk_test_abcdefgh12345678', STRIPE_API_BASE: 'http://127.0.0.1:9' };

const sent = [];
const send = async (_env, msg) => { sent.push(msg); return { ok: true }; };
const envWith = (extra = {}, budget = null) => {
  const db = strict(DB);
  return { ...extra, DB: budget ? meteredDb(db, budget) : db };
};

// --- fixtures ------------------------------------------------------------------------
const acct = (email) => id(run(`INSERT INTO accounts (email, email_norm, display_name, created_at, updated_at, last_login_at)
  VALUES (?, ?, 'Name ' || ?, ?, ?, ?)`, email, email.toLowerCase(), email, at, at, at));
const household = (name) => id(run(`INSERT INTO households (display_name, created_at, updated_at) VALUES (?, ?, ?)`, name, at, at));
const member = (h, a, role) => run(`INSERT INTO household_members (household_id, account_id, role, phone, created_at)
  VALUES (?, ?, ?, '615-555-0100', ?)`, h, a, role, at);
const child = (name, h, email, dob) => id(run(`INSERT INTO players (display_name, name_norm, parent_email_norm, household_id,
  date_of_birth, grade_level, grade_school_year, school, shirt_size, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, 4, 2026, 'CANARY School', 'YM', ?, ?)`, name, name.toLowerCase(), email, h, dob, at, at));
run(`INSERT INTO waiver_versions (id, legal_entity, title, body_text, body_sha256, effective_at, created_at)
     VALUES ('w1', 'Saints LLC', 'Waiver', 'text', ?, ?, ?)`, HASH, at, at);
run(`INSERT INTO program_groups (program_id, name, schedule_summary, capacity, created_at, updated_at)
     VALUES ('academy', 'Tuesday group', 'Tuesdays', 10, ?, ?)`, at, at);
const GROUP = get(`SELECT id FROM program_groups`).id;
const consent = (p, h, a) => id(run(`INSERT INTO consent_records (player_id, household_id, account_id, program_id,
  waiver_version_id, waiver_sha256, signature, signer_relationship, esign_consent, assumption_of_risk, medical_release,
  photo_release, signed_at) VALUES (?, ?, ?, 'academy', 'w1', ?, 'Ann Owner', 'Mother', 1, 1, 1, 0, ?)`, p, h, a, HASH, at));
const place = (p, h, c, extra = {}) => id(run(`INSERT INTO enrollments (ref, player_id, household_id, program_id, group_id, status,
  consent_record_id, applied_at, created_by, created_at, updated_at, billed_outside, outside_reference)
  VALUES (?, ?, ?, 'academy', ?, 'active', ?, ?, 'test', ?, ?, ?, ?)`, `ref-${p}-xxxxxxxxxxxx`, p, h, GROUP, c, at, at, at,
  extra.billed || null, extra.ref || null));

// The family that leaves: an owner, a co-guardian, and a guardian who also belongs to another family.
const OWNER = acct('owner@example.com');
const CO = acct('co@example.com');
const BOTH = acct('both@example.com');
const H = household('The Leaving family');
member(H, OWNER, 'owner');
member(H, CO, 'guardian');
member(H, BOTH, 'guardian');
const OTHER_H = household('The Staying family');
const STAY = acct('stay@example.com');
member(OTHER_H, STAY, 'owner');
member(OTHER_H, BOTH, 'guardian');

const KEPT = child('Kim Kept', H, 'owner@example.com', '2016-05-05'); // signed a waiver, paid
const GONE = child('Gus Gone', H, 'owner@example.com', '2018-06-06'); // nothing that must stay
const STAY_KID = child('Sam Stay', OTHER_H, 'stay@example.com', '2015-01-01');
// A past evaluation under the owner's email, never claimed into the family.
const UNCLAIMED = id(run(`INSERT INTO players (display_name, name_norm, parent_email_norm, created_at, updated_at)
  VALUES ('Una Unclaimed', 'una unclaimed', 'owner@example.com', ?, ?)`, at, at));
const c1 = consent(KEPT, H, OWNER);
const PLACE = place(KEPT, H, c1, { billed: 'paypal_join', ref: 'I-PAYPALJOIN01' });
run(`INSERT INTO payments (paypal_transaction_id, environment, enrollment_id, household_id, amount_cents, currency, kind, status,
  paid_at, created_at) VALUES ('TXN1', 'live', ?, ?, 4000, 'USD', 'setup_fee', 'completed', ?, ?)`, PLACE, H, at, at);
run(`INSERT INTO programs (id, name, kind, billing, created_at, updated_at) VALUES ('camp', 'Camp', 'camp', 'free', ?, ?)`, at, at);
run(`INSERT INTO enrollments (ref, player_id, household_id, program_id, status, applied_at, created_by, created_at, updated_at)
  VALUES ('ref-gone-xxxxxxxxxxxx', ?, ?, 'camp', 'applied', ?, 'test', ?, ?)`, GONE, H, at, at, at);
run(`INSERT INTO stripe_subscriptions (subscription_id, environment, enrollment_id, household_id, status, created_at, updated_at)
  VALUES ('sub_LEAVING0001', 'sandbox', ?, ?, 'active', ?, ?)`, PLACE, H, at, at);
for (const p of [KEPT, GONE, STAY_KID]) {
  run(`INSERT INTO player_medical (player_id, status, notes, updated_by, updated_at, confirmed_at)
       VALUES (?, 'declared', 'MEDICAL-CANARY', 'account:1', ?, ?)`, p, at, at);
}
run(`INSERT INTO household_emergency_contacts (household_id, priority, name, phone, created_at, updated_at)
     VALUES (?, 1, 'Grandma CANARY', '615-555-0111', ?, ?), (?, 1, 'Stay contact', '615-555-0112', ?, ?)`, H, at, at, OTHER_H, at, at);
run(`INSERT INTO household_invites (token_hash, household_id, invited_email_norm, invited_by_account_id, created_at, expires_at)
     VALUES ('inv-own', ?, 'aunt@example.com', ?, ?, ?), ('inv-to-co', ?, 'co@example.com', ?, ?, ?)`,
  H, OWNER, at, at, OTHER_H, STAY, at, at);
for (const a of [OWNER, CO, BOTH, STAY]) {
  run(`INSERT INTO sessions (id_hash, account_id, auth_method, auth_at, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
       VALUES (?, ?, 'email', ?, ?, ?, '2099-01-01', '2099-01-01')`, `s-${a}`, a, at, at, at);
}
run(`INSERT INTO account_identities (account_id, provider, subject, created_at) VALUES (?, 'google', 'g-owner', ?)`, OWNER, at);
run(`INSERT INTO auth_login_tokens (token_hash, email_norm, purpose, created_at, expires_at) VALUES ('t-owner', 'owner@example.com',
  'login', ?, '2099-01-01')`, at);
// The CRM knew them as a lead first.
const LEAD = id(run(`INSERT INTO crm_contacts (kind, name, email, email_norm, phone, source, household_id, account_id, status,
  created_at, updated_at) VALUES ('family', 'Ann CANARY', 'owner@example.com', 'owner@example.com', '615', 'website:player', ?, ?,
  'converted', ?, ?)`, H, OWNER, at, at));
const STAY_LEAD = id(run(`INSERT INTO crm_contacts (kind, name, email, email_norm, source, household_id, status, created_at,
  updated_at) VALUES ('family', 'Stay Lead', 'stay@example.com', 'stay@example.com', 'website:player', ?, 'converted', ?, ?)`,
  OTHER_H, at, at));
run(`INSERT INTO crm_inquiries (contact_id, purpose, fields, message, received_at, status) VALUES (?, 'player', '{"x":"CANARY"}',
  'CANARY message', ?, 'new')`, LEAD, at);
run(`INSERT INTO crm_tasks (title, status, origin, contact_id, created_by, created_at) VALUES ('Call Ann CANARY', 'open', 'manual', ?,
  'staff', ?)`, LEAD, at);
run(`INSERT INTO crm_activities (kind, body, contact_id, actor, occurred_at, created_at) VALUES ('note', 'CANARY note', ?, 'staff', ?, ?)`,
  LEAD, at, at);
run(`INSERT INTO crm_prospect_players (contact_id, name, school, created_at, updated_at) VALUES (?, 'Kim CANARY', 'CANARY', ?, ?)`,
  LEAD, at, at);
// A past evaluation: the registration, a coach's notes, the message sent, and the parent's reply.
const REG = id(run(`INSERT INTO registrations (event_id, session_time, status, cancel_token, player_name, player_name_norm, grade,
  parent_name, parent_email, parent_email_norm, phone, school, emergency_contact_name, emergency_contact_phone, medical_notes,
  assumption_of_risk, medical_release, photo_release, signature, signed_at, created_at, player_id)
  VALUES ('2026-08-29-evaluation', '9:00 AM', 'confirmed', 'tok-kept', 'Kim Kept', 'kim kept', '4th', 'Ann CANARY',
  'owner@example.com', 'owner@example.com', '615-CANARY', 'CANARY School', 'EC CANARY', '615', 'EVAL-MEDICAL-CANARY', 1, 1, 1,
  'Ann Owner', ?, ?, ?)`, at, at, KEPT));
const REG_UNCLAIMED = id(run(`INSERT INTO registrations (event_id, session_time, status, cancel_token, player_name, player_name_norm,
  grade, parent_name, parent_email, parent_email_norm, phone, school, emergency_contact_name, emergency_contact_phone,
  assumption_of_risk, medical_release, photo_release, signature, signed_at, created_at, player_id)
  VALUES ('2025-08-29-evaluation', '9:00 AM', 'confirmed', 'tok-una', 'Una Unclaimed', 'una unclaimed', '3rd', 'Ann CANARY',
  'owner@example.com', 'owner@example.com', '615-CANARY', 'CANARY', 'EC CANARY', '615', 1, 1, 1, 'Ann Owner', ?, ?, ?)`,
  at, at, UNCLAIMED));
run(`INSERT INTO eval_feedback (player_id, registration_id, event_id, author_email, author_label, strengths, created_at, updated_at)
     VALUES (?, ?, '2026-08-29-evaluation', 'coach@example.com', 'Coach', 'CANARY strengths', ?, ?)`, KEPT, REG, at, at);
run(`INSERT INTO eval_notes_internal (player_id, registration_id, event_id, author_email, body, created_at, updated_at)
     VALUES (?, ?, '2026-08-29-evaluation', 'coach@example.com', 'CANARY internal', ?, ?)`, KEPT, REG, at, at);
const MSG = id(run(`INSERT INTO parent_messages (player_id, registration_id, event_id, kind, subject, body_html, body_text, send_state,
  send_attempts, created_by, created_at) VALUES (?, ?, '2026-08-29-evaluation', 'decision', 'About Kim CANARY', '<p>CANARY</p>',
  'CANARY', 'queued', 0, 'staff', ?)`, KEPT, REG, at));
run(`INSERT INTO parent_feedback (player_id, parent_message_id, body, rating, created_at) VALUES (?, ?, 'CANARY reply', 5, ?)`,
  KEPT, MSG, at);

// --- asking --------------------------------------------------------------------------
console.log('\n=== asking, and changing your mind ===');
let r = await scheduleDeletion(envWith(), { accountId: CO, now: T0 });
check('a co-guardian cannot ask', r.result === 'not-owner' && !get(`SELECT 1 FROM data_requests`), r);
r = await scheduleDeletion(envWith(), { accountId: OWNER, now: T0 });
const due = new Date(T0.getTime() + GRACE_DAYS * DAY).toISOString();
check('the owner can: scheduled for 7 days later', r.result === 'scheduled' && r.purgeAfter === due && r.subject === String(H), r);
r = await scheduleDeletion(envWith(), { accountId: OWNER, now: T0 });
check('asking again changes nothing', r.result === 'exists' && all(`SELECT 1 FROM data_requests`).length === 1, r);
let st = await deletionStatus(envWith(), CO);
check('every guardian sees the date; only the owner may cancel',
  st.pending?.purgeAfter === due && st.owner === false && (await deletionStatus(envWith(), OWNER)).owner === true, st);
check('a co-guardian cannot cancel', (await cancelDeletion(envWith(), { accountId: CO, now: T0 })).result === 'not-owner'
  && get(`SELECT status FROM data_requests`).status === 'scheduled');
r = await cancelDeletion(envWith(), { accountId: OWNER, now: T0 });
check('the owner can cancel, by whom recorded', r.result === 'cancelled'
  && get(`SELECT status, completed_by FROM data_requests`).completed_by === `account:${OWNER}`, r);
check('then nothing is pending', (await deletionStatus(envWith(), OWNER)).pending === null);
r = await scheduleDeletion(envWith(), { accountId: OWNER, now: T0 });
check('and they can ask again', r.result === 'scheduled', r);
const REQ = r.id;

// --- waiting ---------------------------------------------------------------------------
console.log('\n=== nothing happens early, or while held, or while Stripe cannot cancel ===');
r = await purgeNext(envWith(STRIPE), { now: later(GRACE_DAYS - 0.01), send });
check('before the grace period ends: nothing', r.result === 'none' && stripeCalls.length === 0, r);
run(`INSERT INTO legal_holds (subject_type, subject_id, reason, placed_by, placed_at) VALUES ('player', ?, 'Insurance claim', 'staff', ?)`,
  GONE, at);
r = await purgeNext(envWith(STRIPE), { now: later(GRACE_DAYS + 0.01), send });
check('a legal hold on one child stops it', r.result === 'none' && stripeCalls.length === 0
  && get(`SELECT status FROM households WHERE id = ?`, H).status === 'active', r);
run(`UPDATE legal_holds SET released_at = ?, released_by = 'staff'`, at);
r = await purgeNext(envWith(), { now: later(GRACE_DAYS + 0.01), send });
check('with no Stripe key, a live Stripe subscription makes it wait, changing nothing', r.result === 'blocked'
  && r.reason === 'stripe-not-configured' && get(`SELECT status FROM accounts WHERE id = ?`, OWNER).status === 'active'
  && JSON.parse(get(`SELECT result_counts FROM data_requests WHERE id = ?`, REQ).result_counts).blocked === 'stripe-not-configured', r);
stripeFails = true;
r = await purgeNext(envWith(STRIPE), { now: later(GRACE_DAYS + 0.02), send });
check('if Stripe will not cancel, it waits too', r.result === 'blocked' && r.reason === 'stripe-cancel-failed'
  && get(`SELECT status FROM enrollments WHERE id = ?`, PLACE).status === 'active', r);
stripeFails = false;
stripeCalls.length = 0;

// --- the purge ---------------------------------------------------------------------------
console.log('\n=== then one run deletes the family ===');
const budget = { used: 0, limit: 45 };
r = await purgeNext(envWith(STRIPE, budget), { now: later(GRACE_DAYS + 0.03), send });
check('deleted', r.result === 'deleted', r);
check(`within its declared query count (${PURGE_QUERIES})`, budget.used <= PURGE_QUERIES, budget);
check('Stripe billing was cancelled first, and recorded', stripeCalls.includes('DELETE /v1/subscriptions/sub_LEAVING0001')
  && get(`SELECT status FROM stripe_subscriptions`).status === 'canceled', stripeCalls);
check('the request is completed by the system, with counts only',
  (() => { const q = get(`SELECT status, completed_by, result_counts FROM data_requests WHERE id = ?`, REQ);
    const c = JSON.parse(q.result_counts);
    return q.status === 'completed' && q.completed_by === 'system:deletion' && c.accounts === 2 && c.places === 2
      && !/example\.com|CANARY|Kim|Ann/.test(q.result_counts); })(), get(`SELECT result_counts FROM data_requests WHERE id = ?`, REQ));
check('the owner is told, at the address they asked from', sent.length === 1 && sent[0].to === 'owner@example.com', sent);

const acc = (a) => get(`SELECT status, email, email_norm, display_name, last_login_at FROM accounts WHERE id = ?`, a);
check('the owner and co-guardian accounts are empty markers',
  [OWNER, CO].every((a) => acc(a).status === 'deleted' && acc(a).email === '' && acc(a).email_norm === `deleted:${a}`
    && acc(a).display_name === null), [acc(OWNER), acc(CO)]);
check('a guardian who also belongs to another family keeps their account and that family',
  acc(BOTH).status === 'active' && get(`SELECT 1 AS x FROM household_members WHERE account_id = ? AND household_id = ?`, BOTH, OTHER_H)
  && !get(`SELECT 1 FROM household_members WHERE household_id = ?`, H), acc(BOTH));
check('their sessions, Google link and sign-in links are gone; the staying guardian keeps theirs',
  all(`SELECT account_id FROM sessions ORDER BY account_id`).map((x) => x.account_id).join() === [BOTH, STAY].sort((a, b) => a - b).join()
  && !get(`SELECT 1 FROM account_identities`) && !get(`SELECT 1 FROM auth_login_tokens`));
check('the family is an empty marker', (() => { const h = get(`SELECT status, display_name FROM households WHERE id = ?`, H);
  return h.status === 'deleted' && h.display_name === null; })());
check('emergency contacts and invitations (theirs, and others\' to them) are gone; the other family keeps its own',
  !get(`SELECT 1 FROM household_emergency_contacts WHERE household_id = ?`, H) && !get(`SELECT 1 FROM household_invites`)
  && get(`SELECT name FROM household_emergency_contacts WHERE household_id = ?`, OTHER_H)?.name === 'Stay contact');
check('medical answers are gone, except the other family\'s',
  all(`SELECT player_id FROM player_medical`).map((x) => x.player_id).join() === String(STAY_KID));
const kid = (p) => get(`SELECT display_name, name_norm, date_of_birth, parent_email_norm, school, shirt_size, grade_level FROM players
  WHERE id = ?`, p);
check('a child with a waiver keeps only their name and date of birth', (() => { const k = kid(KEPT);
  return k.display_name === 'Kim Kept' && k.date_of_birth === '2016-05-05' && k.school === null && k.shirt_size === null
    && k.grade_level === null && k.parent_email_norm === `deleted:${KEPT}`; })(), kid(KEPT));
check('a child with nothing that must stay keeps no name at all', (() => { const k = kid(GONE);
  return k.display_name === '(removed)' && k.name_norm === `deleted:${GONE}` && k.date_of_birth === null; })(), kid(GONE));
check('an evaluation child never claimed into the family, found by the email, loses the email',
  kid(UNCLAIMED).parent_email_norm === `deleted:${UNCLAIMED}`, kid(UNCLAIMED));
check('the other family\'s child is untouched', kid(STAY_KID).school === 'CANARY School' && kid(STAY_KID).parent_email_norm === 'stay@example.com');
check('the signed waiver and the payment stay', get(`SELECT signature FROM consent_records WHERE id = ?`, c1)?.signature === 'Ann Owner'
  && get(`SELECT amount_cents FROM payments`)?.amount_cents === 4000);
check('places end (or are withdrawn)', all(`SELECT status FROM enrollments WHERE household_id = ? ORDER BY id`, H).map((x) => x.status).join()
  === 'ended,cancelled', all(`SELECT status FROM enrollments WHERE household_id = ?`, H));
const reg = (x) => get(`SELECT * FROM registrations WHERE id = ?`, x);
check('evaluation registrations keep the child and the signed releases, and lose every contact and medical detail',
  [REG, REG_UNCLAIMED].every((x) => { const g = reg(x);
    return g.player_name && g.signature === 'Ann Owner' && g.parent_name === '' && g.parent_email === '' && g.phone === ''
      && g.emergency_contact_name === '' && g.medical_notes === null && g.parent_email_norm === `deleted:${x}`; }), reg(REG));
check('coaches\' notes and feedback, and the parent\'s reply, are gone',
  !get(`SELECT 1 FROM eval_feedback`) && !get(`SELECT 1 FROM eval_notes_internal`) && !get(`SELECT 1 FROM parent_feedback`));
check('a message about them is emptied, and a queued one will never send',
  (() => { const m = get(`SELECT subject, body_text, send_state FROM parent_messages WHERE id = ?`, MSG);
    return m.subject === '(removed)' && m.body_text === '' && m.send_state === 'skipped'; })());
check('the CRM contact is anonymized and unlinked, its inquiry, note, task and prospect emptied',
  (() => { const c = get(`SELECT status, name, email_norm, household_id, account_id FROM crm_contacts WHERE id = ?`, LEAD);
    return c.status === 'anonymized' && c.name === null && c.email_norm === null && c.household_id === null && c.account_id === null
      && get(`SELECT message FROM crm_inquiries`).message === null && get(`SELECT body FROM crm_activities`).body === null
      && get(`SELECT title, status FROM crm_tasks`).status === 'cancelled' && get(`SELECT name FROM crm_prospect_players`).name === ''; })());
check('the other family\'s CRM contact is untouched', get(`SELECT name FROM crm_contacts WHERE id = ?`, STAY_LEAD).name === 'Stay Lead');
const leftovers = all(`SELECT 'medical' AS t, notes AS v FROM player_medical WHERE player_id != ?
  UNION ALL SELECT 'crm', name FROM crm_contacts WHERE id = ?
  UNION ALL SELECT 'reg', medical_notes FROM registrations
  UNION ALL SELECT 'msg', body_html FROM parent_messages`, STAY_KID, LEAD).filter((x) => /CANARY/.test(String(x.v)));
check('no CANARY text left anywhere it was', leftovers.length === 0, leftovers);
check('the old PayPal subscription is listed for staff to cancel',
  (await deletedFamiliesPaypal(envWith())).map((p) => p.outside_reference).join() === 'I-PAYPALJOIN01'
  && JSON.parse(get(`SELECT result_counts FROM data_requests WHERE id = ?`, REQ).result_counts).paypal_to_cancel.join() === 'I-PAYPALJOIN01');
check('audited with counts only', (() => { const a = get(`SELECT actor, detail FROM audit_log WHERE action = 'privacy.deleted'`);
  return a && a.actor === 'system' && !/example\.com|CANARY|Kim/.test(a.detail); })());
r = await purgeNext(envWith(STRIPE), { now: later(GRACE_DAYS + 1), send });
check('a second run finds nothing more', r.result === 'none' && sent.length === 1, r);
check('every statement bound exactly what it named', misbound.length === 0, misbound.slice(0, 3));

// --- an account with no family ---------------------------------------------------------
console.log('\n=== an account that never set up a family ===');
const LONE = acct('lone@example.com');
run(`INSERT INTO sessions (id_hash, account_id, auth_method, auth_at, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
     VALUES ('s-lone', ?, 'email', ?, ?, ?, '2099-01-01', '2099-01-01')`, LONE, at, at, at);
r = await scheduleDeletion(envWith(), { accountId: LONE, now: T0 });
check('can ask, for the account alone', r.result === 'scheduled' && r.subject === `account:${LONE}`, r);
r = await purgeNext(envWith(STRIPE), { now: later(GRACE_DAYS + 2), send });
check('and is deleted, without touching anyone else', r.result === 'deleted' && acc(LONE).status === 'deleted'
  && !get(`SELECT 1 FROM sessions WHERE account_id = ?`, LONE) && acc(STAY).status === 'active', r);
check('still binding exactly', misbound.length === 0, misbound.slice(0, 3));

check.finish();
