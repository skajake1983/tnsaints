/**
 * Inviting people to an event (the Events plan, phase EV5).
 *
 * WHO: chosen from sources staff tick — people who signed up for earlier
 * events, the academy's families, a team's families, CRM contacts by kind and
 * stage — and always WITHOUT: anyone marked do-not-contact (a contact, or a
 * portal family), anyone who unsubscribed (email_suppressions), anyone already
 * invited to this event, anyone already signed up for it. One address once.
 *
 * NOTHING IS SENT WITHOUT APPROVAL (the owner, 2026-10-21): an invitation is
 * a draft campaign whose rows are 'held'. Approving it (messages:approve, and
 * the academy's mailing address set, for the legally required footer) queues
 * them; the hourly sender, and staff's "Send the next 10", send them only
 * while INVITES_ENABLED is "true", within the 'invite' email lane (which
 * always leaves room for sign-up receipts).
 *
 * UNSUBSCRIBE: every invitation carries its own token; the link (and the
 * one-click header Gmail and Outlook use) suppresses that address for every
 * future invitation, by keyed hash only. Evaluation results and receipts are
 * not invitations and are not stopped by it.
 *
 * Counts only in the audit log; addresses never leave the database except in
 * the email itself and staff's Outlook copy (crm:export, audited by count).
 */

import { keyedHash, randomToken } from '../lib/crypto.js';
import { flag } from '../lib/flags.js';
import { reserveSend, refundSend, budgetStatus } from '../email-budget.js';
import { sendEventInvitation } from '../email.js';
import { withEvent } from '../programs/evaluation.js';

const iso = () => new Date().toISOString();
const norm = (e) => String(e || '').trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const MAX_AUDIENCE = 500;
export const SEND_NOW = 10;
export const PER_RUN = 4;
export const CONTACT_KINDS = ['family', 'coach', 'volunteer', 'sponsor', 'donor', 'other'];

/** What staff can choose from: past events with sign-ups, and teams. */
export async function audienceOptions(env, eventId) {
  const [events, teams, stages] = await env.DB.batch([
    env.DB.prepare(
      `SELECT p.id, p.name, COALESCE(p.event_kind, p.kind) AS kind, COALESCE(p.starts_on, substr(p.id, 1, 10)) AS day,
              (SELECT COUNT(*) FROM registrations r WHERE r.event_id = p.id AND r.status != 'cancelled')
            + (SELECT COUNT(*) FROM event_interest i WHERE i.event_id = p.id AND i.status != 'withdrawn')
            + (SELECT COUNT(*) FROM event_teams t WHERE t.event_id = p.id AND t.status != 'withdrawn') AS signups
         FROM programs p
        WHERE p.id != ?1 AND (p.signup_mode IN ('spot', 'interest', 'team') OR p.kind = 'evaluation')
        ORDER BY day DESC LIMIT 60`
    ).bind(eventId),
    env.DB.prepare(`SELECT id, name FROM programs WHERE kind = 'team' AND status != 'archived' ORDER BY name LIMIT 60`),
    env.DB.prepare(`SELECT pipeline, stage, label FROM crm_stages ORDER BY pipeline, position`),
  ]);
  return {
    events: (events.results || []).filter((e) => Number(e.signups) > 0),
    teams: teams.results || [],
    stages: stages.results || [],
  };
}

/** The chosen sources, read from a form (GET or POST) and checked against what exists. */
export function readAudience(form, options) {
  const all = (name) => (typeof form.getAll === 'function' ? form.getAll(name) : []).map(String);
  const eventIds = new Set(options.events.map((e) => e.id));
  const teamIds = new Set(options.teams.map((t) => t.id));
  const stageKeys = new Set(options.stages.map((s) => `${s.pipeline}:${s.stage}`));
  const stage = String(form.get('crm_stage') || '');
  return {
    events: all('from_event').filter((id) => eventIds.has(id)).slice(0, 20),
    academy: form.get('academy') === '1',
    teams: all('team').filter((id) => teamIds.has(id)).slice(0, 20),
    crmKinds: all('crm_kind').filter((k) => CONTACT_KINDS.includes(k)),
    crmStage: stageKeys.has(stage) ? stage : '',
  };
}

