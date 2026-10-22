/**
 * Event sign-ups into the CRM (the Events plan, phase EV3). Runs after the
 * family has their answer (register.js ctx.waitUntil), so it never slows or
 * undoes a sign-up. Sends nothing.
 *
 *   - the parent (or a visiting team's coach) becomes, or refreshes, a CRM
 *     contact — the same upsert the website's contact forms use
 *     (intake.js upsertContact), linked to their portal family if they have one
 *   - the child becomes a player at sign-up (the registration's player_id),
 *     so their history is one person across events
 *   - an 'event' activity on the contact's timeline: ids and kinds only
 *   - an evaluation opens (or keeps) the child's family card; the daily
 *     reconcile moves it to "evaluated" once a coach writes about them.
 *     Other events add to the timeline but never move a card.
 */

import { upsertContact } from './intake.js';
import { resolvePlayerId } from '../feedback/players.js';

const iso = () => new Date().toISOString();

async function ensurePlayer(env, name, nameNorm, emailNorm, grade) {
  const now = iso();
  await env.DB.prepare(
    `INSERT INTO players (display_name, name_norm, parent_email_norm, grade, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5) ON CONFLICT (parent_email_norm, name_norm) DO NOTHING`
  ).bind(name, nameNorm, emailNorm, grade || null, now).run();
  const p = await env.DB.prepare(`SELECT id FROM players WHERE parent_email_norm = ?1 AND name_norm = ?2`)
    .bind(emailNorm, nameNorm).first();
  return p ? Number(p.id) : null;
}

/** @param {{event: object, mode: string, value: object, result: object}} signup */
export async function recordEventSignup(env, { event, mode, value, result }) {
  const now = iso();
  const team = mode === 'team';
  const contact = await upsertContact(env, {
    kind: team ? 'other' : 'family',
    name: team ? value.coach_name : value.parent_name,
    email: team ? value.coach_email : value.parent_email,
    phone: team ? value.coach_phone : value.phone,
    organization: team ? value.team_name : null,
    source: `event:${event.id}`,
  });

  let playerId = null;
  if (mode === 'spot' && result.registrationId) {
    playerId = await resolvePlayerId(env, result.registrationId);
  } else if (mode === 'interest' && result.interestId) {
    playerId = await ensurePlayer(env, value.player_name, value.player_name_norm, value.parent_email_norm, value.grade);
    if (playerId) {
      await env.DB.prepare(`UPDATE event_interest SET player_id = ?2 WHERE id = ?1 AND player_id IS NULL`)
        .bind(result.interestId, playerId).run();
    }
  }

  const detail = JSON.stringify({
    event: event.id, kind: event.kind, mode, status: result.status,
    ...(result.registrationId ? { registration: result.registrationId } : {}),
    ...(result.interestId ? { interest: result.interestId } : {}),
    ...(result.teamId ? { team: result.teamId } : {}),
  });
  const statements = [
    env.DB.prepare(
      `INSERT INTO crm_activities (kind, detail, contact_id, household_id, actor, occurred_at, created_at)
       VALUES ('event', ?1, ?2, ?3, 'system:website', ?4, ?4)`
    ).bind(detail, contact.id, contact.household_id, now),
  ];

  // An evaluation is where a family's card starts: one per child, as the
  // contact form's player-interest does (intake.js recordLead).
  if (event.kind === 'evaluation' && mode === 'spot' && value.player_name) {
    let p = await env.DB.prepare(
      `SELECT id FROM crm_prospect_players WHERE contact_id = ?1 AND lower(name) = lower(?2)`
    ).bind(contact.id, value.player_name).first();
    if (!p) {
      p = await env.DB.prepare(
        `INSERT INTO crm_prospect_players (contact_id, name, school, player_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5) RETURNING id`
      ).bind(contact.id, value.player_name, value.school || null, playerId, now).first();
    } else if (playerId) {
      statements.push(env.DB.prepare(`UPDATE crm_prospect_players SET player_id = ?2 WHERE id = ?1 AND player_id IS NULL`)
        .bind(p.id, playerId));
    }
    statements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO crm_opportunities (pipeline, stage, contact_id, household_id, prospect_player_id, player_id,
                                                source, opened_at, created_at, updated_at)
       VALUES ('family', 'eval_registered', ?1, ?2, ?3, ?4, ?5, ?6, ?6, ?6)`
    ).bind(contact.id, contact.household_id, p.id, playerId, `event:${event.id}`, now));
  }
  await env.DB.batch(statements);
  return { contactId: contact.id, playerId };
}
