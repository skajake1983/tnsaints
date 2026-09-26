/**
 * Program enrollment: apply -> (waitlist) -> offered a seat -> paid -> active.
 *
 * THE RULE: nobody pays without a seat in a scheduled group. A family applies;
 * staff offer a seat in a specific group only while it has room; the offer
 * carries a pay-by date; the pay page exists only while an unexpired offer does
 * (P1.9). An offer that lapses gives its seat back at once — seats are COUNTED,
 * never stored, and a lapsed offer simply stops counting.
 *
 * A seat is held by: active, past_due, and offered-and-not-yet-expired.
 *
 * The offer is ATOMIC, the claimSpot pattern (registration.js): the capacity
 * count is inside the UPDATE's WHERE clause, and D1 runs writes one at a time,
 * so two staff offering the last seat at the same moment cannot both succeed.
 *
 * Portal functions take the signed-in accountId and embed the household check
 * in the statement, like portal/data.js. Staff functions take the staff email
 * for attribution; the admin router checks `enrollments:manage` first.
 */

import { randomToken } from '../lib/crypto.js';
import { currentGrade } from '../lib/grades.js';

const MEMBER_OF = `SELECT household_id FROM household_members WHERE account_id = ?1`;
const HOLDS_SEAT = `(e.status IN ('active', 'past_due') OR (e.status = 'offered' AND e.offer_expires_at > ?now))`;
const LIVE = `('applied', 'waitlist', 'offered', 'active', 'past_due')`;
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const DAY_MS = 24 * 60 * 60 * 1000;

const dollars = (cents) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

/** What a family will pay, in words, for the apply page and the offer email. */
export function priceLine(program) {
  if (program.billing === 'free') return 'Free.';
  const price = program.price_cents !== null ? dollars(program.price_cents) : 'Price to be confirmed';
  const per = program.billing === 'subscription' ? ' a month' : '';
  const setup = program.setup_fee_cents ? `, plus a one-time ${dollars(program.setup_fee_cents)} setup fee that covers the practice shirt` : '';
  return `${price}${per}${setup}. You pay only once we offer your child a place in a group.`;
}

function seatsSql(groupExpr, nowParam) {
  return `(SELECT COUNT(*) FROM enrollments e WHERE e.group_id = ${groupExpr} AND ${HOLDS_SEAT.replace('?now', nowParam)})`;
}

// --- programs and groups ---------------------------------------------------------

export async function getProgram(env, programId) {
  return env.DB.prepare(`SELECT * FROM programs WHERE id = ?1`).bind(programId).first();
}

/** A program's groups with seats taken right now. */
export async function listGroups(env, programId) {
  const { results } = await env.DB.prepare(
    `SELECT g.*, ${seatsSql('g.id', '?2')} AS taken
       FROM program_groups g WHERE g.program_id = ?1
      ORDER BY g.status, g.weekday IS NULL, g.weekday, g.start_time, g.name`
  )
    .bind(programId, iso())
    .all();
  return results || [];
}

/**
 * The waiver a program's families sign, with its text checked against its
 * stored hash. A mismatch means the text changed underneath the hash — the
 * version is then unusable rather than silently signed.
 */
export async function currentWaiver(env, program) {
  if (!program?.waiver_version_id) return null;
  const w = await env.DB.prepare(`SELECT * FROM waiver_versions WHERE id = ?1`).bind(program.waiver_version_id).first();
  if (!w) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(w.body_text));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hex !== w.body_sha256) {
    console.error(JSON.stringify({ event: 'waiver_hash_mismatch', waiver: w.id }));
    return null;
  }
  return w;
}

/** Is the program taking applications right now? */
export function programOpen(program, now = Date.now()) {
  if (!program || program.status !== 'open') return false;
  if (program.registration_opens_at && Date.parse(program.registration_opens_at) > now) return false;
  if (program.registration_closes_at && Date.parse(program.registration_closes_at) <= now) return false;
  return true;
}

// --- applying (portal) ---------------------------------------------------------------

/**
 * What stands between this child and applying. Empty list = ready.
 * Each item: { key, message, href } so the page can link to the fix.
 */
