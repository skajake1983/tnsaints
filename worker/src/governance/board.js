/**
 * Non-profit governance: the board, its meetings, motions and votes, minutes,
 * action items, documents, conflict-of-interest disclosures, and the
 * compliance calendar.
 *
 * WHO. Board members sign in like staff (Cloudflare Access, then the staff
 * list with role 'board'). The board role carries board:view and
 * board:disclose and NOTHING about children: every roster, family and CRM
 * screen needs a capability it does not have. Academy admins hold
 * board:manage. The board SECRETARY (an office in board_members, not a staff
 * role) may also take attendance, record motions and votes, draft and
 * circulate minutes, and record the board's approval of them — the
 * per-person grant the plan describes.
 *
 * SERVING means the term has started, has not ended, and was not ended early.
 * A member-elect is listed but has no rights until their term starts.
 *
 * RECORD. Approved minutes lock the whole meeting — its minutes, attendance,
 * quorum, motions and votes — and a decided motion's votes are locked too
 * (database triggers). A recusal must say why. Quorum is snapshotted when
 * attendance is taken, and a motion cannot be decided without it.
 *
 * Bylaws decide some of this (quorum, what carries a motion). The defaults —
 * quorum is a majority of voting members serving; a motion carries when more
 * vote yes than no among those voting — are stated on the screens and TAKEN
 * ON TRUST until the bylaws say otherwise.
 */

import { normEmail } from '../auth/access.js';
import { centralToIso } from '../programs/manage.js';

export const OFFICES = { chair: 'Chair', vice_chair: 'Vice chair', secretary: 'Secretary', treasurer: 'Treasurer', director: 'Director' };
export const MEETING_KINDS = { regular: 'Regular meeting', special: 'Special meeting', annual: 'Annual meeting', committee: 'Committee meeting' };
export const DOC_CATEGORIES = { bylaws: 'Bylaws', policy: 'Policy', minutes: 'Minutes', financials: 'Financials', filings: 'Filings',
  insurance: 'Insurance', other: 'Other' };
export const COMPLIANCE_CATEGORIES = { federal: 'Federal', state: 'State', insurance: 'Insurance', payroll: 'Payroll',
  safety: 'Safety', other: 'Other' };
export const ATTENDANCE = ['present', 'remote', 'absent', 'excused'];
export const VOTES = ['yes', 'no', 'abstain', 'recused'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const iso = () => new Date().toISOString();
const clean = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max + 1);
// A choice from one of the lists above ('constructor' is not an office).
const isKey = (obj, k) => Object.hasOwn(obj, k);

/** A real calendar date as YYYY-MM-DD (not 2026-02-31 or 2026-13-01). */
export function realDate(s) {
  if (!DATE_RE.test(String(s))) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** An optional email: blank, or a plausible address of sensible length. */
function okEmail(e) {
  return !e || (e.length <= 254 && EMAIL_RE.test(e));
}

export function centralToday(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(now));
}

/**
 * The next occurrence. Month ends stay month ends: Jan 31 monthly is Feb 28
 * (or 29), Nov 30 quarterly is Feb 28, and Feb 29 yearly is Feb 28.
 */
export function addPeriod(date, recurrence) {
  const [y, m, d] = date.split('-').map(Number);
  const months = recurrence === 'monthly' ? 1 : recurrence === 'quarterly' ? 3 : 12;
  const target = new Date(Date.UTC(y, m - 1 + months, 1, 12));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days, 12)).toISOString().slice(0, 10);
}

/** Hosts a document link may point to (BOARD_DOC_HOSTS, default SharePoint). */
export function docHostAllowed(url, env) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const allowed = String(env.BOARD_DOC_HOSTS || 'sharepoint.com').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const host = u.hostname.toLowerCase();
  return allowed.some((h) => host === h || host.endsWith(`.${h}`));
}

// --- members -------------------------------------------------------------------------

