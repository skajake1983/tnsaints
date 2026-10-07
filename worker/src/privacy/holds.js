/**
 * Legal holds (privacy:manage): keep everything about a family, child,
 * contact or evaluation registration out of the retention rules until
 * released. See privacy/retention.js for what each kind of hold covers.
 */

export const HOLD_TYPES = {
  household: 'Family',
  player: 'Child',
  crm_contact: 'CRM contact',
  registration: 'Evaluation registration',
};

const EXISTS = {
  household: `SELECT 1 FROM households WHERE id = ?2`,
  player: `SELECT 1 FROM players WHERE id = ?2`,
  crm_contact: `SELECT 1 FROM crm_contacts WHERE id = ?2`,
  registration: `SELECT 1 FROM registrations WHERE id = ?2`,
};

/** Active holds first, then the last 50 released, with a name to recognise each by. */
export async function listHolds(env) {
  const { results } = await env.DB.prepare(
    `SELECT h.id, h.subject_type, h.subject_id, h.reason, h.placed_by, h.placed_at, h.released_by, h.released_at,
            CASE h.subject_type
              WHEN 'household' THEN (SELECT display_name FROM households WHERE id = h.subject_id)
              WHEN 'player' THEN (SELECT display_name FROM players WHERE id = h.subject_id)
              WHEN 'crm_contact' THEN (SELECT COALESCE(name, organization, 'Contact ' || id) FROM crm_contacts WHERE id = h.subject_id)
              WHEN 'registration' THEN (SELECT player_name FROM registrations WHERE id = h.subject_id)
            END AS subject_name
       FROM legal_holds h
      ORDER BY h.released_at IS NOT NULL, COALESCE(h.released_at, h.placed_at) DESC LIMIT 100`
  ).all();
  return results || [];
}

/**
 * Place a hold. The subject must exist; one active hold per subject.
 * @returns {Promise<{result: 'placed'|'exists'|'not-found'|'invalid', id?: number}>}
 */
export async function placeHold(env, { subjectType, subjectId, reason, actor }) {
  const why = String(reason ?? '').trim().replace(/\s+/g, ' ');
  if (!EXISTS[subjectType] || !Number.isInteger(subjectId) || subjectId < 1 || why.length < 3 || why.length > 200) {
    return { result: 'invalid' };
  }
  const row = await env.DB.prepare(
    `INSERT INTO legal_holds (subject_type, subject_id, reason, placed_by, placed_at)
     SELECT ?1, ?2, ?3, ?4, ?5
      WHERE EXISTS (${EXISTS[subjectType]})
        AND NOT EXISTS (SELECT 1 FROM legal_holds WHERE subject_type = ?1 AND subject_id = ?2 AND released_at IS NULL)
     RETURNING id`
  ).bind(subjectType, subjectId, why, actor, new Date().toISOString()).first();
  if (row) return { result: 'placed', id: Number(row.id) };
  const active = await env.DB.prepare(
    `SELECT 1 FROM legal_holds WHERE subject_type = ?1 AND subject_id = ?2 AND released_at IS NULL`
  ).bind(subjectType, subjectId).first();
  return { result: active ? 'exists' : 'not-found' };
}

/** Release an active hold. */
export async function releaseHold(env, { id, actor }) {
  const res = await env.DB.prepare(
    `UPDATE legal_holds SET released_by = ?2, released_at = ?3 WHERE id = ?1 AND released_at IS NULL`
  ).bind(id, actor, new Date().toISOString()).run();
  return Boolean(res.meta?.changes);
}