export async function applicationBlockers(env, accountId, child, program) {
  const blockers = [];
  const grade = currentGrade(child.grade_level, child.grade_school_year);
  if (!child.date_of_birth) blockers.push({ key: 'dob', message: 'Add a date of birth', href: `/children/${child.id}` });
  if (!child.school) blockers.push({ key: 'school', message: 'Add their school', href: `/children/${child.id}` });
  if (!child.shirt_size) blockers.push({ key: 'shirt', message: 'Choose a shirt size', href: `/children/${child.id}` });
  if (grade === null) blockers.push({ key: 'grade', message: 'Add their grade', href: `/children/${child.id}` });
  if (!child.medical_status) {
    blockers.push({ key: 'medical', message: 'Answer the medical question', href: `/children/${child.id}#medical` });
  }
  const contact = await env.DB.prepare(
    `SELECT 1 FROM household_emergency_contacts WHERE household_id IN (${MEMBER_OF}) LIMIT 1`
  )
    .bind(accountId)
    .first();
  if (!contact) blockers.push({ key: 'contact', message: 'Add an emergency contact', href: '/contacts' });
  if (grade !== null && ((program.grade_min !== null && grade < program.grade_min) ||
      (program.grade_max !== null && grade > program.grade_max))) {
    blockers.push({ key: 'grade-range', message: `This program is for grades ${program.grade_min}–${program.grade_max}`, href: null });
  }
  return blockers;
}

/** The child's live enrollment in a program, if any (household-checked). */
export async function liveEnrollment(env, accountId, playerId, programId) {
  return env.DB.prepare(
    `SELECT e.* FROM enrollments e
      WHERE e.player_id = ?2 AND e.program_id = ?3 AND e.status IN ${LIVE}
        AND e.household_id IN (${MEMBER_OF})`
  )
    .bind(accountId, playerId, programId)
    .first();
}

/**
 * Record the signed waiver and the application together, or neither.
 * One batch = one transaction; the unique live-enrollment index makes a second
 * application for the same child fail, and the consent rolls back with it.
 * @returns {Promise<{ok: true, ref: string} | {ok: false, reason: 'duplicate'|'not-found'}>}
 */
export async function apply(env, accountId, { playerId, program, waiver, signature, relationship, photoRelease,
  preferredGroupIds, ipHash }) {
  const now = iso();
  const ref = randomToken(16);
  try {
    const [consent, enrollment] = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO consent_records (player_id, household_id, account_id, program_id, waiver_version_id,
                                     waiver_sha256, signature, signer_relationship, esign_consent,
                                     assumption_of_risk, medical_release, photo_release, signed_at, ip_hash)
         SELECT p.id, p.household_id, ?1, ?3, w.id, w.body_sha256, ?5, ?6, 1, 1, 1, ?7, ?8, ?9
           FROM players p JOIN waiver_versions w ON w.id = ?4
          WHERE p.id = ?2 AND p.household_id IN (${MEMBER_OF})`
      ).bind(accountId, playerId, program.id, waiver.id, signature, relationship, photoRelease ? 1 : 0, now, ipHash),
      env.DB.prepare(
        `INSERT INTO enrollments (ref, player_id, household_id, program_id, preferred_group_ids, status,
                                  consent_record_id, applied_at, created_by, created_at, updated_at)
         SELECT ?3, p.id, p.household_id, ?4, ?5, 'applied', c.id, ?6, ?7, ?6, ?6
           FROM players p
           -- The consent written by the statement above, and no other: same
           -- child, same signer, same instant. If that insert wrote nothing,
           -- this matches nothing, and the application fails whole.
           JOIN consent_records c ON c.id = last_insert_rowid() AND c.player_id = p.id
                                 AND c.account_id = ?1 AND c.signed_at = ?6 AND c.program_id = ?4
          WHERE p.id = ?2 AND p.household_id IN (${MEMBER_OF})`
      ).bind(accountId, playerId, ref, program.id, JSON.stringify(preferredGroupIds), now, `account:${accountId}`),
    ]);
    if ((consent.meta?.changes || 0) !== 1 || (enrollment.meta?.changes || 0) !== 1) {
      return { ok: false, reason: 'not-found' };
    }
    return { ok: true, ref };
  } catch (err) {
    if (/UNIQUE/.test(String(err?.message))) return { ok: false, reason: 'duplicate' };
    throw err;
  }
}

/** Every enrollment for the account's family, newest first, with group details. */
export async function familyEnrollments(env, accountId) {
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.ref, e.player_id, e.program_id, e.status, e.offer_expires_at, e.applied_at,
            pr.name AS program_name, g.name AS group_name, g.schedule_summary, g.location, g.starts_on
       FROM enrollments e
       JOIN programs pr ON pr.id = e.program_id
       LEFT JOIN program_groups g ON g.id = e.group_id
      WHERE e.household_id IN (${MEMBER_OF})
      ORDER BY e.applied_at DESC`
  )
    .bind(accountId)
    .all();
  return results || [];
}

// --- staff decisions -------------------------------------------------------------------

/**
 * Offer a seat in a group. Succeeds only while the group, counted inside this
 * statement, still has room, and only from 'applied' or 'waitlist'.
 * @returns {Promise<{ok: true, expiresAt: string} | {ok: false, reason: 'full'|'state'}>}
 */
