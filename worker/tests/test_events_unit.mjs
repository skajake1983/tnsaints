/**
 * The events API's switches (src/events/register.js), on Node's SQLite.
 *
 * Proved: with EVENTS_ENABLED not "true", the website gets no events and
 * sign-ups are refused; with it on and EVENT_EMAILS_ENABLED not "true", a
 * sign-up is recorded and reaches the CRM and NOT ONE email is attempted (the
 * owner, 2026-10-21: no email goes out without their approval); with both on,
 * the receipt is attempted. Every statement binds exactly what it names.
 *
 *   node --no-warnings tests/test_events_unit.mjs
 */
import { fakeD1, checker } from './_d1_fake.mjs';
import { handleEventsList, handleEventDetail, handleEventRegister } from '../src/events/register.js';

const check = checker();
const DB = fakeD1();
const run = (sql, ...a) => DB.raw.prepare(sql).run(...a);
const get = (sql, ...a) => DB.raw.prepare(sql).get(...a);

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

// Every outbound request is recorded; mail would go to api.resend.com.
const calls = [];
globalThis.fetch = async (url) => {
  calls.push(String(url));
  return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
};
const isMail = (u) => /resend|8799|\/emails/.test(u);

run(`INSERT INTO waiver_versions (id, legal_entity, title, body_text, body_sha256, effective_at, created_at)
     VALUES ('w1', 'Saints LLC', 'Waiver', 'text', ?, 'n', 'n')`, 'a'.repeat(64));
run(`INSERT INTO programs (id, kind, event_kind, name, status, enrollment_mode, billing, grade_min, grade_max, waiver_version_id,
     public, registration_closes_at, waitlist_enabled, created_at, updated_at, signup_mode, starts_on, location)
     VALUES ('2099-06-06-open-gym', 'clinic', 'open_gym', 'Open Gym', 'open', 'approval', 'free', 3, 8, 'w1', 1,
             '2099-06-05T23:59:00.000Z', 1, 'n', 'n', 'spot', '2099-06-06', 'Franklin, TN')`);
run(`INSERT INTO program_groups (program_id, name, schedule_summary, start_time, starts_on, capacity, status, created_at, updated_at)
     VALUES ('2099-06-06-open-gym', '6:00 PM', '6:00 PM', '18:00', '2099-06-06', 10, 'active', 'n', 'n')`);

const cors = { 'Access-Control-Allow-Origin': 'https://tnsaints.com' };
const base = {
  DB: strict(DB), TURNSTILE_ENABLED: 'false', IP_HASH_SALT: 'salt', AUTH_PEPPER: 'p'.repeat(40),
  RESEND_API_KEY: 're_test_key', NOTIFY_EMAIL_FROM: 'Saints <noreply@tnsaints.com>', NOTIFY_EMAIL_TO: 'staff@tnsaints.com',
};
const signup = (email) => new Request('https://api.tnsaints.com/api/events/2099-06-06-open-gym/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.9' },
  body: JSON.stringify({
    session_time: '6:00 PM', player_name: 'Unit Kid', grade: '5th', parent_name: 'Pat Parent', parent_email: email,
    phone: '(615) 555-0100', emergency_contact_name: 'Erin Contact', emergency_contact_phone: '(615) 555-0199',
    assumption_of_risk: true, medical_release: true, photo_release: false, signature: 'Pat Parent', waiver_version_id: 'w1',
  }),
});
const waits = [];
const ctx = { waitUntil: (p) => waits.push(p) };
const body = async (res) => JSON.parse(await res.text());

console.log('\n=== events off: the website gets nothing ===');
let r = await body(await handleEventsList(base, cors));
check('the feed is empty and says it is off', r.enabled === false && r.events.length === 0, r);
check('one event is not found', (await handleEventDetail(base, cors, '2099-06-06-open-gym')).status === 404);
check('sign-up is refused', (await handleEventRegister(signup('off@example.com'), base, ctx, cors, '2099-06-06-open-gym')).status === 503);

console.log('\n=== events on, event emails off: recorded, and no email ===');
const on = { ...base, EVENTS_ENABLED: 'true' };
r = await body(await handleEventsList(on, cors));
check('the feed lists the event', r.events.map((e) => e.id).join() === '2099-06-06-open-gym', r);
const res = await handleEventRegister(signup('quiet@example.com'), on, ctx, cors, '2099-06-06-open-gym');
r = await body(res);
await Promise.all(waits.splice(0));
check('the sign-up is recorded', res.status === 200 && r.status === 'confirmed'
  && get(`SELECT COUNT(*) AS n FROM registrations WHERE parent_email_norm = 'quiet@example.com'`).n === 1, r);
check('and promises no email', !/email/i.test(r.message), r.message);
check('it reached the CRM', get(`SELECT COUNT(*) AS n FROM crm_contacts WHERE email_norm = 'quiet@example.com'`).n === 1);
check('and not one email was attempted', calls.filter(isMail).length === 0, calls);

console.log('\n=== both on: the receipt is attempted ===');
const loud = { ...on, EVENT_EMAILS_ENABLED: 'true' };
await handleEventRegister(signup('loud@example.com'), loud, ctx, cors, '2099-06-06-open-gym');
await Promise.all(waits.splice(0));
check('with the owner\'s switch on, mail is sent', calls.filter(isMail).length >= 1, calls);
check('every statement bound exactly what it named', misbound.length === 0, misbound.slice(0, 3));

check.finish();
