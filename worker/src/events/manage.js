/**
 * Creating and running events (the Events plan, 2026-10-21, phase EV2).
 *
 * "Make it easy to create a new evaluation day": a new event starts from the
 * last one of its kind — name, sessions, sizes, place, grades, blurb, waiver,
 * price — so staff change the date and save. Duplicate copies any event;
 * Repeat weekly makes the next open gyms of a series. Every event is created
 * as a hidden draft; Publish opens it (the programs table refuses to open
 * one without a waiver: migrations/009, kept in 023).
 *
 * Payments: a priced event is paid at check-in until online payment for
 * events ships (EV6, waiting on Stripe going live).
 */

import { centralToIso, isoToCentral } from '../programs/manage.js';
import { setProgramStatus } from '../programs/settings.js';
import { onlinePaymentReady } from './payments.js';

const iso = () => new Date().toISOString();
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const MAX_SESSIONS = 6;
export const MAX_REPEAT_WEEKS = 12;
const FEATURED_KEY = 'events.featured';

/** What each kind of event starts as when there is no earlier one to copy. */
export const KIND_DEFAULTS = {
  evaluation: { mode: 'spot', name: 'Free Academy Evaluation', grades: [3, 6], notify: 1,
    sessions: [['9:00 AM', '09:00', '10:00', 25], ['10:00 AM', '10:00', '11:00', 25]] },
  open_gym: { mode: 'spot', name: 'Open Gym Shoot-Around', grades: [3, 8], notify: 0,
    sessions: [['6:00 PM', '18:00', '19:30', 20]] },
  camp: { mode: 'spot', name: 'Basketball Camp', grades: [3, 8], notify: 0, multiDay: true,
    sessions: [['Morning', '09:00', '12:00', 30]] },
  scrimmage: { mode: 'interest', name: 'Scrimmage', grades: [3, 8], notify: 0,
    sessions: [['Game', '18:00', '19:30', 20]] },
  tournament: { mode: 'team', name: 'Tournament', grades: [3, 8], notify: 0, multiDay: true,
    sessions: [['4th grade', '08:00', '17:00', 8]] },
};
export const EVENT_KIND_LIST = Object.keys(KIND_DEFAULTS);

// What programs.kind holds for each event kind (migration 023: its CHECK
// can't take new values on D1). The real kind is programs.event_kind.
const STORED_KIND = { evaluation: 'evaluation', camp: 'camp', tournament: 'tournament', open_gym: 'clinic', scrimmage: 'clinic' };

const clean = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max + 1);

/** The day before `date` at 23:59 Central, as an ISO instant: the default sign-up close. */
export function dayBeforeClose(date) {
  if (!DATE.test(String(date || ''))) return null;
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return centralToIso(`${d.toISOString().slice(0, 10)}T23:59`);
}

/** The most recent event of a kind (the one a new event starts from), or null. */
export async function lastOfKind(env, kind) {
  return env.DB.prepare(
    `SELECT id FROM programs p WHERE COALESCE(p.event_kind, p.kind) = ?1
        AND (p.signup_mode IN ('spot', 'interest', 'team') OR p.kind = 'evaluation') AND p.status != 'archived'
      ORDER BY COALESCE(p.starts_on, (SELECT MIN(g.starts_on) FROM program_groups g WHERE g.program_id = p.id)) DESC,
               p.created_at DESC LIMIT 1`
  ).bind(kind).first();
}

/**
 * The values the New event form opens with: copied from `fromId` (any event),
 * else from the kind's defaults. The date is left for staff to set.
 */
