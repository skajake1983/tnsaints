/**
 * Retention (src/privacy/retention.js) and legal holds (src/privacy/holds.js),
 * against real SQL on Node's SQLite, with the clock set to 2034 so the
 * seven-year rules can come due.
 *
 * Proved: report mode removes nothing; each rule finds exactly what it should
 * and nothing it should not (live places, children who never had a place,
 * leads with recent contact, onboarded volunteers, children under 21, waivers
 * of unknown age); a legal hold keeps its subject out of every rule until
 * released; enforcement removes what was due, leaves no dangling waiver
 * pointer, records counts only, and a second run finds nothing more.
 *
 *   node --no-warnings tests/test_retention.mjs
 */
import { fakeD1, checker } from './_d1_fake.mjs';
import { retentionConfig, retentionCounts, runRetention, lastRetentionReport, RULES } from '../src/privacy/retention.js';
import { placeHold, releaseHold, listHolds } from '../src/privacy/holds.js';

const check = checker();
const NOW = new Date('2034-06-01T15:00:00.000Z');
const OLD = '2026-09-01T15:00:00.000Z';
const HASH = 'a'.repeat(64);
const DB = fakeD1();
const run = (sql, ...a) => DB.raw.prepare(sql).run(...a);
const get = (sql, ...a) => DB.raw.prepare(sql).get(...a);
const id = (r) => Number(r.lastInsertRowid);

// --- fixtures --------------------------------------------------------------------
const acct = (email) => id(run(`INSERT INTO accounts (email, email_norm, created_at, updated_at) VALUES (?, ?, ?, ?)`, email, email, OLD, OLD));
const family = (name, email) => {
  const h = id(run(`INSERT INTO households (display_name, created_at, updated_at) VALUES (?, ?, ?)`, name, OLD, OLD));
  run(`INSERT INTO household_members (household_id, account_id, role, created_at) VALUES (?, ?, 'owner', ?)`, h, acct(email), OLD);
  return h;
};
const child = (name, h, dob) => id(run(`INSERT INTO players (display_name, name_norm, parent_email_norm, household_id, date_of_birth,
  created_at, updated_at) VALUES (?, ?, 'x@example.com', ?, ?, ?, ?)`, name, name.toLowerCase(), h, dob, OLD, OLD));
const medical = (p) => run(`INSERT INTO player_medical (player_id, status, notes, updated_by, updated_at, confirmed_at)
  VALUES (?, 'declared', 'MEDICAL-CANARY', 'account:1', ?, ?)`, p, OLD, OLD);
run(`INSERT INTO program_groups (program_id, name, schedule_summary, capacity, created_at, updated_at)
     VALUES ('academy', 'Tuesday group', 'Tuesdays', 10, ?, ?)`, OLD, OLD);
const GROUP = get(`SELECT id FROM program_groups`).id;
const waiver = (() => {
  run(`INSERT INTO waiver_versions (id, legal_entity, title, body_text, body_sha256, effective_at, created_at)
       VALUES ('w1', 'Saints LLC', 'Waiver', 'text', ?, ?, ?)`, HASH, OLD, OLD);
  return 'w1';
})();
const consent = (p, h, signed = OLD) => id(run(`INSERT INTO consent_records (player_id, household_id, account_id, program_id,
  waiver_version_id, waiver_sha256, signature, signer_relationship, esign_consent, assumption_of_risk, medical_release,
  photo_release, signed_at) VALUES (?, ?, 1, 'academy', ?, ?, 'Sig', 'Mother', 1, 1, 1, 0, ?)`, p, h, waiver, HASH, signed));
const place = (p, h, status, consentId, ended = null) => id(run(`INSERT INTO enrollments (ref, player_id, household_id, program_id,
  group_id, status, consent_record_id, offer_expires_at, applied_at, ended_at, created_by, created_at, updated_at)
  VALUES (?, ?, ?, 'academy', ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?, 'test', ?, ?)`,
  `ref-${p}-${status}-xxxxxxxx`, p, h, GROUP, status, consentId, OLD, ended, OLD, ended || OLD));
