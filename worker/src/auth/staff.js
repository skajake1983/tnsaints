/**
 * Authorization: what a signed-in human may actually do.
 *
 * Access decides who reaches the Worker. This decides what happens next, and
 * the two are deliberately not the same system. Cloudflare Access policies are
 * edited in a dashboard by whoever holds the account; this table is in the
 * repo's schema and changes through a reviewed command. A policy widened to
 * "anyone with an @tnsaints.com address" still cannot read a medical note,
 * because that address is not in `staff`.
 */

import { normEmail } from './access.js';

/**
 * Capabilities per role.
 *
 * Named capabilities rather than role checks scattered through handlers, so
 * adding an endpoint means naming what it needs, and the answer for every role
 * is visible in one place instead of inferred from a dozen `if (role ===
 * 'admin')` lines that drift apart.
 */
const CAPABILITIES = {
  admin: new Set([
    'roster:view',
    'roster:contact', // parent email, phone, emergency contacts
    'roster:medical', // the medical note text itself, audited per read
    'roster:export',
    'notes:write',
    // Deliberately NO capability to write as another coach. An evaluation is
    // attributable to the person who typed it or it is not evidence of
    // anything, and the owner chose non-repudiation over the convenience of
    // transcribing for someone.
    //
    // An admin may REMOVE another coach's evaluation — for something entered
    // about the wrong child, or written in a way that should not stand — but
    // cannot alter it and cannot author one in their name. Delete leaves an
    // audit row; a silent edit under someone else's name would not.
    'feedback:delete',
    'decisions:set',
    'messages:approve',
    'messages:send',
    'staff:manage',
    'events:manage',
  ]),

  // Coaches evaluate basketball. Contact details and medical notes are not
  // inputs to that job, so the role does not carry them — see rosterView().
  coach: new Set(['roster:view', 'notes:write']),

  viewer: new Set(['roster:view']),

  // The ADMIN_TOKEN runbook path. It is a shared bearer token with no human
  // behind it, so it can read the roster it was built to export and can do
  // nothing else. Every mutation needs an identity to attribute the change to,
  // and a shared token has none.
  'token:automation': new Set(['roster:view', 'roster:contact', 'roster:export']),
};

export function can(principal, capability) {
  const set = CAPABILITIES[principal?.role];
  return Boolean(set && set.has(capability));
}

/**
 * Resolve a verified email to a staff principal.
 *
 * Returns null when the email is unknown or deactivated — the caller turns
 * that into a 403 rather than a 401, because the person genuinely is
 * authenticated. They are simply not authorised, and saying so is what lets a
 * coach text Jacob for a one-line fix instead of concluding their login is
 * broken and giving up.
 */
export async function loadStaff(env, email) {
  const norm = normEmail(email);
  if (!norm) return null;

  const row = await env.DB.prepare(
    `SELECT email_norm, display_name, author_label, role, active
       FROM staff
      WHERE email_norm = ?1`
  )
    .bind(norm)
    .first();

  if (!row || row.active !== 1) return null;

  return {
    email: row.email_norm,
    displayName: row.display_name,
    authorLabel: row.author_label,
    role: row.role,
  };
}

/** Every staff row, active and inactive, for the management screen. */
export async function listStaff(env) {
  const { results } = await env.DB.prepare(
    `SELECT email_norm, display_name, author_label, role, active, created_at, updated_at
       FROM staff
      ORDER BY active DESC, role, email_norm`
  ).all();
  return results || [];
}

/** How many admins can currently sign in. Backs the last-admin guard. */
export async function countActiveAdmins(env) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM staff WHERE role = 'admin' AND active = 1`
  ).first();
  return Number(row?.n || 0);
}

const ROLES = new Set(['admin', 'coach', 'viewer']);

/**
 * Create or update a staff member.
 *
 * Upserts on the normalised email, so re-adding an existing person edits them
 * rather than erroring. Returns whether the row was newly created, so the
 * caller knows whether to send a welcome email.
 *
 * THE LAST-ADMIN GUARD lives here and in setStaffStatus: demoting or
 * deactivating the final active admin would lock the whole staff out of user
 * management from the UI, and the person doing it is usually the one who would
 * then need to fix it. Refused rather than allowed-then-regretted.
 */
export async function addOrUpdateStaff(env, { email, displayName, authorLabel, role }) {
  const norm = normEmail(email);
  if (!norm || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(norm)) {
    return { ok: false, error: 'Enter a valid email address.' };
  }
  if (!ROLES.has(role)) {
    return { ok: false, error: 'Role must be admin, coach, or viewer.' };
  }
  const name = String(displayName || '').trim();
  const label = String(authorLabel || '').trim();
  if (!name) return { ok: false, error: 'A name is required.' };
  if (!label) return { ok: false, error: 'A parent-facing label (e.g. "Coach Adams") is required.' };

  const existing = await env.DB.prepare(
    `SELECT role, active FROM staff WHERE email_norm = ?1`
  )
    .bind(norm)
    .first();

  // Guard: do not demote the last active admin.
  if (existing && existing.role === 'admin' && existing.active === 1 && role !== 'admin') {
    if ((await countActiveAdmins(env)) <= 1) {
      return { ok: false, error: 'This is the only active admin. Add another admin before changing this role.' };
    }
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO staff (email_norm, display_name, author_label, role, active, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)
     ON CONFLICT (email_norm) DO UPDATE SET
       display_name = excluded.display_name,
       author_label = excluded.author_label,
       role         = excluded.role,
       active       = 1,
       updated_at   = excluded.updated_at`
  )
    .bind(norm, name, label, role, now)
    .run();

  return { ok: true, email: norm, role, created: !existing, reactivated: Boolean(existing && existing.active === 0) };
}