export async function offerSeat(env, { enrollmentId, groupId, staffEmail, holdDays }) {
  const nowMs = Date.now();
  const now = iso(nowMs);
  const expiresAt = iso(nowMs + holdDays * DAY_MS);
  const res = await env.DB.prepare(
    `UPDATE enrollments
        SET status = 'offered', group_id = ?2, offered_at = ?3, offer_expires_at = ?4,
            decided_by = ?5, decided_at = ?3, updated_at = ?3
      WHERE id = ?1 AND status IN ('applied', 'waitlist')
        AND EXISTS (
          SELECT 1 FROM program_groups g
           WHERE g.id = ?2 AND g.status = 'active' AND g.program_id = enrollments.program_id
             AND ${seatsSql('g.id', '?3')} < g.capacity)`
  )
    .bind(enrollmentId, groupId, now, expiresAt, staffEmail)
    .run();
  if (res.meta.changes === 1) return { ok: true, expiresAt };
  const row = await env.DB.prepare(`SELECT status FROM enrollments WHERE id = ?1`).bind(enrollmentId).first();
  return { ok: false, reason: row && ['applied', 'waitlist'].includes(row.status) ? 'full' : 'state' };
}

/** Put on the waiting list. Keeps the original place in line (waitlisted_at is set once). */
export async function waitlist(env, { enrollmentId, staffEmail }) {
  const now = iso();
  const res = await env.DB.prepare(
    `UPDATE enrollments
        SET status = 'waitlist', group_id = NULL, offer_expires_at = NULL,
            waitlisted_at = COALESCE(waitlisted_at, ?2), decided_by = ?3, decided_at = ?2, updated_at = ?2
      WHERE id = ?1 AND status IN ('applied', 'offered')`
  )
    .bind(enrollmentId, now, staffEmail)
    .run();
  return res.meta.changes === 1;
}

export async function decline(env, { enrollmentId, staffEmail, reason }) {
  const now = iso();
  const res = await env.DB.prepare(
    `UPDATE enrollments
        SET status = 'declined', group_id = NULL, offer_expires_at = NULL, decline_reason = ?4,
            decided_by = ?3, decided_at = ?2, ended_at = ?2, updated_at = ?2
      WHERE id = ?1 AND status IN ('applied', 'waitlist', 'offered')`
  )
    .bind(enrollmentId, now, staffEmail, reason)
    .run();
  return res.meta.changes === 1;
}

/**
 * Lapsed offers go back to the waiting list, keeping their place. Their seats
 * were already free (a lapsed offer stops counting the moment it expires); this
 * just makes the status say so. Bounded per run.
 */
export async function expireOffers(env) {
  const now = iso();
  const res = await env.DB.prepare(
    `UPDATE enrollments
        SET status = 'waitlist', group_id = NULL, offer_expires_at = NULL,
            waitlisted_at = COALESCE(waitlisted_at, applied_at), updated_at = ?1
      WHERE id IN (SELECT id FROM enrollments WHERE status = 'offered' AND offer_expires_at <= ?1 LIMIT 200)`
  )
    .bind(now)
    .run();
  return res.meta.changes || 0;
}

/**
 * The staff queue for a program: everyone applied, waitlisted or offered, in
 * the order they joined the line, with what staff need to decide.
 */
export async function queue(env, programId) {
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.status, e.preferred_group_ids, e.applied_at, e.waitlisted_at, e.offer_expires_at, e.group_id,
            p.display_name AS child_name, p.grade_level, p.grade_school_year,
            h.display_name AS family_name,
            (SELECT COUNT(*) FROM registrations r WHERE r.player_id = p.id) AS evaluations
       FROM enrollments e
       JOIN players p ON p.id = e.player_id
       JOIN households h ON h.id = e.household_id
      WHERE e.program_id = ?1 AND e.status IN ('applied', 'waitlist', 'offered')
      ORDER BY CASE e.status WHEN 'offered' THEN 2 ELSE 1 END, COALESCE(e.waitlisted_at, e.applied_at), e.id`
  )
    .bind(programId)
    .all();
  return results || [];
}

/** Guardians' addresses for a household, for the offer email. */
export async function householdEmails(env, enrollmentId) {
  const { results } = await env.DB.prepare(
    `SELECT a.email FROM enrollments e
       JOIN household_members m ON m.household_id = e.household_id
       JOIN accounts a ON a.id = m.account_id AND a.status = 'active'
      WHERE e.id = ?1`
  )
    .bind(enrollmentId)
    .all();
  return (results || []).map((r) => r.email);
}

export async function enrollmentWithGroup(env, enrollmentId) {
  return env.DB.prepare(
    `SELECT e.*, g.name AS group_name, g.schedule_summary, g.location, g.starts_on, pr.name AS program_name,
            pr.price_cents, pr.setup_fee_cents
       FROM enrollments e JOIN programs pr ON pr.id = e.program_id
       LEFT JOIN program_groups g ON g.id = e.group_id
      WHERE e.id = ?1`
  )
    .bind(enrollmentId)
    .first();
}