/** Serving members, then members-elect (term not started), then past ones. */
export async function listMembers(env) {
  const today = centralToday();
  const { results } = await env.DB.prepare(
    `SELECT *, CASE WHEN ended_at IS NULL AND term_start <= ?1 AND (term_end IS NULL OR term_end >= ?1) THEN 1 ELSE 0 END AS serving,
            CASE WHEN ended_at IS NULL AND term_start > ?1 THEN 1 ELSE 0 END AS upcoming
       FROM board_members ORDER BY serving DESC, upcoming DESC, office = 'chair' DESC, office = 'vice_chair' DESC,
            office = 'secretary' DESC, office = 'treasurer' DESC, name`
  ).bind(today).all();
  return results || [];
}

/** The serving board member for this sign-in, if any (a member-elect is not yet). */
export async function memberFor(env, email) {
  return env.DB.prepare(
    `SELECT * FROM board_members WHERE email = ?1 AND ended_at IS NULL AND term_start <= ?2 AND (term_end IS NULL OR term_end >= ?2)
      ORDER BY term_start DESC LIMIT 1`
  ).bind(normEmail(email), centralToday()).first();
}

/** May this person record meetings (admins, and the serving secretary)? */
export async function maySecretary(env, principal, can) {
  if (can(principal, 'board:manage')) return true;
  const m = await memberFor(env, principal.email);
  return m?.office === 'secretary';
}

export function validateMember(form) {
  const v = {
    email: normEmail(form.get('email')),
    name: clean(form.get('name'), 80),
    office: String(form.get('office') || ''),
    voting: form.get('voting') === '1' ? 1 : 0,
    termStart: String(form.get('term_start') || ''),
    termEnd: String(form.get('term_end') || ''),
  };
  const errors = {};
  if (!v.email || !okEmail(v.email)) errors.email = 'Enter their email (the one they sign in with).';
  if (!v.name || v.name.length > 80) errors.name = 'Enter their name.';
  if (!isKey(OFFICES, v.office)) errors.office = 'Choose an office.';
  if (!realDate(v.termStart)) errors.term_start = 'Enter when the term starts.';
  if (v.termEnd && (!realDate(v.termEnd) || v.termEnd <= v.termStart)) errors.term_end = 'The term must end after it starts, or leave it blank.';
  return { value: v, errors };
}

export async function addMember(env, v, actor) {
  const now = iso();
  const row = await env.DB.prepare(
    `INSERT INTO board_members (email, name, office, voting, term_start, term_end, created_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8) RETURNING id`
  ).bind(v.email, v.name, v.office, v.voting, v.termStart, v.termEnd || null, actor, now).first();
  return Number(row.id);
}

/**
 * End a term now (or withdraw a member-elect). The term's end date becomes
 * today when it had none and today is after it started; a term ended the day
 * it starts, or before, keeps no end date (ended_at says it ended).
 */
export async function endMember(env, id) {
  const now = iso();
  const res = await env.DB.prepare(
    `UPDATE board_members SET ended_at = ?2,
            term_end = CASE WHEN term_end IS NOT NULL THEN term_end WHEN ?3 > term_start THEN ?3 ELSE NULL END,
            updated_at = ?2 WHERE id = ?1 AND ended_at IS NULL`
  ).bind(id, now, centralToday()).run();
  return Boolean(res.meta?.changes);
}

// --- meetings ---------------------------------------------------------------------------

export function validateMeeting(form) {
  const v = {
    kind: String(form.get('kind') || ''),
    title: clean(form.get('title'), 120),
    startsAt: centralToIso(String(form.get('starts_at') || '')),
    location: clean(form.get('location'), 120),
    agenda: String(form.get('agenda') || '').trim().slice(0, 8001),
  };
  const errors = {};
  if (!isKey(MEETING_KINDS, v.kind)) errors.kind = 'Choose the kind of meeting.';
  if (!v.title || v.title.length > 120) errors.title = 'Give the meeting a title.';
  if (!v.startsAt) errors.starts_at = 'Enter when it starts.';
  if (v.location.length > 120) errors.location = 'Keep the place under 120 characters.';
  if (v.agenda.length > 8000) errors.agenda = 'Keep the agenda under 8,000 characters.';
  return { value: v, errors };
}