export const audienceEmpty = (a) => !a.events.length && !a.academy && !a.teams.length && !a.crmKinds.length && !a.crmStage;

/**
 * Everyone the sources name, after every exclusion, at most MAX_AUDIENCE.
 * @returns {Promise<{people: Array<{email, name, contact_id}>, bySource: object, excluded: number, capped: boolean}>}
 */
export async function buildAudience(env, eventId, a) {
  const p = (sql, ...args) => env.DB.prepare(sql).bind(...args);
  const statements = [];
  const labels = [];
  if (a.events.length) {
    const ids = JSON.stringify(a.events);
    statements.push(p(
      `SELECT parent_email AS email, parent_name AS name FROM registrations
        WHERE event_id IN (SELECT value FROM json_each(?1)) AND status != 'cancelled'
       UNION ALL SELECT parent_email, parent_name FROM event_interest
        WHERE event_id IN (SELECT value FROM json_each(?1)) AND status != 'withdrawn'
       UNION ALL SELECT coach_email, coach_name FROM event_teams
        WHERE event_id IN (SELECT value FROM json_each(?1)) AND status != 'withdrawn'`, ids));
    labels.push('events');
  }
  if (a.academy) {
    statements.push(env.DB.prepare(
      `SELECT DISTINCT ac.email, ac.display_name AS name FROM enrollments e
         JOIN programs pr ON pr.id = e.program_id AND pr.kind = 'academy'
         JOIN household_members m ON m.household_id = e.household_id
         JOIN accounts ac ON ac.id = m.account_id AND ac.status = 'active'
        WHERE e.status IN ('active', 'past_due')
          AND NOT EXISTS (SELECT 1 FROM crm_household_meta hm WHERE hm.household_id = e.household_id AND hm.do_not_contact = 1)`));
    labels.push('academy');
  }
  if (a.teams.length) {
    statements.push(p(
      `SELECT DISTINCT ac.email, ac.display_name AS name FROM enrollments e
         JOIN household_members m ON m.household_id = e.household_id
         JOIN accounts ac ON ac.id = m.account_id AND ac.status = 'active'
        WHERE e.program_id IN (SELECT value FROM json_each(?1)) AND e.status IN ('active', 'past_due')
          AND NOT EXISTS (SELECT 1 FROM crm_household_meta hm WHERE hm.household_id = e.household_id AND hm.do_not_contact = 1)`,
      JSON.stringify(a.teams)));
    labels.push('teams');
  }
  if (a.crmKinds.length || a.crmStage) {
    const [pipeline, stage] = a.crmStage ? a.crmStage.split(':') : ['', ''];
    statements.push(p(
      `SELECT c.email, c.name, c.id AS contact_id FROM crm_contacts c
        WHERE c.status = 'active' AND c.email IS NOT NULL AND c.do_not_contact = 0
          AND (?1 = '[]' OR c.kind IN (SELECT value FROM json_each(?1)))
          AND (?2 = '' OR EXISTS (SELECT 1 FROM crm_opportunities o WHERE o.contact_id = c.id AND o.pipeline = ?2
                                   AND o.stage = ?3 AND o.closed_at IS NULL))`,
      JSON.stringify(a.crmKinds), pipeline, stage));
    labels.push('crm');
  }
  if (!statements.length) return { people: [], bySource: {}, excluded: 0, capped: false };
  // Who must never be invited, whatever the source: do-not-contact, and
  // anyone already signed up for this event.
  statements.push(p(
    `SELECT email_norm AS e FROM crm_contacts WHERE do_not_contact = 1 AND email_norm IS NOT NULL
     UNION SELECT parent_email_norm FROM registrations WHERE event_id = ?1 AND status != 'cancelled'
     UNION SELECT coach_email_norm FROM event_teams WHERE event_id = ?1 AND status != 'withdrawn'`, eventId));
  const out = await env.DB.batch(statements);
  const blocked = new Set((out[out.length - 1].results || []).map((r) => r.e));
  const seen = new Map();
  const bySource = {};
  let excluded = 0;
  out.slice(0, -1).forEach((res, i) => {
    let n = 0;
    for (const r of res.results || []) {
      const e = norm(r.email);
      if (!EMAIL_RE.test(e) || e.startsWith('deleted:')) continue;
      n += 1;
      if (blocked.has(e)) { excluded += 1; continue; }
      if (!seen.has(e)) seen.set(e, { email: String(r.email).trim(), name: r.name || '', contact_id: r.contact_id || null });
    }
    bySource[labels[i]] = n;
  });
  // Unsubscribed, by hash; and anyone already invited to this event.
  const people = [...seen.values()];
  const hashes = await Promise.all(people.map((x) => keyedHash(env, 'email', norm(x.email))));
  const [suppressed, invited] = await env.DB.batch([
    p(`SELECT email_hash FROM email_suppressions WHERE email_hash IN (SELECT value FROM json_each(?1))`, JSON.stringify(hashes)),
    p(`SELECT email_hash FROM event_invitations WHERE event_id = ?1 AND email_hash IN (SELECT value FROM json_each(?2))`,
      eventId, JSON.stringify(hashes)),
  ]);
  const gone = new Set([...(suppressed.results || []), ...(invited.results || [])].map((r) => r.email_hash));
  const kept = [];
  people.forEach((x, i) => {
    if (gone.has(hashes[i])) { excluded += 1; return; }
    kept.push({ ...x, hash: hashes[i] });
  });
  return { people: kept.slice(0, MAX_AUDIENCE), bySource, excluded, capped: kept.length > MAX_AUDIENCE };
}

