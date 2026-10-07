/**
 * Evaluation capture: the list, one player's form, saving, and an admin
 * removing another coach's evaluation.
 *
 * The evaluation surface shows eval_notes_internal -- coaches' candid,
 * staff-only assessments. Reading it is gated on the same capability as
 * writing it (notes:write), so a read-only role never sees internal notes
 * through the form.
 */

import { json } from '../../http.js';
import { can, audit } from '../../auth/staff.js';
import { page, htmlResponse, adminHeaders } from '../ui.js';
import { saveEvaluation, evaluationForStaff, completeness, deleteCoachEvaluation } from '../../feedback/notes.js';
import { evalFormBody, evalListBody, EVAL_STYLES, evalCsp } from '../eval-ui.js';
import { NAV, denyHtml, denyJson } from '../nav.js';

const denyEval = denyHtml('Not permitted', 'Evaluations are limited to coaches and admins.');

export const routes = [
  {
    method: 'GET', path: '/eval', cap: 'notes:write', deny: denyEval,
    handler: ({ env, principal }) => renderEvalList(env, principal),
  },
  {
    method: 'GET', path: /^\/eval\/(\d+)$/, cap: 'notes:write', deny: denyEval,
    handler: ({ env, principal }, m) => renderEvalForm(env, principal, Number(m[1])),
  },
  {
    method: 'POST', path: /^\/api\/eval\/(\d+)$/, cap: 'notes:write',
    deny: denyJson('This role cannot write evaluations.'),
    handler: ({ request, env, ctx, principal }, m) => handleEvalSave(request, env, ctx, principal, Number(m[1])),
  },
  // Remove another coach's evaluation. An admin may delete, never overwrite —
  // see the capability comment in auth/staff.js.
  {
    method: 'POST', path: /^\/api\/eval\/(\d+)\/author\/delete$/, cap: 'feedback:delete',
    deny: denyJson('Only academy admins can remove another coach’s evaluation.'),
    handler: ({ request, env, ctx, principal }, m) => handleEvalDelete(request, env, ctx, principal, Number(m[1])),
  },
];

async function handleEvalDelete(request, env, ctx, principal, registrationId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Could not read that request.' }, { status: 400 });
  }
  const target = String(body.author_email || '').trim().toLowerCase();
  if (!target) {
    return json({ ok: false, error: 'No coach specified.' }, { status: 400 });
  }
  const result = await deleteCoachEvaluation(env, registrationId, target);
  if (!result.ok) {
    return json({ ok: false, error: 'That coach has no evaluation for this player.' }, { status: 404 });
  }
  ctx.waitUntil(
    audit(env, {
      actor: principal.email,
      action: 'eval.delete',
      subjectType: 'registration',
      subjectId: registrationId,
      detail: { removed_author: target, had_internal: result.hadInternal },
    })
  );
  return json({ ok: true, removed: result.authorLabel });
}

async function handleEvalSave(request, env, ctx, principal, registrationId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Could not read that submission.' }, { status: 400 });
  }

  // The author is ALWAYS the authenticated principal, never anything the
  // request supplies. An evaluation whose attribution can be set by its sender
  // is not evidence of who observed the child; it is only a claim.
  const result = await saveEvaluation(env, {
    registrationId,
    authorEmail: principal.email,
    authorLabel: principal.authorLabel,
    data: body,
  });

  if (!result.ok) {
    return json({ ok: false, error: 'That player is no longer in this event.' }, { status: 404 });
  }

  // Identifiers and shape only — never the note text. An audit log holding the
  // notes would be a second copy of the sensitive content under different
  // access rules, which is what auditing was supposed to avoid.
  ctx.waitUntil(
    audit(env, {
      actor: principal.email,
      action: 'eval.save',
      subjectType: 'registration',
      subjectId: registrationId,
      detail: { has_internal: Boolean(String(body.internal_note || '').trim()) },
    })
  );

  return json({ ok: true, saved_as: principal.authorLabel });
}

async function renderEvalList(env, principal) {
  const summary = await completeness(env);

  const { results } = await env.DB.prepare(
    `SELECT registration_id FROM eval_feedback WHERE event_id = ?1 AND author_email = ?2`
  )
    .bind(env.EVENT_ID, principal.email)
    .all();

  const mineByRegistration = new Set((results || []).map((r) => Number(r.registration_id)));

  return htmlResponse(
    page({
      title: 'Evaluations',
      principal,
      nav: NAV,
      current: '/eval',
      extraStyles: EVAL_STYLES,
      body: evalListBody({ summary, mineByRegistration }),
    })
  );
}

async function renderEvalForm(env, principal, registrationId) {
  const registration = await env.DB.prepare(
    `SELECT id, player_name, session_time, grade, years_experience, school, status,
            CASE WHEN medical_notes IS NOT NULL AND TRIM(medical_notes) != ''
                 THEN 1 ELSE 0 END AS has_medical_notes
       FROM registrations
      WHERE id = ?1 AND event_id = ?2`
  )
    .bind(registrationId, env.EVENT_ID)
    .first();

  if (!registration) {
    return htmlResponse(
      page({
        title: 'Not found',
        principal,
        nav: NAV,
        body: '<h1>Not found</h1><p class="sub">No player with that id in this event.</p>',
      }),
      { status: 404 }
    );
  }

  const { feedback, internal } = await evaluationForStaff(env, registrationId);

  const mineFeedback = feedback.find((f) => f.author_email === principal.email) || null;
  const mineInternal = internal.find((n) => n.author_email === principal.email) || null;
  const mine = mineFeedback
    ? { ...mineFeedback, internal_note: mineInternal?.body || '' }
    : mineInternal
      ? { internal_note: mineInternal.body }
      : null;

  const canDelete = can(principal, 'feedback:delete');

  const html = page({
    title: registration.player_name,
    principal,
    nav: NAV,
    current: '/eval',
    extraStyles: EVAL_STYLES,
    body: evalFormBody({
      registration,
      mine,
      others: feedback.filter((f) => f.author_email !== principal.email),
      internalOthers: internal.filter((n) => n.author_email !== principal.email),
      canDelete,
    }),
  });

  // This page runs the only script in the admin surface, so it carries its own
  // CSP with that script's hash rather than the default deny-all.
  return new Response(html, {
    headers: adminHeaders({ 'Content-Security-Policy': await evalCsp() }),
  });
}
