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

/** The current evaluation program with its sessions, or null. */
export async function currentEvaluation(env) {
  const row = await env.DB.prepare(
    `SELECT p.id, p.name, p.grade_min, p.grade_max, p.registration_closes_at, p.status,
            (SELECT json_group_array(json_object('name', s.name, 'capacity', s.capacity, 'starts_on', s.starts_on))
               FROM (SELECT g.name, g.capacity, g.starts_on FROM program_groups g
                      WHERE g.program_id = p.id AND g.status = 'active'
                      ORDER BY g.start_time IS NULL, g.start_time, g.name) s) AS sessions
       FROM programs p
      WHERE p.kind = 'evaluation' AND p.id = (SELECT value FROM app_settings WHERE key = ?1)`
  ).bind(CURRENT_KEY).first();
  if (!row) return null;
  let sessions = [];
  try { sessions = JSON.parse(row.sessions || '[]'); } catch { sessions = []; }
  return { ...row, sessions };
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
  if (!ev) return env;
  const capacities = ev.sessions.map((s) => Number(s.capacity)).filter((n) => n > 0);
  return {
    ...env,
    EVENT_ID: ev.id,
    EVENT_LABEL: ev.name,
    EVENT_SHORT_LABEL: shortLabel(ev.sessions) || env.EVENT_SHORT_LABEL,
    // An evaluation with no sessions, or closed, takes no registrations:
    // validation finds no session to accept, and the window says closed.
    SESSION_TIMES: ev.sessions.map((s) => s.name).join(','),
    SLOT_CAPACITY: String(capacities.length ? Math.min(...capacities) : 0),
    ALLOWED_GRADES: gradeList(ev.grade_min, ev.grade_max),
    REGISTRATION_CLOSES_AT: ev.status === 'open' ? (ev.registration_closes_at || '') : '1970-01-01T00:00:00Z',
    EVALUATION_SOURCE: 'program',
  };
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
        WHERE status = 'open' AND public = 1
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