/** A draft campaign with its rows held: one batch. */
export async function createCampaign(env, { eventId, subject, message, audience, people, actor }) {
  const now = iso();
  const camp = await env.DB.prepare(
    `INSERT INTO invite_campaigns (event_id, subject, message, audience, status, created_by, created_at)
     VALUES (?1, ?2, ?3, ?4, 'draft', ?5, ?6) RETURNING id`
  ).bind(eventId, subject, message, JSON.stringify(audience), actor, now).first();
  const rows = people.map((x) => ({ e: x.email, n: norm(x.email), h: x.hash, m: x.name || null, c: x.contact_id, t: randomToken(32) }));
  // INSERT OR IGNORE: an address already invited to this event (a race with
  // another campaign) is simply not invited twice.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO event_invitations (campaign_id, event_id, email, email_norm, email_hash, name, contact_id, token,
                                              send_state, created_at, updated_at)
     SELECT ?1, ?2, json_extract(value, '$.e'), json_extract(value, '$.n'), json_extract(value, '$.h'), json_extract(value, '$.m'),
            json_extract(value, '$.c'), json_extract(value, '$.t'), 'held', ?3, ?3
       FROM json_each(?4)`
  ).bind(Number(camp.id), eventId, now, JSON.stringify(rows)).run();
  return Number(camp.id);
}

export function readMessage(form) {
  const subject = String(form.get('subject') || '').trim().replace(/\s+/g, ' ');
  const message = String(form.get('message') || '').replace(/\r\n/g, '\n').trim();
  const errors = [];
  if (!subject || subject.length > 120) errors.push('Write a subject (up to 120 characters).');
  if (!message || message.length > 1500) errors.push('Write a message (up to 1500 characters).');
  return { subject, message, errors };
}

/** A campaign and its numbers. */
export async function campaignSummary(env, eventId, campaignId) {
  const [camp, counts] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM invite_campaigns WHERE id = ?1 AND event_id = ?2`).bind(campaignId, eventId),
    env.DB.prepare(`SELECT send_state, COUNT(*) AS n, SUM(registered_at IS NOT NULL) AS registered FROM event_invitations
                     WHERE campaign_id = ?1 GROUP BY send_state`).bind(campaignId),
  ]);
  const c = camp.results?.[0];
  if (!c) return null;
  const n = { held: 0, queued: 0, sending: 0, sent: 0, failed: 0, cancelled: 0, registered: 0, total: 0 };
  for (const r of counts.results || []) {
    n[r.send_state] = Number(r.n);
    n.registered += Number(r.registered || 0);
    n.total += Number(r.n);
  }
  return { campaign: c, counts: n };
}

