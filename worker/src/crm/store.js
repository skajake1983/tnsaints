/**
 * The CRM's reads and writes for the staff screens (admin/routes/crm.js).
 *
 * TWO KINDS OF PEOPLE.
 *   - CONTACTS (crm_contacts): leads, coaches, volunteers, sponsors — people
 *     who are not a portal family. Their name, email and phone live here.
 *   - FAMILIES (households): once a contact has a portal account, the family
 *     is authoritative and the contact's copy of their details is cleared
 *     (crm/reconcile.js). The CRM keeps only an owner and a do-not-contact
 *     flag about a family (crm_household_meta); everything else is read live.
 *
 * Staff text (activity notes) lives in crm_activities and never in audit_log;
 * the routes audit identifiers only. Medical information never appears here.
 *
 * Every list is bounded. Every write that has an "only if" — a stage that
 * exists in the card's pipeline, a contact still active — says it inside the
 * statement, not in a read beforehand.
 */

import { normEmail } from '../auth/access.js';
import { PHONE_RE } from '../validate.js';
import { parseLegacyGrade, schoolYearOf } from '../lib/grades.js';

export const PIPELINES = ['family', 'coach', 'volunteer', 'sponsor', 'donor'];
export const PIPELINE_LABELS = { family: 'Families', coach: 'Coaches', volunteer: 'Volunteers', sponsor: 'Sponsors', donor: 'Donors' };
export const CONTACT_KINDS = ['family', 'coach', 'volunteer', 'sponsor', 'donor', 'other'];
export const KIND_LABELS = { family: 'Family', coach: 'Coach', volunteer: 'Volunteer', sponsor: 'Sponsor', donor: 'Donor', other: 'Other' };
export const LOGGED_KINDS = ['note', 'call', 'email', 'text', 'meeting'];
export const TASK_VIEWS = ['today', 'overdue', 'week', 'open', 'done'];

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const iso = () => new Date().toISOString();
const DAY_MS = 24 * 60 * 60 * 1000;
const clean = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max + 1);
const phoneDigits = (p) => (p ? p.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '') : null);

/** Today's Central date, YYYY-MM-DD. */
export function centralToday(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(now));
}

