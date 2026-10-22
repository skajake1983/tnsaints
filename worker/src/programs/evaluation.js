/**
 * The evaluation, as a program.
 *
 * The 8/29 evaluation ran from settings in wrangler.toml — EVENT_ID,
 * EVENT_LABEL, SESSION_TIMES, SLOT_CAPACITY, ALLOWED_GRADES,
 * REGISTRATION_CLOSES_AT — read in some thirty places across registration,
 * notes, decisions and email. Rather than change all of them, the next
 * evaluation can be a PROGRAM (kind 'evaluation'; each session a group) that
 * staff mark as the current one, and withActiveEvent() hands every one of
 * those places the same settings, drawn from it:
 *
 *   EVENT_ID                the program's id (a legacy id like
 *                           '2026-08-29-evaluation' fits unchanged)
 *   EVENT_LABEL             its name
 *   EVENT_SHORT_LABEL       "Saturday's evaluation", from its first
 *                           session's date (feedback email subjects)
 *   SESSION_TIMES           its active groups' names, in start-time order
 *   SLOT_CAPACITY           the smallest of their capacities (never overbook)
 *   ALLOWED_GRADES          its grade range, as "3rd,4th,..."
 *   REGISTRATION_CLOSES_AT  its sign-up close time
 *
 * With no current evaluation program, nothing changes: wrangler.toml rules.
 * tests/test_eval_programs_mode.py runs the evaluation suites both ways.
 */

const CURRENT_KEY = 'evaluation.current';

