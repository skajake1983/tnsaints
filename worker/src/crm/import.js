/**
 * Past evaluation registrations into the CRM (crm:admin), so families who
 * came to an evaluation are in the pipeline: one contact per parent email,
 * one family card per child at "Evaluation registered", or "Evaluation
 * attended" if a coach wrote about them.
 *
 * Idempotent: a parent email already in the CRM is not added again, a child
 * who already has a family card (open or closed) gets no second one, and a
 * parent with a portal account gets no contact at all — their card belongs to
 * their family. Cancelled registrations are left out. The preview counts what
 * a run would do, and the run itself is a fixed number of statements.
 */

import { reconcileCrm } from './reconcile.js';

const KEPT = `('confirmed', 'waitlist')`;
const PORTAL = (email) => `EXISTS (SELECT 1 FROM accounts a WHERE a.email_norm = ${email} AND a.status = 'active')`;
const DIGITS = (col) =>
  `replace(replace(replace(replace(replace(replace(COALESCE(${col}, ''), '(', ''), ')', ''), '-', ''), ' ', ''), '.', ''), '+', '')`;

/** What an import would do now. */
export async function previewImport(env) {
  const row = await env.DB.prepare(
    `SELECT
       COUNT(DISTINCT r.parent_email_norm) AS families,
       COUNT(DISTINCT r.player_id) AS children,
       COUNT(DISTINCT CASE WHEN NOT ${PORTAL('r.parent_email_norm')}
                            AND NOT EXISTS (SELECT 1 FROM crm_contacts c WHERE c.email_norm = r.parent_email_norm)
                           THEN r.parent_email_norm END) AS new_contacts,
       COUNT(DISTINCT CASE WHEN NOT EXISTS (SELECT 1 FROM crm_opportunities o WHERE o.pipeline = 'family'
                                              AND o.player_id = r.player_id)
                           THEN r.player_id END) AS new_cards,
       COUNT(DISTINCT CASE WHEN ${PORTAL('r.parent_email_norm')} THEN r.parent_email_norm END) AS portal_families,
       COUNT(DISTINCT r.event_id) AS events
     FROM registrations r
    WHERE r.status IN ${KEPT} AND r.player_id IS NOT NULL AND r.parent_email_norm IS NOT NULL`
  ).first();
  return {
    families: Number(row?.families || 0),
    children: Number(row?.children || 0),
    newContacts: Number(row?.new_contacts || 0),
    newCards: Number(row?.new_cards || 0),
    portalFamilies: Number(row?.portal_families || 0),
    events: Number(row?.events || 0),
  };
}

/**
 * Import. Returns how many contacts and cards were created.
 * @returns {Promise<{contacts: number, cards: number}>}
 */
export async function runImport(env, { now = new Date() } = {}) {
  const at = now.toISOString();
  const results = await env.DB.batch([
    // One contact per parent email: details from their most recent registration.
    env.DB.prepare(
      `INSERT INTO crm_contacts (kind, name, email, email_norm, phone, phone_norm, source, created_at, updated_at)
       SELECT 'family', r.parent_name, r.parent_email, r.parent_email_norm, r.phone,
              CASE WHEN length(${DIGITS('r.phone')}) = 11 AND substr(${DIGITS('r.phone')}, 1, 1) = '1'
                   THEN substr(${DIGITS('r.phone')}, 2) ELSE NULLIF(${DIGITS('r.phone')}, '') END,
              'import:' || r.event_id, ?1, ?1
         FROM registrations r
        WHERE r.status IN ${KEPT} AND r.player_id IS NOT NULL AND r.parent_email_norm IS NOT NULL
          AND r.id = (SELECT MAX(r2.id) FROM registrations r2
                       WHERE r2.parent_email_norm = r.parent_email_norm AND r2.status IN ${KEPT})
          AND NOT ${PORTAL('r.parent_email_norm')}
          AND NOT EXISTS (SELECT 1 FROM crm_contacts c WHERE c.email_norm = r.parent_email_norm)`
    ).bind(at),
    // One card per child: the most recent registration decides the stage.
    env.DB.prepare(
      `INSERT INTO crm_opportunities (pipeline, stage, contact_id, household_id, player_id, source, opened_at,
                                      created_at, updated_at)
       SELECT 'family',
              CASE WHEN EXISTS (SELECT 1 FROM eval_feedback f WHERE f.registration_id = r.id)
                   THEN 'eval_attended' ELSE 'eval_registered' END,
              (SELECT c.id FROM crm_contacts c WHERE c.email_norm = r.parent_email_norm),
              COALESCE((SELECT p.household_id FROM players p WHERE p.id = r.player_id),
                       (SELECT hm.household_id FROM household_members hm JOIN accounts a ON a.id = hm.account_id
                         WHERE a.email_norm = r.parent_email_norm ORDER BY hm.created_at LIMIT 1)),
              r.player_id, 'import:' || r.event_id, r.created_at, ?1, ?1
         FROM registrations r
        WHERE r.status IN ${KEPT} AND r.player_id IS NOT NULL AND r.parent_email_norm IS NOT NULL
          AND r.id = (SELECT MAX(r2.id) FROM registrations r2 WHERE r2.player_id = r.player_id AND r2.status IN ${KEPT})
          AND NOT EXISTS (SELECT 1 FROM crm_opportunities o WHERE o.pipeline = 'family' AND o.player_id = r.player_id)`
    ).bind(at),
    // The timeline says where each new card came from.
    env.DB.prepare(
      `INSERT INTO crm_activities (kind, detail, contact_id, household_id, opportunity_id, actor, occurred_at, created_at)
       SELECT 'import', json_object('source', o.source), o.contact_id, o.household_id, o.id, 'system', ?1, ?1
         FROM crm_opportunities o
        WHERE o.created_at = ?1 AND o.source LIKE 'import:%' AND (o.contact_id IS NOT NULL OR o.household_id IS NOT NULL)`
    ).bind(at),
  ]);
  await reconcileCrm(env, { now });
  return { contacts: results[0].meta?.changes || 0, cards: results[1].meta?.changes || 0 };
}
