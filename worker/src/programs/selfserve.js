/**
 * Self-serve programs (camps, clinics, tournaments): a family picks a group
 * with a free seat, signs the waiver, and pays — no staff decision.
 *
 * STILL NO PAYING WITHOUT A SEAT. Signing up holds a seat in a SCHEDULED group
 * for HOLD_MINUTES, as an offer the family made themselves (status 'offered',
 * decided_by 'self-serve'): the pay page exists only while that hold is live,
 * and a lapsed hold is CANCELLED (not waitlisted) by expireOffers. A free
 * program confirms the place at once.
 *
 * ATOMIC. The waiver and the place are written in one transaction, and BOTH
 * statements carry the seat check, so a full group writes neither — no
 * orphaned signature. D1 runs writes one at a time, so two families taking the
 * last seat at the same moment cannot both get it.
 *
 * Full, and the program keeps a waiting list: the family can join it (status
 * 'waitlist' with that group preferred); staff then offer seats from the
 * program's queue as for the academy.
 */

import { randomToken } from '../lib/crypto.js';
import { enrollmentEnabled } from './enrollment.js';

export const HOLD_MINUTES = 30;

const MEMBER_OF = `SELECT household_id FROM household_members WHERE account_id = ?1`;
const LIVE = `('applied', 'waitlist', 'offered', 'active', 'past_due')`;
const iso = (ms = Date.now()) => new Date(ms).toISOString();

/** The group has a free seat right now (?now = ISO instant), counted in the statement. */
const SEAT_FREE = (group, nowParam) => `EXISTS (
  SELECT 1 FROM program_groups g
   WHERE g.id = ${group} AND g.program_id = ?3 AND g.status = 'active'
     AND (SELECT COUNT(*) FROM enrollments x WHERE x.group_id = g.id
            AND (x.status IN ('active', 'past_due') OR (x.status = 'offered' AND x.offer_expires_at > ${nowParam})))
         < g.capacity)`;

/**
 * Hold (or, for a free program, confirm) a seat.
 * @returns {Promise<{ok: true, ref: string, status: 'offered'|'active'} |
 *                   {ok: false, reason: 'paused'|'full'|'duplicate'|'not-found'}>}
 */