/** The Central date `days` after `date` (YYYY-MM-DD arithmetic, no clocks). */
export function addDays(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Every stage of every pipeline, in order: Map pipeline -> [{stage, label, outcome}]. */
export async function allStages(env) {
  const { results } = await env.DB.prepare(
    `SELECT pipeline, stage, label, position, outcome FROM crm_stages ORDER BY pipeline, position`
  ).all();
  const map = new Map(PIPELINES.map((p) => [p, []]));
  for (const r of results || []) map.get(r.pipeline)?.push(r);
  return map;
}

/** Staff who can own a contact, family or task. */
export async function owners(env) {
  const { results } = await env.DB.prepare(
    `SELECT email_norm AS email, display_name FROM staff WHERE active = 1 ORDER BY display_name`
  ).all();
  return results || [];
}

async function validOwner(env, owner) {
  if (!owner) return '';
  const row = await env.DB.prepare(`SELECT email_norm FROM staff WHERE email_norm = ?1 AND active = 1`)
    .bind(normEmail(owner)).first();
  return row ? row.email_norm : null;
}

const CARD_SELECT = `
  SELECT o.id, o.pipeline, o.stage, o.owner_email, o.updated_at, o.closed_at, o.contact_id, o.household_id,
         o.player_id, o.source, s.label AS stage_label, s.outcome,
         CASE WHEN o.pipeline = 'family'
              THEN COALESCE(NULLIF(p.display_name, ''), NULLIF(pp.name, ''), 'Child not named yet')
              ELSE COALESCE(NULLIF(c.name, ''), h.display_name, 'Unnamed') END AS title,
         CASE WHEN o.pipeline = 'family' THEN COALESCE(h.display_name, c.name)
              ELSE c.organization END AS who,
         COALESCE(c.do_not_contact, hm.do_not_contact, 0) AS do_not_contact
    FROM crm_opportunities o
    JOIN crm_stages s ON s.pipeline = o.pipeline AND s.stage = o.stage
    LEFT JOIN crm_contacts c ON c.id = o.contact_id
    LEFT JOIN crm_prospect_players pp ON pp.id = o.prospect_player_id
    LEFT JOIN players p ON p.id = o.player_id
    LEFT JOIN households h ON h.id = o.household_id
    LEFT JOIN crm_household_meta hm ON hm.household_id = o.household_id`;

/** One pipeline's cards: everything open, plus what closed in the last 30 days. */
export async function board(env, pipeline, { owner = '' } = {}) {
  const since = new Date(Date.now() - 30 * DAY_MS).toISOString();
  const { results } = await env.DB.prepare(
    `${CARD_SELECT}
      WHERE o.pipeline = ?1 AND (o.closed_at IS NULL OR o.closed_at >= ?2)
        AND (?3 = '' OR o.owner_email = ?3 OR (?3 = 'none' AND o.owner_email IS NULL))
      ORDER BY o.updated_at DESC LIMIT 500`
  ).bind(pipeline, since, owner).all();
  return results || [];
}

/**
 * Move a card to another stage of ITS pipeline. Won/lost stages close the
 * card; any other stage (re)opens it. The timeline gets a 'stage' entry.
 * @returns {Promise<'moved'|'same'|'invalid'|'conflict'>}
 */
export async function moveCard(env, { id, stage, actor }) {
  const now = iso();
  try {
    const [, moved] = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO crm_activities (kind, detail, contact_id, household_id, opportunity_id, actor, occurred_at, created_at)
         SELECT 'stage', json_object('from', o.stage, 'to', s.stage), o.contact_id, o.household_id, o.id, ?3, ?4, ?4
           FROM crm_opportunities o JOIN crm_stages s ON s.pipeline = o.pipeline AND s.stage = ?2
          WHERE o.id = ?1 AND o.stage != ?2 AND (o.contact_id IS NOT NULL OR o.household_id IS NOT NULL)`
      ).bind(id, stage, actor, now),
      env.DB.prepare(
        `UPDATE crm_opportunities
            SET stage = ?2, updated_at = ?3,
                closed_at = CASE WHEN (SELECT outcome FROM crm_stages s
                                        WHERE s.pipeline = crm_opportunities.pipeline AND s.stage = ?2) IN ('won', 'lost')
                                 THEN ?3 ELSE NULL END
          WHERE id = ?1 AND stage != ?2
            AND EXISTS (SELECT 1 FROM crm_stages s WHERE s.pipeline = crm_opportunities.pipeline AND s.stage = ?2)`
      ).bind(id, stage, now),
    ]);
    if (moved.meta?.changes) return 'moved';
  } catch (err) {
    // Reopening a card for a child who already has an open one.
    if (/UNIQUE/i.test(String(err?.message))) return 'conflict';
    throw err;
  }
  const row = await env.DB.prepare(
    `SELECT o.stage FROM crm_opportunities o JOIN crm_stages s ON s.pipeline = o.pipeline AND s.stage = ?2 WHERE o.id = ?1`
  ).bind(id, stage).first();
  return row ? 'same' : 'invalid';
}

/** The List screen: active contacts, filtered. */
export async function listContacts(env, { kind = '', owner = '', q = '', stage = '', dnc = false } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.kind, c.name, c.email, c.phone, c.organization, c.owner_email, c.do_not_contact, c.source,
            c.household_id, c.created_at, c.updated_at,
            (SELECT group_concat(s.label, ', ') FROM crm_opportunities o
               JOIN crm_stages s ON s.pipeline = o.pipeline AND s.stage = o.stage
              WHERE o.contact_id = c.id AND o.closed_at IS NULL) AS open_stages,
            (SELECT MAX(a.occurred_at) FROM crm_activities a
              WHERE a.contact_id = c.id AND a.kind IN ('note', 'call', 'email', 'text', 'meeting')) AS last_contact
       FROM crm_contacts c
      WHERE c.status = 'active'
        AND (?1 = '' OR c.kind = ?1)
        AND (?2 = '' OR c.owner_email = ?2 OR (?2 = 'none' AND c.owner_email IS NULL))
        AND (?3 = '' OR instr(lower(COALESCE(c.name, '') || ' ' || COALESCE(c.email, '') || ' ' ||
                                    COALESCE(c.organization, '') || ' ' || COALESCE(c.phone, '')), lower(?3)) > 0)
        AND (?4 = '' OR EXISTS (SELECT 1 FROM crm_opportunities o WHERE o.contact_id = c.id AND o.closed_at IS NULL
                                   AND o.pipeline || ':' || o.stage = ?4))
        AND (?5 = 0 OR c.do_not_contact = 1)
      ORDER BY c.updated_at DESC LIMIT 500`
  ).bind(kind, owner, clean(q, 80), stage, dnc ? 1 : 0).all();
  return results || [];
}

/** Everything about one contact, in one round trip. Null if there is no such contact. */
export async function contactDetail(env, id) {
  const one = (sql) => env.DB.prepare(sql).bind(id);
  const [contact, prospects, cards, tasks, inquiries, activities, duplicates] = await env.DB.batch([
    one(`SELECT c.*, h.display_name AS family_name, m.name AS merged_into_name
           FROM crm_contacts c LEFT JOIN households h ON h.id = c.household_id
           LEFT JOIN crm_contacts m ON m.id = c.merged_into_id WHERE c.id = ?1`),
    one(`SELECT pp.id, pp.name, pp.grade_level, pp.grade_school_year, pp.school, pp.position, pp.player_id,
                p.display_name AS player_name
           FROM crm_prospect_players pp LEFT JOIN players p ON p.id = pp.player_id
          WHERE pp.contact_id = ?1 ORDER BY pp.id`),
    one(`${CARD_SELECT} WHERE o.contact_id = ?1 ORDER BY o.closed_at IS NOT NULL, o.updated_at DESC LIMIT 50`),
    one(`SELECT id, title, due_on, owner_email, status, origin, completed_at FROM crm_tasks
          WHERE contact_id = ?1 ORDER BY status != 'open', due_on IS NULL, due_on, id DESC LIMIT 50`),
    one(`SELECT id, purpose, fields, message, received_at, status FROM crm_inquiries
          WHERE contact_id = ?1 ORDER BY received_at DESC LIMIT 50`),
    one(`SELECT id, kind, body, detail, actor, occurred_at FROM crm_activities
          WHERE contact_id = ?1 ORDER BY occurred_at DESC, id DESC LIMIT 200`),
    // A shared phone only SUGGESTS a duplicate: families share phones.
    one(`SELECT d.id, d.name, d.email, d.kind FROM crm_contacts c JOIN crm_contacts d
           ON d.phone_norm = c.phone_norm AND d.id != c.id AND d.status = 'active'
          WHERE c.id = ?1 AND c.phone_norm IS NOT NULL LIMIT 10`),
  ]);
  const row = contact.results?.[0];
  if (!row) return null;
  return {
    contact: row,
    prospects: prospects.results || [],
    cards: cards.results || [],
    tasks: tasks.results || [],
    inquiries: inquiries.results || [],
    activities: activities.results || [],
    duplicates: duplicates.results || [],
  };
}

/** Everything about one portal family, read live. Null if there is no such family. */
export async function householdDetail(env, id) {
  const one = (sql) => env.DB.prepare(sql).bind(id);
  const contactsOf = `SELECT id FROM crm_contacts WHERE household_id = ?1`;
  const guardianEmails = `SELECT a.email_norm FROM accounts a JOIN household_members hm ON hm.account_id = a.id
                           WHERE hm.household_id = ?1`;
  const [house, guardians, children, enrollments, payments, subscriptions, cards, tasks, activities, inquiries,
    contacts, evalMessages] = await env.DB.batch([
    one(`SELECT h.id, h.display_name, h.status, h.created_at, m.owner_email, COALESCE(m.do_not_contact, 0) AS do_not_contact
           FROM households h LEFT JOIN crm_household_meta m ON m.household_id = h.id WHERE h.id = ?1`),
    one(`SELECT a.email, a.display_name, hm.role, hm.relationship, hm.phone
           FROM household_members hm JOIN accounts a ON a.id = hm.account_id
          WHERE hm.household_id = ?1 ORDER BY hm.role = 'owner' DESC, hm.created_at`),
    one(`SELECT id, display_name, grade_level, grade_school_year, school FROM players
          WHERE household_id = ?1 ORDER BY display_name`),
    one(`SELECT e.id, e.status, e.applied_at, e.offered_at, e.activated_at, e.ended_at, e.offer_expires_at,
                p.display_name AS child_name, pr.name AS program_name, g.name AS group_name
           FROM enrollments e JOIN players p ON p.id = e.player_id JOIN programs pr ON pr.id = e.program_id
           LEFT JOIN program_groups g ON g.id = e.group_id
          WHERE e.household_id = ?1 ORDER BY e.applied_at DESC LIMIT 50`),
    one(`SELECT amount_cents, kind, status, paid_at FROM payments WHERE household_id = ?1 ORDER BY paid_at DESC LIMIT 36`),
    one(`SELECT b.paypal_subscription_id, b.status, b.next_billing_at, b.last_payment_at
           FROM billing_subscriptions b LEFT JOIN enrollments e ON e.id = b.enrollment_id
          WHERE b.household_id = ?1 OR e.household_id = ?1 LIMIT 20`),
    one(`${CARD_SELECT} WHERE o.household_id = ?1 ORDER BY o.closed_at IS NOT NULL, o.updated_at DESC LIMIT 50`),
    one(`SELECT id, title, due_on, owner_email, status, origin, completed_at FROM crm_tasks
          WHERE household_id = ?1 OR contact_id IN (${contactsOf})
          ORDER BY status != 'open', due_on IS NULL, due_on, id DESC LIMIT 50`),
    one(`SELECT id, kind, body, detail, actor, occurred_at FROM crm_activities
          WHERE household_id = ?1 OR contact_id IN (${contactsOf})
          ORDER BY occurred_at DESC, id DESC LIMIT 200`),
    one(`SELECT id, purpose, fields, message, received_at, status FROM crm_inquiries
          WHERE household_id = ?1 OR contact_id IN (${contactsOf}) ORDER BY received_at DESC LIMIT 50`),
    one(`SELECT id, kind, status, source FROM crm_contacts WHERE household_id = ?1 ORDER BY id`),
    one(`SELECT m.sent_at, r.player_name FROM parent_messages m JOIN registrations r ON r.id = m.registration_id
          WHERE m.send_state = 'sent' AND r.parent_email_norm IN (${guardianEmails}) ORDER BY m.sent_at DESC LIMIT 20`),
  ]);
  const row = house.results?.[0];
  if (!row) return null;
  return {
    household: row,
    guardians: guardians.results || [],
    children: children.results || [],
    enrollments: enrollments.results || [],
    payments: payments.results || [],
    subscriptions: subscriptions.results || [],
    cards: cards.results || [],
    tasks: tasks.results || [],
    activities: activities.results || [],
    inquiries: inquiries.results || [],
    contacts: contacts.results || [],
    evalMessages: evalMessages.results || [],
  };
}

/**
 * Log a call, note, email, text or meeting against a contact or a family.
 * `occurredOn` is a Central date (today if empty); never in the future.
 * @returns {Promise<'logged'|'invalid'|'not-found'>}
 */
export async function logActivity(env, { contactId = null, householdId = null, kind, body, occurredOn = '', actor }) {
  if (!LOGGED_KINDS.includes(kind)) return 'invalid';
  const text = String(body ?? '').trim();
  if (text.length > 4000) return 'invalid';
  if (kind === 'note' && !text) return 'invalid';
  const today = centralToday();
  let occurredAt = iso();
  if (occurredOn) {
    if (!DATE_RE.test(occurredOn) || occurredOn > today || occurredOn < addDays(today, -366)) return 'invalid';
    if (occurredOn !== today) occurredAt = `${occurredOn}T17:00:00.000Z`; // midday Central
  }
  const now = iso();
  const res = contactId
    ? await env.DB.prepare(
      `INSERT INTO crm_activities (kind, body, contact_id, household_id, actor, occurred_at, created_at)
       SELECT ?2, ?3, c.id, c.household_id, ?4, ?5, ?6 FROM crm_contacts c WHERE c.id = ?1 AND c.status = 'active'`
    ).bind(contactId, kind, text || null, actor, occurredAt, now).run()
    : await env.DB.prepare(
      `INSERT INTO crm_activities (kind, body, household_id, actor, occurred_at, created_at)
       SELECT ?2, ?3, h.id, ?4, ?5, ?6 FROM households h WHERE h.id = ?1 AND h.status = 'active'`
    ).bind(householdId, kind, text || null, actor, occurredAt, now).run();
  return res.meta?.changes ? 'logged' : 'not-found';
}

/**
 * Who on staff looks after a contact or family ('' = nobody). Their open
 * cards follow.
 * @returns {Promise<'saved'|'invalid'|'not-found'>}
 */
export async function setOwner(env, { contactId = null, householdId = null, owner, actor }) {
  const who = await validOwner(env, owner);
  if (who === null) return 'invalid';
  const now = iso();
  const value = who || null;
  if (contactId) {
    const [res] = await env.DB.batch([
      env.DB.prepare(`UPDATE crm_contacts SET owner_email = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'active'`)
        .bind(contactId, value, now),
      env.DB.prepare(`UPDATE crm_opportunities SET owner_email = ?2, updated_at = ?3
                       WHERE contact_id = ?1 AND closed_at IS NULL
                         AND EXISTS (SELECT 1 FROM crm_contacts WHERE id = ?1 AND status = 'active')`)
        .bind(contactId, value, now),
    ]);
    return res.meta?.changes ? 'saved' : 'not-found';
  }
  const [res] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO crm_household_meta (household_id, owner_email, updated_by, updated_at)
       SELECT id, ?2, ?3, ?4 FROM households WHERE id = ?1 AND status = 'active'
       ON CONFLICT (household_id) DO UPDATE SET owner_email = excluded.owner_email,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    ).bind(householdId, value, actor, now),
    env.DB.prepare(`UPDATE crm_opportunities SET owner_email = ?2, updated_at = ?3
                     WHERE household_id = ?1 AND closed_at IS NULL`).bind(householdId, value, now),
  ]);
  return res.meta?.changes ? 'saved' : 'not-found';
}

