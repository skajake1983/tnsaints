/**
 * Invitations' and event payments' switches and timing, on Node's SQLite
 * (src/events/invitations.js, src/events/payments.js).
 *
 * Proved:
 * - with INVITES_ENABLED not "true" nothing is sent, even approved and queued
 *   (the owner, 2026-10-21: no email without approval — and the switch);
 * - without the academy's mailing address an invitation cannot be approved,
 *   and nothing would send;
 * - an unpaid hold that lapses gives its place back, and the next family
 *   waiting is offered it with a pay hold (48 hours), never a free place;
 * - a held team entry that lapses is withdrawn, and a waiting team moved up
 *   owes the fee (held 48 hours online, or at check-in), never a free place;
 * - a family or team moved up is emailed ONLY with EVENT_EMAILS_ENABLED, in
 *   the event's own words, with a pay link to its own held place when paid;
 * - every statement binds exactly what it names (D1's rule).
 *
 *   node --no-warnings tests/test_events_more.mjs
 */
import { fakeD1, checker } from './_d1_fake.mjs';
import { approveCampaign, drainInvitations } from '../src/events/invitations.js';
import { expireEventHolds } from '../src/events/payments.js';
import worker from '../src/index.js';

const check = checker();
const DB = fakeD1();
const run = (sql, ...a) => DB.raw.prepare(sql).run(...a);
const get = (sql, ...a) => DB.raw.prepare(sql).get(...a);
const all = (sql, ...a) => DB.raw.prepare(sql).all(...a);

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

const sent = [];
const mail = []; // what each email said
globalThis.fetch = async (url, init = {}) => {
  sent.push(String(url));
  try { mail.push(JSON.parse(init.body || '{}')); } catch { mail.push({}); }
  return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
};

const PAST = '2020-01-01T00:00:00.000Z';
run(`INSERT INTO waiver_versions (id, legal_entity, title, body_text, body_sha256, effective_at, created_at)
     VALUES ('w1', 'Saints LLC', 'Waiver', 'text', ?, 'n', 'n')`, 'a'.repeat(64));
const event = (id, policy) => {
  run(`INSERT INTO programs (id, kind, event_kind, name, status, enrollment_mode, billing, price_cents, grade_min, grade_max,
       waiver_version_id, public, registration_closes_at, waitlist_enabled, created_at, updated_at, signup_mode, starts_on,
       payment_policy) VALUES (?, 'camp', 'camp', ?, 'open', 'approval', 'one_time', 7500, 3, 8, 'w1', 1,
       '2099-01-01T00:00:00.000Z', 1, 'n', 'n', 'spot', '2099-02-01', ?)`, id, `Camp ${id}`, policy);
  run(`INSERT INTO program_groups (program_id, name, schedule_summary, start_time, starts_on, capacity, status, created_at, updated_at)
       VALUES (?, 'Morning', 'Morning', '09:00', '2099-02-01', 1, 'active', 'n', 'n')`, id);
};
const reg = (event, name, status, state, hold) => run(`INSERT INTO registrations (event_id, session_time, status, cancel_token,
  player_name, player_name_norm, grade, parent_name, parent_email, parent_email_norm, phone, school, emergency_contact_name,
  emergency_contact_phone, assumption_of_risk, medical_release, photo_release, signature, signed_at, created_at, payment_state,
  hold_expires_at, amount_due_cents) VALUES (?, 'Morning', ?, ?, ?, ?, '5th', 'P', ?, ?, '615', '', 'E', '615', 1, 1, 0, 'P', 'n',
  ?, ?, ?, 7500)`, event, status, name.padEnd(64, '0').slice(0, 64), name, name, `${name}@example.com`, `${name}@example.com`,
  `2026-01-0${status === 'waitlist' ? 2 : 1}T00:00:00.000Z`, state, hold);

console.log('\n=== invitations: approval and the switch ===');
event('2099-02-01-camp', 'online');
run(`INSERT INTO invite_campaigns (event_id, subject, message, audience, status, created_by, created_at)
     VALUES ('2099-02-01-camp', 'Come to camp', 'Hello', '{}', 'draft', 'staff', 'n')`);