export async function register(env, accountId, { playerId, program, groupId, waiver, signature, relationship, photoRelease, ipHash }) {
  if (!enrollmentEnabled(env)) return { ok: false, reason: 'paused' };
  const nowMs = Date.now();
  const now = iso(nowMs);
  const free = program.billing === 'free';
  const status = free ? 'active' : 'offered';
  const expires = free ? null : iso(nowMs + HOLD_MINUTES * 60 * 1000);
  const ref = randomToken(16);
  try {
    const [consent, enrollment] = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO consent_records (player_id, household_id, account_id, program_id, waiver_version_id,
                                     waiver_sha256, signature, signer_relationship, esign_consent,
                                     assumption_of_risk, medical_release, photo_release, signed_at, ip_hash)
         SELECT p.id, p.household_id, ?1, ?3, w.id, w.body_sha256, ?5, ?6, 1, 1, 1, ?7, ?8, ?9
           FROM players p JOIN waiver_versions w ON w.id = ?4
          WHERE p.id = ?2 AND p.household_id IN (${MEMBER_OF})
            AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.player_id = p.id AND e.program_id = ?3 AND e.status IN ${LIVE})
            AND ${SEAT_FREE('?10', '?8')}`
      ).bind(accountId, playerId, program.id, waiver.id, signature, relationship, photoRelease ? 1 : 0, now, ipHash, groupId),
      env.DB.prepare(
        `INSERT INTO enrollments (ref, player_id, household_id, program_id, group_id, preferred_group_ids, status,
                                  consent_record_id, offered_at, offer_expires_at, activated_at, applied_at,
                                  decided_by, decided_at, created_by, created_at, updated_at)
         SELECT ?4, p.id, p.household_id, ?3, ?10, ?11, ?5, c.id, ?6, ?7, CASE WHEN ?5 = 'active' THEN ?6 END, ?6,
                ?9, ?6, ?8, ?6, ?6
           FROM players p
           -- The consent the statement above wrote, and no other.
           JOIN consent_records c ON c.id = last_insert_rowid() AND c.player_id = p.id
                                 AND c.account_id = ?1 AND c.signed_at = ?6 AND c.program_id = ?3
          WHERE p.id = ?2 AND p.household_id IN (${MEMBER_OF})`
      // The preferred-group list is built here: D1 binds a JS number as REAL,
      // so json_array(?) would store [12.0].
      ).bind(accountId, playerId, program.id, ref, status, now, expires, `account:${accountId}`, 'self-serve', groupId,
        JSON.stringify([Number(groupId)])),
    ]);
    if ((consent.meta?.changes || 0) === 1 && (enrollment.meta?.changes || 0) === 1) return { ok: true, ref, status };
  } catch (err) {
    if (/UNIQUE/.test(String(err?.message))) return { ok: false, reason: 'duplicate' };
    throw err;
  }
  // Nothing was written. Why?
  const why = await env.DB.prepare(
    `SELECT (SELECT 1 FROM players p WHERE p.id = ?2 AND p.household_id IN (${MEMBER_OF})) AS mine,
            (SELECT 1 FROM enrollments e WHERE e.player_id = ?2 AND e.program_id = ?3 AND e.status IN ${LIVE}) AS taken`
  ).bind(accountId, playerId, program.id).first();
  if (!why?.mine) return { ok: false, reason: 'not-found' };
  if (why.taken) return { ok: false, reason: 'duplicate' };
  return { ok: false, reason: 'full' };
}

/**
 * Join a full self-serve program's waiting list for one group (signed, like an
 * application). Staff offer seats from the queue.
 * @returns {Promise<{ok: true, ref: string} | {ok: false, reason: 'paused'|'duplicate'|'not-found'|'no-waitlist'}>}
 */
export async function joinWaitlist(env, accountId, { playerId, program, groupId, waiver, signature, relationship, photoRelease, ipHash }) {
  if (!enrollmentEnabled(env)) return { ok: false, reason: 'paused' };
  if (!program.waitlist_enabled) return { ok: false, reason: 'no-waitlist' };
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
          WHERE p.id = ?2 AND p.household_id IN (${MEMBER_OF})
            AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.player_id = p.id AND e.program_id = ?3 AND e.status IN ${LIVE})
            AND EXISTS (SELECT 1 FROM program_groups g WHERE g.id = ?10 AND g.program_id = ?3)`
      ).bind(accountId, playerId, program.id, waiver.id, signature, relationship, photoRelease ? 1 : 0, now, ipHash, groupId),
      env.DB.prepare(
        `INSERT INTO enrollments (ref, player_id, household_id, program_id, preferred_group_ids, status, consent_record_id,
                                  applied_at, waitlisted_at, created_by, created_at, updated_at)
         SELECT ?4, p.id, p.household_id, ?3, ?7, 'waitlist', c.id, ?5, ?5, ?6, ?5, ?5
           FROM players p
           JOIN consent_records c ON c.id = last_insert_rowid() AND c.player_id = p.id
                                 AND c.account_id = ?1 AND c.signed_at = ?5 AND c.program_id = ?3
          WHERE p.id = ?2 AND p.household_id IN (${MEMBER_OF})`
      ).bind(accountId, playerId, program.id, ref, now, `account:${accountId}`, JSON.stringify([Number(groupId)])),
    ]);
    if ((consent.meta?.changes || 0) === 1 && (enrollment.meta?.changes || 0) === 1) return { ok: true, ref };
  } catch (err) {
    if (/UNIQUE/.test(String(err?.message))) return { ok: false, reason: 'duplicate' };
    throw err;
  }
  return { ok: false, reason: 'not-found' };
}