function ordinal(n) {
  if (n === 0) return 'K';
  const suffix = n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

/** "3rd,4th,5th,6th" for grades 3–6; '' when the program has no range. */
export function gradeList(min, max) {
  if (min === null || min === undefined || max === null || max === undefined) return '';
  const out = [];
  for (let g = Number(min); g <= Number(max); g += 1) out.push(ordinal(g));
  return out.join(',');
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * "Saturday's evaluation" — the wording feedback emails have always used —
 * from the earliest session date, or null when no session has one.
 */
export function shortLabel(sessions) {
  const dates = sessions.map((s) => String(s.starts_on || '')).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!dates.length) return null;
  const day = new Date(`${dates[0]}T12:00:00Z`).getUTCDay();
  return Number.isNaN(day) ? null : `${WEEKDAYS[day]}'s evaluation`;
}

// Events (the Events plan, 2026-10-21): programs whose sign-ups are public
// — a place in a session ('spot', as evaluations always were), "register
// interest", or a team entry — rather than portal enrollments. An evaluation
// is always one, whatever created it. Event ids look like program ids.
// An event's kind is programs.event_kind (migration 023: programs.kind can't
// take new values on D1, so an open gym or scrimmage stores 'clinic' there).
export const KIND_SQL = 'COALESCE(p.event_kind, p.kind)';
/** A program families sign up for in the portal (the academy, teams, portal camps), not an event. */
export const PORTAL_PROGRAM_SQL = `(signup_mode = 'enroll' AND kind != 'evaluation')`;
export const EVENT_KINDS = ['evaluation', 'open_gym', 'camp', 'scrimmage', 'tournament'];
export const EVENT_MODES = ['spot', 'interest', 'team'];
const IS_EVENT = `(p.signup_mode IN ('spot', 'interest', 'team') OR p.kind = 'evaluation')`;
export const EVENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

/**
 * One event (a program of a registration kind) with its active sessions, or
 * null. `id` null means the current evaluation (app_settings), in the same
 * single query.
 */
async function loadEvent(env, id) {
  const row = await env.DB.prepare(
    `SELECT p.id, ${KIND_SQL} AS kind, p.name, p.grade_min, p.grade_max, p.registration_opens_at, p.registration_closes_at,
            p.status,
            CASE WHEN p.kind = 'evaluation' AND p.signup_mode = 'enroll' THEN 'spot' ELSE p.signup_mode END AS signup_mode,
            p.payment_policy, p.billing, p.price_cents, p.starts_on, p.ends_on, p.location, p.share_text,
            p.notify_each_signup,
            (SELECT json_group_array(json_object('name', s.name, 'capacity', s.capacity, 'starts_on', s.starts_on,
                                                 'start_time', s.start_time, 'end_time', s.end_time, 'location', s.location))
               FROM (SELECT g.name, g.capacity, g.starts_on, g.start_time, g.end_time, g.location FROM program_groups g
                      WHERE g.program_id = p.id AND g.status = 'active'
                      ORDER BY g.starts_on IS NULL, g.starts_on, g.start_time IS NULL, g.start_time, g.name) s) AS sessions
       FROM programs p
      WHERE ${IS_EVENT}
        AND p.id = CASE WHEN ?1 IS NULL
                        THEN (SELECT value FROM app_settings WHERE key = '${CURRENT_KEY}') ELSE ?1 END
        AND (?1 IS NOT NULL OR p.kind = 'evaluation')`
  ).bind(id ?? null).first();
  if (!row) return null;
  let sessions = [];
  try { sessions = JSON.parse(row.sessions || '[]'); } catch { sessions = []; }
  return { ...row, sessions };
}

/** The current evaluation program with its sessions, or null. */
export async function currentEvaluation(env) {
  return loadEvent(env, null);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'];

/** "Saturday, August 29", or "Saturday, August 29 – Sunday, August 30", from YYYY-MM-DD dates; '' with none. */
export function dateLine(dates) {
  const days = [...new Set(dates.map(String).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
  const fmt = (d) => {
    const t = new Date(`${d}T12:00:00Z`);
    return `${WEEKDAYS[t.getUTCDay()]}, ${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}`;
  };
  if (!days.length) return '';
  return days.length === 1 ? fmt(days[0]) : `${fmt(days[0])} – ${fmt(days[days.length - 1])}`;
}

/** env with one event's settings in place of wrangler.toml's. */
function overlay(env, ev) {
  // Each session's own size (registration.js slotCapacity); SLOT_CAPACITY
  // stays the smallest, for anything that still reads one number.
  const capacities = {};
  for (const s of ev.sessions) if (Number(s.capacity) > 0) capacities[s.name] = Number(s.capacity);
  const sizes = Object.values(capacities);
  const location = String(ev.location || '').trim()
    || ev.sessions.map((s) => String(s.location || '').trim()).find(Boolean) || '';
  const days = [ev.starts_on, ev.ends_on].filter(Boolean);
  return {
    ...env,
    // What wrangler.toml said, so a page can still offer that event.
    BASE: env.BASE ?? env,
    BASE_EVENT_ID: env.BASE_EVENT_ID ?? env.EVENT_ID,
    BASE_EVENT_LABEL: env.BASE_EVENT_LABEL ?? env.EVENT_LABEL,
    EVENT_ID: ev.id,
    EVENT_KIND: ev.kind,
    EVENT_LABEL: ev.name,
    EVENT_SHORT_LABEL: shortLabel(ev.sessions) || env.EVENT_SHORT_LABEL,
    EVENT_DATE_LINE: dateLine(days.length ? days : ev.sessions.map((s) => s.starts_on)),
    EVENT_LOCATION: location,
    SIGNUP_MODE: ev.signup_mode || 'spot',
    PAYMENT_POLICY: ev.payment_policy || 'free',
    PRICE_CENTS: ev.billing === 'free' || ev.price_cents === null || ev.price_cents === undefined ? '' : String(ev.price_cents),
    SHARE_TEXT: ev.share_text || '',
    // Whether staff are emailed for each sign-up (and cancellation), or only the daily brief.
    NOTIFY_EACH_SIGNUP: Number(ev.notify_each_signup ?? 1) ? '1' : '0',
    // An event with no sessions, or closed, takes no registrations:
    // validation finds no session to accept, and the window says closed.
    SESSION_TIMES: ev.sessions.map((s) => s.name).join(','),
    SESSION_CAPACITIES: JSON.stringify(capacities),
    SLOT_CAPACITY: String(sizes.length ? Math.min(...sizes) : 0),
    ALLOWED_GRADES: gradeList(ev.grade_min, ev.grade_max),
    REGISTRATION_OPENS_AT: ev.registration_opens_at || '',
    REGISTRATION_CLOSES_AT: ev.status === 'open' ? (ev.registration_closes_at || '') : '1970-01-01T00:00:00Z',
    EVALUATION_SOURCE: 'program',
  };
}

/**
 * env, or env with the evaluation settings drawn from the current evaluation
 * program. A lookup failure leaves env as it is (wrangler.toml), logged.
 */
export async function withActiveEvent(env) {
  let ev;
  try {
    ev = await currentEvaluation(env);
  } catch (err) {
    console.error(JSON.stringify({ event: 'evaluation_overlay_failed', message: err?.message }));
    return env;
  }
  return ev ? overlay(env, ev) : env;
}

/**
 * env with a particular event's settings — any event, past or future, not
 * only the current one (staff looking back at a roster; a cancel link for
 * an earlier event). env unchanged if there is no such event.
 */
export async function withEvent(env, id) {
  if (typeof id !== 'string' || !EVENT_ID_RE.test(id)) return env;
  let ev;
  try {
    ev = await loadEvent(env, id);
  } catch (err) {
    console.error(JSON.stringify({ event: 'event_overlay_failed', message: err?.message }));
    return env;
  }
  return ev ? overlay(env, ev) : env;
}

/**
 * Every event staff can look at, newest first, with its dates and sign-up
 * counts. The wrangler.toml event is included while it is not a program.
 */
export async function listEvents(env) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, ${KIND_SQL} AS kind, p.name, p.status, p.public, p.registration_closes_at, p.created_at, p.series_id,
            CASE WHEN p.kind = 'evaluation' AND p.signup_mode = 'enroll' THEN 'spot' ELSE p.signup_mode END AS signup_mode,
            COALESCE(p.starts_on, (SELECT MIN(g.starts_on) FROM program_groups g WHERE g.program_id = p.id)) AS first_day,
            COALESCE(p.ends_on, p.starts_on, (SELECT MAX(g.starts_on) FROM program_groups g WHERE g.program_id = p.id)) AS last_day,
            (SELECT COUNT(*) FROM registrations r WHERE r.event_id = p.id AND r.status = 'confirmed') AS confirmed,
            (SELECT COUNT(*) FROM registrations r WHERE r.event_id = p.id AND r.status = 'waitlist') AS waiting
       FROM programs p
      WHERE ${IS_EVENT} AND p.status != 'archived'
      ORDER BY first_day IS NULL, first_day DESC, p.created_at DESC
      LIMIT 200`
  ).all();
  const events = (results || []).map((e) => ({ ...e, confirmed: Number(e.confirmed), waiting: Number(e.waiting) }));
  const baseId = env.BASE_EVENT_ID ?? env.EVENT_ID;
  if (baseId && !events.some((e) => e.id === baseId)) {
    const n = await env.DB.prepare(
      `SELECT SUM(status = 'confirmed') AS confirmed, SUM(status = 'waitlist') AS waiting FROM registrations WHERE event_id = ?1`
    ).bind(baseId).first();
    const day = /^\d{4}-\d{2}-\d{2}/.test(baseId) ? baseId.slice(0, 10) : null;
    events.push({ id: baseId, kind: 'evaluation', name: env.BASE_EVENT_LABEL ?? env.EVENT_LABEL ?? baseId, status: 'closed',
      settings: true, first_day: day, last_day: day, confirmed: Number(n?.confirmed || 0), waiting: Number(n?.waiting || 0) });
  }
  return events;
}

/** Make a program the current evaluation (or, with null, go back to wrangler.toml). */
export async function setCurrentEvaluation(env, programId, actor) {
  const now = new Date().toISOString();
  if (!programId) {
    await env.DB.prepare(`DELETE FROM app_settings WHERE key = ?1`).bind(CURRENT_KEY).run();
    return 'cleared';
  }
  const res = await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     SELECT ?1, id, ?3, ?4 FROM programs WHERE id = ?2 AND kind = 'evaluation'
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).bind(CURRENT_KEY, programId, actor, now).run();
  return res.meta?.changes ? 'current' : 'invalid';
}

/**
 * GET /api/programs: what the website may show — open, listed programs with
 * their sessions and seats left. No families, no children; cacheable.
 */
export async function publicPrograms(env) {
  const now = new Date().toISOString();
  const [programs, groups] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, kind, name, description, billing, price_cents, grade_min, grade_max, enrollment_mode,
              registration_opens_at, registration_closes_at, preview_title, preview_image
         FROM programs
        WHERE status = 'open' AND public = 1 AND (signup_mode = 'enroll' OR kind = 'evaluation')
          AND (registration_opens_at IS NULL OR registration_opens_at <= ?1)
          AND (registration_closes_at IS NULL OR registration_closes_at > ?1)
        ORDER BY kind = 'academy' DESC, registration_closes_at IS NULL, registration_closes_at, name LIMIT 50`
    ).bind(now),
    env.DB.prepare(
      `SELECT g.program_id, g.name, g.schedule_summary, g.location, g.starts_on, g.capacity,
              g.capacity - (SELECT COUNT(*) FROM enrollments e WHERE e.group_id = g.id
                             AND (e.status IN ('active', 'past_due') OR (e.status = 'offered' AND e.offer_expires_at > ?1))) AS seats_left
         FROM program_groups g JOIN programs p ON p.id = g.program_id
        WHERE g.status = 'active' AND p.status = 'open' AND p.public = 1
        ORDER BY g.starts_on IS NULL, g.starts_on, g.start_time, g.name`
    ).bind(now),
  ]);
  const byProgram = new Map();
  for (const g of groups.results || []) {
    if (!byProgram.has(g.program_id)) byProgram.set(g.program_id, []);
    byProgram.get(g.program_id).push({
      name: g.name, schedule: g.schedule_summary, location: g.location, starts_on: g.starts_on,
      seats_left: Math.max(0, Number(g.seats_left)),
    });
  }
  return (programs.results || []).map((p) => ({
    id: p.id, kind: p.kind, name: p.name, description: p.description, billing: p.billing,
    price: p.billing === 'free' || p.price_cents === null ? null : (p.price_cents / 100).toFixed(2),
    grades: gradeList(p.grade_min, p.grade_max) || null, joining: p.enrollment_mode,
    registration_opens_at: p.registration_opens_at, registration_closes_at: p.registration_closes_at,
    preview_title: p.preview_title, preview_image: p.preview_image,
    groups: byProgram.get(p.id) || [],
  }));
}