export async function listCampaigns(env, eventId) {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.subject, c.status, c.created_at,
            (SELECT COUNT(*) FROM event_invitations i WHERE i.campaign_id = c.id) AS total,
            (SELECT COUNT(*) FROM event_invitations i WHERE i.campaign_id = c.id AND i.send_state = 'sent') AS sent,
            (SELECT COUNT(*) FROM event_invitations i WHERE i.campaign_id = c.id AND i.registered_at IS NOT NULL) AS registered
       FROM invite_campaigns c WHERE c.event_id = ?1 ORDER BY c.created_at DESC LIMIT 20`
  ).bind(eventId).all();
  return results || [];
}

/** Approve: the footer needs the academy's mailing address (CAN-SPAM). Held rows become queued. */
export async function approveCampaign(env, eventId, campaignId, actor) {
  if (!String(env.MAILING_ADDRESS || '').trim()) return 'needs-address';
  const now = iso();
  const res = await env.DB.prepare(
    `UPDATE invite_campaigns SET status = 'approved', approved_by = ?3, approved_at = ?4
      WHERE id = ?1 AND event_id = ?2 AND status = 'draft'`
  ).bind(campaignId, eventId, actor, now).run();
  if (!res.meta?.changes) return 'invalid';
  await env.DB.prepare(`UPDATE event_invitations SET send_state = 'queued', updated_at = ?2 WHERE campaign_id = ?1 AND send_state = 'held'`)
    .bind(campaignId, now).run();
  return 'approved';
}

export async function cancelCampaign(env, eventId, campaignId) {
  const now = iso();
  const res = await env.DB.prepare(
    `UPDATE invite_campaigns SET status = 'cancelled', cancelled_at = ?3 WHERE id = ?1 AND event_id = ?2 AND status != 'cancelled'`
  ).bind(campaignId, eventId, now).run();
  if (!res.meta?.changes) return 'invalid';
  await env.DB.prepare(`UPDATE event_invitations SET send_state = 'cancelled', updated_at = ?2
                         WHERE campaign_id = ?1 AND send_state IN ('held', 'queued')`).bind(campaignId, now).run();
  return 'cancelled';
}

/** The addresses an invitation would reach, for an Outlook BCC, in pieces of 400. */
export function bccChunks(people, size = 400) {
  const out = [];
  for (let i = 0; i < people.length; i += size) out.push(people.slice(i, i + size).map((x) => x.email).join('; '));
  return out;
}

/** How many of `queued` can go today, and the rest over the following days, from the invite lane. */
export async function sendEstimate(env, queued) {
  const lane = await budgetStatus(env, 'invite');
  const today = Math.min(queued, lane.remaining);
  return { today, later: queued - today, perDay: lane.limit };
}

/**
 * Send up to `limit` queued invitations of approved campaigns for events that
 * are still open. Only while INVITES_ENABLED is "true". Each is claimed
 * before it is sent, so two senders never send the same one; a provider
 * failure puts it back (three tries), an empty lane stops the run.
 */
export async function drainInvitations(env, { limit = PER_RUN, campaignId = null } = {}) {
  if (!flag(env, 'INVITES_ENABLED', false)) return { sent: 0, skipped: 'disabled' };
  if (!String(env.MAILING_ADDRESS || '').trim()) return { sent: 0, skipped: 'no-address' };
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.email, i.name, i.token, i.event_id, i.attempts, c.subject, c.message
       FROM event_invitations i
       JOIN invite_campaigns c ON c.id = i.campaign_id AND c.status = 'approved'
       JOIN programs p ON p.id = i.event_id AND p.status = 'open'
      WHERE i.send_state = 'queued' AND i.email IS NOT NULL AND (?2 IS NULL OR i.campaign_id = ?2)
      ORDER BY i.id LIMIT ?1`
  ).bind(limit, campaignId).all();
  let sent = 0;
  let failed = 0;
  const events = new Map();
  for (const inv of results || []) {
    const claim = await env.DB.prepare(
      `UPDATE event_invitations SET send_state = 'sending', attempts = attempts + 1, updated_at = ?2
        WHERE id = ?1 AND send_state = 'queued'`
    ).bind(inv.id, iso()).run();
    if (!claim.meta?.changes) continue;
    if (!(await reserveSend(env, { lane: 'invite', recipients: 1 }))) {
      await env.DB.prepare(`UPDATE event_invitations SET send_state = 'queued', attempts = attempts - 1 WHERE id = ?1`).bind(inv.id).run();
      return { sent, failed, stopped: 'budget' };
    }
    if (!events.has(inv.event_id)) events.set(inv.event_id, await withEvent(env, inv.event_id));
    try {
      await sendEventInvitation(events.get(inv.event_id), { invitation: inv });
      await env.DB.prepare(`UPDATE event_invitations SET send_state = 'sent', sent_at = ?2, last_error = NULL, updated_at = ?2
                             WHERE id = ?1`).bind(inv.id, iso()).run();
      sent += 1;
    } catch (err) {
      await refundSend(env, { recipients: 1 });
      await env.DB.prepare(`UPDATE event_invitations SET send_state = ?2, last_error = ?3, updated_at = ?4 WHERE id = ?1`)
        .bind(inv.id, Number(inv.attempts) + 1 >= 3 ? 'failed' : 'queued', String(err?.message || 'send failed').slice(0, 300), iso())
        .run();
      failed += 1;
    }
  }
  return { sent, failed };
}

