/**
 * Coach note capture.
 *
 * Two stores, deliberately not one table with a visibility flag:
 *
 *   eval_feedback        — parent-facing. Ratings, strengths, growth area, and
 *                          an optional note to the family. SELECT * is safe.
 *   eval_notes_internal  — staff only. Candid assessment. Never composed into
 *                          an email, and no accessor here that a composer may
 *                          import can reach it.
 *
 * A single shared table with `visibility` would be one forgotten WHERE clause
 * away from mailing a coach's private assessment to the child's family. There
 * is no undo for that, and no apology that repairs it, so the separation is
 * physical.
 *
 * WHY UPSERT RATHER THAN APPEND
 *
 * One row per coach per player. Notes are added at the gym, revised over the
 * following days, and argued about in a meeting before decisions are set — so a
 * coach revisiting on Tuesday should be EDITING Saturday's note, not adding a
 * second one. Append-only would turn each player into a thread nobody reads to
 * the bottom of, and the decision meeting would open by reconciling duplicates.
 */

import { resolvePlayerId } from './players.js';

const RATINGS = ['rating_skill', 'rating_effort', 'rating_coachability', 'rating_decisions'];

/** 1–5, or null. Anything else is dropped rather than stored wrong. */
function rating(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

/** Trim and cap. Null rather than empty string, so "unset" has one representation. */
function text(value, max) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t.slice(0, max) : null;
}

/**
 * Save one coach's evaluation of one player.
 *
 * `authorEmail` is the ATTRIBUTED author, which is not always the person
 * typing — an admin transcribing from paper sets it to the coach who actually
 * watched the child. The caller is responsible for the audit row naming the
 * real typist; see the on_behalf_of handling in the admin router.
 *
 * Everything is optional. Saving four taps of ratings with no prose is a valid
 * and expected state on event day: the approve gate later refuses to SEND
 * anything incomplete, which is the right place to enforce quality. Enforcing
 * it at capture time would mean a coach with 30 seconds between drills either
 * writes filler or loses the rating too.
 */
export async function saveEvaluation(env, { registrationId, authorEmail, authorLabel, data }) {
  const playerId = await resolvePlayerId(env, registrationId);
  if (!playerId) return { ok: false, code: 'no-such-registration' };

  const reg = await env.DB.prepare(`SELECT event_id FROM registrations WHERE id = ?1`)
    .bind(registrationId)
    .first();
  if (!reg) return { ok: false, code: 'no-such-registration' };

  const now = new Date().toISOString();

  const values = {
    rating_skill: rating(data.rating_skill),
    rating_effort: rating(data.rating_effort),
    rating_coachability: rating(data.rating_coachability),
    rating_decisions: rating(data.rating_decisions),
    strengths: text(data.strengths, 2000),
    growth_area: text(data.growth_area, 2000),
    parent_note: text(data.parent_note, 2000),
  };

  // created_at is preserved on conflict, updated_at moves. Knowing a note was
  // first written at the gym and refined on Tuesday is exactly the provenance
  // worth keeping when someone asks how a decision was reached.
  await env.DB.prepare(
    `INSERT INTO eval_feedback
       (player_id, registration_id, event_id, author_email, author_label,
        rating_skill, rating_effort, rating_coachability, rating_decisions,
        strengths, growth_area, parent_note, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
     ON CONFLICT (registration_id, author_email) DO UPDATE SET
       author_label        = excluded.author_label,
       rating_skill        = excluded.rating_skill,
       rating_effort       = excluded.rating_effort,
       rating_coachability = excluded.rating_coachability,
       rating_decisions    = excluded.rating_decisions,
       strengths           = excluded.strengths,
       growth_area         = excluded.growth_area,
       parent_note         = excluded.parent_note,
       updated_at          = excluded.updated_at`
  )
    .bind(
      playerId,
      registrationId,
      reg.event_id,
      authorEmail,
      authorLabel,
      values.rating_skill,
      values.rating_effort,
      values.rating_coachability,
      values.rating_decisions,
      values.strengths,
      values.growth_area,
      values.parent_note,
      now
    )
    .run();

  const internal = text(data.internal_note, 4000);

  if (internal) {
    await env.DB.prepare(
      `INSERT INTO eval_notes_internal
         (player_id, registration_id, event_id, author_email, body, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT (registration_id, author_email) DO UPDATE SET
         body       = excluded.body,
         updated_at = excluded.updated_at`
    )
      .bind(playerId, registrationId, reg.event_id, authorEmail, internal, now)
      .run();
  } else {
    // Clearing the box deletes the note. The alternative — leaving an empty
    // row — would show as "has an internal note" in the completeness view and
    // send a coach looking for something that is not there.
    await env.DB.prepare(
      `DELETE FROM eval_notes_internal WHERE registration_id = ?1 AND author_email = ?2`
    )
      .bind(registrationId, authorEmail)
      .run();
  }

  return { ok: true, playerId };
}