run(`INSERT INTO event_invitations (campaign_id, event_id, email, email_norm, email_hash, name, token, send_state, created_at, updated_at)
     VALUES (1, '2099-02-01-camp', 'a@example.com', 'a@example.com', 'h1', 'Ann', 'tok-aaaaaaaaaaaaaaaaaaaaaaaa', 'held', 'n', 'n')`);
const env = { DB: strict(DB), RESEND_API_KEY: 're_test', NOTIFY_EMAIL_FROM: 'Saints <noreply@tnsaints.com>', NOTIFY_EMAIL_TO: 'staff@tnsaints.com' };
check('without the mailing address it cannot be approved', (await approveCampaign(env, '2099-02-01-camp', 1, 'staff')) === 'needs-address'
  && get(`SELECT status FROM invite_campaigns WHERE id = 1`).status === 'draft');
const withAddress = { ...env, MAILING_ADDRESS: 'PO Box 1, Franklin, TN 37064' };
check('with it, approval queues the invitations', (await approveCampaign(withAddress, '2099-02-01-camp', 1, 'staff')) === 'approved'
  && get(`SELECT send_state FROM event_invitations WHERE id = 1`).send_state === 'queued');
let r = await drainInvitations(withAddress, { limit: 10 });
check('approved and queued, but INVITES_ENABLED is off: nothing is sent', r.skipped === 'disabled' && sent.length === 0
  && get(`SELECT send_state FROM event_invitations WHERE id = 1`).send_state === 'queued', r);
r = await drainInvitations({ ...env, INVITES_ENABLED: 'true' }, { limit: 10 });
check('switched on but with no mailing address: still nothing', r.skipped === 'no-address' && sent.length === 0, r);
r = await drainInvitations({ ...withAddress, INVITES_ENABLED: 'true' }, { limit: 10 });
check('switched on, approved, with the address: it sends', r.sent === 1 && sent.length === 1
  && get(`SELECT send_state FROM event_invitations WHERE id = 1`).send_state === 'sent', r);

console.log('\n=== holds that lapse ===');
event('2099-03-01-camp', 'online');
reg('2099-03-01-camp', 'late', 'confirmed', 'pending', PAST);
reg('2099-03-01-camp', 'next', 'waitlist', null, null);
r = await expireEventHolds({ DB: strict(DB) });
const late = get(`SELECT status, payment_state FROM registrations WHERE player_name = 'late'`);
const next = get(`SELECT status, payment_state, hold_expires_at FROM registrations WHERE player_name = 'next'`);
check('an unpaid hold that lapsed gives the place back', late.status === 'cancelled' && late.payment_state === 'expired', late);
check('and the next family is offered it to pay for, with 48 hours', next.status === 'confirmed' && next.payment_state === 'pending'
  && Date.parse(next.hold_expires_at) - Date.now() > 47 * 3600 * 1000, next);
check('counted', r.released === 1 && r.offered === 1, r);
event('2099-04-01-camp', 'at_check_in');
reg('2099-04-01-camp', 'free1', 'confirmed', 'pending', PAST);
reg('2099-04-01-camp', 'free2', 'waitlist', null, null);
await expireEventHolds({ DB: strict(DB) });
check('an event paid at check-in promotes to a plain place, no payment hold',
  get(`SELECT status, payment_state FROM registrations WHERE player_name = 'free2'`).payment_state === null
  && get(`SELECT status FROM registrations WHERE player_name = 'free2'`).status === 'confirmed');
run(`INSERT INTO event_teams (event_id, group_id, team_name, team_name_norm, coach_name, coach_email, coach_email_norm, coach_phone,
     players_count, status, agreement, signature, signed_at, cancel_token, created_at, updated_at, payment_state, hold_expires_at,
     amount_due_cents) VALUES ('2099-03-01-camp', (SELECT id FROM program_groups WHERE program_id = '2099-03-01-camp'), 'Flyers',
     'flyers', 'C', 'c@example.com', 'c@example.com', '615', 8, 'entered', 1, 'C', 'n', 'teamtok', 'n', 'n', 'pending', ?, 5000)`, PAST);