const payment = (h, paidAt, txn) => id(run(`INSERT INTO payments (paypal_transaction_id, environment, household_id, amount_cents,
  currency, kind, status, paid_at, created_at) VALUES (?, 'live', ?, 4000, 'USD', 'setup_fee', 'completed', ?, ?)`, txn, h, paidAt, paidAt));
const lead = (name, created, kind = 'family') => id(run(`INSERT INTO crm_contacts (kind, name, email, email_norm, source, created_at,
  updated_at) VALUES (?, ?, ?, ?, 'website:player', ?, ?)`, kind, name, `${name.replace(/\s/g, '')}@example.com`,
  `${name.replace(/\s/g, '').toLowerCase()}@example.com`, created, created));
const registration = (name, eventId) => id(run(`INSERT INTO registrations (event_id, session_time, status, cancel_token, player_name,
  player_name_norm, grade, parent_name, parent_email, parent_email_norm, phone, school, emergency_contact_name,
  emergency_contact_phone, medical_notes, assumption_of_risk, medical_release, photo_release, signature, signed_at, created_at)
  VALUES (?, '9:00 AM', 'confirmed', ?, ?, ?, '4th', 'P', 'p@example.com', 'p@example.com', '615', 'S', 'EC', '615',
  'EVAL-MEDICAL-CANARY', 1, 1, 1, 'Sig', ?, ?)`, eventId, `tok-${name}`, name, name.toLowerCase(), OLD, OLD));

const H1 = family('The Old family', 'old@example.com');
const ADULT = child('Ada Adult', H1, '2012-01-01'); // 22 in 2034; place ended 2026
const c1 = consent(ADULT, H1);
place(ADULT, H1, 'ended', c1, '2026-10-01T15:00:00.000Z');
medical(ADULT);
const TEEN = child('Tim Teen', H1, '2016-01-01'); // 18 in 2034: waiver kept
const c2 = consent(TEEN, H1);
place(TEEN, H1, 'ended', c2, '2026-10-01T15:00:00.000Z');
const ACTIVE = child('Ann Active', H1, '2012-02-02'); // still has a place: kept
const c3 = consent(ACTIVE, H1);
place(ACTIVE, H1, 'active', c3);
medical(ACTIVE);
const NEVER = child('Ned Never', H1, '2014-03-03'); // never had a place: medical kept
medical(NEVER);
const UNKNOWN = child('Una Unknown', H1, null); // no date of birth: waiver kept
consent(UNKNOWN, H1);
payment(H1, '2026-10-01T15:00:00.000Z', 'TXN-OLD');
payment(H1, '2030-10-01T15:00:00.000Z', 'TXN-RECENT');

const H2 = family('The Held family', 'held@example.com'); // household on hold
const HELDKID = child('Hal Held', H2, '2010-01-01');
const c5 = consent(HELDKID, H2);
place(HELDKID, H2, 'ended', c5, '2026-10-01T15:00:00.000Z');
medical(HELDKID);
payment(H2, '2026-10-01T15:00:00.000Z', 'TXN-HELD');

const R1 = registration('Rae Eval', '2026-08-29-evaluation');
const R2 = registration('Ron Held', '2026-08-29-evaluation');
const R3 = registration('Rex Future', '2034-05-20-evaluation'); // within 90 days of NOW: kept

const OLDLEAD = lead('Olive Old', '2026-01-01T15:00:00.000Z');
const FRESH = lead('Fred Fresh', '2026-01-01T15:00:00.000Z');
run(`INSERT INTO crm_inquiries (contact_id, purpose, fields, received_at) VALUES (?, 'player', '{}', '2034-05-01T15:00:00.000Z')`, FRESH);
const VOL = lead('Vera Volunteer', '2026-01-01T15:00:00.000Z', 'volunteer');
run(`INSERT INTO crm_opportunities (pipeline, stage, contact_id, source, opened_at, closed_at, created_at, updated_at)
     VALUES ('volunteer', 'onboarded', ?, 'manual', ?, ?, ?, ?)`, VOL, OLD, OLD, OLD, OLD);