export async function eventPrefill(env, kind, fromId) {
  const d = KIND_DEFAULTS[kind];
  if (!d) return null;
  let src = null;
  let groups = [];
  if (fromId) {
    const [p, g] = await env.DB.batch([
      env.DB.prepare(`SELECT *, COALESCE(event_kind, kind) AS shown_kind FROM programs WHERE id = ?1`).bind(fromId),
      env.DB.prepare(`SELECT name, start_time, end_time, capacity, location FROM program_groups WHERE program_id = ?1 AND status = 'active'
                       ORDER BY start_time IS NULL, start_time, name`).bind(fromId),
    ]);
    src = p.results?.[0] || null;
    groups = g.results || [];
  }
  const mode = src && src.shown_kind === kind && src.signup_mode !== 'enroll' ? src.signup_mode : d.mode;
  return {
    kind,
    mode,
    from: src ? src.id : '',
    name: src ? src.name.replace(/\s*[-–—]\s*\w+day,?\s+\w+\s+\d{1,2}(,\s*\d{4})?\s*$/i, '').replace(/\s*[-–—]\s*\w+\s+\d{1,2},?\s*\d{4}\s*$/, '') : d.name,
    starts_on: '',
    ends_on: '',
    // An older event keeps its place on its sessions.
    location: src?.location || groups.map((g) => g.location).find(Boolean) || '',
    grade_min: src ? src.grade_min : d.grades[0],
    grade_max: src ? src.grade_max : d.grades[1],
    sessions: (groups.length ? groups.map((g) => [g.name, g.start_time || '', g.end_time || '', g.capacity]) : d.sessions)
      .map(([name, start, end, cap]) => ({ name, start, end, cap })),
    opens: '',
    closes: '',
    description: src?.description || '',
    banner_title: src?.banner_title || '',
    banner_text: '',
    share_text: '',
    price: src && src.price_cents !== null && src.billing !== 'free' ? (Number(src.price_cents) / 100).toFixed(2) : '',
    payment: src && src.payment_policy === 'online' ? 'online' : 'at_check_in',
    waiver_version_id: src?.waiver_version_id || '',
    notify: src ? Number(src.notify_each_signup) : d.notify,
    waitlist: src ? Number(src.waitlist_enabled) : 1,
  };
}

/**
 * Read and check the New event form.
 * @returns {{ok: true, value: object} | {ok: false, errors: object, value: object}}
 */
