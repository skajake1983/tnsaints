/**
 * Teams: a group of a 'team' program, its roster (the children enrolled in
 * it), its coaches and its schedule.
 *
 * COACHES MUST BE CLEARED. A coach can be assigned to a team only while their
 * background check, abuse-prevention and concussion training are all current
 * (safety/clearances.js). The check is made when they are assigned; the
 * Clearances page and daily brief show anyone lapsing afterwards.
 *
 * WHAT A COACH SEES of a roster: names, grades, shirt sizes and whether a
 * medical note exists — the same minimisation as the evaluation roster. Notes
 * and family contact details stay with admins (plan item O16 can widen this
 * for head coaches; off by default).
 *
 * THE CALENDAR FEED is a link anyone with it can subscribe to: team name,
 * event kinds, times, places and opponents — never a child. The link carries
 * an HMAC of the team and a per-team secret, so it cannot be guessed, and
 * staff can replace one team's link without touching the others.
 */

import { keyedHash, safeEqual, randomToken } from '../lib/crypto.js';
import { normEmail } from '../auth/access.js';
import { isCleared } from '../safety/clearances.js';
import { centralToIso } from './manage.js';

export const EVENT_KINDS = { practice: 'Practice', game: 'Game', tournament: 'Tournament', other: 'Event' };
const PLACED = `('active', 'past_due')`;
const iso = () => new Date().toISOString();