export async function addMeeting(env, v, actor) {
  const now = iso();
  const row = await env.DB.prepare(
    `INSERT INTO board_meetings (kind, title, starts_at, location, agenda, created_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7) RETURNING id`
  ).bind(v.kind, v.title, v.startsAt, v.location || null, v.agenda || null, actor, now).first();
  return Number(row.id);
}

export async function listMeetings(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, title, starts_at, status, minutes_status, quorum_present, voting_members FROM board_meetings
      ORDER BY starts_at DESC LIMIT 200`
  ).all();
  return results || [];
}

/** One meeting with its attendance, motions (and votes), and action items. */
export async function meetingDetail(env, id) {
  const row = await env.DB.prepare(`SELECT * FROM board_meetings WHERE id = ?1`).bind(id).first();
  if (!row) return null;
  // The board on the meeting's date, in Central time (an evening meeting is
  // the next day in UTC), and not anyone whose term was ended before it began.
  const day = centralToday(Date.parse(row.starts_at));
  const [attendance, motions, votes, actions, members] = await env.DB.batch([
    env.DB.prepare(`SELECT a.*, m.name, m.voting FROM meeting_attendance a JOIN board_members m ON m.id = a.board_member_id
                     WHERE a.meeting_id = ?1 ORDER BY m.name`).bind(id),
    env.DB.prepare(`SELECT mo.*, a.name AS moved_name, s.name AS seconded_name FROM board_motions mo
                      LEFT JOIN board_members a ON a.id = mo.moved_by LEFT JOIN board_members s ON s.id = mo.seconded_by
                     WHERE mo.meeting_id = ?1 ORDER BY mo.id`).bind(id),
    env.DB.prepare(`SELECT v.*, m.name FROM motion_votes v JOIN board_members m ON m.id = v.board_member_id
                     WHERE v.motion_id IN (SELECT id FROM board_motions WHERE meeting_id = ?1) ORDER BY m.name`).bind(id),
    env.DB.prepare(`SELECT * FROM board_action_items WHERE meeting_id = ?1 ORDER BY status = 'open' DESC, due_on`).bind(id),
    // Who was serving on the meeting's date (so a past meeting keeps its board).
    env.DB.prepare(`SELECT m.id, m.name, m.office, m.voting FROM board_members m
                     WHERE m.term_start <= ?1 AND (m.term_end IS NULL OR m.term_end >= ?1)
                       AND (m.ended_at IS NULL OR m.ended_at > ?2) ORDER BY m.name`).bind(day, row.starts_at),
  ]);
  const voteRows = votes.results || [];
  return {
    meeting: row,
    attendance: attendance.results || [],
    motions: (motions.results || []).map((m) => ({ ...m, votes: voteRows.filter((v) => v.motion_id === m.id) })),
    actions: actions.results || [],
    members: members.results || [],
  };
}

/**
 * Record attendance for every serving member at once, and snapshot quorum:
 * voting members serving, and how many of them were present or remote.
 * Once the minutes are approved the record is locked.
 * @returns {Promise<{voting: number, present: number, quorum: boolean} | 'locked' | null>}
 */
export async function recordAttendance(env, meetingId, statuses, actor) {
  const detail = await meetingDetail(env, meetingId);
  if (!detail || detail.meeting.status === 'cancelled') return null;
  if (detail.meeting.minutes_status === 'approved') return 'locked';
  const now = iso();
  const rows = detail.members.filter((m) => ATTENDANCE.includes(statuses[m.id])).map((m) => ({ id: m.id, status: statuses[m.id] }));
  const voting = detail.members.filter((m) => m.voting).length;
  const present = detail.members.filter((m) => m.voting && ['present', 'remote'].includes(statuses[m.id])).length;
  const statements = [];
  // One statement for the whole board, however large it grows.
  if (rows.length) {
    statements.push(env.DB.prepare(
      `INSERT INTO meeting_attendance (meeting_id, board_member_id, status, recorded_by, recorded_at)
       SELECT ?1, json_extract(j.value, '$.id'), json_extract(j.value, '$.status'), ?3, ?4 FROM json_each(?2) j WHERE true
       ON CONFLICT (meeting_id, board_member_id) DO UPDATE SET status = excluded.status, recorded_by = excluded.recorded_by,
         recorded_at = excluded.recorded_at`
    ).bind(meetingId, JSON.stringify(rows), actor, now));
  }
  statements.push(env.DB.prepare(
    `UPDATE board_meetings SET voting_members = ?2, quorum_present = ?3, status = CASE WHEN status = 'scheduled' THEN 'held' ELSE status END,
            updated_at = ?4 WHERE id = ?1`
  ).bind(meetingId, voting, present, now));
  try {
    await env.DB.batch(statements);
  } catch (err) {
    if (/locked/.test(String(err?.message))) return 'locked';
    throw err;
  }
  return { voting, present, quorum: hasQuorum(voting, present) };
}

/** Quorum (default until the bylaws say otherwise): a majority of the voting members serving. */
export function hasQuorum(voting, present) {
  return voting > 0 && present >= Math.floor(voting / 2) + 1;
}

export async function cancelMeeting(env, id) {
  const res = await env.DB.prepare(
    `UPDATE board_meetings SET status = 'cancelled', updated_at = ?2 WHERE id = ?1 AND status = 'scheduled'`
  ).bind(id, iso()).run();
  return Boolean(res.meta?.changes);
}

// --- motions and votes --------------------------------------------------------------------

/** A motion on an open record (not cancelled, minutes not approved), moved and seconded by real members. */
export async function addMotion(env, meetingId, form, actor) {
  const title = clean(form.get('title'), 160);
  const body = String(form.get('body') || '').trim().slice(0, 4001);
  const memberId = (k) => (/^\d{1,12}$/.test(String(form.get(k) || '')) ? Number(form.get(k)) : null);
  const moved = memberId('moved_by');
  const seconded = memberId('seconded_by');
  if (!title || title.length > 160 || body.length > 4000 || (moved && seconded && moved === seconded)) return null;
  const now = iso();
  try {
    const row = await env.DB.prepare(
      `INSERT INTO board_motions (meeting_id, title, body, moved_by, seconded_by, created_by, created_at, updated_at)
       SELECT id, ?2, ?3, ?4, ?5, ?6, ?7, ?7 FROM board_meetings
        WHERE id = ?1 AND status != 'cancelled' AND minutes_status != 'approved'
          AND (?4 IS NULL OR EXISTS (SELECT 1 FROM board_members WHERE id = ?4))
          AND (?5 IS NULL OR EXISTS (SELECT 1 FROM board_members WHERE id = ?5))
       RETURNING id`
    ).bind(meetingId, title, body || null, moved, seconded, actor, now).first();
    return row ? Number(row.id) : null;
  } catch (err) {
    if (/locked/.test(String(err?.message))) return null;
    throw err;
  }
}

/**
 * Record a roll call, then decide the motion: carried when quorum was present
 * and more voted yes than no (abstentions and recusals do not count either
 * way). EVERY voting member present must be given a vote — yes, no, abstain,
 * or recused with a reason — so a name skipped by mistake is never counted.
 * Votes are locked once decided, and the whole record once minutes are approved.
 * @returns {Promise<'carried'|'failed'|'no-quorum'|'incomplete'|'invalid'|'decided'|'locked'>}
 */
export async function recordVotes(env, motionId, votes, reasons, actor) {
  const motion = await env.DB.prepare(
    `SELECT mo.id, mo.status, mo.meeting_id, me.voting_members, me.quorum_present, me.minutes_status FROM board_motions mo
       JOIN board_meetings me ON me.id = mo.meeting_id WHERE mo.id = ?1`
  ).bind(motionId).first();
  if (!motion) return 'invalid';
  if (motion.minutes_status === 'approved') return 'locked';
  if (motion.status !== 'pending') return 'decided';
  if (motion.quorum_present === null || !hasQuorum(Number(motion.voting_members), Number(motion.quorum_present))) return 'no-quorum';
  const detail = await meetingDetail(env, motion.meeting_id);
  const present = detail.attendance.filter((a) => ['present', 'remote'].includes(a.status) && a.voting).map((a) => a.board_member_id);
  if (!present.length) return 'invalid';
  const rows = [];
  let yes = 0;
  let no = 0;
  for (const id of present) {
    const vote = votes[String(id)];
    const reason = String(reasons[String(id)] || '').trim().slice(0, 300);
    if (!VOTES.includes(vote) || (vote === 'recused' && !reason)) return 'incomplete';
    if (vote === 'yes') yes += 1;
    if (vote === 'no') no += 1;
    rows.push({ id, vote, reason: vote === 'recused' ? reason : null });
  }
  const outcome = yes > no ? 'carried' : 'failed';
  const now = iso();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO motion_votes (motion_id, board_member_id, vote, recusal_reason, recorded_by, recorded_at)
         SELECT ?1, json_extract(j.value, '$.id'), json_extract(j.value, '$.vote'), json_extract(j.value, '$.reason'), ?3, ?4
           FROM json_each(?2) j WHERE true
         ON CONFLICT (motion_id, board_member_id) DO UPDATE SET vote = excluded.vote, recusal_reason = excluded.recusal_reason,
           recorded_by = excluded.recorded_by, recorded_at = excluded.recorded_at`
      ).bind(motionId, JSON.stringify(rows), actor, now),
      env.DB.prepare(
        `UPDATE board_motions SET status = ?2, decided_at = ?3, updated_at = ?3 WHERE id = ?1 AND status = 'pending'`
      ).bind(motionId, outcome, now),
    ]);
  } catch (err) {
    // A second click, or the minutes approved meanwhile: the first answer stands.
    if (/locked/.test(String(err?.message))) return 'decided';
    throw err;
  }
  return outcome;
}