export function readEventForm(form, waiverIds) {
  const kind = String(form.get('kind') || '');
  const d = KIND_DEFAULTS[kind];
  const errors = {};
  const value = {
    kind,
    mode: kind === 'tournament' && form.get('mode') === 'interest' ? 'interest' : (d?.mode || 'spot'),
    from: /^[a-z0-9][a-z0-9-]{0,59}$/.test(String(form.get('from') || '')) ? String(form.get('from')) : '',
    name: clean(form.get('name'), 120),
    starts_on: String(form.get('starts_on') || '').trim(),
    ends_on: String(form.get('ends_on') || '').trim(),
    location: clean(form.get('location'), 160),
    grade_min: form.get('grade_min') === '' || form.get('grade_min') === null ? null : Number(form.get('grade_min')),
    grade_max: form.get('grade_max') === '' || form.get('grade_max') === null ? null : Number(form.get('grade_max')),
    sessions: [],
    opens: String(form.get('opens') || '').trim(),
    closes: String(form.get('closes') || '').trim(),
    description: String(form.get('description') || '').trim().slice(0, 801),
    banner_title: clean(form.get('banner_title'), 80),
    banner_text: clean(form.get('banner_text'), 160),
    share_text: clean(form.get('share_text'), 280),
    price: String(form.get('price') || '').trim(),
    payment: form.get('payment') === 'online' ? 'online' : 'at_check_in',
    waiver_version_id: String(form.get('waiver_version_id') || ''),
    notify: form.get('notify') === '1' ? 1 : 0,
    waitlist: form.get('waitlist') === '1' ? 1 : 0,
  };
  if (!d) errors.kind = 'Choose what kind of event this is.';
  if (!value.name || value.name.length > 120) errors.name = 'Give it a name families will recognise (up to 120 characters).';
  if (!DATE.test(value.starts_on)) errors.starts_on = 'Choose the day it happens.';
  if (value.ends_on && (!DATE.test(value.ends_on) || value.ends_on < value.starts_on)) errors.ends_on = 'The last day can\'t be before the first.';
  if (!value.location || value.location.length > 160) errors.location = 'Say where it is (up to 160 characters).';
  const gradeOk = (g) => g === null || (Number.isInteger(g) && g >= 0 && g <= 12);
  if (!gradeOk(value.grade_min) || !gradeOk(value.grade_max) || (value.grade_min !== null) !== (value.grade_max !== null)
      || (value.grade_min !== null && value.grade_min > value.grade_max)) {
    errors.grades = 'Choose both grades, youngest first, or neither.';
  }
  const names = new Set();
  for (let i = 1; i <= MAX_SESSIONS; i += 1) {
    const name = clean(form.get(`s${i}_name`), 60);
    const start = String(form.get(`s${i}_start`) || '').trim();
    const end = String(form.get(`s${i}_end`) || '').trim();
    const capRaw = String(form.get(`s${i}_cap`) || '').trim();
    if (!name && !start && !end && !capRaw) continue;
    const cap = Number(capRaw);
    if (!name || name.length > 60 || names.has(name.toLowerCase())) errors[`s${i}`] = `Session ${i} needs its own name.`;
    else if ((start && !TIME.test(start)) || (end && !TIME.test(end)) || (start && end && end <= start)) errors[`s${i}`] = `Session ${i}: check its times.`;
    else if (!Number.isInteger(cap) || cap < 1 || cap > 500) errors[`s${i}`] = `Session ${i}: how many can come (1–500).`;
    names.add(name.toLowerCase());
    value.sessions.push({ name, start, end, cap });
  }
  if (!value.sessions.length) errors.sessions = 'Add at least one session, with how many can come.';
  value.opensIso = value.opens ? centralToIso(value.opens) : null;
  value.closesIso = value.closes ? centralToIso(value.closes) : dayBeforeClose(value.starts_on);
  if (value.opens && !value.opensIso) errors.opens = 'Check when sign-ups open.';
  if (value.closes && !value.closesIso) errors.closes = 'Check when sign-ups close.';
  if (value.opensIso && value.closesIso && value.opensIso >= value.closesIso) errors.closes = 'Sign-ups must close after they open.';
  if (value.price) {
    const m = /^\$?(\d{1,5})(?:\.(\d{2}))?$/.exec(value.price);
    if (!m) errors.price = 'Enter a price like 75 or 75.00, or leave it blank for free.';
    else value.price_cents = Number(m[1]) * 100 + Number(m[2] || 0);
  }
  if (value.price_cents === 0) value.price_cents = undefined;
  if (value.waiver_version_id && !waiverIds.includes(value.waiver_version_id)) errors.waiver = 'Choose a waiver from the list.';
  if (value.description.length > 800) errors.description = 'Keep the description to 800 characters.';
  return Object.keys(errors).length ? { ok: false, errors, value } : { ok: true, value };
}

/** "2027-03-06-open-gym", then "-2", "-3"... if taken. */
function eventIds(base, taken, count = 1) {
  const out = [];
  let n = 1;
  while (out.length < count) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!taken.has(id)) { out.push(id); taken.add(id); }
    n += 1;
  }
  return out;
}

/** Ids already used by events on these days ("2027-03-06..."), in one query. */
async function takenIds(env, days) {
  const { results } = await env.DB.prepare(
    `SELECT id FROM programs WHERE substr(id, 1, 10) IN (SELECT value FROM json_each(?1))`
  ).bind(JSON.stringify(days)).all();
  return new Set((results || []).map((r) => r.id));
}

const longDay = (day) => new Date(`${day}T12:00:00Z`)
  .toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });

/** "Saturday, March 6 · 9:00–10:00 AM": what the portal and calendar show for a session. */
function scheduleSummary(day, s) {
  const clock = (hhmm) => {
    if (!hhmm) return '';
    const [h, m] = hhmm.split(':').map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  };
  return [longDay(day), [clock(s.start), clock(s.end)].filter(Boolean).join('–')].filter(Boolean).join(' · ').slice(0, 100);
}

