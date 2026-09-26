/**
 * Staff-side program settings: price, groups, waiver versions, open/close.
 *
 * Input is validated here; the database's CHECK constraints remain the final
 * word (a program cannot be OPEN without a price, a PayPal plan and a waiver,
 * whatever any page sends). Every function returns a plain result the admin
 * router turns into a message; nothing here trusts the form.
 */

const iso = () => new Date().toISOString();
const MONEY = /^\d{1,5}(\.\d{2})?$/;
const PLAN = /^P-[A-Z0-9]{10,40}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const text = (form, key, max) => String(form.get(key) || '').trim().replace(/\s+/g, ' ').slice(0, max + 1);

function cents(value) {
  const v = String(value || '').trim();
  if (!v) return { ok: true, value: null };
  if (!MONEY.test(v)) return { ok: false };
  return { ok: true, value: Math.round(Number(v) * 100) };
}

function grade(value) {
  const v = String(value ?? '').trim();
  if (!v) return { ok: true, value: null };
  if (!/^(?:[0-9]|1[0-2])$/.test(v)) return { ok: false };
  return { ok: true, value: Number(v) };
}

function gradeRange(form) {
  const min = grade(form.get('grade_min'));
  const max = grade(form.get('grade_max'));
  if (!min.ok || !max.ok) return { ok: false };
  if (min.value !== null && max.value !== null && min.value > max.value) return { ok: false };
  return { ok: true, min: min.value, max: max.value };
}