export async function setMotionStatus(env, motionId, status) {
  if (!['withdrawn', 'tabled'].includes(status)) return false;
  try {
    const res = await env.DB.prepare(
      `UPDATE board_motions SET status = ?2, decided_at = ?3, updated_at = ?3
        WHERE id = ?1 AND status = 'pending'
          AND meeting_id IN (SELECT id FROM board_meetings WHERE minutes_status != 'approved')`
    ).bind(motionId, status, iso()).run();
    return Boolean(res.meta?.changes);
  } catch (err) {
    if (/locked/.test(String(err?.message))) return false;
    throw err;
  }
}

// --- minutes ----------------------------------------------------------------------------------

/**
 * Save, circulate or approve minutes. Approval needs the minutes to have been
 * circulated first, and locks them (database trigger).
 * @returns {Promise<'saved'|'circulated'|'approved'|'locked'|'invalid'>}
 */
export async function minutesStep(env, meetingId, step, text, actor) {
  const now = iso();
  try {
    if (step === 'save') {
      const body = String(text || '').trim();
      if (!body || body.length > 30000) return 'invalid';
      const res = await env.DB.prepare(
        `UPDATE board_meetings SET minutes = ?2, minutes_status = CASE WHEN minutes_status = 'none' THEN 'draft' ELSE minutes_status END,
                updated_at = ?3 WHERE id = ?1 AND status != 'cancelled'`
      ).bind(meetingId, body, now).run();
      return res.meta?.changes ? 'saved' : 'invalid';
    }
    if (step === 'circulate') {
      const res = await env.DB.prepare(
        `UPDATE board_meetings SET minutes_status = 'circulated', updated_at = ?2 WHERE id = ?1 AND minutes_status = 'draft'`
      ).bind(meetingId, now).run();
      return res.meta?.changes ? 'circulated' : 'invalid';
    }
    if (step === 'approve') {
      const res = await env.DB.prepare(
        `UPDATE board_meetings SET minutes_status = 'approved', minutes_approved_at = ?2, minutes_approved_by = ?3, updated_at = ?2
          WHERE id = ?1 AND minutes_status = 'circulated'`
      ).bind(meetingId, now, actor).run();
      return res.meta?.changes ? 'approved' : 'invalid';
    }
  } catch (err) {
    if (/locked/.test(String(err?.message))) return 'locked';
    throw err;
  }
  return 'invalid';
}

