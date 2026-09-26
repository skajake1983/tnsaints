/**
 * Every portal read and write of family data. THE AUTHORIZATION BOUNDARY.
 *
 * The rule, with no exceptions: each function takes the signed-in accountId
 * first, and the "is this your family?" test is part of the SAME SQL statement
 * as the read or write:
 *
 *     ... AND household_id IN (SELECT household_id FROM household_members
 *                               WHERE account_id = ?1)
 *
 * Never a lookup followed by a separate check. A check in a different
 * statement is one refactor away from being skipped, and between the two a
 * row can change hands. Embedded in the statement, a foreign id simply matches
 * nothing, and the caller renders the same 404 it renders for an id that does
 * not exist — so the portal never confirms that an id belongs to somebody.
 *
 * Route handlers never touch env.DB for family data; tests/test_portal_idor.py
 * walks every route as the wrong family to hold that line.
 */

const MEMBER_OF = `SELECT household_id FROM household_members WHERE account_id = ?1`;

const iso = () => new Date().toISOString();

// --- household ---------------------------------------------------------------

/** The account's household, or null if they have not set one up yet. */
export async function getHousehold(env, accountId) {
  return env.DB.prepare(
    `SELECT h.id, h.display_name, m.role
       FROM household_members m JOIN households h ON h.id = m.household_id
      WHERE m.account_id = ?1 AND h.status = 'active'
      ORDER BY m.created_at LIMIT 1`
  )
    .bind(accountId)
    .first();
}

/**
 * Create a household with this account as its owner. One household per account:
 * refused (returns null) if the account already belongs to one.
 */