/**
 * Activate or deactivate a staff member.
 *
 * Deactivate rather than delete: deleting orphans the notes they authored,
 * while active=0 ends access immediately and keeps attribution intact.
 */
export async function setStaffStatus(env, { email, active }) {
  const norm = normEmail(email);
  if (!norm) return { ok: false, error: 'Unknown staff member.' };

  const existing = await env.DB.prepare(`SELECT role, active FROM staff WHERE email_norm = ?1`)
    .bind(norm)
    .first();
  if (!existing) return { ok: false, error: 'That person is not on the staff list.' };

  if (!active && existing.role === 'admin' && existing.active === 1) {
    if ((await countActiveAdmins(env)) <= 1) {
      return { ok: false, error: 'This is the only active admin. Add another admin before deactivating this one.' };
    }
  }

  await env.DB.prepare(
    `UPDATE staff SET active = ?2, updated_at = ?3 WHERE email_norm = ?1`
  )
    .bind(norm, active ? 1 : 0, new Date().toISOString())
    .run();

  return { ok: true, email: norm, active: Boolean(active) };
}

/** The display fields for one staff member — used when re-sending an invite. */
export async function getStaff(env, email) {
  const norm = normEmail(email);
  if (!norm) return null;
  return await env.DB.prepare(
    `SELECT email_norm, display_name, author_label, role, active FROM staff WHERE email_norm = ?1`
  )
    .bind(norm)
    .first();
}

/**
 * Append an audit row.
 *
 * Never throws: an audit write failing must not take down the operation it was
 * recording. A missing audit line is a gap; a 500 in the middle of a coach
 * saving notes on event day is a lost note.
 *
 * `detail` carries identifiers only. Putting the medical note text in here
 * would copy the sensitive value into a second table with different access
 * rules, which is precisely what logging the access was meant to avoid.
 */
export async function audit(env, { actor, action, subjectType, subjectId, detail }) {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_log (at, actor, action, subject_type, subject_id, detail)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    )
      .bind(
        new Date().toISOString(),
        actor || 'unknown',
        action,
        subjectType || null,
        subjectId != null ? String(subjectId) : null,
        detail ? JSON.stringify(detail) : null
      )
      .run();
  } catch (err) {
    console.error('Audit write failed:', err?.message, action);
  }
}

/**
 * Columns a principal may see on the roster.
 *
 * THE MINIMISATION THAT MATTERS IS THIS PROJECTION, NOT THE ROLE CHECK.
 *
 * A role check gates a page. This gates the bytes: a coach's roster response
 * never contains a parent email, phone number, emergency contact, medical note,
 * signature, IP hash, or cancel token — not hidden by CSS, not omitted by the
 * template, not present in the JSON at all. There is nothing to leak through a
 * view-source, a browser extension, a forwarded screenshot, or a future bug in
 * a template.
 *
 * Medical notes are a genuine safety need on event day, and the answer is a
 * separate audited endpoint rather than a wider role — see 'roster:medical'.
 * The coach view shows a flag: there is a note on file, ask Jacob. That gets
 * the child the care they need without handing fifty medical histories to
 * everyone holding a clipboard.
 */
const BASE_COLUMNS = [
  'id',
  'session_time',
  'status',
  'player_name',
  'grade',
  'years_experience',
  'school',
  'player_notes',
  'highlight_link',
  'created_at',
];

const CONTACT_COLUMNS = [
  'parent_name',
  'parent_email',
  'phone',
  'emergency_contact_name',
  'emergency_contact_phone',
  'signature',
  'signed_at',
  'assumption_of_risk',
  'medical_release',
  'photo_release',
  'cancelled_at',
  'cancel_reason',
];

export function rosterColumns(principal) {
  const cols = [...BASE_COLUMNS];

  if (can(principal, 'roster:contact')) {
    cols.push(...CONTACT_COLUMNS);
  }

  // A boolean, never the text. Everyone who runs a session needs to know a
  // child has a note; only an admin reads what it says, and that read is
  // audited.
  cols.push(`CASE WHEN medical_notes IS NOT NULL AND TRIM(medical_notes) != ''
                  THEN 1 ELSE 0 END AS has_medical_notes`);

  return cols.join(', ');
}

/**
 * Roster rows for a principal, already minimised.
 */
export async function rosterView(env, principal) {
  const { results } = await env.DB.prepare(
    `SELECT ${rosterColumns(principal)}
       FROM registrations
      WHERE event_id = ?1
      ORDER BY session_time, status DESC, id`
  )
    .bind(env.EVENT_ID)
    .all();

  return results || [];
}
