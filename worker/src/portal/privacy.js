/**
 * A family's privacy rights, from the Account page.
 *
 * POST /account/export          download everything we hold about the family (JSON)
 * POST /account/delete-request  delete it, GRACE_DAYS from now (privacy/deletion.js)
 * POST /account/delete-cancel   keep it after all
 *
 * Export and deletion need a RECENT sign-in (12 h): an export is the whole
 * family's data in one file, and a deletion cannot be undone once it runs, so
 * neither should ride on a three-week-old cookie. Cancelling does not: it
 * only keeps things as they are. Only the guardian who set the family up
 * (the owner) may ask or cancel; every guardian sees the date.
 *
 * WHAT THE EXPORT HOLDS: the family, its guardians (names and roles; the
 * requester's own email), its children's profiles and medical answers,
 * emergency contacts, applications and places, signed consents, payments,
 * the parent-facing evaluation feedback about its children, and the devices
 * signed in. WHAT IT LEAVES OUT: coaches' staff-only evaluation notes (plan
 * default O11) and other guardians' email addresses. Exports are recorded as
 * data requests with counts only — never the data.
 *
 * Deletion is automatic once the grace period ends, unless a legal hold is
 * placed; signed waivers and payment records are kept for their retention
 * period (PORTAL-SETUP.md, "Privacy requests").
 */

import { json } from '../http.js';
import { audit } from '../auth/staff.js';
import { rateLimit } from '../lib/ratelimit.js';
import { redirect } from './auth-pages.js';
import { inviteMessagePage } from './family-pages.js';
import { esc } from './ui.js';
import { scheduleDeletion, cancelDeletion, deletionDay, GRACE_DAYS } from '../privacy/deletion.js';
import { sendDeletionScheduled } from '../email.js';
import { portalOrigin, portalBase } from '../auth/magic.js';

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
    // Each request emails the address; a few a day is plenty for a change of mind.
    const limit = await rateLimit(env, [
      { scope: 'delete-request-day', subject: String(session.accountId), limit: 3, windowSeconds: 24 * 60 * 60 },
    ]);
    if (!limit.allowed) {
      return inviteMessagePage(rc, { title: 'Please try again tomorrow', text: 'You have asked several times today.', status: 429 });
    }
    const r = await scheduleDeletion(env, { accountId: session.accountId });
    if (r.result === 'not-owner') return ownerOnly(rc);
    if (r.result === 'scheduled') {
      ctx.waitUntil(audit(env, { actor: `account:${session.accountId}`, action: 'portal.deletion_requested',
        subjectType: 'household', subjectId: r.subject, detail: { grace_days: GRACE_DAYS } }));
      ctx.waitUntil(sendDeletionScheduled(env, { to: session.email, date: deletionDay(r.purgeAfter),
        accountUrl: `${portalOrigin(env)}${portalBase(env)}/account` }));
    }
    return redirect(rc.url('/account?notice=delete-requested'));
  }

  if (pathname === '/account/delete-cancel' && method === 'POST') {
    const r = await cancelDeletion(env, { accountId: session.accountId });
    if (r.result === 'not-owner') return ownerOnly(rc);
    if (r.result === 'cancelled') {
      ctx.waitUntil(audit(env, { actor: `account:${session.accountId}`, action: 'portal.deletion_cancelled',
        subjectType: 'data_request', subjectId: r.id }));
    }
    return redirect(rc.url('/account?notice=delete-cancelled'));
  }
  return null;
}

function ownerOnly(rc) {
  return inviteMessagePage(rc, {
    title: 'Only the guardian who set up your family can do this',
    text: "Ask them to do it from their Account page. Your family's data is unchanged.",
    status: 403,
  });
}

/**
 * The Account page's data section. `deletion` is privacy/deletion.js
 * deletionStatus(): whether this guardian may ask or cancel, and any open request.
 */
export function privacySection(rc, deletion = { owner: true, pending: null }) {
  const download = `<form method="post" action="${esc(rc.url('/account/export'))}" style="margin-bottom:12px">
    <button class="btn secondary" type="submit">Download our data</button>
  </form>`;
  const pending = deletion.pending;
  if (pending) {
    const when = pending.purgeAfter ? `will be deleted on ${esc(deletionDay(pending.purgeAfter))}` : 'is being deleted';
    return `<section class="panel" aria-labelledby="priv-h">
  <h2 id="priv-h" style="margin-top:0">Your family's data</h2>
  <div class="notice" role="note"><strong>Your family's data ${when}.</strong> Until then, nothing changes.
  ${deletion.owner ? '' : 'Only the guardian who set up your family can cancel it.'}</div>
  ${deletion.owner ? `<form method="post" action="${esc(rc.url('/account/delete-cancel'))}" style="margin-bottom:12px">
    <button class="btn" type="submit">Keep our data</button>
  </form>` : ''}
  ${download}
</section>`;
  }
  return `<section class="panel" aria-labelledby="priv-h">
  <h2 id="priv-h" style="margin-top:0">Your family's data</h2>
  <p>Download a copy of everything we hold about your family${deletion.owner ? ', or delete it' : ''}. Both need a recent sign-in.</p>
  ${download}
  ${deletion.owner ? `<details>
    <summary>Delete your family's data</summary>
    <p>We delete it ${GRACE_DAYS} days after you ask, and email you now with the date. Until then you can cancel here, and
    nothing changes.</p>
    <p><strong>What we delete:</strong> your account and your family's other guardians' sign-ins, your children's details and
    medical answers, your emergency contacts, and any place in a program. Card or bank payments stop.</p>
    <p><strong>What we keep:</strong> signed waivers and payment records, with your child's name and date of birth only, for as long
    as the law requires; then they are deleted too. If you pay through PayPal, we cancel that for you, or you can in PayPal.</p>
    <form method="post" action="${esc(rc.url('/account/delete-request'))}">
      <button class="btn secondary" type="submit">Delete our data in ${GRACE_DAYS} days</button>
    </form>
  </details>` : `<p class="hint">Only the guardian who set up your family can delete its data.</p>`}
</section>`;
}