// --- action items ---------------------------------------------------------------------------

export async function addAction(env, { meetingId = null, title, ownerEmail, dueOn, actor }) {
  const t = clean(title, 160);
  const owner = ownerEmail ? normEmail(ownerEmail) : '';
  if (!t || t.length > 160 || (dueOn && !realDate(dueOn)) || !okEmail(owner)) return false;
  const res = await env.DB.prepare(
    `INSERT INTO board_action_items (meeting_id, title, owner_email, due_on, created_by, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE ?1 IS NULL OR EXISTS (SELECT 1 FROM board_meetings WHERE id = ?1)`
  ).bind(meetingId, t, owner || null, dueOn || null, actor, iso()).run();
  return Boolean(res.meta?.changes);
}

export async function setActionStatus(env, id, status, actor) {
  if (!['open', 'done', 'dropped'].includes(status)) return false;
  const closing = status !== 'open';
  const res = await env.DB.prepare(
    `UPDATE board_action_items SET status = ?2, completed_at = CASE WHEN ?3 THEN ?4 END, completed_by = CASE WHEN ?3 THEN ?5 END
      WHERE id = ?1 AND status != ?2`
  ).bind(id, status, closing ? 1 : 0, iso(), actor).run();
  return Boolean(res.meta?.changes);
}

