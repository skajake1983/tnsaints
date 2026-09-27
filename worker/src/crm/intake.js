/**
 * Website inquiries into the CRM (POST /api/lead).
 *
 * The contact, player-interest, coaching, sponsorship and volunteer forms on
 * tnsaints.com post here instead of Formspree. Each submission becomes:
 *   - a CONTACT, found by normalized email (one row per person), linked to a
 *     portal account and family if that address already has one;
 *   - an INQUIRY: the submission itself, ALLOW-LISTED fields only — anything
 *     else the form sent is dropped;
 *   - for player interest, a PROSPECT CHILD and a card in the family pipeline;
 *     for coaching, volunteering and sponsorship, a card in that pipeline;
 *   - a TASK "Respond to ..." for whoever owns that kind of inquiry, unless the
 *     contact already has one open.
 * No email goes out per lead: Resend's free tier is the tightest limit this
 * system has. New inquiries are summarised in the daily staff brief.
 *
 * Field names match the existing website forms exactly, so switching the site
 * from Formspree is a one-line change there.
 */

import { PHONE_RE } from '../validate.js';
import { normEmail } from '../auth/access.js';
import { parseLegacyGrade, schoolYearOf } from '../lib/grades.js';

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/;
const URL_RE = /^https?:\/\/[^\s<>"]{3,300}$/i;

/** Site purpose value -> CRM purpose, contact kind, pipeline. */
export const PURPOSES = {
  general: { purpose: 'general', kind: 'other', pipeline: null, task: 'Respond to general inquiry' },
  'player-interest': { purpose: 'player', kind: 'family', pipeline: 'family', task: 'Respond to academy interest' },
  'coaching-interest': { purpose: 'coaching', kind: 'coach', pipeline: 'coach', task: 'Respond to coaching interest' },
  'sponsor-interest': { purpose: 'sponsor', kind: 'sponsor', pipeline: 'sponsor', task: 'Respond to sponsorship interest' },
  'volunteer-interest': { purpose: 'volunteer', kind: 'volunteer', pipeline: 'volunteer', task: 'Respond to volunteer interest' },
};

export const POSITIONS = ['Point Guard', 'Shooting Guard', 'Small Forward', 'Power Forward', 'Center', 'Combo Guard', 'Wing'];
export const COACH_ROLES = ['Head Coach', 'Assistant Coach', 'Skills Trainer', 'Strength & Conditioning', 'Team Manager', 'Volunteer Support'];
const GRADES = ['3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', '11th', '12th'];

const s = (body, key, max) => (typeof body[key] === 'string' ? body[key].trim().replace(/\s+/g, ' ') : '').slice(0, max + 1);
const long = (body, key, max) => (typeof body[key] === 'string' ? body[key].trim() : '').slice(0, max + 1);

function need(errors, key, value, max, label) {
  if (!value) errors[key] = `Please enter ${label}.`;
  else if (value.length > max) errors[key] = `Please keep ${label} under ${max} characters.`;
}

function email(errors, key, value) {
  if (!value) errors[key] = 'Please enter an email address.';
  else if (value.length > 254 || !EMAIL_RE.test(value)) errors[key] = 'Please enter a valid email address.';
}

function phone(errors, key, value, required) {
  if (!value) { if (required) errors[key] = 'Please enter a phone number.'; }
  else if (!PHONE_RE.test(value)) errors[key] = 'Please enter a valid phone number.';
}

/**
 * Validate a submission for its purpose.
 * @returns {{ok: true, value: object} | {ok: false, errors: Record<string,string>}}
 *   value: { sitePurpose, contact: {name, email, phone, organization}, message, fields, prospect }
 */
export function validateLead(body) {
  const sitePurpose = String(body.purpose || '');
  const config = PURPOSES[sitePurpose];
  if (!config) return { ok: false, errors: { purpose: 'Please choose what you are contacting us about.' } };
  const errors = {};
  let contact;
  let message = '';
  let fields = {};
  let prospect = null;

  if (sitePurpose === 'general') {
    contact = { name: s(body, 'name', 80), email: s(body, 'email', 254), phone: s(body, 'phone', 30), organization: null };
    message = long(body, 'message', 1000);
    need(errors, 'name', contact.name, 80, 'your name');
    email(errors, 'email', contact.email);
    phone(errors, 'phone', contact.phone, false);
    if (message.length < 10) errors.message = 'Please tell us a little more (at least 10 characters).';
    else if (message.length > 1000) errors.message = 'Please keep your message under 1000 characters.';
  } else if (sitePurpose === 'player-interest') {
    contact = { name: s(body, 'parent_name', 80), email: s(body, 'parent_email', 254), phone: s(body, 'phone', 30), organization: null };
    const child = s(body, 'player_name', 80);
    const grade = s(body, 'grade', 10);
    const school = s(body, 'school', 100);
    const position = s(body, 'position', 40);
    const highlight = s(body, 'highlight_link', 300);
    message = long(body, 'player_notes', 1000);
    need(errors, 'parent_name', contact.name, 80, "the parent's name");
    email(errors, 'parent_email', contact.email);
    phone(errors, 'phone', contact.phone, false);
    need(errors, 'player_name', child, 80, "the player's name");
    if (!GRADES.includes(grade)) errors.grade = 'Please choose a grade.';
    need(errors, 'school', school, 100, 'their school');
    if (position && !POSITIONS.includes(position)) errors.position = 'Please choose a position from the list.';
    // Optional: a highlight video is unusual for a 3rd grader (plan item O11).
    if (highlight && !URL_RE.test(highlight)) errors.highlight_link = 'Please enter a link starting with http:// or https://.';
    if (message.length > 1000) errors.player_notes = 'Please keep notes under 1000 characters.';
    fields = { player_name: child, grade, school, position: position || null, highlight_link: highlight || null };
    prospect = { name: child, gradeLevel: parseLegacyGrade(grade), school, position: position || null };
  } else if (sitePurpose === 'coaching-interest') {
    contact = { name: s(body, 'coach_name', 80), email: s(body, 'coach_email', 254), phone: s(body, 'coach_phone', 30), organization: null };
    const role = s(body, 'coach_role', 40);
    const location = s(body, 'coach_location', 80);
    message = long(body, 'coach_experience', 1000);
    need(errors, 'coach_name', contact.name, 80, 'your name');
    email(errors, 'coach_email', contact.email);
    phone(errors, 'coach_phone', contact.phone, true);
    if (!COACH_ROLES.includes(role)) errors.coach_role = 'Please choose a role.';
    need(errors, 'coach_location', location, 80, 'your city and state');
    if (message.length < 10) errors.coach_experience = 'Please tell us a little about your background.';
    else if (message.length > 1000) errors.coach_experience = 'Please keep this under 1000 characters.';
    fields = { role, location };
  } else {
    // sponsor-interest, volunteer-interest
    contact = { name: s(body, 'name', 80), email: s(body, 'email', 254), phone: s(body, 'phone', 30),
      organization: sitePurpose === 'sponsor-interest' ? s(body, 'organization', 120) || null : null };
    message = long(body, 'message', 1000);
    need(errors, 'name', contact.name, 80, 'your name');
    email(errors, 'email', contact.email);
    phone(errors, 'phone', contact.phone, sitePurpose === 'volunteer-interest');
    if (contact.organization && contact.organization.length > 120) errors.organization = 'Please keep the organization under 120 characters.';
    if (message.length > 1000) errors.message = 'Please keep your message under 1000 characters.';
    if (sitePurpose === 'sponsor-interest') fields = { organization: contact.organization };
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { sitePurpose, config, contact, message: message || null, fields, prospect } };
}

const iso = () => new Date().toISOString();

/** Tomorrow's Central date, YYYY-MM-DD: a "respond by" that means something in Franklin. */
function tomorrowCentral(now = Date.now()) {
  const d = new Date(now + 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(d);
  return parts; // en-CA formats as YYYY-MM-DD
}

/**
 * Record a validated lead. Idempotent enough for a double-click: one contact
 * per email, one open card per prospect child, one open auto task per contact.
 * @returns {Promise<{inquiryId: number, contactId: number}>}
 */
export async function recordLead(env, { value, ipHash }) {
  const now = iso();
  const { config, contact, message, fields, prospect } = value;
  const emailNorm = normEmail(contact.email);
  const phoneNorm = contact.phone ? contact.phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '') : null;
  const owner = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = ?1`)
    .bind(`crm.owner.${config.purpose}`)
    .first();

  // Contact: create, or refresh what we know. A converted/merged contact has
  // no email any more, so this never resurrects one.
  await env.DB.prepare(
    `INSERT INTO crm_contacts (kind, name, email, email_norm, phone, phone_norm, organization, owner_email, source,
                               account_id, household_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
             (SELECT id FROM accounts WHERE email_norm = ?4 AND status = 'active'),
             (SELECT m.household_id FROM household_members m JOIN accounts a ON a.id = m.account_id
               WHERE a.email_norm = ?4 ORDER BY m.created_at LIMIT 1),
             ?10, ?10)
     ON CONFLICT (email_norm) WHERE email_norm IS NOT NULL DO UPDATE SET
       name = excluded.name, phone = COALESCE(excluded.phone, crm_contacts.phone),
       phone_norm = COALESCE(excluded.phone_norm, crm_contacts.phone_norm),
       organization = COALESCE(excluded.organization, crm_contacts.organization),
       account_id = COALESCE(crm_contacts.account_id, excluded.account_id),
       household_id = COALESCE(crm_contacts.household_id, excluded.household_id),
       updated_at = excluded.updated_at`
  )
    .bind(config.kind, contact.name, contact.email, emailNorm, contact.phone || null, phoneNorm, contact.organization,
      owner?.value || null, `website:${config.purpose}`, now)
    .run();
  const c = await env.DB.prepare(`SELECT id, household_id FROM crm_contacts WHERE email_norm = ?1`).bind(emailNorm).first();

  const inquiry = await env.DB.prepare(
    `INSERT INTO crm_inquiries (contact_id, household_id, purpose, fields, message, ip_hash, received_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id`
  )
    .bind(c.id, c.household_id, config.purpose, JSON.stringify(fields || {}), message, ipHash, now)
    .first();

  const statements = [];
  if (prospect) {
    // One prospect row per child name per contact; a repeat form refreshes it.
    let p = await env.DB.prepare(
      `SELECT id FROM crm_prospect_players WHERE contact_id = ?1 AND lower(name) = lower(?2)`
    ).bind(c.id, prospect.name).first();
    if (!p) {
      p = await env.DB.prepare(
        `INSERT INTO crm_prospect_players (contact_id, name, grade_level, grade_school_year, school, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7) RETURNING id`
      ).bind(c.id, prospect.name, prospect.gradeLevel, prospect.gradeLevel === null ? null : schoolYearOf(),
        prospect.school, prospect.position, now).first();
    }
    statements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO crm_opportunities (pipeline, stage, contact_id, household_id, prospect_player_id, owner_email,
                                                source, opened_at, created_at, updated_at)
       VALUES ('family', 'new', ?1, ?2, ?3, ?4, ?5, ?6, ?6, ?6)`
    ).bind(c.id, c.household_id, p.id, owner?.value || null, `website:${config.purpose}`, now));
  } else if (config.pipeline) {
    statements.push(env.DB.prepare(
      `INSERT INTO crm_opportunities (pipeline, stage, contact_id, owner_email, source, opened_at, created_at, updated_at)
       SELECT ?1, 'new', ?2, ?3, ?4, ?5, ?5, ?5
        WHERE NOT EXISTS (SELECT 1 FROM crm_opportunities WHERE contact_id = ?2 AND pipeline = ?1 AND closed_at IS NULL)`
    ).bind(config.pipeline, c.id, owner?.value || null, `website:${config.purpose}`, now));
  }
  statements.push(env.DB.prepare(
    `INSERT INTO crm_tasks (title, due_on, owner_email, origin, contact_id, household_id, inquiry_id, created_by, created_at)
     SELECT ?1, ?2, ?3, 'auto:inquiry', ?4, ?5, ?6, 'system:website', ?7
      WHERE NOT EXISTS (SELECT 1 FROM crm_tasks WHERE contact_id = ?4 AND origin = 'auto:inquiry' AND status = 'open')`
  ).bind(config.task, tomorrowCentral(), owner?.value || null, c.id, c.household_id, inquiry.id, now));
  await env.DB.batch(statements);
  return { inquiryId: Number(inquiry.id), contactId: Number(c.id) };
}

/** Null inquiries' IP hashes after 30 days; they exist only for rate limiting. Bounded. */
export async function expireInquiryIpHashes(env) {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const res = await env.DB.prepare(
    `UPDATE crm_inquiries SET ip_hash = NULL
      WHERE rowid IN (SELECT rowid FROM crm_inquiries WHERE ip_hash IS NOT NULL AND received_at < ?1 LIMIT 500)`
  ).bind(cutoff).run();
  return res.meta.changes || 0;
}
