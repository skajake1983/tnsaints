/**
 * A family's privacy rights, from the Account page.
 *
 * POST /account/export          download everything we hold about the family (JSON)
 * POST /account/delete-request  ask us to delete it; staff act on it by runbook
 *
 * Both need a RECENT sign-in (12 h): an export is the whole family's data in
 * one file, and a deletion request is irreversible once acted on, so neither
 * should ride on a three-week-old cookie.
 *
 * WHAT THE EXPORT HOLDS: the family, its guardians (names and roles; the
 * requester's own email), its children's profiles and medical answers,
 * emergency contacts, applications and places, signed consents, payments,
 * the parent-facing evaluation feedback about its children, and the devices
 * signed in. WHAT IT LEAVES OUT: coaches' staff-only evaluation notes (plan
 * default O11) and other guardians' email addresses. Exports are recorded as
 * data requests with counts only — never the data.
 *
 * Deletion is not automatic: signed waivers and payment records are kept for
 * their retention period, and a person decides what goes (PORTAL-SETUP.md,
 * "Privacy requests").
 */

import { json } from '../http.js';
import { audit } from '../auth/staff.js';
import { rateLimit } from '../lib/ratelimit.js';
import { redirect } from './auth-pages.js';
import { inviteMessagePage } from './family-pages.js';
import { esc } from './ui.js';

const MEMBER_OF = `SELECT household_id FROM household_members WHERE account_id = ?1`;
const iso = () => new Date().toISOString();

/** Everything about the account's family, assembled from household-scoped queries only. */
export async function buildExport(env, accountId) {
  const q = (sql) => env.DB.prepare(sql).bind(accountId);
  const [account, household, guardians, children, medical, contacts, enrollments, consents, payments, feedback, sessions] =
    await env.DB.batch([
      q(`SELECT email, display_name, created_at, last_login_at FROM accounts WHERE id = ?1`),
      q(`SELECT h.id, h.display_name, h.created_at FROM households h WHERE h.id IN (${MEMBER_OF})`),
      q(`SELECT a.display_name AS name, m.role, m.relationship, CASE WHEN m.account_id = ?1 THEN m.phone END AS phone,
                m.created_at AS joined_at
           FROM household_members m JOIN accounts a ON a.id = m.account_id WHERE m.household_id IN (${MEMBER_OF})`),
      q(`SELECT p.id, p.display_name AS name, p.date_of_birth, p.grade_level, p.grade_school_year, p.school, p.shirt_size,
                p.created_at
           FROM players p WHERE p.household_id IN (${MEMBER_OF})`),
      q(`SELECT pm.player_id, pm.status, pm.notes, pm.updated_at, pm.confirmed_at
           FROM player_medical pm JOIN players p ON p.id = pm.player_id WHERE p.household_id IN (${MEMBER_OF})`),
      q(`SELECT priority, name, phone, relationship FROM household_emergency_contacts WHERE household_id IN (${MEMBER_OF})`),
      q(`SELECT e.player_id, e.program_id, e.status, e.applied_at, e.offered_at, e.activated_at, e.ended_at,
                g.name AS group_name, g.schedule_summary
           FROM enrollments e LEFT JOIN program_groups g ON g.id = e.group_id WHERE e.household_id IN (${MEMBER_OF})`),
      q(`SELECT c.player_id, c.program_id, c.waiver_version_id, c.signature, c.signer_relationship, c.photo_release, c.signed_at,
                w.title AS waiver_title, w.legal_entity
           FROM consent_records c JOIN waiver_versions w ON w.id = c.waiver_version_id WHERE c.household_id IN (${MEMBER_OF})`),
      q(`SELECT paid_at, amount_cents, currency, kind, status FROM payments WHERE household_id IN (${MEMBER_OF})`),
      // Parent-facing feedback only: every column of eval_feedback is, by the
      // schema's own invariant, safe to show a parent. eval_notes_internal is
      // never read here.
      q(`SELECT f.player_id, f.event_id, f.author_label, f.rating_skill, f.rating_effort, f.rating_coachability,
                f.rating_decisions, f.strengths, f.growth_area, f.parent_note, f.updated_at
           FROM eval_feedback f JOIN players p ON p.id = f.player_id WHERE p.household_id IN (${MEMBER_OF})`),
      q(`SELECT device_label, auth_method, created_at, last_seen_at FROM sessions
          WHERE account_id = ?1 AND revoked_at IS NULL`),
    ]);
  const rows = (r) => r.results || [];
  return {
    exported_at: iso(),
    about: 'Everything the Tennessee Saints parent portal holds about your family. Staff-only coaching notes are not included.',
    account: rows(account)[0] || null,
    family: rows(household)[0] || null,
    guardians: rows(guardians),
    children: rows(children),
    medical: rows(medical),
    emergency_contacts: rows(contacts),
    program_places: rows(enrollments),
    signed_consents: rows(consents),
    payments: rows(payments),
    evaluation_feedback: rows(feedback),
    signed_in_devices: rows(sessions),
  };
}