/**
 * Do-not-contact on or off, for a contact or a family, recorded on the timeline.
 * @returns {Promise<'saved'|'not-found'>}
 */
export async function setDoNotContact(env, { contactId = null, householdId = null, on, actor }) {
  const now = iso();
  const flag = on ? 1 : 0;
  const detail = JSON.stringify({ on: Boolean(on) });
  // The timeline entry first, written only if the flag is about to change;
  // then the change itself. One transaction.
  if (contactId) {
    const [, , exists] = await env.DB.batch([
      env.DB.prepare(`INSERT INTO crm_activities (kind, detail, contact_id, household_id, actor, occurred_at, created_at)
                      SELECT 'dnc', ?2, id, household_id, ?3, ?4, ?4 FROM crm_contacts
                       WHERE id = ?1 AND status = 'active' AND do_not_contact != ?5`)
        .bind(contactId, detail, actor, now, flag),
      env.DB.prepare(`UPDATE crm_contacts SET do_not_contact = ?2, updated_at = ?3
                       WHERE id = ?1 AND status = 'active' AND do_not_contact != ?2`).bind(contactId, flag, now),
      env.DB.prepare(`SELECT id FROM crm_contacts WHERE id = ?1 AND status = 'active'`).bind(contactId),
    ]);
    return exists.results?.length ? 'saved' : 'not-found';
  }
  const current = `COALESCE((SELECT do_not_contact FROM crm_household_meta WHERE household_id = ?1), 0)`;
  const [, , exists] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO crm_activities (kind, detail, household_id, actor, occurred_at, created_at)
                    SELECT 'dnc', ?2, id, ?3, ?4, ?4 FROM households
                     WHERE id = ?1 AND status = 'active' AND ${current} != ?5`)
      .bind(householdId, detail, actor, now, flag),
    env.DB.prepare(
      `INSERT INTO crm_household_meta (household_id, do_not_contact, updated_by, updated_at)
       SELECT id, ?2, ?3, ?4 FROM households WHERE id = ?1 AND status = 'active'
       ON CONFLICT (household_id) DO UPDATE SET do_not_contact = excluded.do_not_contact,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    ).bind(householdId, flag, actor, now),
    env.DB.prepare(`SELECT id FROM households WHERE id = ?1 AND status = 'active'`).bind(householdId),
  ]);
  return exists.results?.length ? 'saved' : 'not-found';
}