export async function openActions(env) {
  const { results } = await env.DB.prepare(
    `SELECT a.*, m.title AS meeting_title FROM board_action_items a LEFT JOIN board_meetings m ON m.id = a.meeting_id
      WHERE a.status = 'open' ORDER BY a.due_on IS NULL, a.due_on LIMIT 200`
  ).all();
  return results || [];
}

// --- documents ----------------------------------------------------------------------------------

export async function listDocuments(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM board_documents WHERE archived_at IS NULL ORDER BY category, effective_on DESC, title LIMIT 500`
  ).all();
  return results || [];
}

/** @returns {Promise<'added'|'host'|'invalid'>} */
export async function addDocument(env, form, actor) {
  const title = clean(form.get('title'), 160);
  const category = String(form.get('category') || '');
  const url = String(form.get('url') || '').trim();
  const effective = String(form.get('effective_on') || '');
  const notes = String(form.get('notes') || '').trim().slice(0, 501);
  if (!title || title.length > 160 || !isKey(DOC_CATEGORIES, category) || url.length > 2000 || notes.length > 500) return 'invalid';
  if (effective && !realDate(effective)) return 'invalid';
  if (!docHostAllowed(url, env)) return 'host';
  await env.DB.prepare(
    `INSERT INTO board_documents (title, category, url, effective_on, notes, added_by, added_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  ).bind(title, category, url, effective || null, notes || null, actor, iso()).run();
  return 'added';
}

export async function archiveDocument(env, id, actor) {
  const res = await env.DB.prepare(
    `UPDATE board_documents SET archived_at = ?2, archived_by = ?3 WHERE id = ?1 AND archived_at IS NULL`
  ).bind(id, iso(), actor).run();
  return Boolean(res.meta?.changes);
}

// --- conflict-of-interest disclosures -------------------------------------------------------------

/** Every serving member and whether they have disclosed for `year`. */
export async function disclosureStatus(env, year) {
  const today = centralToday();
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.name, m.office, d.has_conflicts, d.details, d.signed_at FROM board_members m
       LEFT JOIN coi_disclosures d ON d.board_member_id = m.id AND d.year = ?1
      WHERE m.ended_at IS NULL AND m.term_start <= ?2 AND (m.term_end IS NULL OR m.term_end >= ?2) ORDER BY m.name`
  ).bind(year, today).all();
  return results || [];
}

/** A member signs their own disclosure for the year. @returns {Promise<'signed'|'exists'|'invalid'|'not-member'>} */
export async function signDisclosure(env, email, form) {
  const member = await memberFor(env, email);
  if (!member) return 'not-member';
  const year = Number(centralToday().slice(0, 4));
  const has = form.get('has_conflicts') === '1' ? 1 : form.get('has_conflicts') === '0' ? 0 : null;
  const details = String(form.get('details') || '').trim().slice(0, 4001);
  const signature = clean(form.get('signature'), 80);
  if (has === null || !signature || signature.length > 80 || details.length > 4000 || (has === 1 && !details)) return 'invalid';
  try {
    await env.DB.prepare(
      `INSERT INTO coi_disclosures (board_member_id, year, has_conflicts, details, signature, signed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    ).bind(member.id, year, has, has ? details : null, signature, iso()).run();
    return 'signed';
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message))) return 'exists';
    throw err;
  }
}