const HELDLEAD = lead('Hank Held', '2026-01-01T15:00:00.000Z');
run(`INSERT INTO crm_activities (kind, body, contact_id, actor, occurred_at, created_at) VALUES ('note', 'LEAD-NOTE-CANARY', ?, 'staff', ?, ?)`,
  OLDLEAD, OLD, OLD);

console.log('\n=== legal holds ===');
const env = { DB };
check('a hold needs a real subject', (await placeHold(env, { subjectType: 'household', subjectId: 999999, reason: 'Dispute', actor: 'admin' })).result === 'not-found');
check('and a reason', (await placeHold(env, { subjectType: 'household', subjectId: H2, reason: 'x', actor: 'admin' })).result === 'invalid');
check('a hold on a family is placed', (await placeHold(env, { subjectType: 'household', subjectId: H2, reason: 'Insurance claim', actor: 'admin' })).result === 'placed');
check('only one active hold per subject', (await placeHold(env, { subjectType: 'household', subjectId: H2, reason: 'Again', actor: 'admin' })).result === 'exists');
await placeHold(env, { subjectType: 'registration', subjectId: R2, reason: 'Dispute', actor: 'admin' });
await placeHold(env, { subjectType: 'crm_contact', subjectId: HELDLEAD, reason: 'Complaint', actor: 'admin' });
const holds = await listHolds(env);
check('holds are listed with a name to recognise them by', holds.find((h) => h.subject_type === 'household')?.subject_name === 'The Held family', holds);

console.log('\n=== report mode: counts, removes nothing ===');
const report = await runRetention(env, { now: NOW, config: retentionConfig({}) });
const due = Object.fromEntries(report.rules.map((r) => [r.key, [r.due, r.held]]));
check('medical answers: only the child whose place ended long ago (one more kept by the family hold)',
  JSON.stringify(due.medical_portal) === '[1,1]', due.medical_portal);
check('evaluation medical notes: the old one due, the held one kept, the recent one not due',
  JSON.stringify(due.medical_eval) === '[1,1]', due.medical_eval);
check('leads: the untouched one due; recent contact and onboarded volunteers are not; one held',
  JSON.stringify(due.leads) === '[1,1]', due.leads);
check('waivers: only the adult whose place ended (under-21s and live places kept; one held)',
  JSON.stringify(due.waivers) === '[1,1]', due.waivers);
check('payments: the 2026 one due; 2030 not yet; one held', JSON.stringify(due.payments) === '[1,1]', due.payments);
check('a waiver whose child has no date of birth is kept and counted', report.waiversAgeUnknown === 1, report.waiversAgeUnknown);
check('report mode removed nothing', get(`SELECT COUNT(*) AS n FROM player_medical`).n === 4 && get(`SELECT COUNT(*) AS n FROM payments`).n === 3
  && get(`SELECT COUNT(*) AS n FROM consent_records`).n === 5 && Object.keys(report.removed).length === 0);
check('the report is saved for the Privacy page', (await lastRetentionReport(env))?.mode === 'report');

console.log('\n=== enforce mode ===');
const enforce = retentionConfig({ RETENTION_MODE: 'enforce' });
const done = await runRetention(env, { now: NOW, config: enforce });
check('it reports what it removed', JSON.stringify(done.removed) ===
  JSON.stringify({ medical_portal: 1, medical_eval: 1, leads: 1, waivers: 1, payments: 1 }), done.removed);