/** Validate the "add a contact" form. Same limits as website intake. */
export function validateNewContact(form) {
  const v = {
    kind: String(form.get('kind') || ''),
    name: clean(form.get('name'), 80),
    email: clean(form.get('email'), 254),
    phone: clean(form.get('phone'), 30),
    organization: clean(form.get('organization'), 120),
    child: clean(form.get('child_name'), 80),
    grade: clean(form.get('child_grade'), 10),
    owner: clean(form.get('owner'), 254),
  };
  const errors = {};
  if (!CONTACT_KINDS.includes(v.kind)) errors.kind = 'Choose what kind of contact this is.';
  if (!v.name) errors.name = 'Enter a name.';
  else if (v.name.length > 80) errors.name = 'Keep the name under 80 characters.';
  if (v.email && (v.email.length > 254 || !EMAIL_RE.test(v.email))) errors.email = 'Enter a valid email address, or leave it blank.';
  if (v.phone && !PHONE_RE.test(v.phone)) errors.phone = 'Enter a valid phone number, or leave it blank.';
  if (!v.email && !v.phone) errors.email = 'Enter an email address or a phone number.';
  if (v.organization.length > 120) errors.organization = 'Keep the organization under 120 characters.';
  if (v.child.length > 80) errors.child_name = "Keep the child's name under 80 characters.";
  if (v.grade && parseLegacyGrade(v.grade) === null) errors.child_grade = 'Enter a grade like 4th, or leave it blank.';
  return { value: v, errors };
}

