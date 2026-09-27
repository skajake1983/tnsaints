/**
 * Staff reads of portal families: the families list, shirt-size totals, and a
 * child's medical note.
 *
 * The same minimisation as the evaluation roster (auth/staff.js rosterView):
 * what a staff member can see depends on capability, decided HERE in the
 * projection, so a coach's page never carries a guardian's email or a word of
 * medical text — not hidden, absent from the bytes.
 *   roster:view     families, children, grade, shirt size, academy status,
 *                   whether a medical note exists
 *   roster:contact  + guardians' email and phone, emergency contacts
 *   roster:medical  + a child's medical note, one child at a time, audited
 */

import { can } from '../auth/staff.js';
import { currentGrade } from '../lib/grades.js';

const LIVE = `('applied', 'waitlist', 'offered', 'active', 'past_due')`;

export async function familiesView(env, principal) {
  const contact = can(principal, 'roster:contact');
  const [households, members, children, contacts] = await Promise.all([
    env.DB.prepare(`SELECT id, display_name, created_at FROM households WHERE status = 'active' ORDER BY display_name, id`).all(),
    env.DB.prepare(
      `SELECT m.household_id, m.role, m.relationship, m.phone, a.display_name, a.email
         FROM household_members m JOIN accounts a ON a.id = m.account_id AND a.status = 'active'
        ORDER BY m.role DESC, m.created_at`
    ).all(),
    env.DB.prepare(
      `SELECT p.id, p.household_id, p.display_name, p.grade_level, p.grade_school_year, p.shirt_size, p.school,
              pm.status AS medical_status,
              e.status AS academy_status, g.name AS academy_group
         FROM players p
         LEFT JOIN player_medical pm ON pm.player_id = p.id
         LEFT JOIN enrollments e ON e.player_id = p.id AND e.program_id = 'academy' AND e.status IN ${LIVE}
         LEFT JOIN program_groups g ON g.id = e.group_id
        WHERE p.household_id IS NOT NULL
        ORDER BY p.display_name`
    ).all(),
    contact
      ? env.DB.prepare(
          `SELECT household_id, priority, name, phone, relationship FROM household_emergency_contacts ORDER BY household_id, priority`
        ).all()
      : Promise.resolve({ results: [] }),
  ]);

  const byHousehold = new Map((households.results || []).map((h) => [h.id, { ...h, guardians: [], children: [], contacts: [] }]));
  for (const m of members.results || []) {
    const h = byHousehold.get(m.household_id);
    if (!h) continue;
    h.guardians.push({
      name: m.display_name || '',
      role: m.role,
      relationship: m.relationship || '',
      // Contact details only for a capability that may see them.
      ...(contact ? { email: m.email, phone: m.phone || '' } : {}),
    });
  }
  for (const c of children.results || []) {
    const h = byHousehold.get(c.household_id);
    if (!h) continue;
    h.children.push({
      id: c.id,
      name: c.display_name,
      grade: currentGrade(c.grade_level, c.grade_school_year),
      shirtSize: c.shirt_size || '',
      school: c.school || '',
      medical: c.medical_status || 'missing',
      academy: c.academy_status || '',
      group: c.academy_group || '',
    });
  }
  for (const ec of contacts.results || []) byHousehold.get(ec.household_id)?.contacts.push(ec);

  const families = [...byHousehold.values()];
  return { families, contact, medical: can(principal, 'roster:medical') };
}

/**
 * Practice-shirt totals for ordering: children who hold a place or have been
 * offered one (the $40 setup fee covers the shirt), and everyone, separately.
 */
export function shirtTotals(families) {
  const placed = new Map();
  const all = new Map();
  for (const f of families) {
    for (const c of f.children) {
      const size = c.shirtSize || 'Not given';
      all.set(size, (all.get(size) || 0) + 1);
      if (['offered', 'active', 'past_due'].includes(c.academy)) placed.set(size, (placed.get(size) || 0) + 1);
    }
  }
  return { placed, all };
}

/** One child's medical note, for roster:medical only; the caller audits the read. */
export async function childMedical(env, playerId) {
  return env.DB.prepare(
    `SELECT p.id, p.display_name, h.display_name AS family_name, pm.status, pm.notes, pm.updated_at, pm.confirmed_at
       FROM players p JOIN households h ON h.id = p.household_id
       LEFT JOIN player_medical pm ON pm.player_id = p.id
      WHERE p.id = ?1 AND p.household_id IS NOT NULL`
  )
    .bind(playerId)
    .first();
}

/** Accounts staff invited that have not set up a family yet (newest first). */
export async function invitedAccounts(env) {
  const { results } = await env.DB.prepare(
    `SELECT a.email, a.created_at, a.last_login_at FROM accounts a
      WHERE a.status = 'active' AND NOT EXISTS (SELECT 1 FROM household_members m WHERE m.account_id = a.id)
      ORDER BY a.created_at DESC LIMIT 100`
  ).all();
  return results || [];
}