await expireEventHolds({ DB: strict(DB) });
check('a held team entry that lapses is withdrawn', get(`SELECT status, payment_state FROM event_teams WHERE team_name = 'Flyers'`).status
  === 'withdrawn');

console.log('\n=== the family or team moved up: told only with EVENT_EMAILS_ENABLED ===');
const mailEnv = { ...env, SITE_URL: 'https://tnsaints.example' };
event('2099-05-01-camp', 'online');
reg('2099-05-01-camp', 'lapse1', 'confirmed', 'pending', PAST);
reg('2099-05-01-camp', 'wait1', 'waitlist', null, null);
let before = sent.length;
r = await expireEventHolds(mailEnv);
check('switch off: the next family is moved up and held, but no email goes', r.offered === 1 && r.told === 0 && sent.length === before
  && get(`SELECT payment_state FROM registrations WHERE player_name = 'wait1'`).payment_state === 'pending', r);
event('2099-06-01-camp', 'online');
reg('2099-06-01-camp', 'lapse2', 'confirmed', 'pending', PAST);
reg('2099-06-01-camp', 'wait2', 'waitlist', null, null);
before = sent.length;
r = await expireEventHolds({ ...mailEnv, EVENT_EMAILS_ENABLED: 'true' });
const told = mail.slice(before);
const wait2 = get(`SELECT cancel_token FROM registrations WHERE player_name = 'wait2'`);
check('switch on: that family is told, with a pay link to its own held place', r.told === 1 && told.length === 1
  && JSON.stringify(told[0].to) === JSON.stringify(['wait2@example.com'])
  && told[0].text.includes(`/?event=2099-06-01-camp&pay=${wait2.cancel_token}`) && /Pay by then/.test(told[0].text), told[0]?.text);
check('in the event\'s own words, never the evaluation\'s', told[0].subject.includes('Camp 2099-06-01-camp')
  && !/evaluation|Grassland/i.test(told[0].text + told[0].subject), told[0]?.subject);

// Teams: a paid division, one place, a team holding it unpaid and one waiting.
const teamRow = (event, name, status, state, hold, amount) => run(`INSERT INTO event_teams (event_id, group_id, team_name,
  team_name_norm, coach_name, coach_email, coach_email_norm, coach_phone, players_count, status, agreement, signature, signed_at,
  cancel_token, created_at, updated_at, payment_state, hold_expires_at, amount_due_cents)
  VALUES (?, (SELECT id FROM program_groups WHERE program_id = ?), ?, ?, 'C', ?, ?, '615', 8, ?, 1, 'C', 'n', ?, ?, 'n', ?, ?, ?)`,
  event, event, name, name.toLowerCase(), `${name}@example.com`, `${name}@example.com`, status, `team-${name}`,
  `2026-01-0${status === 'waitlist' ? 2 : 1}T00:00:00.000Z`, state, hold, amount);
event('2099-07-01-camp', 'online');
teamRow('2099-07-01-camp', 'Hawks', 'entered', 'pending', PAST, 7500);
teamRow('2099-07-01-camp', 'Owls', 'waitlist', null, null, null);
before = sent.length;
r = await expireEventHolds(mailEnv);
const owls = get(`SELECT status, payment_state, hold_expires_at, amount_due_cents FROM event_teams WHERE team_name = 'Owls'`);
check('a waiting team moved up on a paid event owes the fee, held 48 hours — never a free place', owls.status === 'entered'
  && owls.payment_state === 'pending' && owls.amount_due_cents === 7500
  && Date.parse(owls.hold_expires_at) - Date.now() > 47 * 3600 * 1000, owls);