/**
 * Add a contact by hand, with a card in the matching pipeline (a family card
 * only when a child is named: family cards are per child).
 * @returns {Promise<{result: 'created'|'exists'|'invalid', id?: number}>}
 */
export async function createContact(env, value, actor) {
  const owner = await validOwner(env, value.owner);
  if (owner === null) return { result: 'invalid' };
  const now = iso();
  const emailNorm = value.email ? normEmail(value.email) : null;
  if (emailNorm) {
    const existing = await env.DB.prepare(`SELECT id FROM crm_contacts WHERE email_norm = ?1`).bind(emailNorm).first();
    if (existing) return { result: 'exists', id: Number(existing.id) };
  }
  let contact;
  try {
    contact = await env.DB.prepare(
      `INSERT INTO crm_contacts (kind, name, email, email_norm, phone, phone_norm, organization, owner_email, source,
                                 created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'manual', ?9, ?9) RETURNING id`
    ).bind(value.kind, value.name, value.email || null, emailNorm, value.phone || null, phoneDigits(value.phone),
      value.organization || null, owner || null, now).first();
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message))) return { result: 'exists' };
    throw err;
  }
  const id = Number(contact.id);
  const pipeline = value.kind === 'other' ? null : value.kind;
  if (pipeline === 'family' && value.child) {
    const grade = value.grade ? parseLegacyGrade(value.grade) : null;
    const prospect = await env.DB.prepare(
      `INSERT INTO crm_prospect_players (contact_id, name, grade_level, grade_school_year, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5) RETURNING id`
    ).bind(id, value.child, grade, grade === null ? null : schoolYearOf(), now).first();
    await env.DB.prepare(
      `INSERT INTO crm_opportunities (pipeline, stage, contact_id, prospect_player_id, owner_email, source, opened_at,
                                      created_at, updated_at)
       VALUES ('family', 'new', ?1, ?2, ?3, 'manual', ?4, ?4, ?4)`
    ).bind(id, prospect.id, owner || null, now).run();
  } else if (pipeline && pipeline !== 'family') {
    await env.DB.prepare(
      `INSERT INTO crm_opportunities (pipeline, stage, contact_id, owner_email, source, opened_at, created_at, updated_at)
       VALUES (?1, 'new', ?2, ?3, 'manual', ?4, ?4, ?4)`
    ).bind(pipeline, id, owner || null, now).run();
  }
  return { result: 'created', id };
}