check("the adult's medical answer is gone; the active child's, the never-enrolled child's and the held child's remain",
  !get(`SELECT 1 AS x FROM player_medical WHERE player_id = ?`, ADULT) && get(`SELECT COUNT(*) AS n FROM player_medical`).n === 3);
check('the old evaluation medical note is cleared; the held and recent ones remain',
  get(`SELECT medical_notes FROM registrations WHERE id = ?`, R1).medical_notes === null
  && get(`SELECT medical_notes FROM registrations WHERE id = ?`, R2).medical_notes === 'EVAL-MEDICAL-CANARY'
  && get(`SELECT medical_notes FROM registrations WHERE id = ?`, R3).medical_notes === 'EVAL-MEDICAL-CANARY');
const ol = get(`SELECT status, name, email FROM crm_contacts WHERE id = ?`, OLDLEAD);
check('the untouched lead is anonymized, with what staff wrote', ol.status === 'anonymized' && ol.name === null && ol.email === null
  && get(`SELECT COUNT(*) AS n FROM crm_activities WHERE body LIKE '%LEAD-NOTE-CANARY%'`).n === 0, ol);
check('the recent lead, the volunteer and the held lead are untouched',
  ['Fred Fresh', 'Vera Volunteer', 'Hank Held'].every((n) => get(`SELECT status FROM crm_contacts WHERE name = ?`, n)?.status === 'active'));
check("the adult's waiver is gone, and their ended place no longer points to it",
  !get(`SELECT 1 AS x FROM consent_records WHERE id = ?`, c1)
  && get(`SELECT consent_record_id FROM enrollments WHERE player_id = ?`, ADULT).consent_record_id === null);
check("the teen's, the active child's, the unknown-age and the held waivers remain",
  [c2, c3, c5].every((c) => get(`SELECT 1 AS x FROM consent_records WHERE id = ?`, c)) && get(`SELECT COUNT(*) AS n FROM consent_records`).n === 4);
check('the 2026 payment is gone; the 2030 and held ones remain',
  !get(`SELECT 1 AS x FROM payments WHERE paypal_transaction_id = 'TXN-OLD'`) && get(`SELECT COUNT(*) AS n FROM payments`).n === 2);
const a = get(`SELECT actor, detail FROM audit_log WHERE action = 'retention.enforced'`);
check('enforcement is audited with counts only', a?.actor === 'system' && !/CANARY|Ada|Olive/.test(a.detail), a);
const again = await runRetention(env, { now: NOW, config: enforce });
check('a second run finds nothing more due', again.rules.every((r) => r.due === 0) && Object.keys(again.removed).length === 0, again.rules);

console.log('\n=== releasing a hold ===');
const familyHold = (await listHolds(env)).find((h) => h.subject_type === 'household' && !h.released_at);
check('a hold can be released', await releaseHold(env, { id: familyHold.id, actor: 'admin' }));
check('and not released twice', !(await releaseHold(env, { id: familyHold.id, actor: 'admin' })));
const after = await retentionCounts(env, { now: NOW, config: enforce });
const byKey = Object.fromEntries(after.rules.map((r) => [r.key, r.due]));
check('once released, what it kept becomes due', byKey.medical_portal === 1 && byKey.waivers === 1 && byKey.payments === 1, byKey);

console.log('\n=== settings ===');
const odd = retentionConfig({ RETENTION_MODE: 'ENFORCE', RETENTION_MEDICAL_DAYS: '5', RETENTION_LEAD_MONTHS: 'two', RETENTION_PAYMENT_YEARS: '10' });
check('only exactly "enforce" enforces; out-of-range or malformed periods fall back to the defaults',
  odd.mode === 'report' && odd.medicalDays === 90 && odd.leadMonths === 24 && odd.paymentYears === 10, odd);
const before = DB.stats.queries;
await retentionCounts(env, { now: NOW });
check('the report is one fixed batch', DB.stats.queries - before === RULES.length * 2 + 1, DB.stats.queries - before);

check.finish();