// --- compliance calendar ----------------------------------------------------------------------------

export async function listCompliance(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM compliance_items ORDER BY status = 'open' DESC, due_on IS NOT NULL, due_on, title LIMIT 300`
  ).all();
  return results || [];
}

export function validateCompliance(form) {
  const v = {
    title: clean(form.get('title'), 160),
    category: String(form.get('category') || ''),
    dueOn: String(form.get('due_on') || ''),
    recurrence: String(form.get('recurrence') || 'annual'),
    owner: normEmail(form.get('owner_email') || ''),
    notes: String(form.get('notes') || '').trim().slice(0, 1001),
  };
  const ok = v.title && v.title.length <= 160 && isKey(COMPLIANCE_CATEGORIES, v.category) && (!v.dueOn || realDate(v.dueOn))
    && ['once', 'monthly', 'quarterly', 'annual'].includes(v.recurrence) && v.notes.length <= 1000 && okEmail(v.owner);
  return ok ? v : null;
}

export async function addCompliance(env, v) {
  const now = iso();
  await env.DB.prepare(
    `INSERT INTO compliance_items (title, category, due_on, recurrence, owner_email, notes, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`
  ).bind(v.title, v.category, v.dueOn || null, v.recurrence, v.owner || null, v.notes || null, now).run();
}

export async function setComplianceDate(env, id, dueOn) {
  if (!realDate(String(dueOn || ''))) return false;
  const res = await env.DB.prepare(`UPDATE compliance_items SET due_on = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'open'`)
    .bind(id, dueOn, iso()).run();
  return Boolean(res.meta?.changes);
}

/**
 * Mark done; a recurring item gets its next occurrence. The next one is
 * written FIRST, and only while this one is still open, so a double click
 * (two requests both reading it open) makes one, not two.
 */
export async function completeCompliance(env, id, actor) {
  const item = await env.DB.prepare(`SELECT * FROM compliance_items WHERE id = ?1 AND status = 'open'`).bind(id).first();
  if (!item) return false;
  const now = iso();
  const statements = [];
  if (item.recurrence !== 'once' && item.due_on && realDate(item.due_on)) {
    statements.push(env.DB.prepare(
      `INSERT INTO compliance_items (title, category, due_on, recurrence, owner_email, notes, created_at, updated_at)
       SELECT title, category, ?2, recurrence, owner_email, notes, ?3, ?3 FROM compliance_items WHERE id = ?1 AND status = 'open'`
    ).bind(id, addPeriod(item.due_on, item.recurrence), now));
  }
  statements.push(env.DB.prepare(
    `UPDATE compliance_items SET status = 'done', completed_on = ?2, completed_by = ?3, updated_at = ?4 WHERE id = ?1 AND status = 'open'`
  ).bind(id, centralToday(), actor, now));
  const results = await env.DB.batch(statements);
  return Boolean(results[results.length - 1].meta?.changes);
}

/** For the daily brief: due within 30 days or overdue, and items still needing a date. */
export async function complianceAttention(env) {
  const today = centralToday();
  const soon = addDays(today, 30);
  const row = await env.DB.prepare(
    `SELECT SUM(due_on IS NOT NULL AND due_on <= ?1) AS due, SUM(due_on IS NULL) AS undated
       FROM compliance_items WHERE status = 'open'`
  ).bind(soon).first();
  return { due: Number(row?.due || 0), undated: Number(row?.undated || 0) };
}