check('and with the switch off its coach is not emailed', r.told === 0 && sent.length === before, r);
event('2099-08-01-camp', 'at_check_in');
teamRow('2099-08-01-camp', 'Bears', 'entered', 'pending', PAST, 7500);
teamRow('2099-08-01-camp', 'Lions', 'waitlist', null, null, null);
before = sent.length;
r = await expireEventHolds({ ...mailEnv, EVENT_EMAILS_ENABLED: 'true' });
const lions = get(`SELECT status, payment_state, hold_expires_at, amount_due_cents FROM event_teams WHERE team_name = 'Lions'`);
check('on an event paid at check-in it owes the fee there, with no hold', lions.status === 'entered'
  && lions.payment_state === 'at_check_in' && lions.amount_due_cents === 7500 && lions.hold_expires_at === null, lions);
check('with the switch on its coach is told, with no pay link', r.told === 1 && mail.slice(before).length === 1
  && JSON.stringify(mail[before].to) === JSON.stringify(["Lions@example.com"]) && !mail[before].text.includes("&pay="), { r, n: mail.slice(before).length, to: mail[before]?.to });

console.log('\n=== a family cancelling an event place, through the real route ===');
const ORIGIN = 'https://tnsaints.example';
const cancelEnv = { ...mailEnv, ALLOWED_ORIGINS: ORIGIN };
const cancelPlace = async (token, extra = {}) => {
  const waits = [];
  const res = await worker.fetch(new Request('https://api.tnsaints.example/api/cancel', { method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }),
  { ...cancelEnv, ...extra }, { waitUntil: (p) => waits.push(p), passThroughOnException() {} });
  await Promise.all(waits);
  return res;
};
const placeAndWaiter = (id, goer, waiter) => {
  event(id, 'at_check_in');
  reg(id, goer, 'confirmed', 'at_check_in', null);
  reg(id, waiter, 'waitlist', 'at_check_in', null);
  // Signed up through the event's own form (events/register.js marks the source).
  run(`UPDATE registrations SET source = 'website', cancel_token = ? WHERE player_name = ?`, `${goer.charCodeAt(0).toString(16)}`.repeat(32).slice(0, 64), goer);
  return get(`SELECT cancel_token FROM registrations WHERE player_name = ?`, goer).cancel_token;
};
let tok = placeAndWaiter('2099-09-01-camp', 'alpha', 'beta');
before = sent.length;
let res = await cancelPlace(tok);
check('switch off: the place is released and the next family moved up', res.status === 200
  && get(`SELECT status FROM registrations WHERE player_name = 'beta'`).status === 'confirmed', res.status);
check('and not one email goes: not to the family moved up, not to staff', sent.length === before, sent.slice(before));
tok = placeAndWaiter('2099-10-01-camp', 'gamma', 'delta');
before = sent.length;
res = await cancelPlace(tok, { EVENT_EMAILS_ENABLED: 'true' });
const toldNow = mail.slice(before);
check('switch on: the family moved up is told in the event\'s words, and staff are alerted', res.status === 200
  && toldNow.some((m) => JSON.stringify(m.to) === JSON.stringify(['delta@example.com']) && m.subject.includes('Camp 2099-10-01-camp'))
  && toldNow.some((m) => JSON.stringify(m.to) === JSON.stringify(['staff@tnsaints.com'])), toldNow.map((m) => [m.to, m.subject]));
tok = placeAndWaiter('2099-11-01-camp', 'epsilon', 'zeta');
run(`UPDATE programs SET notify_each_signup = 0 WHERE id = '2099-11-01-camp'`);
before = sent.length;
await cancelPlace(tok, { EVENT_EMAILS_ENABLED: 'true' });
check('an event that asks for no staff email per sign-up sends staff none for a cancellation either',
  mail.slice(before).every((m) => JSON.stringify(m.to) !== JSON.stringify(['staff@tnsaints.com'])) && mail.slice(before).length === 1,
  mail.slice(before).map((m) => m.to));
check('every statement bound exactly what it named', misbound.length === 0, misbound.slice(0, 3));

check.finish();
