/**
 * Durable player identity.
 *
 * A registration is event-scoped: it says "this child signed up for the August
 * evaluation". A player is the child. Notes, feedback, and every future message
 * anchor to the player, so a second event next spring extends one history
 * rather than starting a parallel one.
 *
 * Identity is (parent_email_norm, name_norm) — deliberately the SAME pair the
 * registration duplicate-guard already computes and stores. Reusing it rather
 * than inventing a second normalisation means the two can never disagree about
 * whether two rows are the same child, which is the failure that would quietly
 * split one family's history in half.
 */

/**
 * Resolve the player for a registration, creating the row if needed.
 *
 * Called lazily — the first time a coach writes about a registration — rather
 * than during signup. The public registration endpoint is the one path that
 * must stay fast during a rush and must never fail for a reason unrelated to
 * claiming a spot, so it does not pay for this.
 *
 * The INSERT is guarded by the unique identity index rather than by a
 * check-then-insert, so two coaches opening the same player at the same moment
 * cannot create two rows. Whoever loses the race falls through to the SELECT
 * and gets the winner's row.
 *
 * @returns {Promise<number|null>} player id, or null if the registration is gone
 */
export async function resolvePlayerId(env, registrationId) {
  const reg = await env.DB.prepare(
    `SELECT id, player_id, player_name, player_name_norm, parent_email_norm, grade
       FROM registrations
      WHERE id = ?1`
  )
    .bind(registrationId)
    .first();

  if (!reg) return null;
  if (reg.player_id) return Number(reg.player_id);

  const now = new Date().toISOString();

  // ON CONFLICT DO NOTHING rather than an existence check: the unique index is
  // the authority, and letting the database arbitrate removes the window where
  // two concurrent writers both see "no row" and both insert.
  await env.DB.prepare(
    `INSERT INTO players (display_name, name_norm, parent_email_norm, grade, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT (parent_email_norm, name_norm) DO NOTHING`
  )
    .bind(reg.player_name, reg.player_name_norm, reg.parent_email_norm, reg.grade || null, now)
    .run();

  const player = await env.DB.prepare(
    `SELECT id FROM players WHERE parent_email_norm = ?1 AND name_norm = ?2`
  )
    .bind(reg.parent_email_norm, reg.player_name_norm)
    .first();

  if (!player) return null;

  // Cache it on the registration so later reads are a plain column, not a join.
  await env.DB.prepare(`UPDATE registrations SET player_id = ?2 WHERE id = ?1 AND player_id IS NULL`)
    .bind(registrationId, player.id)
    .run();

  return Number(player.id);
}