/**
 * Everything staff may see about one player's evaluation: this coach's own
 * entry, plus every other coach's, plus the internal notes.
 *
 * Coaches seeing each other's notes is the point of the tool. Comparing
 * impressions is what the decision meeting is for, and forcing everyone into a
 * room to do it wastes the only thing software is good at here.
 */
export async function evaluationForStaff(env, registrationId) {
  const [feedback, internal] = await Promise.all([
    env.DB.prepare(
      `SELECT author_email, author_label, rating_skill, rating_effort,
              rating_coachability, rating_decisions,
              strengths, growth_area, parent_note, created_at, updated_at
         FROM eval_feedback
        WHERE registration_id = ?1
        ORDER BY author_label`
    )
      .bind(registrationId)
      .all(),
    env.DB.prepare(
      `SELECT author_email, body, created_at, updated_at
         FROM eval_notes_internal
        WHERE registration_id = ?1
        ORDER BY author_email`
    )
      .bind(registrationId)
      .all(),
  ]);

  return {
    feedback: feedback.results || [],
    internal: internal.results || [],
  };
}

/**
 * THE ONLY data accessor a parent-facing composer may import.
 *
 * It reads eval_feedback and nothing else. There is no code path from here to
 * eval_notes_internal — not a join, not an optional flag, not a parameter that
 * widens it. A committed test writes a canary token into an internal note,
 * composes, and asserts the token is absent from the output; this function is
 * why that test can pass.
 */
export async function parentFacingFeedback(env, registrationId) {
  const { results } = await env.DB.prepare(
    `SELECT author_label, rating_skill, rating_effort, rating_coachability,
            rating_decisions, strengths, growth_area, parent_note
       FROM eval_feedback
      WHERE registration_id = ?1
      ORDER BY author_label`
  )
    .bind(registrationId)
    .all();

  return results || [];
}

/**
 * Completeness across the event.
 *
 * REQUIRED, not a nice-to-have. Without it the decision meeting opens by
 * discovering which players nobody wrote about — the slowest possible moment to
 * find out, and the one where the information is least recoverable, because the
 * gym is empty and the children went home three days ago.
 *
 * Counts coaches per player, so "one coach wrote something" is visibly distinct
 * from "we have a second opinion".
 */
export async function completeness(env) {
  const { results } = await env.DB.prepare(
    `SELECT r.id                              AS registration_id,
            r.player_name                     AS player_name,
            r.session_time                    AS session_time,
            r.grade                           AS grade,
            COUNT(DISTINCT f.author_email)    AS coach_count,
            SUM(CASE WHEN TRIM(COALESCE(f.strengths,   '')) != '' THEN 1 ELSE 0 END) AS with_strengths,
            SUM(CASE WHEN TRIM(COALESCE(f.growth_area, '')) != '' THEN 1 ELSE 0 END) AS with_growth,
            COUNT(DISTINCT n.author_email)    AS internal_count
       FROM registrations r
       LEFT JOIN eval_feedback       f ON f.registration_id = r.id
       LEFT JOIN eval_notes_internal n ON n.registration_id = r.id
      WHERE r.event_id = ?1 AND r.status = 'confirmed'
      GROUP BY r.id
      ORDER BY r.session_time, r.player_name`
  )
    .bind(env.EVENT_ID)
    .all();

  const rows = results || [];

  return {
    players: rows,
    total: rows.length,
    none: rows.filter((r) => Number(r.coach_count) === 0).length,
    one: rows.filter((r) => Number(r.coach_count) === 1).length,
    twoPlus: rows.filter((r) => Number(r.coach_count) >= 2).length,
    readyToSend: rows.filter(
      (r) => Number(r.with_strengths) > 0 && Number(r.with_growth) > 0
    ).length,
  };
}