/** Create the event and its sessions as a hidden draft, in one batch. */
export async function createEvent(env, v, actor) {
  const base = `${v.starts_on}-${v.kind.replace('_', '-')}`;
  const [id] = eventIds(base, await takenIds(env, [v.starts_on]));
  const now = iso();
  const weekday = new Date(`${v.starts_on}T12:00:00Z`).getUTCDay();
  const priced = v.price_cents !== undefined;
  const statements = [
    env.DB.prepare(
      `INSERT INTO programs (id, kind, name, status, enrollment_mode, billing, price_cents, currency, grade_min, grade_max,
                             waiver_version_id, public, registration_opens_at, registration_closes_at, waitlist_enabled,
                             description, created_at, updated_at, signup_mode, starts_on, ends_on, location, payment_policy,
                             banner_title, banner_text, share_text, notify_each_signup, created_from, event_kind)
       VALUES (?1, ?2, ?3, 'draft', 'approval', ?4, ?5, 'USD', ?6, ?7, ?8, 0, ?9, ?10, ?11, ?12, ?13, ?13, ?14, ?15, ?16, ?17,
               ?18, ?19, ?20, ?21, ?22, ?23, ?24)`
    ).bind(id, STORED_KIND[v.kind], v.name, priced ? 'one_time' : 'free', priced ? v.price_cents : null, v.grade_min, v.grade_max,
      v.waiver_version_id || null, v.opensIso, v.closesIso, v.mode === 'spot' ? v.waitlist : 0, v.description || null, now,
      v.mode, v.starts_on, v.ends_on || null, v.location, priced ? v.payment : 'free', v.banner_title || null,
      v.banner_text || null, v.share_text || null, v.notify, v.from || null, v.kind),
    ...v.sessions.map((s) => env.DB.prepare(
      `INSERT INTO program_groups (program_id, name, schedule_summary, weekday, start_time, end_time, location, starts_on,
                                   capacity, status, created_at, updated_at)
       SELECT id, ?2, ?3, ?4, ?5, ?6, location, starts_on, ?7, 'active', ?8, ?8 FROM programs WHERE id = ?1`
    ).bind(id, s.name, scheduleSummary(v.starts_on, s), weekday, s.start || null, s.end || null, s.cap, now)),
  ];
  await env.DB.batch(statements);
  return { result: 'created', id };
}

/**
 * The next `weeks` weekly copies of an event (open gyms): same sessions, sizes,
 * place and settings, each a week later — its sign-up window too — in the
 * same series, in the original's status. Two statements a copy.
 */