function needRecent(rc) {
  return inviteMessagePage(rc, {
    title: 'Please sign in again',
    text: 'For your security, this needs a recent sign-in. Sign out, sign in again, then try once more.',
    status: 403,
  });
}

/** @returns {Promise<Response|null>} */
export async function privacyRoutes({ env, ctx, rc, session, pathname, method }) {
  if (pathname === '/account/export' && method === 'POST') {
    if (!session.recentAuth) return needRecent(rc);
    const limit = await rateLimit(env, [
      { scope: 'export-account-day', subject: String(session.accountId), limit: 5, windowSeconds: 24 * 60 * 60 },
    ]);
    if (!limit.allowed) {
      return inviteMessagePage(rc, { title: 'Please try again tomorrow', text: 'You have downloaded your data several times today.', status: 429 });
    }
    const data = await buildExport(env, session.accountId);
    const counts = Object.fromEntries(
      Object.entries(data).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length])
    );
    const now = iso();
    const subject = data.family ? String(data.family.id) : `account:${session.accountId}`;
    await env.DB.prepare(
      `INSERT INTO data_requests (kind, subject_type, subject_id, requested_by, status, verification, result_counts,
                                  created_at, updated_at, completed_at, completed_by)
       VALUES ('export', 'household', ?1, ?2, 'completed', 'recent_sign_in', ?3, ?4, ?4, ?4, 'system:portal')`
    )
      .bind(subject, `account:${session.accountId}`, JSON.stringify(counts), now)
      .run();
    ctx.waitUntil(audit(env, { actor: `account:${session.accountId}`, action: 'portal.export', subjectType: 'household',
      subjectId: subject, detail: counts }));
    return json(data, {
      headers: {
        'Content-Disposition': `attachment; filename="tnsaints-family-data-${now.slice(0, 10)}.json"`,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  if (pathname === '/account/delete-request' && method === 'POST') {
    if (!session.recentAuth) return needRecent(rc);
    const household = await env.DB.prepare(`SELECT household_id FROM household_members WHERE account_id = ?1 LIMIT 1`)
      .bind(session.accountId)
      .first();
    const subject = household ? String(household.household_id) : `account:${session.accountId}`;
    const now = iso();
    const open = await env.DB.prepare(
      `SELECT 1 FROM data_requests WHERE kind = 'deletion' AND subject_id = ?1 AND status IN ('received', 'verified', 'scheduled')`
    ).bind(subject).first();
    if (!open) {
      await env.DB.prepare(
        `INSERT INTO data_requests (kind, subject_type, subject_id, requested_by, status, verification, created_at, updated_at)
         VALUES ('deletion', 'household', ?1, ?2, 'received', 'recent_sign_in', ?3, ?3)`
      ).bind(subject, `account:${session.accountId}`, now).run();
      ctx.waitUntil(audit(env, { actor: `account:${session.accountId}`, action: 'portal.deletion_requested',
        subjectType: 'household', subjectId: subject }));
    }
    return redirect(rc.url('/account?notice=delete-requested'));
  }
  return null;
}

export function privacySection(rc) {
  return `<section class="panel" aria-labelledby="priv-h">
  <h2 id="priv-h" style="margin-top:0">Your family's data</h2>
  <p>Download a copy of everything we hold about your family, or ask us to delete it. Both need a recent sign-in.</p>
  <form method="post" action="${esc(rc.url('/account/export'))}" style="margin-bottom:12px">
    <button class="btn secondary" type="submit">Download our data</button>
  </form>
  <details>
    <summary>Ask us to delete your family's data</summary>
    <p>We will delete your family's account, children's details, medical answers and contacts. Signed waivers and payment
    records are kept for as long as the law requires, then deleted. Any place in a program will end, and you should cancel
    any PayPal subscription in PayPal. We will email you when it is done.</p>
    <form method="post" action="${esc(rc.url('/account/delete-request'))}">
      <button class="btn secondary" type="submit">Ask us to delete our data</button>
    </form>
  </details>
</section>`;
}