export async function createHousehold(env, accountId, { displayName, guardianName, phone, relationship }) {
  if (await getHousehold(env, accountId)) return null;
  const now = iso();
  const household = await env.DB.prepare(
    `INSERT INTO households (display_name, created_at, updated_at) VALUES (?1, ?2, ?2) RETURNING id`
  )
    .bind(displayName, now)
    .first();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO household_members (household_id, account_id, role, relationship, phone, created_at)
       VALUES (?1, ?2, 'owner', ?3, ?4, ?5)`
    ).bind(household.id, accountId, relationship, phone, now),
    env.DB.prepare(`UPDATE accounts SET display_name = ?2, updated_at = ?3 WHERE id = ?1`).bind(
      accountId,
      guardianName,
      now
    ),
  ]);
  return household.id;
}

export async function listGuardians(env, accountId) {
  const { results } = await env.DB.prepare(
    `SELECT a.id AS account_id, a.email, a.display_name, m.role, m.relationship, m.phone
       FROM household_members m JOIN accounts a ON a.id = m.account_id
      WHERE m.household_id IN (${MEMBER_OF})
      ORDER BY m.role DESC, m.created_at`
  )
    .bind(accountId)
    .all();
  return results || [];
}

export async function updateGuardianProfile(env, accountId, { guardianName, phone, relationship }) {
  const now = iso();
  await env.DB.batch([
    env.DB.prepare(`UPDATE accounts SET display_name = ?2, updated_at = ?3 WHERE id = ?1`).bind(
      accountId,
      guardianName,
      now
    ),
    env.DB.prepare(
      `UPDATE household_members SET phone = ?2, relationship = ?3 WHERE account_id = ?1`
    ).bind(accountId, phone, relationship),
  ]);
}

// --- children ----------------------------------------------------------------

const CHILD_COLUMNS = `p.id, p.display_name, p.date_of_birth, p.grade_level, p.grade_school_year,
  p.school, p.shirt_size, p.household_id,
  (SELECT status FROM player_medical pm WHERE pm.player_id = p.id) AS medical_status`;

export async function listChildren(env, accountId) {
  const { results } = await env.DB.prepare(
    `SELECT ${CHILD_COLUMNS} FROM players p
      WHERE p.household_id IN (${MEMBER_OF})
      ORDER BY p.date_of_birth IS NULL, p.date_of_birth, p.display_name`
  )
    .bind(accountId)
    .all();
  return results || [];
}

/** One child, only if they are in this account's household. */
export async function getChild(env, accountId, playerId) {
  return env.DB.prepare(
    `SELECT ${CHILD_COLUMNS} FROM players p WHERE p.id = ?2 AND p.household_id IN (${MEMBER_OF})`
  )
    .bind(accountId, playerId)
    .first();
}

/**
 * Add a child to the account's household.
 * @returns {Promise<{ok: true, id: number} | {ok: false, reason: 'no-household'|'duplicate'|'legacy'}>}
 */
export async function createChild(env, accountId, child) {
  const household = await getHousehold(env, accountId);
  if (!household) return { ok: false, reason: 'no-household' };
  const now = iso();
  try {
    const row = await env.DB.prepare(
      `INSERT INTO players (display_name, name_norm, parent_email_norm, grade, created_at, updated_at,
                           household_id, date_of_birth, grade_level, grade_school_year, school, shirt_size)
       SELECT ?2, ?3, a.email_norm, NULL, ?4, ?4, ?5, ?6, ?7, ?8, ?9, ?10
         FROM accounts a
        WHERE a.id = ?1 AND ?5 IN (${MEMBER_OF})
       RETURNING id`
    )
      .bind(accountId, child.name, child.nameNorm, now, household.id, child.dateOfBirth, child.gradeLevel,
        child.gradeSchoolYear, child.school, child.shirtSize)
      .first();
    return row ? { ok: true, id: Number(row.id) } : { ok: false, reason: 'no-household' };
  } catch (err) {
    const message = String(err?.message || '');
    if (/idx_players_household_name|players\.household_id, players\.name_norm/.test(message)) {
      return { ok: false, reason: 'duplicate' };
    }
    // The legacy identity index: this parent already registered a child of
    // this name for an evaluation. That child should be CLAIMED, not re-added.
    if (/idx_players_identity|players\.parent_email_norm, players\.name_norm/.test(message)) {
      return { ok: false, reason: 'legacy' };
    }
    throw err;
  }
}

/** @returns {Promise<boolean>} false if not this account's child (or a name clash) */
export async function updateChild(env, accountId, playerId, child) {
  try {
    const res = await env.DB.prepare(
      `UPDATE players SET display_name = ?3, name_norm = ?4, date_of_birth = ?5, grade_level = ?6,
              grade_school_year = ?7, school = ?8, shirt_size = ?9, updated_at = ?10
        WHERE id = ?2 AND household_id IN (${MEMBER_OF})`
    )
      .bind(accountId, playerId, child.name, child.nameNorm, child.dateOfBirth, child.gradeLevel,
        child.gradeSchoolYear, child.school, child.shirtSize, iso())
      .run();
    return { ok: res.meta.changes === 1, reason: res.meta.changes === 1 ? null : 'not-found' };
  } catch (err) {
    if (/UNIQUE/.test(String(err?.message))) return { ok: false, reason: 'duplicate' };
    throw err;
  }
}

// --- medical -----------------------------------------------------------------

export async function getMedical(env, accountId, playerId) {
  return env.DB.prepare(
    `SELECT pm.status, pm.notes, pm.updated_at, pm.confirmed_at
       FROM player_medical pm JOIN players p ON p.id = pm.player_id
      WHERE pm.player_id = ?2 AND p.household_id IN (${MEMBER_OF})`
  )
    .bind(accountId, playerId)
    .first();
}

/**
 * Record the parent's answer. The INSERT ... SELECT only produces a row when
 * the child is in this account's household, so a foreign id writes nothing.
 * @returns {Promise<boolean>}
 */
export async function setMedical(env, accountId, playerId, { status, notes }) {
  const now = iso();
  // The actor string is built here, not with SQL `||`: D1 binds a JavaScript
  // number as REAL, so 'account:' || ?1 stored "account:27.0".
  const res = await env.DB.prepare(
    `INSERT INTO player_medical (player_id, status, notes, updated_by, updated_at, confirmed_at)
     SELECT p.id, ?3, ?4, ?6, ?5, ?5
       FROM players p
      WHERE p.id = ?2 AND p.household_id IN (${MEMBER_OF})
     ON CONFLICT (player_id) DO UPDATE SET
       status = excluded.status, notes = excluded.notes, updated_by = excluded.updated_by,
       updated_at = excluded.updated_at, confirmed_at = excluded.confirmed_at`
  )
    .bind(accountId, playerId, status, status === 'declared' ? notes : null, now, `account:${accountId}`)
    .run();
  return res.meta.changes >= 1;
}

// --- claiming children from past evaluations -----------------------------------

/**
 * Children registered for past evaluations under this account's email and not
 * yet in any family. The email is the account's own verified address: a parent
 * can only ever see children registered under the address they signed in with.
 */
export async function claimableChildren(env, accountId) {
  const { results } = await env.DB.prepare(
    `SELECT r.id AS registration_id, r.player_id, r.player_name, r.grade, r.school, r.event_id, r.created_at
       FROM registrations r
       JOIN accounts a ON a.id = ?1 AND r.parent_email_norm = a.email_norm
       LEFT JOIN players p ON p.id = r.player_id
      WHERE r.status != 'cancelled'
        AND (p.id IS NULL OR p.household_id IS NULL)
        AND NOT EXISTS (SELECT 1 FROM players p2
                         WHERE p2.parent_email_norm = r.parent_email_norm
                           AND p2.name_norm = r.player_name_norm AND p2.household_id IS NOT NULL)
      ORDER BY r.created_at DESC`
  )
    .bind(accountId)
    .all();
  // One entry per child even if they registered for several events.
  const seen = new Set();
  return (results || []).filter((r) => {
    const key = r.player_name.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Bring a child from a past registration into the family. The WHERE clause is
 * the authority: the registration must be under this account's email, and the
 * player must not already belong to a household.
 * @param {(env, registrationId) => Promise<number|null>} ensurePlayer find-or-create
 * @returns {Promise<number|null>} the player id, or null if not claimable
 */
export async function claimChild(env, accountId, registrationId, ensurePlayer, profile) {
  const household = await getHousehold(env, accountId);
  if (!household) return null;
  const reg = await env.DB.prepare(
    `SELECT r.id FROM registrations r JOIN accounts a ON a.id = ?1
      WHERE r.id = ?2 AND r.parent_email_norm = a.email_norm AND r.status != 'cancelled'`
  )
    .bind(accountId, registrationId)
    .first();
  if (!reg) return null;
  const playerId = await ensurePlayer(env, registrationId);
  if (!playerId) return null;
  const res = await env.DB.prepare(
    `UPDATE players
        SET household_id = ?3, updated_at = ?4,
            school = COALESCE(school, ?5),
            grade_level = COALESCE(grade_level, ?6),
            grade_school_year = COALESCE(grade_school_year, ?7)
      WHERE id = ?2 AND household_id IS NULL
        AND parent_email_norm = (SELECT email_norm FROM accounts WHERE id = ?1)
        AND ?3 IN (${MEMBER_OF})`
  )
    .bind(accountId, playerId, household.id, iso(), profile.school, profile.gradeLevel, profile.gradeSchoolYear)
    .run();
  return res.meta.changes === 1 ? playerId : null;
}

// --- emergency contacts ---------------------------------------------------------

export async function listEmergencyContacts(env, accountId) {
  const { results } = await env.DB.prepare(
    `SELECT priority, name, phone, relationship FROM household_emergency_contacts
      WHERE household_id IN (${MEMBER_OF}) ORDER BY priority`
  )
    .bind(accountId)
    .all();
  return results || [];
}

/** Replace the household's contacts with `contacts` (priority 1..3, in order). */
export async function replaceEmergencyContacts(env, accountId, contacts) {
  const household = await getHousehold(env, accountId);
  if (!household) return false;
  const now = iso();
  const statements = [
    env.DB.prepare(`DELETE FROM household_emergency_contacts WHERE household_id = ?2 AND ?2 IN (${MEMBER_OF})`).bind(
      accountId,
      household.id
    ),
    ...contacts.map((c, i) =>
      env.DB.prepare(
        `INSERT INTO household_emergency_contacts (household_id, priority, name, phone, relationship, created_at, updated_at)
         SELECT ?2, ?3, ?4, ?5, ?6, ?7, ?7 WHERE ?2 IN (${MEMBER_OF})`
      ).bind(accountId, household.id, i + 1, c.name, c.phone, c.relationship, now)
    ),
  ];
  await env.DB.batch(statements);
  return true;
}