export async function repeatWeekly(env, sourceId, weeks) {
  const n = Number(weeks);
  if (!Number.isInteger(n) || n < 1 || n > MAX_REPEAT_WEEKS) return { result: 'invalid' };
  const src = await env.DB.prepare(`SELECT id, COALESCE(event_kind, kind) AS kind, starts_on, series_id FROM programs
                                     WHERE id = ?1 AND starts_on IS NOT NULL AND signup_mode IN ('spot', 'interest', 'team')`)
    .bind(sourceId).first();
  if (!src) return { result: 'invalid' };
  const series = src.series_id || src.id;
  const shift = (date, days) => {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const plan = [];
  for (let w = 1; w <= n; w += 1) {
    const day = shift(src.starts_on, 7 * w);
    plan.push({ day, modifier: `+${7 * w} days`, base: `${day}-${src.kind.replace('_', '-')}` });
  }
  const taken = await takenIds(env, plan.map((p) => p.day));
  for (const p of plan) [p.id] = eventIds(p.base, taken);
  const now = iso();
  const statements = [env.DB.prepare(`UPDATE programs SET series_id = ?2, updated_at = ?3 WHERE id = ?1`).bind(src.id, series, now)];
  for (const p of plan) {
    statements.push(env.DB.prepare(
      `INSERT INTO programs (id, kind, name, status, enrollment_mode, offer_hold_days, grade_min, grade_max, billing, price_cents,
                             setup_fee_cents, currency, waiver_version_id, public, registration_opens_at, registration_closes_at,
                             waitlist_enabled, description, preview_title, preview_image, created_at, updated_at, signup_mode,
                             starts_on, ends_on, location, payment_policy, banner_title, banner_text, share_text, series_id,
                             notify_each_signup, published_at, created_from, event_kind)
       SELECT ?2, kind, name, status, enrollment_mode, offer_hold_days, grade_min, grade_max, billing, price_cents,
              setup_fee_cents, currency, waiver_version_id, public,
              strftime('%Y-%m-%dT%H:%M:%fZ', registration_opens_at, ?3), strftime('%Y-%m-%dT%H:%M:%fZ', registration_closes_at, ?3),
              waitlist_enabled, description, preview_title, preview_image, ?4, ?4, signup_mode,
              date(starts_on, ?3), date(ends_on, ?3), location, payment_policy, banner_title, banner_text, share_text, ?5,
              notify_each_signup, CASE WHEN status = 'open' THEN ?4 END, id, event_kind
         FROM programs WHERE id = ?1`
    ).bind(src.id, p.id, p.modifier, now, series));
    // A session's summary names its day ("Saturday, March 6 · 6:00 PM"): say the new one.
    statements.push(env.DB.prepare(
      `INSERT INTO program_groups (program_id, name, schedule_summary, weekday, start_time, end_time, location, starts_on,
                                   capacity, grade_min, grade_max, status, created_at, updated_at)
       SELECT ?2, name, CASE WHEN instr(schedule_summary, ' · ') > 0
                             THEN ?5 || substr(schedule_summary, instr(schedule_summary, ' · ')) ELSE schedule_summary END,
              weekday, start_time, end_time, location, date(starts_on, ?3), capacity, grade_min, grade_max, status, ?4, ?4
         FROM program_groups WHERE program_id = ?1 AND status = 'active'`
    ).bind(src.id, p.id, p.modifier, now, longDay(p.day)));
  }
  await env.DB.batch(statements);
  return { result: 'repeated', ids: plan.map((p) => p.id) };
}

/**
 * Publish (open and list it), close, or archive. Opening keeps every check the
 * programs table makes (a waiver; a price if it isn't free) and needs a session.
 * @returns {Promise<string>} a message key
 */
export async function setEventStatus(env, id, action) {
  if (action === 'publish') {
    const has = await env.DB.prepare(`SELECT
        (SELECT waiver_version_id FROM programs WHERE id = ?1) AS waiver,
        (SELECT COUNT(*) FROM program_groups WHERE program_id = ?1 AND status = 'active') AS sessions`).bind(id).first();
    if (!has?.waiver) return 'needs-waiver';
    // Online payment needs Stripe set up and switched on (Admin -> Billing).
    const policy = await env.DB.prepare(`SELECT payment_policy FROM programs WHERE id = ?1`).bind(id).first();
    if (policy?.payment_policy === 'online' && !(await onlinePaymentReady(env))) return 'needs-stripe';
    if (!Number(has.sessions)) return 'needs-session';
    // A price that isn't set, or anything else the table refuses, stops it here.
    if ((await setProgramStatus(env, id, 'open')) !== 'opened') return 'publish-refused';
    await env.DB.prepare(`UPDATE programs SET public = 1, published_at = COALESCE(published_at, ?2), updated_at = ?2 WHERE id = ?1`)
      .bind(id, iso()).run();
    return 'published';
  }
  if (action === 'close' || action === 'archive') {
    const res = await env.DB.prepare(`UPDATE programs SET status = ?2, updated_at = ?3 WHERE id = ?1`)
      .bind(id, action === 'close' ? 'closed' : 'archived', iso()).run();
    if (action === 'archive') {
      await env.DB.prepare(`DELETE FROM app_settings WHERE key = ?1 AND value = ?2`).bind(FEATURED_KEY, id).run();
    }
    return res.meta?.changes ? (action === 'close' ? 'closed' : 'archived') : 'invalid';
  }
  return 'invalid';
}

/** The event in the website banner (or none). */
export async function featuredEvent(env) {
  const row = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = ?1`).bind(FEATURED_KEY).first();
  return row ? row.value : null;
}

export async function setFeatured(env, id, actor) {
  if (!id) {
    await env.DB.prepare(`DELETE FROM app_settings WHERE key = ?1`).bind(FEATURED_KEY).run();
    return 'unfeatured';
  }
  const res = await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     SELECT ?1, id, ?3, ?4 FROM programs WHERE id = ?2 AND signup_mode IN ('spot', 'interest', 'team') AND status != 'archived'
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).bind(FEATURED_KEY, id, actor, iso()).run();
  return res.meta?.changes ? 'featured' : 'invalid';
}

export { isoToCentral };
