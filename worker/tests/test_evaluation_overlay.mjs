/**
 * The evaluation as a program (src/programs/evaluation.js), on Node's SQLite.
 *
 * Proved: with no current evaluation program, env is returned untouched
 * (wrangler.toml rules); with one, every evaluation setting comes from it —
 * sessions in time order, the smallest session size, the grade range, the
 * close time — and a closed one takes no registrations; only an evaluation can
 * be made current; and the public programs feed lists open, listed programs in
 * their window, with seats left and nothing about families.
 *
 *   node --no-warnings tests/test_evaluation_overlay.mjs
 */
import { fakeD1, checker } from './_d1_fake.mjs';
import { withActiveEvent, setCurrentEvaluation, gradeList, publicPrograms } from '../src/programs/evaluation.js';

const check = checker();
const DB = fakeD1();
const run = (sql, ...a) => DB.raw.prepare(sql).run(...a);
const T = '2026-10-01T00:00:00.000Z';
const HASH = 'b'.repeat(64);
run(`INSERT INTO waiver_versions (id, legal_entity, title, body_text, body_sha256, effective_at, created_at)
     VALUES ('ev-w', 'Saints LLC', 'Evaluation waiver', 'text', ?, ?, ?)`, HASH, T, T);
const program = (id, kind, extra = {}) => run(`INSERT INTO programs (id, kind, name, status, enrollment_mode, billing, grade_min,
  grade_max, waiver_version_id, public, registration_opens_at, registration_closes_at, preview_title, price_cents, created_at, updated_at)
  VALUES (?, ?, ?, ?, 'approval', ?, ?, ?, 'ev-w', ?, ?, ?, ?, ?, ?, ?)`,
id, kind, extra.name || id, extra.status || 'open', extra.billing || 'free', extra.min ?? 3, extra.max ?? 6, extra.public ?? 0,
extra.opens || null, extra.closes || '2099-01-01T00:00:00.000Z', extra.preview || null, extra.price ?? null, T, T);
const group = (programId, name, start, capacity, status = 'active') => run(`INSERT INTO program_groups (program_id, name,
  schedule_summary, start_time, capacity, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
programId, name, name, start, capacity, status, T, T);

const env = { DB, EVENT_ID: 'from-toml', EVENT_LABEL: 'Toml label', SESSION_TIMES: '9:00 AM', SLOT_CAPACITY: '25',
  ALLOWED_GRADES: '3rd,4th', REGISTRATION_CLOSES_AT: '2026-08-27T23:59:59-05:00' };

console.log('\n=== nothing current: wrangler.toml rules ===');
check('env comes back untouched', (await withActiveEvent(env)) === env);

console.log('\n=== a current evaluation program ===');
program('2027-03-06-evaluation', 'evaluation', { name: 'Spring Evaluation - March 6, 2027', min: 3, max: 6, closes: '2027-03-04T23:59:59.000Z' });
group('2027-03-06-evaluation', '10:00 AM', '10:00', 20);
group('2027-03-06-evaluation', '9:00 AM', '09:00', 24);
group('2027-03-06-evaluation', 'Old session', '08:00', 5, 'closed');
check('only an evaluation can be made current', (await setCurrentEvaluation({ DB }, 'academy', 'admin')) === 'invalid');
check('an evaluation can', (await setCurrentEvaluation({ DB }, '2027-03-06-evaluation', 'admin')) === 'current');
const ev = await withActiveEvent(env);
check('its id, name and close time are the evaluation settings',
  ev.EVENT_ID === '2027-03-06-evaluation' && ev.EVENT_LABEL === 'Spring Evaluation - March 6, 2027'
  && ev.REGISTRATION_CLOSES_AT === '2027-03-04T23:59:59.000Z', ev);
check('its active groups are the sessions, in time order', ev.SESSION_TIMES === '9:00 AM,10:00 AM', ev.SESSION_TIMES);
check('the session size is the smallest, so no session is overbooked', ev.SLOT_CAPACITY === '20', ev.SLOT_CAPACITY);
check('its grade range is the form\'s grades', ev.ALLOWED_GRADES === '3rd,4th,5th,6th', ev.ALLOWED_GRADES);
check('everything else is unchanged', ev.DB === DB && ev.EVALUATION_SOURCE === 'program' && env.EVENT_ID === 'from-toml');
check('without a short title, the configured one stays', ev.EVENT_SHORT_LABEL === undefined);
run(`UPDATE programs SET status = 'closed' WHERE id = '2027-03-06-evaluation'`);
check('a closed evaluation takes no registrations', Date.parse((await withActiveEvent(env)).REGISTRATION_CLOSES_AT) < Date.now());
check('going back to wrangler.toml', (await setCurrentEvaluation({ DB }, null, 'admin')) === 'cleared' && (await withActiveEvent(env)) === env);
check('grade lists read naturally', gradeList(0, 2) === 'K,1st,2nd' && gradeList(null, 5) === '' && gradeList(11, 12) === '11th,12th');

console.log('\n=== the public programs feed ===');
program('summer-camp', 'camp', { name: 'Summer Camp', public: 1, billing: 'one_time', price: 15000, min: 3, max: 8 });
group('summer-camp', 'Morning', '09:00', 2);
program('secret-camp', 'camp', { name: 'Secret Camp', public: 0 });
program('future-camp', 'camp', { name: 'Future Camp', public: 1, opens: '2099-01-01T00:00:00.000Z', closes: '2099-02-01T00:00:00.000Z' });
program('draft-camp', 'camp', { name: 'Draft Camp', public: 1, status: 'draft' });
run(`INSERT INTO accounts (email, email_norm, created_at, updated_at) VALUES ('f@example.com', 'f@example.com', ?, ?)`, T, T);
run(`INSERT INTO households (display_name, created_at, updated_at) VALUES ('The F family', ?, ?)`, T, T);
run(`INSERT INTO players (display_name, name_norm, parent_email_norm, household_id, created_at, updated_at)
     VALUES ('Feed Kid', 'feed kid', 'f@example.com', 1, ?, ?)`, T, T);
const morning = DB.raw.prepare(`SELECT id FROM program_groups WHERE program_id = 'summer-camp'`).get().id;
run(`INSERT INTO enrollments (ref, player_id, household_id, program_id, group_id, status, applied_at, activated_at, created_by,
     created_at, updated_at) VALUES ('ref-feed-xxxxxxxxxxxx', 1, 1, 'summer-camp', ?, 'active', ?, ?, 'test', ?, ?)`, morning, T, T, T, T);
const feed = await publicPrograms({ DB });
const ids = feed.map((p) => p.id);
check('open, listed programs in their sign-up window are listed', ids.includes('summer-camp'), ids);
check('hidden, not-yet-open and draft ones are not', !ids.includes('secret-camp') && !ids.includes('future-camp') && !ids.includes('draft-camp'), ids);
const camp = feed.find((p) => p.id === 'summer-camp');
check('with price, grades and seats left', camp.price === '150.00' && camp.grades === '3rd,4th,5th,6th,7th,8th'
  && camp.groups[0].seats_left === 1, camp);
check('and nothing about families', !JSON.stringify(feed).includes('Feed Kid') && !JSON.stringify(feed).includes('F family'));

check.finish();