/** Tasks for one view. `owner` '' = everyone's; 'none' = unassigned. */
export async function listTasks(env, { view = 'today', owner = '' } = {}) {
  const today = centralToday();
  const week = addDays(today, 6);
  const where = {
    today: `t.status = 'open' AND t.due_on = ?1`,
    overdue: `t.status = 'open' AND t.due_on < ?1`,
    week: `t.status = 'open' AND t.due_on BETWEEN ?1 AND ?2`,
    open: `t.status = 'open'`,
    done: `t.status = 'done'`,
  }[TASK_VIEWS.includes(view) ? view : 'today'];
  const order = view === 'done' ? 't.completed_at DESC' : 't.due_on IS NULL, t.due_on, t.id';
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.title, t.due_on, t.owner_email, t.status, t.origin, t.contact_id, t.household_id, t.completed_at,
            COALESCE(h.display_name, c.name, c.organization) AS about
       FROM crm_tasks t LEFT JOIN crm_contacts c ON c.id = t.contact_id LEFT JOIN households h ON h.id = t.household_id
      WHERE ${where} AND (?3 = '' OR t.owner_email = ?3 OR (?3 = 'none' AND t.owner_email IS NULL))
      ORDER BY ${order} LIMIT 300`
  ).bind(today, week, owner).all();
  return results || [];
}

/** How many open tasks fall in each view, for the tabs. */
export async function taskCounts(env, { owner = '' } = {}) {
  const today = centralToday();
  const row = await env.DB.prepare(
    `SELECT SUM(due_on = ?1) AS today, SUM(due_on < ?1) AS overdue, SUM(due_on BETWEEN ?1 AND ?2) AS week, COUNT(*) AS open
       FROM crm_tasks WHERE status = 'open' AND (?3 = '' OR owner_email = ?3 OR (?3 = 'none' AND owner_email IS NULL))`
  ).bind(today, addDays(today, 6), owner).first();
  return { today: Number(row?.today || 0), overdue: Number(row?.overdue || 0), week: Number(row?.week || 0), open: Number(row?.open || 0) };
}

/**
 * A follow-up, optionally about a contact or a family.
 * @returns {Promise<'created'|'invalid'>}
 */
export async function createTask(env, { title, dueOn = '', owner = '', contactId = null, householdId = null, actor }) {
  const t = clean(title, 140);
  if (!t || t.length > 140) return 'invalid';
  if (dueOn && (!DATE_RE.test(dueOn) || dueOn < addDays(centralToday(), -366))) return 'invalid';
  const who = await validOwner(env, owner);
  if (who === null) return 'invalid';
  const res = await env.DB.prepare(
    `INSERT INTO crm_tasks (title, due_on, owner_email, origin, contact_id, household_id, created_by, created_at)
     SELECT ?1, ?2, ?3, 'manual', ?4,
            COALESCE(?5, (SELECT household_id FROM crm_contacts WHERE id = ?4)), ?6, ?7
      WHERE (?4 IS NULL OR EXISTS (SELECT 1 FROM crm_contacts WHERE id = ?4 AND status = 'active'))
        AND (?5 IS NULL OR EXISTS (SELECT 1 FROM households WHERE id = ?5 AND status = 'active'))`
  ).bind(t, dueOn || null, who || null, contactId, householdId, actor, iso()).run();
  return res.meta?.changes ? 'created' : 'invalid';
}

/** done / cancelled / open again. */
export async function setTaskStatus(env, { id, status, actor }) {
  if (!['done', 'cancelled', 'open'].includes(status)) return false;
  const closing = status !== 'open';
  const res = await env.DB.prepare(
    `UPDATE crm_tasks SET status = ?2, completed_at = CASE WHEN ?3 THEN ?4 ELSE NULL END,
            completed_by = CASE WHEN ?3 THEN ?5 ELSE NULL END
      WHERE id = ?1 AND status != ?2`
  ).bind(id, status, closing ? 1 : 0, iso(), actor).run();
  return Boolean(res.meta?.changes);
}

/**
 * The Customers screen: every family with a place in a program (any status,
 * including applied and waiting), its children's places, payments and the
 * last time staff were in touch.
 */
export async function customers(env) {
  const [families, places] = await env.DB.batch([
    env.DB.prepare(
      `SELECT h.id, h.display_name, m.owner_email, COALESCE(m.do_not_contact, 0) AS do_not_contact,
              (SELECT MAX(paid_at) FROM payments p WHERE p.household_id = h.id AND p.amount_cents > 0) AS last_paid,
              (SELECT group_concat(DISTINCT b.status) FROM billing_subscriptions b JOIN enrollments e ON e.id = b.enrollment_id
                WHERE e.household_id = h.id AND b.status NOT IN ('CANCELLED', 'EXPIRED')) AS subscription_status,
              (SELECT MAX(a.occurred_at) FROM crm_activities a
                WHERE (a.household_id = h.id OR a.contact_id IN (SELECT id FROM crm_contacts WHERE household_id = h.id))
                  AND a.kind IN ('note', 'call', 'email', 'text', 'meeting')) AS last_contact
         FROM households h LEFT JOIN crm_household_meta m ON m.household_id = h.id
        WHERE h.status = 'active' AND EXISTS (SELECT 1 FROM enrollments e WHERE e.household_id = h.id)
        ORDER BY h.display_name LIMIT 500`
    ),
    env.DB.prepare(
      `SELECT e.household_id, e.status, p.display_name AS child_name, pr.name AS program_name, g.name AS group_name
         FROM enrollments e JOIN players p ON p.id = e.player_id JOIN programs pr ON pr.id = e.program_id
         LEFT JOIN program_groups g ON g.id = e.group_id
        WHERE e.status IN ('applied', 'waitlist', 'offered', 'active', 'past_due')
        ORDER BY p.display_name LIMIT 2000`
    ),
  ]);
  const byFamily = new Map();
  for (const p of places.results || []) {
    if (!byFamily.has(p.household_id)) byFamily.set(p.household_id, []);
    byFamily.get(p.household_id).push(p);
  }
  return (families.results || []).map((f) => ({ ...f, places: byFamily.get(f.id) || [] }));
}

/**
 * Merge one contact into another (crm:admin): everything attached to `fromId`
 * moves to `intoId`, blanks on `intoId` are filled from `fromId`, and `fromId`
 * keeps only a pointer.
 * @returns {Promise<'merged'|'invalid'>}
 */
export async function mergeContacts(env, { fromId, intoId, actor }) {
  if (!fromId || !intoId || fromId === intoId) return 'invalid';
  const both = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM crm_contacts WHERE id IN (?1, ?2) AND status = 'active'`
  ).bind(fromId, intoId).first();
  if (Number(both?.n) !== 2) return 'invalid';
  const now = iso();
  const move = (table) => env.DB.prepare(`UPDATE ${table} SET contact_id = ?2 WHERE contact_id = ?1`).bind(fromId, intoId);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE crm_contacts SET
         name = COALESCE(name, (SELECT name FROM crm_contacts WHERE id = ?1)),
         phone = COALESCE(phone, (SELECT phone FROM crm_contacts WHERE id = ?1)),
         phone_norm = COALESCE(phone_norm, (SELECT phone_norm FROM crm_contacts WHERE id = ?1)),
         organization = COALESCE(organization, (SELECT organization FROM crm_contacts WHERE id = ?1)),
         owner_email = COALESCE(owner_email, (SELECT owner_email FROM crm_contacts WHERE id = ?1)),
         household_id = COALESCE(household_id, (SELECT household_id FROM crm_contacts WHERE id = ?1)),
         account_id = COALESCE(account_id, (SELECT account_id FROM crm_contacts WHERE id = ?1)),
         do_not_contact = MAX(do_not_contact, (SELECT do_not_contact FROM crm_contacts WHERE id = ?1)),
         updated_at = ?3
       WHERE id = ?2 AND status = 'active' AND EXISTS (SELECT 1 FROM crm_contacts WHERE id = ?1 AND status = 'active')`
    ).bind(fromId, intoId, now),
    move('crm_inquiries'),
    move('crm_prospect_players'),
    move('crm_opportunities'),
    move('crm_tasks'),
    move('crm_activities'),
    env.DB.prepare(
      `UPDATE crm_contacts SET status = 'merged', merged_into_id = ?2, name = NULL, email = NULL, email_norm = NULL,
              phone = NULL, phone_norm = NULL, organization = NULL, updated_at = ?3
        WHERE id = ?1 AND status = 'active'`
    ).bind(fromId, intoId, now),
    env.DB.prepare(
      `INSERT INTO crm_activities (kind, detail, contact_id, household_id, actor, occurred_at, created_at)
       SELECT 'merge', json_object('from', ?1), id, household_id, ?3, ?4, ?4 FROM crm_contacts WHERE id = ?2`
    ).bind(fromId, intoId, actor, now),
  ]);
  return results[0].meta?.changes ? 'merged' : 'invalid';
}

/**
 * Anonymize a contact (crm:admin): their name, email, phone and organization,
 * their children's names, what they wrote on the website and what staff wrote
 * about them are removed; dates and stages remain, as counts. Open cards close.
 * Irreversible.
 * @returns {Promise<'anonymized'|'invalid'>}
 */
export async function anonymizeContact(env, { id }) {
  const now = iso();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE crm_contacts SET status = 'anonymized', name = NULL, email = NULL, email_norm = NULL, phone = NULL,
              phone_norm = NULL, organization = NULL, owner_email = NULL, updated_at = ?2
        WHERE id = ?1 AND status IN ('active', 'converted')`
    ).bind(id, now),
    env.DB.prepare(`UPDATE crm_prospect_players SET name = '', school = NULL, position = NULL, updated_at = ?2
                     WHERE contact_id = ?1
                       AND EXISTS (SELECT 1 FROM crm_contacts WHERE id = ?1 AND status = 'anonymized')`).bind(id, now),
    env.DB.prepare(`UPDATE crm_inquiries SET fields = '{}', message = NULL, ip_hash = NULL
                     WHERE contact_id = ?1 AND EXISTS (SELECT 1 FROM crm_contacts WHERE id = ?1 AND status = 'anonymized')`)
      .bind(id),
    env.DB.prepare(`UPDATE crm_activities SET body = NULL
                     WHERE contact_id = ?1 AND EXISTS (SELECT 1 FROM crm_contacts WHERE id = ?1 AND status = 'anonymized')`)
      .bind(id),
    env.DB.prepare(`UPDATE crm_tasks SET title = '(removed)', status = CASE WHEN status = 'open' THEN 'cancelled' ELSE status END
                     WHERE contact_id = ?1 AND EXISTS (SELECT 1 FROM crm_contacts WHERE id = ?1 AND status = 'anonymized')`)
      .bind(id),
    env.DB.prepare(`UPDATE crm_opportunities SET closed_at = ?2, updated_at = ?2
                     WHERE contact_id = ?1 AND closed_at IS NULL
                       AND EXISTS (SELECT 1 FROM crm_contacts WHERE id = ?1 AND status = 'anonymized')`).bind(id, now),
  ]);
  return results[0].meta?.changes ? 'anonymized' : 'invalid';
}

