/**
 * Clearances for adults who work with children (clearances:manage):
 * background check, abuse-prevention training, concussion training.
 *
 * A person's status for each kind comes from their newest unrevoked record:
 *   current    completed, and not expiring within 30 days (or no expiry)
 *   expiring   expires within the next 30 days
 *   expired    the expiry date has passed
 *   missing    no record
 * `isCleared` (all three current or expiring) is what team assignment checks
 * (plan phase G1): a coach without current clearances cannot be put on a team.
 *
 * Which providers, and how long each lasts, is the academy's policy (plan item
 * O14), so the expiry date is entered from the certificate rather than
 * assumed. Tennessee's concussion-training requirement for youth coaches is
 * taken on trust from planning research — verify with the attorney.
 */

import { normEmail } from '../auth/access.js';

export const CLEARANCE_KINDS = {
  background_check: 'Background check',
  abuse_prevention: 'Abuse-prevention training',
  concussion_training: 'Concussion training',
};
const KINDS = Object.keys(CLEARANCE_KINDS);
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SOON_DAYS = 30;

function centralToday(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(now));
}

function plusDays(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Status of one record (or none) on `today`. */
export function statusOf(record, today = centralToday()) {
  if (!record) return 'missing';
  if (!record.expires_on) return 'current';
  if (record.expires_on < today) return 'expired';
  if (record.expires_on <= plusDays(today, SOON_DAYS)) return 'expiring';
  return 'current';
}

/**
 * Everyone who needs clearances — active coaches and admins on staff — plus
 * anyone else with a record (volunteers), each with a status per kind.
 */
export async function clearanceBoard(env, { now = Date.now() } = {}) {
  const today = centralToday(now);
  const [staff, records] = await env.DB.batch([
    env.DB.prepare(`SELECT email_norm AS email, display_name AS name, role FROM staff
                     WHERE active = 1 AND role IN ('admin', 'coach') ORDER BY display_name`),
    env.DB.prepare(`SELECT c.* FROM clearances c
                     WHERE c.revoked_at IS NULL
                       AND c.id = (SELECT c2.id FROM clearances c2
                                    WHERE c2.person_email = c.person_email AND c2.kind = c.kind AND c2.revoked_at IS NULL
                                    ORDER BY c2.completed_on DESC, c2.id DESC LIMIT 1)`),
  ]);
  const people = new Map();
  for (const s of staff.results || []) people.set(s.email, { email: s.email, name: s.name, role: s.role, records: {} });
  for (const r of records.results || []) {
    if (!people.has(r.person_email)) people.set(r.person_email, { email: r.person_email, name: r.person_name, role: 'volunteer', records: {} });
    people.get(r.person_email).records[r.kind] = r;
  }
  return [...people.values()].map((p) => {
    const statuses = Object.fromEntries(KINDS.map((k) => [k, statusOf(p.records[k], today)]));
    return { ...p, statuses, cleared: KINDS.every((k) => ['current', 'expiring'].includes(statuses[k])) };
  });
}

/** Is this person cleared to work with children today? */
export async function isCleared(env, email, { now = Date.now() } = {}) {
  const board = await clearanceBoard(env, { now });
  return Boolean(board.find((p) => p.email === normEmail(email))?.cleared);
}

/** How many people have a clearance lapsed or lapsing within 30 days — for the daily brief. */
export async function clearanceAttention(env, { now = Date.now() } = {}) {
  const board = await clearanceBoard(env, { now });
  return board.filter((p) => Object.values(p.statuses).some((s) => s === 'expired' || s === 'expiring')).length;
}

export function validateClearance(form) {
  const v = {
    email: normEmail(String(form.get('person_email') || '')),
    name: String(form.get('person_name') || '').trim().replace(/\s+/g, ' '),
    kind: String(form.get('kind') || ''),
    completedOn: String(form.get('completed_on') || ''),
    expiresOn: String(form.get('expires_on') || ''),
    provider: String(form.get('provider') || '').trim().slice(0, 81),
    reference: String(form.get('reference') || '').trim().slice(0, 81),
  };
  const errors = {};
  if (!EMAIL_RE.test(v.email) || v.email.length > 254) errors.person_email = 'Enter their email address.';
  if (!v.name || v.name.length > 80) errors.person_name = 'Enter their name (under 80 characters).';
  if (!KINDS.includes(v.kind)) errors.kind = 'Choose which clearance this is.';
  const today = centralToday();
  if (!DATE_RE.test(v.completedOn) || v.completedOn > today) errors.completed_on = 'Enter the date it was completed (not in the future).';
  if (v.expiresOn && (!DATE_RE.test(v.expiresOn) || v.expiresOn <= v.completedOn)) {
    errors.expires_on = 'The expiry date must be after the completion date, or blank if it does not expire.';
  }
  if (v.provider.length > 80) errors.provider = 'Keep the provider under 80 characters.';
  if (v.reference.length > 80) errors.reference = 'Keep the reference under 80 characters.';
  return { value: v, errors };
}

export async function recordClearance(env, v, actor) {
  const row = await env.DB.prepare(
    `INSERT INTO clearances (person_email, person_name, kind, completed_on, expires_on, provider, reference, recorded_by, recorded_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) RETURNING id`
  ).bind(v.email, v.name, v.kind, v.completedOn, v.expiresOn || null, v.provider || null, v.reference || null, actor,
    new Date().toISOString()).first();
  return Number(row.id);
}

/** Withdraw a record entered in error (or a clearance withdrawn by the provider). */
export async function revokeClearance(env, { id, actor }) {
  const res = await env.DB.prepare(
    `UPDATE clearances SET revoked_at = ?2, revoked_by = ?3 WHERE id = ?1 AND revoked_at IS NULL`
  ).bind(id, new Date().toISOString(), actor).run();
  return Boolean(res.meta?.changes);
}

/** One person's history, newest first. */
export async function clearanceHistory(env, email) {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, completed_on, expires_on, provider, reference, recorded_by, recorded_at, revoked_at, revoked_by
       FROM clearances WHERE person_email = ?1 ORDER BY completed_on DESC, id DESC LIMIT 100`
  ).bind(normEmail(email)).all();
  return results || [];
}
