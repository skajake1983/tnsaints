/**
 * Keeping the CRM in step with the portal, without the portal knowing the
 * CRM exists. Run daily by the job runner and whenever staff open the CRM.
 *
 *   1. A lead whose email now has a portal account is LINKED to that family.
 *      Its cards, tasks, inquiries and timeline follow it.
 *   2. A child named on a lead is matched to the PLAYER: the family's child of
 *      that name, or the child registered for an evaluation under that email.
 *   3. Family cards MOVE with what happens: registered for or evaluated at an
 *      evaluation; applied (or waiting), offered a seat, enrolled — the last
 *      closes the card as won. Families who came straight to the portal get a
 *      card for each child with an academy place.
 *   4. A linked family lead is CONVERTED: the household is now the record of
 *      who they are, so the lead's copy of their name, email and phone — and a
 *      matched child's name — is cleared. An owner or do-not-contact set on
 *      the lead carries over to the family.
 *
 * Coaches, volunteers and sponsors who also have a portal family are linked
 * but keep their details: they are in the CRM for another relationship.
 *
 * SET-BASED: one batch of fixed size whatever the number of rows, so it fits
 * the job runner's query budget at any scale. Each statement that moves a card
 * writes the timeline entry first, from the state before the move.
 */

const LIVE = `('applied', 'waitlist', 'offered', 'active', 'past_due')`;
const FAMILY_EMAIL = (email) => `(SELECT hm.household_id FROM household_members hm JOIN accounts a ON a.id = hm.account_id
                                   WHERE a.email_norm = ${email} AND a.status = 'active' ORDER BY hm.created_at LIMIT 1)`;
const NORM = (expr) => `lower(trim(${expr}))`;

/** The family-pipeline stage a child's academy place implies, or NULL if none. */
const ACADEMY_TARGET = (player) => `(SELECT CASE MAX(CASE WHEN e.status IN ('active', 'past_due') THEN 3
                                                          WHEN e.status = 'offered' THEN 2 ELSE 1 END)
                                              WHEN 3 THEN 'enrolled' WHEN 2 THEN 'offered' WHEN 1 THEN 'applied' END
                                        FROM enrollments e JOIN programs pr ON pr.id = e.program_id AND pr.kind = 'academy'
                                       WHERE e.player_id = ${player} AND e.status IN ${LIVE})`;

/** The stage an evaluation implies: evaluated if any coach wrote about the child. */
const EVAL_TARGET = (player) => `(CASE WHEN EXISTS (SELECT 1 FROM eval_feedback f JOIN registrations r ON r.id = f.registration_id
                                                    WHERE r.player_id = ${player}) THEN 'eval_attended'
                                       WHEN EXISTS (SELECT 1 FROM registrations r WHERE r.player_id = ${player}
                                                    AND r.status != 'cancelled') THEN 'eval_registered' END)`;

/** The child a prospect names: in the linked family, else registered under the lead's email. */
const PROSPECT_PLAYER = `COALESCE(
  (SELECT p.id FROM players p JOIN crm_contacts c ON c.id = crm_prospect_players.contact_id
    WHERE c.household_id IS NOT NULL AND p.household_id = c.household_id
      AND ${NORM('p.display_name')} = ${NORM('crm_prospect_players.name')} ORDER BY p.id LIMIT 1),
  (SELECT r.player_id FROM registrations r JOIN crm_contacts c ON c.id = crm_prospect_players.contact_id
    WHERE c.email_norm IS NOT NULL AND r.parent_email_norm = c.email_norm AND r.player_id IS NOT NULL
      AND r.player_name_norm = ${NORM('crm_prospect_players.name')} ORDER BY r.id DESC LIMIT 1))`;

const CARD_PLAYER = `(SELECT pp.player_id FROM crm_prospect_players pp WHERE pp.id = crm_opportunities.prospect_player_id)`;

