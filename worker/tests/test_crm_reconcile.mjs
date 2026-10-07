/**
 * The CRM keeping in step with the portal (src/crm/reconcile.js) and the
 * evaluation import (src/crm/import.js), against real SQL on Node's SQLite.
 *
 * Proved: a lead whose email gets a portal account is linked, and a family
 * lead then gives up its copy of their details (owner and do-not-contact carry
 * over); a named child is matched to the right player; family cards follow
 * evaluations and academy places, closing as won on enrollment, with the
 * timeline saying why; families who came straight to the portal get cards;
 * coaches who are also parents keep their details; two leads naming one child
 * cannot break the run; a second run changes nothing; and the work is a fixed
 * number of statements however much data there is.
 *
 *   node --no-warnings tests/test_crm_reconcile.mjs
 */
import { fakeD1, checker } from './_d1_fake.mjs';
import { reconcileCrm, RECONCILE_STEPS } from '../src/crm/reconcile.js';
import { previewImport, runImport } from '../src/crm/import.js';

const check = checker();
const T = '2026-10-07T15:00:00.000Z';
const NOW = new Date(T);

function seed(DB) {
  const run = (sql, ...args) => DB.raw.prepare(sql).run(...args);
  return {
    run,
    account(email) {
      return Number(run(`INSERT INTO accounts (email, email_norm, created_at, updated_at) VALUES (?, ?, ?, ?)`,
        email, email.toLowerCase(), T, T).lastInsertRowid);
    },
    household(name, accountId) {
      const id = Number(run(`INSERT INTO households (display_name, created_at, updated_at) VALUES (?, ?, ?)`, name, T, T).lastInsertRowid);
      run(`INSERT INTO household_members (household_id, account_id, role, created_at) VALUES (?, ?, 'owner', ?)`, id, accountId, T);
      return id;
    },
    player(name, parentEmail, householdId = null) {
      return Number(run(`INSERT INTO players (display_name, name_norm, parent_email_norm, household_id, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?)`, name, name.toLowerCase(), parentEmail, householdId, T, T).lastInsertRowid);
    },
    contact(kind, name, email, extra = {}) {
      return Number(run(`INSERT INTO crm_contacts (kind, name, email, email_norm, phone, owner_email, do_not_contact, source,
                         created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'website:player', ?, ?)`,
      kind, name, email, email ? email.toLowerCase() : null, extra.phone || null, extra.owner || null, extra.dnc ? 1 : 0, T, T)
        .lastInsertRowid);
    },
    prospectCard(contactId, childName, pipeline = 'family', stage = 'new') {
      const pp = Number(run(`INSERT INTO crm_prospect_players (contact_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
        contactId, childName, T, T).lastInsertRowid);
      const card = Number(run(`INSERT INTO crm_opportunities (pipeline, stage, contact_id, prospect_player_id, source, opened_at,
                               created_at, updated_at) VALUES (?, ?, ?, ?, 'website:player', ?, ?, ?)`,
      pipeline, stage, contactId, pp, T, T, T).lastInsertRowid);
      return { pp, card };
    },
    enroll(playerId, householdId, status) {
      run(`INSERT INTO enrollments (ref, player_id, household_id, program_id, status, applied_at, created_by, created_at, updated_at)
           VALUES (?, ?, ?, 'academy', ?, ?, 'test', ?, ?)`, `ref-${playerId}-${Math.random()}`, playerId, householdId, status, T, T, T);
    },
    setEnrollment(playerId, status) {
      // Offered and enrolled places sit in a group; an offer has a pay-by date.
      let group = DB.raw.prepare(`SELECT id FROM program_groups WHERE program_id = 'academy' LIMIT 1`).get()?.id;
      if (!group) {
        group = Number(run(`INSERT INTO program_groups (program_id, name, schedule_summary, capacity, created_at, updated_at)
                            VALUES ('academy', 'Tuesday group', 'Tuesdays', 10, ?, ?)`, T, T).lastInsertRowid);
      }
      run(`UPDATE enrollments SET status = ?, group_id = ?, offer_expires_at = ? WHERE player_id = ?`,
        status, group, '2099-01-01T00:00:00.000Z', playerId);
    },
    registration(playerName, parentEmail, playerId, { status = 'confirmed', parentName = 'Pat Parent', phone = '(615) 555-0142' } = {}) {
      return Number(run(`INSERT INTO registrations (event_id, session_time, status, cancel_token, player_name, player_name_norm,
        grade, parent_name, parent_email, parent_email_norm, phone, school, emergency_contact_name, emergency_contact_phone,
        assumption_of_risk, medical_release, photo_release, signature, signed_at, created_at, player_id)
        VALUES ('2026-08-29-evaluation', '9:00 AM', ?, ?, ?, ?, '4th', ?, ?, ?, ?, 'School', 'EC', '615', 1, 1, 1, 'Sig', ?, ?, ?)`,
      status, `tok-${Math.random()}`, playerName, playerName.toLowerCase(), parentName, parentEmail, parentEmail.toLowerCase(),
      phone, T, T, playerId).lastInsertRowid);
    },
    feedback(playerId, registrationId) {
      run(`INSERT INTO eval_feedback (player_id, registration_id, event_id, author_email, author_label, strengths, created_at, updated_at)
           VALUES (?, ?, '2026-08-29-evaluation', 'coach@example.com', 'Coach', 'Good', ?, ?)`, playerId, registrationId, T, T);
    },
  };
}

const get = (DB, sql, ...args) => DB.raw.prepare(sql).get(...args);
const all = (DB, sql, ...args) => DB.raw.prepare(sql).all(...args);

console.log('\n=== a lead becomes a portal family ===');
{
  const DB = fakeD1();
  const s = seed(DB);
  const c = s.contact('family', 'Pat Lead', 'Pat.Lead@Example.com', { phone: '(615) 555-0100', owner: 'owner@example.com', dnc: true });
  const { pp, card } = s.prospectCard(c, 'Ava Lead');
  const acct = s.account('pat.lead@example.com');
  const h = s.household('The Lead family', acct);
  const ava = s.player('Ava Lead', 'pat.lead@example.com', h);
  const before = DB.stats.queries;
  const counts = await reconcileCrm({ DB }, { now: NOW });
  check('the whole reconcile is one fixed batch', DB.stats.queries - before === RECONCILE_STEPS.length, DB.stats.queries - before);
  const row = get(DB, `SELECT status, name, email, email_norm, phone, household_id, account_id FROM crm_contacts WHERE id = ?`, c);
  check('the lead is linked to the family by email', row.household_id === h && row.account_id === acct, row);
  check('and converted: the family is now the record of who they are',
    row.status === 'converted' && row.name === null && row.email === null && row.email_norm === null && row.phone === null, row);
  check('the timeline says it was matched', get(DB, `SELECT COUNT(*) AS n FROM crm_activities WHERE kind = 'linked' AND contact_id = ?`, c).n === 1);
  const p = get(DB, `SELECT player_id, name FROM crm_prospect_players WHERE id = ?`, pp);
  check("the named child is matched to the family's player, and the lead's copy of the name cleared",
    p.player_id === ava && p.name === '', p);
  const o = get(DB, `SELECT player_id, household_id FROM crm_opportunities WHERE id = ?`, card);
  check('the card now belongs to that child and family', o.player_id === ava && o.household_id === h, o);
  const meta = get(DB, `SELECT owner_email, do_not_contact FROM crm_household_meta WHERE household_id = ?`, h);
  check("the lead's owner and do-not-contact carry over to the family", meta?.owner_email === 'owner@example.com' && meta?.do_not_contact === 1, meta);
  check('counts are reported per step', counts.linked === 1 && counts.converted === 1, counts);

  console.log('\n=== the card follows the academy place ===');
  s.enroll(ava, h, 'applied');
  await reconcileCrm({ DB }, { now: NOW });
  check('applied: the card moves to Applied', get(DB, `SELECT stage FROM crm_opportunities WHERE id = ?`, card).stage === 'applied');
  s.setEnrollment(ava, 'offered');
  await reconcileCrm({ DB }, { now: NOW });
  check('offered a seat: Offered', get(DB, `SELECT stage FROM crm_opportunities WHERE id = ?`, card).stage === 'offered');
  s.setEnrollment(ava, 'active');
  await reconcileCrm({ DB }, { now: NOW });
  const won = get(DB, `SELECT stage, closed_at FROM crm_opportunities WHERE id = ?`, card);
  check('enrolled: the card closes as won', won.stage === 'enrolled' && won.closed_at === T, won);
  const moves = all(DB, `SELECT kind, json_extract(detail, '$.to') AS t, json_extract(detail, '$.via') AS via
                          FROM crm_activities WHERE opportunity_id = ? ORDER BY id`, card);
  check('each move is on the timeline, saying why',
    JSON.stringify(moves.map((x) => [x.kind, x.t, x.via])) ===
      JSON.stringify([['stage', 'applied', 'enrollment'], ['stage', 'offered', 'enrollment'], ['enrolled', 'enrolled', 'enrollment']]), moves);
  const again = await reconcileCrm({ DB }, { now: NOW });
  check('a second run changes nothing', Object.values(again).every((n) => n === 0), again);
}

console.log('\n=== evaluations, portal-only families, coaches, duplicates ===');
{
  const DB = fakeD1();
  const s = seed(DB);
  // A lead whose child came to an evaluation under the same email.
  const c = s.contact('family', 'Eve Eval', 'eve@example.com');
  const { card } = s.prospectCard(c, 'Ben Eval');
  const ben = s.player('Ben Eval', 'eve@example.com');
  const reg = s.registration('Ben Eval', 'eve@example.com', ben);
  await reconcileCrm({ DB }, { now: NOW });
  let o = get(DB, `SELECT stage, player_id FROM crm_opportunities WHERE id = ?`, card);
  check('a child registered for an evaluation is matched, and the card moves to Evaluation registered',
    o.player_id === ben && o.stage === 'eval_registered', o);
  check('a lead with no portal account keeps their details', get(DB, `SELECT status, email FROM crm_contacts WHERE id = ?`, c).email === 'eve@example.com');
  s.feedback(ben, reg);
  await reconcileCrm({ DB }, { now: NOW });
  o = get(DB, `SELECT stage FROM crm_opportunities WHERE id = ?`, card);
  check('once a coach writes about them: Evaluation attended', o.stage === 'eval_attended', o);

  // A family who came straight to the portal.
  const acct = s.account('direct@example.com');
  const h = s.household('The Direct family', acct);
  const kid = s.player('Cal Direct', 'direct@example.com', h);
  s.enroll(kid, h, 'waitlist');
  await reconcileCrm({ DB }, { now: NOW });
  const direct = get(DB, `SELECT stage, source, household_id, closed_at FROM crm_opportunities WHERE player_id = ?`, kid);
  check('a family who came straight to the portal gets a card at their stage',
    direct?.stage === 'applied' && direct.source === 'portal' && direct.household_id === h && direct.closed_at === null, direct);

  // A coach who is also a parent.
  const coachAcct = s.account('coach.parent@example.com');
  const ch = s.household('The Coach family', coachAcct);
  const coach = s.contact('coach', 'Casey Coach', 'coach.parent@example.com');
  await reconcileCrm({ DB }, { now: NOW });
  const cc = get(DB, `SELECT status, email, household_id FROM crm_contacts WHERE id = ?`, coach);
  check('a coach who is also a portal parent is linked but keeps their details',
    cc.status === 'active' && cc.email === 'coach.parent@example.com' && cc.household_id === ch, cc);

  // Two leads (mum and dad) naming the same child.
  const mum = s.contact('family', 'Mum Dup', 'mum@example.com');
  const dad = s.contact('family', 'Dad Dup', 'dad@example.com');
  const dupKid = s.player('Dee Dup', 'mum@example.com');
  s.registration('Dee Dup', 'mum@example.com', dupKid);
  s.registration('Dee Dup', 'dad@example.com', dupKid);
  const a = s.prospectCard(mum, 'Dee Dup');
  const b = s.prospectCard(dad, 'Dee Dup');
  let crashed = false;
  try { await reconcileCrm({ DB }, { now: NOW }); } catch (err) { crashed = err.message; }
  const owners = all(DB, `SELECT id FROM crm_opportunities WHERE player_id = ? AND closed_at IS NULL`, dupKid).map((r) => r.id);
  check('two leads naming one child: no crash, and only the older card takes the child',
    crashed === false && owners.length === 1 && owners[0] === Math.min(a.card, b.card), { crashed, owners });
}

console.log('\n=== the evaluation import ===');
{
  const DB = fakeD1();
  const s = seed(DB);
  const k1 = s.player('Ivy Import', 'imp@example.com');
  const k2 = s.player('Jay Import', 'imp@example.com');
  const r1 = s.registration('Ivy Import', 'imp@example.com', k1, { parentName: 'Ira Import', phone: '+1 (615) 555-0177' });
  s.registration('Jay Import', 'imp@example.com', k2, { parentName: 'Ira Import', phone: '+1 (615) 555-0177' });
  s.feedback(k1, r1);
  const gone = s.player('Gone Cancelled', 'cancel@example.com');
  s.registration('Gone Cancelled', 'cancel@example.com', gone, { status: 'cancelled' });
  const pAcct = s.account('portal.parent@example.com');
  const ph = s.household('The Portal family', pAcct);
  const pk = s.player('Pia Portal', 'portal.parent@example.com', ph);
  s.registration('Pia Portal', 'portal.parent@example.com', pk);

  const preview = await previewImport({ DB });
  check('the preview counts what would happen, leaving out cancelled registrations',
    preview.families === 2 && preview.children === 3 && preview.newContacts === 1 && preview.newCards === 3 && preview.portalFamilies === 1,
    preview);
  const result = await runImport({ DB }, { now: NOW });
  check('one contact per parent email, one card per child', result.contacts === 1 && result.cards === 3, result);
  const contact = get(DB, `SELECT name, phone_norm, source FROM crm_contacts WHERE email_norm = 'imp@example.com'`);
  check("the contact has the parent's name and a normalized phone", contact?.name === 'Ira Import' && contact.phone_norm === '6155550177'
    && contact.source === 'import:2026-08-29-evaluation', contact);
  const stages = Object.fromEntries(all(DB, `SELECT player_id, stage FROM crm_opportunities`).map((r) => [r.player_id, r.stage]));
  check('evaluated children at Evaluation attended, the rest at Evaluation registered',
    stages[k1] === 'eval_attended' && stages[k2] === 'eval_registered' && stages[pk] === 'eval_registered' && !stages[gone], stages);
  check('a portal family gets a card on their family, not a contact',
    get(DB, `SELECT household_id FROM crm_opportunities WHERE player_id = ?`, pk).household_id === ph &&
      !get(DB, `SELECT 1 AS x FROM crm_contacts WHERE email_norm = 'portal.parent@example.com'`));
  check('each new card says where it came from',
    get(DB, `SELECT COUNT(*) AS n FROM crm_activities WHERE kind = 'import'`).n === 3);
  const twice = await runImport({ DB }, { now: new Date('2026-10-08T15:00:00Z') });
  check('importing again adds nothing', twice.contacts === 0 && twice.cards === 0, twice);
}

check.finish();