export async function listWaivers(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, legal_entity, title, effective_at FROM waiver_versions ORDER BY created_at DESC`
  ).all();
  return results || [];
}

/** @returns {Promise<'saved'|'invalid'>} */
export async function saveProgramSettings(env, programId, form) {
  const price = cents(form.get('price'));
  const setup = cents(form.get('setup_fee'));
  const hold = Number(form.get('offer_hold_days'));
  const grades = gradeRange(form);
  const live = text(form, 'paypal_plan_id_live', 60) || null;
  const sandbox = text(form, 'paypal_plan_id_sandbox', 60) || null;
  const waiver = text(form, 'waiver_version_id', 80) || null;
  if (!price.ok || !setup.ok || !grades.ok || !Number.isInteger(hold) || hold < 1 || hold > 30) return 'invalid';
  if ((live && !PLAN.test(live)) || (sandbox && !PLAN.test(sandbox))) return 'invalid';
  if (waiver && !(await env.DB.prepare(`SELECT 1 FROM waiver_versions WHERE id = ?1`).bind(waiver).first())) return 'invalid';
  try {
    const res = await env.DB.prepare(
      `UPDATE programs SET price_cents = ?2, setup_fee_cents = ?3, offer_hold_days = ?4, grade_min = ?5, grade_max = ?6,
              paypal_plan_id_live = ?7, paypal_plan_id_sandbox = ?8, waiver_version_id = ?9, updated_at = ?10
        WHERE id = ?1`
    )
      .bind(programId, price.value, setup.value, hold, grades.min, grades.max, live, sandbox, waiver, iso())
      .run();
    return res.meta.changes === 1 ? 'saved' : 'invalid';
  } catch {
    // An OPEN program cannot lose its price, plan or waiver (CHECK constraints).
    return 'invalid';
  }
}

/** @returns {Promise<'opened'|'closed'|'cannot-open'|'invalid'>} */
export async function setProgramStatus(env, programId, status) {
  if (!['open', 'closed'].includes(status)) return 'invalid';
  try {
    const res = await env.DB.prepare(`UPDATE programs SET status = ?2, updated_at = ?3 WHERE id = ?1`)
      .bind(programId, status, iso())
      .run();
    if (res.meta.changes !== 1) return 'invalid';
    return status === 'open' ? 'opened' : 'closed';
  } catch {
    return 'cannot-open';
  }
}

function groupFields(form) {
  const name = text(form, 'name', 60);
  const schedule = text(form, 'schedule_summary', 100);
  const weekdayRaw = String(form.get('weekday') ?? '').trim();
  const weekday = weekdayRaw === '' ? null : Number(weekdayRaw);
  const start = String(form.get('start_time') || '').trim() || null;
  const end = String(form.get('end_time') || '').trim() || null;
  const location = text(form, 'location', 120) || null;
  const startsOn = String(form.get('starts_on') || '').trim() || null;
  const capacity = Number(form.get('capacity'));
  const grades = gradeRange(form);
  const status = String(form.get('status') || 'active');
  const ok =
    name && name.length <= 60 && schedule && schedule.length <= 100 &&
    (weekday === null || (Number.isInteger(weekday) && weekday >= 0 && weekday <= 6)) &&
    (start === null || TIME.test(start)) && (end === null || TIME.test(end)) &&
    (startsOn === null || DATE.test(startsOn)) &&
    Number.isInteger(capacity) && capacity >= 1 && capacity <= 200 &&
    grades.ok && ['active', 'closed'].includes(status);
  return ok ? { name, schedule, weekday, start, end, location, startsOn, capacity, gradeMin: grades.min, gradeMax: grades.max, status } : null;
}

/** @returns {Promise<{result: 'group-saved'|'invalid', id?: number}>} */
export async function createGroup(env, programId, form) {
  const g = groupFields(form);
  if (!g) return { result: 'invalid' };
  const now = iso();
  try {
    const row = await env.DB.prepare(
      `INSERT INTO program_groups (program_id, name, schedule_summary, weekday, start_time, end_time, location,
                                   starts_on, capacity, grade_min, grade_max, status, created_at, updated_at)
       SELECT id, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'active', ?12, ?12 FROM programs WHERE id = ?1
       RETURNING id`
    )
      .bind(programId, g.name, g.schedule, g.weekday, g.start, g.end, g.location, g.startsOn, g.capacity,
        g.gradeMin, g.gradeMax, now)
      .first();
    return row ? { result: 'group-saved', id: Number(row.id) } : { result: 'invalid' };
  } catch {
    return { result: 'invalid' }; // duplicate name in this program, or a CHECK
  }
}

/** @returns {Promise<'group-saved'|'invalid'>} */
export async function updateGroup(env, programId, groupId, form) {
  const g = groupFields(form);
  if (!g) return 'invalid';
  try {
    const res = await env.DB.prepare(
      `UPDATE program_groups
          SET name = ?3, schedule_summary = ?4, weekday = ?5, start_time = ?6, end_time = ?7, location = ?8,
              starts_on = ?9, capacity = ?10, grade_min = ?11, grade_max = ?12, status = ?13, updated_at = ?14
        WHERE id = ?2 AND program_id = ?1`
    )
      .bind(programId, groupId, g.name, g.schedule, g.weekday, g.start, g.end, g.location, g.startsOn, g.capacity,
        g.gradeMin, g.gradeMax, g.status, iso())
      .run();
    return res.meta.changes === 1 ? 'group-saved' : 'invalid';
  } catch {
    return 'invalid';
  }
}

/**
 * Save a new, immutable waiver version: `<program>-v<n>`, hashed here.
 * @returns {Promise<{result: 'waiver-saved'|'invalid'|'waiver-exists', id?: string}>}
 */
export async function createWaiver(env, programId, form) {
  const legalEntity = text(form, 'legal_entity', 120);
  const title = text(form, 'title', 120);
  // The body keeps its line breaks: it is shown to families as written.
  const body = String(form.get('body_text') || '').replace(/\r\n/g, '\n').trim();
  if (!legalEntity || legalEntity.length > 120 || !title || title.length > 120 || !body || body.length > 20000) {
    return { result: 'invalid' };
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM waiver_versions WHERE id LIKE ?1`)
    .bind(`${programId}-v%`)
    .first();
  const id = `${programId}-v${Number(n?.n || 0) + 1}`;
  const now = iso();
  try {
    await env.DB.prepare(
      `INSERT INTO waiver_versions (id, legal_entity, title, body_text, body_sha256, effective_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`
    )
      .bind(id, legalEntity, title, body, sha, now)
      .run();
    return { result: 'waiver-saved', id };
  } catch {
    return { result: 'waiver-exists' };
  }
}