/** Statements in order. Each binds ?1 = now. */
export const RECONCILE_STEPS = [
  ['linkedLogged', `
    INSERT INTO crm_activities (kind, detail, contact_id, household_id, actor, occurred_at, created_at)
    SELECT 'linked', json_object('via', 'email'), c.id, ${FAMILY_EMAIL('c.email_norm')}, 'system', ?1, ?1
      FROM crm_contacts c
     WHERE c.status = 'active' AND c.household_id IS NULL AND c.email_norm IS NOT NULL
       AND ${FAMILY_EMAIL('c.email_norm')} IS NOT NULL`],
  ['linked', `
    UPDATE crm_contacts SET household_id = ${FAMILY_EMAIL('crm_contacts.email_norm')},
           account_id = COALESCE(account_id, (SELECT a.id FROM accounts a
                                               WHERE a.email_norm = crm_contacts.email_norm AND a.status = 'active')),
           updated_at = ?1
     WHERE status = 'active' AND household_id IS NULL AND email_norm IS NOT NULL
       AND ${FAMILY_EMAIL('crm_contacts.email_norm')} IS NOT NULL`],
  ...['crm_opportunities', 'crm_tasks', 'crm_inquiries', 'crm_activities'].map((table) => [`${table}Followed`, `
    UPDATE ${table} SET household_id = (SELECT c.household_id FROM crm_contacts c WHERE c.id = ${table}.contact_id)
     WHERE household_id IS NULL AND ?1 IS NOT NULL
       AND contact_id IN (SELECT id FROM crm_contacts WHERE household_id IS NOT NULL)`]),
  ['prospectsMatched', `
    UPDATE crm_prospect_players SET player_id = ${PROSPECT_PLAYER}, updated_at = ?1
     WHERE player_id IS NULL AND name != '' AND ${PROSPECT_PLAYER} IS NOT NULL`],
  // A card takes its child, unless that child already has an open card in the
  // pipeline (and, of two such cards, only the older): staff merge those.
  ['cardsMatched', `
    UPDATE crm_opportunities SET player_id = ${CARD_PLAYER}, updated_at = ?1
     WHERE player_id IS NULL AND prospect_player_id IS NOT NULL AND ${CARD_PLAYER} IS NOT NULL
       AND (closed_at IS NOT NULL OR (
             NOT EXISTS (SELECT 1 FROM crm_opportunities o2 WHERE o2.pipeline = crm_opportunities.pipeline
                           AND o2.closed_at IS NULL AND o2.player_id = ${CARD_PLAYER})
         AND crm_opportunities.id = (SELECT MIN(o3.id) FROM crm_opportunities o3
                                       JOIN crm_prospect_players pp3 ON pp3.id = o3.prospect_player_id
                                      WHERE o3.pipeline = crm_opportunities.pipeline AND o3.closed_at IS NULL
                                        AND o3.player_id IS NULL AND pp3.player_id = ${CARD_PLAYER})))`],
  ['evalLogged', `
    INSERT INTO crm_activities (kind, detail, contact_id, household_id, opportunity_id, actor, occurred_at, created_at)
    SELECT 'stage', json_object('from', o.stage, 'to', ${EVAL_TARGET('o.player_id')}, 'via', 'evaluation'),
           o.contact_id, o.household_id, o.id, 'system', ?1, ?1
      FROM crm_opportunities o
     WHERE o.pipeline = 'family' AND o.closed_at IS NULL AND o.player_id IS NOT NULL
       AND o.stage IN ('new', 'contacted', 'eval_registered') AND ${EVAL_TARGET('o.player_id')} IS NOT NULL
       AND ${EVAL_TARGET('o.player_id')} != o.stage
       AND NOT (o.stage = 'eval_registered' AND ${EVAL_TARGET('o.player_id')} = 'eval_registered')`],
  ['evalMoved', `
    UPDATE crm_opportunities SET stage = ${EVAL_TARGET('crm_opportunities.player_id')}, updated_at = ?1
     WHERE pipeline = 'family' AND closed_at IS NULL AND player_id IS NOT NULL
       AND stage IN ('new', 'contacted', 'eval_registered') AND ${EVAL_TARGET('crm_opportunities.player_id')} IS NOT NULL
       AND ${EVAL_TARGET('crm_opportunities.player_id')} != stage`],
  ['enrollLogged', `
    INSERT INTO crm_activities (kind, detail, contact_id, household_id, opportunity_id, actor, occurred_at, created_at)
    SELECT CASE WHEN ${ACADEMY_TARGET('o.player_id')} = 'enrolled' THEN 'enrolled' ELSE 'stage' END,
           json_object('from', o.stage, 'to', ${ACADEMY_TARGET('o.player_id')}, 'via', 'enrollment'),
           o.contact_id, COALESCE(o.household_id, (SELECT household_id FROM players WHERE id = o.player_id)), o.id,
           'system', ?1, ?1
      FROM crm_opportunities o
     WHERE o.pipeline = 'family' AND o.closed_at IS NULL AND o.player_id IS NOT NULL
       AND ${ACADEMY_TARGET('o.player_id')} IS NOT NULL AND ${ACADEMY_TARGET('o.player_id')} != o.stage`],
  ['enrollMoved', `
    UPDATE crm_opportunities SET stage = ${ACADEMY_TARGET('crm_opportunities.player_id')},
           household_id = COALESCE(household_id, (SELECT household_id FROM players WHERE id = crm_opportunities.player_id)),
           closed_at = CASE WHEN ${ACADEMY_TARGET('crm_opportunities.player_id')} = 'enrolled' THEN ?1 END,
           updated_at = ?1
     WHERE pipeline = 'family' AND closed_at IS NULL AND player_id IS NOT NULL
       AND ${ACADEMY_TARGET('crm_opportunities.player_id')} IS NOT NULL
       AND ${ACADEMY_TARGET('crm_opportunities.player_id')} != stage`],
  ['portalCards', `
    INSERT INTO crm_opportunities (pipeline, stage, household_id, player_id, source, opened_at, created_at, updated_at, closed_at)
    SELECT 'family', ${ACADEMY_TARGET('e.player_id')}, e.household_id, e.player_id, 'portal', MIN(e.applied_at), ?1, ?1,
           CASE WHEN ${ACADEMY_TARGET('e.player_id')} = 'enrolled' THEN ?1 END
      FROM enrollments e JOIN programs pr ON pr.id = e.program_id AND pr.kind = 'academy'
     WHERE e.status IN ${LIVE}
       AND NOT EXISTS (SELECT 1 FROM crm_opportunities o WHERE o.pipeline = 'family' AND o.player_id = e.player_id
                         AND (o.closed_at IS NULL OR o.closed_at >= e.applied_at))
     GROUP BY e.player_id`],
  ['metaCarried', `
    INSERT INTO crm_household_meta (household_id, owner_email, do_not_contact, updated_by, updated_at)
    SELECT c.household_id, MAX(c.owner_email), MAX(c.do_not_contact), 'system', ?1
      FROM crm_contacts c
     WHERE c.status = 'active' AND c.household_id IS NOT NULL AND c.kind IN ('family', 'other')
     GROUP BY c.household_id
    ON CONFLICT (household_id) DO UPDATE SET
      owner_email = COALESCE(crm_household_meta.owner_email, excluded.owner_email),
      do_not_contact = MAX(crm_household_meta.do_not_contact, excluded.do_not_contact),
      updated_at = excluded.updated_at`],
  ['childNamesCleared', `
    UPDATE crm_prospect_players SET name = '', school = NULL, position = NULL, updated_at = ?1
     WHERE player_id IS NOT NULL AND name != ''
       AND contact_id IN (SELECT id FROM crm_contacts
                           WHERE household_id IS NOT NULL AND kind IN ('family', 'other') AND status = 'active')`],
  ['converted', `
    UPDATE crm_contacts SET status = 'converted', name = NULL, email = NULL, email_norm = NULL,
           phone = NULL, phone_norm = NULL, updated_at = ?1
     WHERE status = 'active' AND household_id IS NOT NULL AND kind IN ('family', 'other')`],
];

/**
 * Run every step in one transaction.
 * @returns {Promise<Record<string, number>>} rows changed per step
 */
export async function reconcileCrm(env, { now = new Date() } = {}) {
  const at = now.toISOString();
  const results = await env.DB.batch(RECONCILE_STEPS.map(([, sql]) => env.DB.prepare(sql).bind(at)));
  const counts = {};
  RECONCILE_STEPS.forEach(([name], i) => { counts[name] = results[i].meta?.changes || 0; });
  return counts;
}
