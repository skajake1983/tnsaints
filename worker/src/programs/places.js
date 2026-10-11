/**
 * Places staff add directly, for families who already pay outside the portal.
 *
 * The academy's first families joined through the old Join page and pay
 * through its PayPal button. They have no application, so the offer -> pay
 * flow never gives them a place. Staff add one here: the child, a group with
 * room, and how the family pays today. The place starts ACTIVE (they are
 * already paying), and the family is asked to sign the waiver the next time
 * they sign in (portal/apply.js waiverRoutes).
 *
 * Not paused by ENROLLMENT_ENABLED: like confirming a payment already made,
 * this records a place the family already has; it takes on no one new.
 *
 * The seat is counted inside the INSERT, like the offer (enrollment.js), so
 * two staff placing the last seat at once cannot both succeed; the unique
 * live-enrollment index refuses a second live place in the same program.
 */

import { randomToken } from '../lib/crypto.js';

// A seat is held by a live place, or an offer not yet lapsed (enrollment.js).
const holdsSeat = (now) => `(e.status IN ('active', 'past_due') OR (e.status = 'offered' AND e.offer_expires_at > ${now}))`;
const LIVE = `('applied', 'waitlist', 'offered', 'active', 'past_due')`;
// PayPal subscription ids, as Admin -> Billing accepts them.
const SUBSCRIPTION_ID_RE = /^I-[A-Z0-9]{6,40}$/;

export const PAID_OUTSIDE = {
  paypal_join: 'Through PayPal (the old Join page)',
  other: 'Some other way (cash, check, scholarship)',
};

/** The child, their family's name, and the live places they already have. */
export async function childForPlace(env, playerId) {
  const [child, places] = await env.DB.batch([
    env.DB.prepare(
      `SELECT p.id, p.display_name, p.household_id, h.display_name AS household_name
         FROM players p JOIN households h ON h.id = p.household_id AND h.status = 'active'
        WHERE p.id = ?1`
    ).bind(playerId),
    env.DB.prepare(
      `SELECT e.program_id, e.status, pr.name AS program_name, g.name AS group_name
         FROM enrollments e JOIN programs pr ON pr.id = e.program_id LEFT JOIN program_groups g ON g.id = e.group_id
        WHERE e.player_id = ?1 AND e.status IN ${LIVE} ORDER BY pr.name`
    ).bind(playerId),
  ]);
  const row = child.results?.[0];
  return row ? { ...row, places: places.results || [] } : null;
}

/** Every active group of every program not archived, with seats taken right now. */
export async function placeOptions(env) {
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.name, g.schedule_summary, g.capacity, pr.id AS program_id, pr.name AS program_name, pr.status AS program_status,
            (SELECT COUNT(*) FROM enrollments e WHERE e.group_id = g.id AND ${holdsSeat('?1')}) AS taken
       FROM program_groups g JOIN programs pr ON pr.id = g.program_id AND pr.status != 'archived'
      WHERE g.status = 'active'
      ORDER BY pr.id = 'academy' DESC, pr.name, g.weekday IS NULL, g.weekday, g.start_time, g.name`
  ).bind(new Date().toISOString()).all();
  return results || [];
}

/** Check the form. @returns {{value: object, errors: object}} */
export function validatePlace(form) {
  const groupRaw = String(form.get('group_id') || '');
  const value = {
    groupId: /^\d{1,12}$/.test(groupRaw) ? Number(groupRaw) : null,
    billedOutside: String(form.get('billed_outside') || ''),
    reference: String(form.get('outside_reference') || '').trim().toUpperCase(),
  };
  const errors = {};
  if (!value.groupId) errors.group_id = 'Choose the group the child practises with.';
  if (!Object.hasOwn(PAID_OUTSIDE, value.billedOutside)) errors.billed_outside = 'Choose how the family pays today.';
  if (value.reference && (value.billedOutside !== 'paypal_join' || !SUBSCRIPTION_ID_RE.test(value.reference))) {
    errors.outside_reference = 'A PayPal subscription id looks like I-ABC123DEF456, from the family\'s PayPal receipt. Or leave it blank.';
  }
  return { value, errors };
}

/**
 * Add the place, active from today.
 * @returns {Promise<{ok: true, id: number, programId: string} | {ok: false, reason: 'full'|'exists'|'invalid'}>}
 */
export async function addPlace(env, { playerId, groupId, billedOutside, reference, staffEmail }) {
  const now = new Date().toISOString();
  let row;
  try {
    row = await env.DB.prepare(
      `INSERT INTO enrollments (ref, player_id, household_id, program_id, group_id, status, applied_at, activated_at,
                                decided_by, decided_at, created_by, created_at, updated_at, billed_outside, outside_reference)
       SELECT ?1, p.id, p.household_id, g.program_id, g.id, 'active', ?3, ?3, ?4, ?3, ?4, ?3, ?3, ?5, ?6
         FROM players p
         JOIN households h ON h.id = p.household_id AND h.status = 'active'
         JOIN program_groups g ON g.id = ?7 AND g.status = 'active'
         JOIN programs pr ON pr.id = g.program_id AND pr.status != 'archived'
        WHERE p.id = ?2
          AND (SELECT COUNT(*) FROM enrollments e WHERE e.group_id = g.id AND ${holdsSeat('?3')}) < g.capacity
       RETURNING id, program_id`
    ).bind(randomToken(16), playerId, now, staffEmail, billedOutside, reference || null, groupId).first();
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message))) return { ok: false, reason: 'exists' };
    throw err;
  }
  if (row) return { ok: true, id: Number(row.id), programId: row.program_id };
  // Why not: the group exists and is active but has no room, or something is missing.
  const group = await env.DB.prepare(
    `SELECT g.capacity, (SELECT COUNT(*) FROM enrollments e WHERE e.group_id = g.id AND ${holdsSeat('?2')}) AS taken
       FROM program_groups g JOIN programs pr ON pr.id = g.program_id AND pr.status != 'archived'
      WHERE g.id = ?1 AND g.status = 'active'`
  ).bind(groupId, now).first();
  return { ok: false, reason: group && Number(group.taken) >= Number(group.capacity) ? 'full' : 'invalid' };
}