/** The invitation behind an unsubscribe link, for the inert page: a masked address only. */
export async function lookupUnsubscribe(env, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const row = await env.DB.prepare(
    `SELECT i.email_norm, i.email_hash, EXISTS (SELECT 1 FROM email_suppressions s WHERE s.email_hash = i.email_hash) AS done
       FROM event_invitations i WHERE i.token = ?1`
  ).bind(token).first();
  if (!row) return null;
  const e = String(row.email_norm || '');
  const [local, domain] = e.split('@');
  return { masked: domain ? `${local.length > 1 ? local[0] : ''}•••@${domain}` : 'your address', done: Boolean(Number(row.done)), hash: row.email_hash };
}

/** Stop every future invitation to the address behind this token. Safe to repeat. */
export async function applyUnsubscribe(env, token, source) {
  const found = await lookupUnsubscribe(env, token);
  if (!found) return { ok: false };
  const now = iso();
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO email_suppressions (email_hash, reason, source, created_at) VALUES (?1, 'unsubscribe', ?2, ?3)`)
      .bind(found.hash, source, now),
    env.DB.prepare(`UPDATE event_invitations SET send_state = 'cancelled', updated_at = ?2
                     WHERE email_hash = ?1 AND send_state IN ('held', 'queued')`).bind(found.hash, now),
    env.DB.prepare(
      `INSERT INTO crm_activities (kind, detail, contact_id, actor, occurred_at, created_at)
       SELECT 'unsubscribe', json_object('from', 'invitations'), c.id, 'system:unsubscribe', ?2, ?2
         FROM crm_contacts c WHERE c.email_norm = (SELECT email_norm FROM event_invitations WHERE token = ?1)
          AND ?3 = 0`
    ).bind(token, now, found.done ? 1 : 0),
  ]);
  return { ok: true, already: found.done };
}

/** A sign-up through an invitation link: mark it, once. */
export async function markInvitationUsed(env, eventId, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const row = await env.DB.prepare(
    `UPDATE event_invitations SET registered_at = COALESCE(registered_at, ?3), updated_at = ?3
      WHERE token = ?1 AND event_id = ?2 RETURNING id`
  ).bind(token, eventId, iso()).first();
  return row ? Number(row.id) : null;
}