/** Teams, with counts. A coach sees only the teams they are assigned to. */
export async function listTeams(env, { coachEmail = null } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.name, g.schedule_summary, g.status, p.id AS program_id, p.name AS program_name,
            (SELECT COUNT(*) FROM enrollments e WHERE e.group_id = g.id AND e.status IN ${PLACED}) AS players,
            (SELECT group_concat(s.display_name, ', ') FROM team_coaches tc JOIN staff s ON s.email_norm = tc.staff_email
              WHERE tc.group_id = g.id AND tc.removed_at IS NULL) AS coaches,
            (SELECT MIN(starts_at) FROM team_events te WHERE te.group_id = g.id AND te.cancelled_at IS NULL
              AND te.starts_at >= ?2) AS next_event
       FROM program_groups g JOIN programs p ON p.id = g.program_id AND p.kind = 'team'
      WHERE p.status != 'archived'
        AND (?1 IS NULL OR EXISTS (SELECT 1 FROM team_coaches tc WHERE tc.group_id = g.id AND tc.staff_email = ?1
                                     AND tc.removed_at IS NULL))
      ORDER BY p.name, g.name`
  ).bind(coachEmail ? normEmail(coachEmail) : null, iso()).all();
  return results || [];
}

/** Is this staff member a current coach of this team? */
export async function coachesTeam(env, groupId, email) {
  const row = await env.DB.prepare(
    `SELECT 1 FROM team_coaches WHERE group_id = ?1 AND staff_email = ?2 AND removed_at IS NULL`
  ).bind(groupId, normEmail(email)).first();
  return Boolean(row);
}

/** One team: roster, coaches, schedule. Null if it is not a team. */
export async function teamDetail(env, groupId) {
  const [team, roster, coaches, events] = await env.DB.batch([
    env.DB.prepare(
      `SELECT g.*, p.name AS program_name, p.id AS program_id FROM program_groups g
         JOIN programs p ON p.id = g.program_id AND p.kind = 'team' WHERE g.id = ?1`
    ).bind(groupId),
    env.DB.prepare(
      `SELECT p.id, p.display_name, p.grade_level, p.grade_school_year, p.shirt_size, e.status, h.id AS household_id,
              h.display_name AS family_name, CASE WHEN m.status = 'declared' THEN 1 ELSE 0 END AS has_medical
         FROM enrollments e JOIN players p ON p.id = e.player_id JOIN households h ON h.id = e.household_id
         LEFT JOIN player_medical m ON m.player_id = p.id
        WHERE e.group_id = ?1 AND e.status IN ${PLACED} ORDER BY p.display_name`
    ).bind(groupId),
    env.DB.prepare(
      `SELECT tc.id, tc.staff_email, tc.role, tc.assigned_at, s.display_name FROM team_coaches tc
         LEFT JOIN staff s ON s.email_norm = tc.staff_email
        WHERE tc.group_id = ?1 AND tc.removed_at IS NULL ORDER BY tc.role = 'head' DESC, s.display_name`
    ).bind(groupId),
    env.DB.prepare(
      `SELECT * FROM team_events WHERE group_id = ?1 AND starts_at >= ?2
        ORDER BY starts_at LIMIT 200`
    ).bind(groupId, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()),
  ]);
  const row = team.results?.[0];
  if (!row) return null;
  return { team: row, roster: roster.results || [], coaches: coaches.results || [], events: events.results || [] };
}

/**
 * Assign a coach. They must be active staff (coach or admin) and fully cleared.
 * @returns {Promise<'assigned'|'not-staff'|'not-cleared'|'exists'|'invalid'>}
 */
export async function assignCoach(env, { groupId, email, role, actor }) {
  if (!['head', 'assistant'].includes(role)) return 'invalid';
  const who = normEmail(email);
  const staff = await env.DB.prepare(
    `SELECT email_norm FROM staff WHERE email_norm = ?1 AND active = 1 AND role IN ('coach', 'admin')`
  ).bind(who).first();
  if (!staff) return 'not-staff';
  if (!(await isCleared(env, who))) return 'not-cleared';
  try {
    const res = await env.DB.prepare(
      `INSERT INTO team_coaches (group_id, staff_email, role, assigned_by, assigned_at)
       SELECT g.id, ?2, ?3, ?4, ?5 FROM program_groups g JOIN programs p ON p.id = g.program_id AND p.kind = 'team'
        WHERE g.id = ?1`
    ).bind(groupId, who, role, actor, iso()).run();
    return res.meta?.changes ? 'assigned' : 'invalid';
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message))) return 'exists';
    throw err;
  }
}

export async function removeCoach(env, { groupId, email, actor }) {
  const res = await env.DB.prepare(
    `UPDATE team_coaches SET removed_by = ?3, removed_at = ?4 WHERE group_id = ?1 AND staff_email = ?2 AND removed_at IS NULL`
  ).bind(groupId, normEmail(email), actor, iso()).run();
  return Boolean(res.meta?.changes);
}

/** Validate a schedule entry typed in Central time. */
export function validateEvent(form) {
  const v = {
    kind: String(form.get('kind') || ''),
    title: String(form.get('title') || '').trim().replace(/\s+/g, ' ').slice(0, 81),
    startsAt: centralToIso(String(form.get('starts_at') || '')),
    endsAt: form.get('ends_at') ? centralToIso(String(form.get('ends_at'))) : null,
    location: String(form.get('location') || '').trim().replace(/\s+/g, ' ').slice(0, 121),
    opponent: String(form.get('opponent') || '').trim().replace(/\s+/g, ' ').slice(0, 81),
    notes: String(form.get('notes') || '').trim().slice(0, 501),
  };
  const errors = {};
  if (!EVENT_KINDS[v.kind]) errors.kind = 'Choose practice, game, tournament or other.';
  if (!v.startsAt) errors.starts_at = 'Enter when it starts.';
  if (form.get('ends_at') && !v.endsAt) errors.ends_at = 'Enter a valid end time, or leave it blank.';
  if (v.startsAt && v.endsAt && v.endsAt <= v.startsAt) errors.ends_at = 'It has to end after it starts.';
  if (v.title.length > 80 || v.location.length > 120 || v.opponent.length > 80 || v.notes.length > 500) {
    errors.title = 'Keep each field short (title 80, place 120, opponent 80, notes 500 characters).';
  }
  return { value: v, errors };
}

export async function addEvent(env, groupId, v, actor) {
  const now = iso();
  const row = await env.DB.prepare(
    `INSERT INTO team_events (group_id, kind, title, starts_at, ends_at, location, opponent, notes, created_by, created_at, updated_at)
     SELECT g.id, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10 FROM program_groups g
       JOIN programs p ON p.id = g.program_id AND p.kind = 'team' WHERE g.id = ?1
     RETURNING id`
  ).bind(groupId, v.kind, v.title || null, v.startsAt, v.endsAt, v.location || null, v.opponent || null, v.notes || null,
    actor, now).first();
  return row ? Number(row.id) : null;
}

export async function cancelEvent(env, { groupId, id }) {
  const res = await env.DB.prepare(
    `UPDATE team_events SET cancelled_at = ?3, updated_at = ?3 WHERE id = ?1 AND group_id = ?2 AND cancelled_at IS NULL`
  ).bind(id, groupId, iso()).run();
  return Boolean(res.meta?.changes);
}

/** The feed's secret part for a team. */
export async function calendarToken(env, team) {
  return (await keyedHash(env, 'calendar', `${team.id}:${team.calendar_salt || ''}`)).slice(0, 32);
}

/** Replace a team's feed link: the old one stops working. */
export async function rotateCalendar(env, groupId) {
  const res = await env.DB.prepare(`UPDATE program_groups SET calendar_salt = ?2, updated_at = ?3 WHERE id = ?1`)
    .bind(groupId, randomToken(12), iso()).run();
  return Boolean(res.meta?.changes);
}

const icsText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
const icsTime = (value) => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Fold a content line to 75 octets, as RFC 5545 asks. */
function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let chunk = '';
  for (const ch of line) {
    if (new TextEncoder().encode(chunk + ch).length > (out.length ? 74 : 75)) {
      out.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  out.push(chunk);
  return out.join('\r\n ');
}

/**
 * The team's schedule as an iCalendar feed, if the token matches; else null.
 * Every event in the last 30 days and ahead; cancelled ones as CANCELLED so
 * calendars remove them.
 */
export async function calendarFeed(env, groupId, token) {
  const team = await env.DB.prepare(
    `SELECT g.id, g.name, g.calendar_salt, p.name AS program_name FROM program_groups g
       JOIN programs p ON p.id = g.program_id AND p.kind = 'team' WHERE g.id = ?1`
  ).bind(groupId).first();
  if (!team || !safeEqual(await calendarToken(env, team), String(token || ''))) return null;
  const { results } = await env.DB.prepare(
    `SELECT * FROM team_events WHERE group_id = ?1 AND starts_at >= ?2 ORDER BY starts_at LIMIT 500`
  ).bind(groupId, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()).all();
  const stamp = icsTime(iso());
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tennessee Saints//Team schedule//EN', 'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${icsText(`Tennessee Saints — ${team.name}`)}`,
  ];
  for (const e of results || []) {
    const end = e.ends_at || new Date(Date.parse(e.starts_at) + 90 * 60 * 1000).toISOString();
    const what = e.title || `${EVENT_KINDS[e.kind] || 'Event'}${e.opponent ? ` vs ${e.opponent}` : ''}`;
    lines.push('BEGIN:VEVENT', `UID:team-event-${e.id}@tnsaints.com`, `DTSTAMP:${stamp}`,
      `DTSTART:${icsTime(e.starts_at)}`, `DTEND:${icsTime(end)}`, `SUMMARY:${icsText(`${team.name}: ${what}`)}`);
    if (e.location) lines.push(`LOCATION:${icsText(e.location)}`);
    if (e.notes) lines.push(`DESCRIPTION:${icsText(e.notes)}`);
    lines.push(`STATUS:${e.cancelled_at ? 'CANCELLED' : 'CONFIRMED'}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** For the family page: each child's team, its next events and its calendar link path. */
export async function familyTeams(env, accountId) {
  const { results } = await env.DB.prepare(
    `SELECT e.player_id, g.id AS group_id, g.name AS team_name, g.calendar_salt
       FROM enrollments e JOIN program_groups g ON g.id = e.group_id
       JOIN programs p ON p.id = e.program_id AND p.kind = 'team'
      WHERE e.status IN ${PLACED}
        AND e.household_id IN (SELECT household_id FROM household_members WHERE account_id = ?1)`
  ).bind(accountId).all();
  const teams = results || [];
  if (!teams.length) return [];
  const ids = [...new Set(teams.map((t) => t.group_id))];
  const { results: events } = await env.DB.prepare(
    `SELECT group_id, kind, title, starts_at, location, opponent, cancelled_at FROM team_events
      WHERE group_id IN (SELECT value FROM json_each(?1)) AND starts_at >= ?2
      ORDER BY starts_at LIMIT 60`
  ).bind(JSON.stringify(ids), iso()).all();
  return Promise.all(teams.map(async (t) => ({
    ...t,
    events: (events || []).filter((e) => e.group_id === t.group_id).slice(0, 3),
    feedPath: `/calendar/${t.group_id}/${await calendarToken(env, { id: t.group_id, calendar_salt: t.calendar_salt })}.ics`,
  })));
}