/**
 * Link a contact to the portal family of a given guardian email (for when the
 * family signed up with a different address than they wrote from). The
 * reconcile job then clears the contact's copy of their details.
 * @returns {Promise<{result: 'linked'|'no-family'|'not-found', householdId?: number}>}
 */
export async function linkContactToFamily(env, { contactId, guardianEmail, actor }) {
  const family = await env.DB.prepare(
    `SELECT hm.household_id, a.id AS account_id FROM accounts a JOIN household_members hm ON hm.account_id = a.id
      WHERE a.email_norm = ?1 AND a.status = 'active' ORDER BY hm.created_at LIMIT 1`
  ).bind(normEmail(guardianEmail)).first();
  if (!family) return { result: 'no-family' };
  const now = iso();
  const [, res] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO crm_activities (kind, detail, contact_id, household_id, actor, occurred_at, created_at)
                    SELECT 'linked', json_object('via', 'staff'), id, ?2, ?3, ?4, ?4
                      FROM crm_contacts WHERE id = ?1 AND status = 'active'`)
      .bind(contactId, family.household_id, actor, now),
    env.DB.prepare(`UPDATE crm_contacts SET household_id = ?2, account_id = COALESCE(account_id, ?3), updated_at = ?4
                     WHERE id = ?1 AND status = 'active'`).bind(contactId, family.household_id, family.account_id, now),
  ]);
  return res.meta?.changes ? { result: 'linked', householdId: Number(family.household_id) } : { result: 'not-found' };
}

/** The List's rows as CSV-ready objects (formula-safe via http.js toCsv). No children, no notes. */
export function exportRows(rows) {
  return rows.map((r) => ({
    name: r.name || '',
    kind: r.kind,
    email: r.email || '',
    phone: r.phone || '',
    organization: r.organization || '',
    owner: r.owner_email || '',
    open_stages: r.open_stages || '',
    do_not_contact: r.do_not_contact ? 'yes' : '',
    source: r.source || '',
    added: String(r.created_at || '').slice(0, 10),
    last_contact: String(r.last_contact || '').slice(0, 10),
  }));
}
