/**
 * The admin surface, served on its own hostname.
 *
 * WHY A HOSTNAME AND NOT api.tnsaints.com/admin
 * ----------------------------------------------
 * Same Worker, same D1, same-origin fetch — the split is not about
 * infrastructure. It is about which way a mistake fails.
 *
 * api.tnsaints.com must keep /api/register and /api/availability public
 * forever, so any Access application on that hostname is necessarily
 * path-scoped. Path-scoped policies fail OPEN: add /api/staff/... in six
 * months, forget to widen the include rule, and it is on the public internet
 * serving children's medical notes with no error anywhere. admin.tnsaints.com/*
 * fails CLOSED — a path nobody thought about is still behind the door.
 *
 * The decisive argument is blast radius. A fat-fingered Access policy on
 * api.tnsaints.com during a live campaign breaks parent registration. On a
 * separate hostname the same mistake breaks only the dashboard, and families
 * signing up never notice.
 *
 * It also keeps /api/stripe/webhook reachable later: Stripe cannot do SSO, so
 * on a path-scoped app you would be carving an exception into the policy you
 * just wrote.
 */

import { json } from '../http.js';
import { verifyAccessJwt, devPrincipalEmail } from '../auth/access.js';
import { loadStaff, can, audit, rosterView } from '../auth/staff.js';
import {
  getAvailability,
  registrationWindow,
  slotCapacity,
  sessionTimes,
  adminCancelRegistration,
  adminDeleteRegistration,
} from '../registration.js';
import { page, esc, htmlResponse, notAuthorisedPage, adminHeaders } from './ui.js';
import {
  saveEvaluation,
  evaluationForStaff,
  completeness,
  deleteCoachEvaluation,
} from '../feedback/notes.js';
import { gateMessage, textToHtml } from '../feedback/compose.js';
import {
  setDecision,
  decisionGrid,
  buildBatch,
  approveBatch,
  preflight,
  drainBatch,
} from '../feedback/batches.js';
import { evalFormBody, evalListBody, EVAL_STYLES, evalCsp } from './eval-ui.js';
import { logoResponse } from './logo.js';
import { decisionsBody, DECISION_STYLES, decisionsCsp } from './decisions-ui.js';

const NAV = [
  { href: '/', label: 'Roster' },
  { href: '/eval', label: 'Evaluations' },
  { href: '/decisions', label: 'Decisions' },
  { href: '/profile', label: 'Profile' },
];

/**
 * Everything on this hostname is gated. There is no public path here by
 * design — see the module comment on failing closed.
 */
export async function handleAdmin(request, env, ctx, path) {
  const url = new URL(request.url);
  // Resolved by the dispatcher, which strips the local development prefix. Do
  // not read url.pathname directly here — that would make every route below
  // wrong under local dev, which is exactly where they get tested.
  const pathname = path || url.pathname;

  // Served before the STAFF check — Cloudflare Access still gates the hostname
  // in front of it, so this is not a public URL. It sits here so the response
  // stays a plain cacheable image rather than something that varies by
  // principal: these are the same bytes tnsaints.com serves to anyone, and
  // nothing about who is signed in can be inferred from them.
  if (pathname === '/logo.png' && request.method === 'GET') {
    return logoResponse();
  }

  // Local development only — see devPrincipalEmail(). Null in production.
  const devEmail = devPrincipalEmail(request, env);
  const verified = devEmail
    ? { ok: true, email: devEmail, sub: 'dev', claims: {} }
    : await verifyAccessJwt(request, env);

  if (!verified.ok) {
    // 401 rather than 403: the visitor has not proven who they are. In normal
    // operation this is unreachable, because Access redirects to login before
    // the request ever arrives — reaching it means either a direct hit that
    // bypassed the Access app, or a misconfiguration. Both are worth seeing.
    const detail =
      verified.reason === 'misconfigured'
        ? 'This admin app is not fully configured yet. Contact Jacob.'
        : 'Sign in through the Tennessee Saints staff login to continue.';

    return htmlResponse(
      page({
        title: 'Sign in required',
        body: `<h1>Sign in required</h1><p class="sub">${esc(detail)}</p>`,
      }),
      { status: 401 }
    );
  }

  const principal = await loadStaff(env, verified.email);

  if (!principal) {
    // Authenticated, not authorised. This is the control that survives someone
    // widening the Access policy: being admitted through the door is not the
    // same as being on the staff list.
    console.warn(
      JSON.stringify({ event: 'admin_denied_not_staff', email_domain: verified.email.split('@')[1] })
    );
    ctx.waitUntil(
      audit(env, {
        actor: verified.email,
        action: 'admin.denied',
        detail: { reason: 'not-in-staff' },
      })
    );
    return htmlResponse(notAuthorisedPage(verified.email), { status: 403 });
  }

  if (pathname === '/' && request.method === 'GET') {
    return await renderRoster(env, principal);
  }

  if (pathname === '/profile' && request.method === 'GET') {
    return renderWhoami(principal);
  }

  // JSON sibling of the roster page, same projection. Useful for a quick pull
  // from a phone and, later, for the notes UI to fetch against.
  if (pathname === '/api/roster' && request.method === 'GET') {
    const rows = await rosterView(env, principal);
    return json({ ok: true, count: rows.length, registrations: rows });
  }

  if (pathname === '/api/health' && request.method === 'GET') {
    return json({ ok: true, principal: principal.email, role: principal.role });
  }

  // A medical note is a real safety need on event day and the most sensitive
  // field in the database. Resolved by ACCESS PATH rather than by widening the
  // coach role: everyone sees a flag saying a note exists, reading the text is
  // admin-only, and every read leaves an audit row naming who read whose.
  //
  // Deliberately not folded into the roster projection even for admins. A
  // field that arrives with the page gets read by nobody in particular and
  // audits as one bulk event; a field you have to ask for audits as an
  // intentional act, which is what makes the log worth keeping.
  const medical = pathname.match(/^\/api\/roster\/(\d+)\/medical$/);
  if (medical && request.method === 'GET') {
    return await handleMedicalRead(env, ctx, principal, Number(medical[1]));
  }

  if (pathname === '/eval' && request.method === 'GET') {
    return await renderEvalList(env, principal);
  }

  const evalForm = pathname.match(/^\/eval\/(\d+)$/);
  if (evalForm && request.method === 'GET') {
    return await renderEvalForm(env, principal, Number(evalForm[1]));
  }

  const evalSave = pathname.match(/^\/api\/eval\/(\d+)$/);
  if (evalSave && request.method === 'POST') {
    return await handleEvalSave(request, env, ctx, principal, Number(evalSave[1]));
  }

  // Remove another coach's evaluation. An admin may delete, never overwrite —
  // see the capability comment in auth/staff.js.
  const evalDelete = pathname.match(/^\/api\/eval\/(\d+)\/author\/delete$/);
  if (evalDelete && request.method === 'POST') {
    if (!can(principal, 'feedback:delete')) {
      return json(
        { ok: false, error: 'Only academy admins can remove another coach’s evaluation.' },
        { status: 403 }
      );
    }
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
    const result = await deleteCoachEvaluation(env, Number(evalDelete[1]), target);
    if (!result.ok) {
      return json({ ok: false, error: 'That coach has no evaluation for this player.' }, { status: 404 });
    }
    ctx.waitUntil(
      audit(env, {
        actor: principal.email,
        action: 'eval.delete',
        subjectType: 'registration',
        subjectId: Number(evalDelete[1]),
        detail: { removed_author: target, had_internal: result.hadInternal },
      })
    );
    return json({ ok: true, removed: result.authorLabel });
  }

  // --- Decisions and the outbound batch ------------------------------------
  // Everything here is admin-only. A coach records what they saw; deciding who
  // is offered a place, and mailing fifty families about it, is not that job.

  const decide = pathname.match(/^\/api\/decision\/(\d+)$/);
  if (decide && request.method === 'POST') {
    if (!can(principal, 'decisions:set')) {
      return json({ ok: false, error: 'Only academy admins set decisions.' }, { status: 403 });
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'Could not read that request.' }, { status: 400 });
    }
    const result = await setDecision(env, {
      registrationId: Number(decide[1]),
      decision: body.decision,
      actor: principal.email,
    });
    if (result.ok) {
      ctx.waitUntil(
        audit(env, {
          actor: principal.email,
          action: 'decision.set',
          subjectType: 'registration',
          subjectId: Number(decide[1]),
          detail: { decision: body.decision },
        })
      );
    }
    return json(result, { status: result.ok ? 200 : 400 });
  }

  if (pathname === '/api/batch/build' && request.method === 'POST') {
    if (!can(principal, 'messages:approve')) {
      return json({ ok: false, error: 'Only academy admins build batches.' }, { status: 403 });
    }
    const result = await buildBatch(env, principal.email);
    if (result.ok) {
      ctx.waitUntil(
        audit(env, {
          actor: principal.email,
          action: 'batch.build',
          subjectType: 'batch',
          subjectId: result.batchId,
          detail: { composed: result.composed, blocked: result.problems.length },
        })
      );
    }
    return json(result, { status: result.ok ? 200 : 400 });
  }

  const approve = pathname.match(/^\/api\/batch\/([\w.-]+)\/approve$/);
  if (approve && request.method === 'POST') {
    if (!can(principal, 'messages:approve')) {
      return json({ ok: false, error: 'Only academy admins approve batches.' }, { status: 403 });
    }
    const result = await approveBatch(env, approve[1], principal.email);
    if (result.ok) {
      ctx.waitUntil(
        audit(env, {
          actor: principal.email,
          action: 'batch.approve',
          subjectType: 'batch',
          subjectId: approve[1],
          detail: { queued: result.queued },
        })
      );
    }
    return json(result, { status: result.ok ? 200 : 400 });
  }

  const pre = pathname.match(/^\/api\/batch\/([\w.-]+)\/preflight$/);
  if (pre && request.method === 'GET') {
    return json({ ok: true, ...(await preflight(env, pre[1])) });
  }

  // The only endpoint in this system that mails families. Deliberately a
  // separate, explicit action from approval — approving says "these messages
  // are right", sending says "send them now", and collapsing the two removes
  // the last moment where someone can stop.
  const drain = pathname.match(/^\/api\/batch\/([\w.-]+)\/send$/);
  if (drain && request.method === 'POST') {
    if (!can(principal, 'messages:send')) {
      return json({ ok: false, error: 'Only academy admins send batches.' }, { status: 403 });
    }
    const result = await drainBatch(env, drain[1], { max: 10 });
    ctx.waitUntil(
      audit(env, {
        actor: principal.email,
        action: 'batch.send_tick',
        subjectType: 'batch',
        subjectId: drain[1],
        detail: { sent: result.sent, queued: result.queued, failed: result.failed },
      })
    );
    return json(result, { status: result.ok ? 200 : 400 });
  }

  if (pathname === '/decisions' && request.method === 'GET') {
    if (!can(principal, 'decisions:set')) {
      return htmlResponse(
        page({
          title: 'Decisions',
          principal,
          nav: NAV,
          body: '<h1>Not permitted</h1><p class="sub">Decisions and sending are limited to academy admins.</p>',
        }),
        { status: 403 }
      );
    }
    return await renderDecisions(env, principal);
  }

  // Cancel keeps the record and frees the seat; delete destroys it. Both are
  // admin-only and both are audited. See registration.js for why cancel is the
  // default and delete refuses once a family has already been mailed.
  const cancelReg = pathname.match(/^\/api\/registration\/(\d+)\/cancel$/);
  if (cancelReg && request.method === 'POST') {
    if (!can(principal, 'decisions:set')) {
      return json({ ok: false, error: 'Only academy admins can cancel a place.' }, { status: 403 });
    }
    let body = {};
    try {
      body = await request.json();
    } catch {
      /* reason is optional */
    }
    const result = await adminCancelRegistration(env, Number(cancelReg[1]), body.reason);
    if (!result.ok) {
      return json(
        {
          ok: false,
          error:
            result.code === 'already-cancelled'
              ? 'That place is already cancelled.'
              : 'No such player in this event.',
        },
        { status: result.code === 'already-cancelled' ? 409 : 404 }
      );
    }
    ctx.waitUntil(
      audit(env, {
        actor: principal.email,
        action: 'registration.cancel',
        subjectType: 'registration',
        subjectId: Number(cancelReg[1]),
        detail: { promoted: Boolean(result.promoted) },
      })
    );
    return json({ ok: true, promoted: Boolean(result.promoted) });
  }

  const deleteReg = pathname.match(/^\/api\/registration\/(\d+)\/delete$/);
  if (deleteReg && request.method === 'POST') {
    if (!can(principal, 'decisions:set')) {
      return json({ ok: false, error: 'Only academy admins can delete a player.' }, { status: 403 });
    }
    const result = await adminDeleteRegistration(env, Number(deleteReg[1]));
    if (!result.ok) {
      return json(
        {
          ok: false,
          error:
            result.code === 'already-messaged'
              ? 'This family has already been emailed, so the record cannot be deleted. Cancel it instead.'
              : 'No such player in this event.',
        },
        { status: result.code === 'already-messaged' ? 409 : 404 }
      );
    }
    // Audited with what was destroyed, because this is the one action with no
    // undo and "how many notes went with it" is the question asked afterwards.
    ctx.waitUntil(
      audit(env, {
        actor: principal.email,
        action: 'registration.delete',
        subjectType: 'registration',
        subjectId: Number(deleteReg[1]),
        detail: { destroyed: result.destroyed, promoted: Boolean(result.promoted) },
      })
    );
    return json({ ok: true, destroyed: result.destroyed });
  }

  // Mark one message read. approveBatch() refuses while any draft is unread,
  // so this is what makes approval reachable at all — and it can only be set by
  // opening the message, which is the point.
  const reviewMsg = pathname.match(/^\/api\/message\/(\d+)\/review$/);
  if (reviewMsg && request.method === 'POST') {
    if (!can(principal, 'messages:approve')) {
      return json({ ok: false, error: 'Not permitted.' }, { status: 403 });
    }
    const res = await env.DB.prepare(
      `UPDATE parent_messages SET reviewed_by = ?2, reviewed_at = ?3
        WHERE id = ?1 AND send_state = 'draft'`
    )
      .bind(Number(reviewMsg[1]), principal.email, new Date().toISOString())
      .run();

    if (res.meta.changes === 0) {
      return json(
        { ok: false, error: 'That message is no longer a draft, so it cannot be marked read.' },
        { status: 409 }
      );
    }
    ctx.waitUntil(
      audit(env, {
        actor: principal.email,
        action: 'message.review',
        subjectType: 'message',
        subjectId: Number(reviewMsg[1]),
      })
    );
    return json({ ok: true });
  }

  // Edit the message before it is frozen.
  //
  // This was missing entirely, and its absence was the real defect behind
  // "families all got the same letter": compose.js promised that a human edits
  // the draft into one voice and that the edit is what sends, but there was no
  // surface to do it, so machine-assembled text went out verbatim.
  const editMsg = pathname.match(/^\/api\/message\/(\d+)\/edit$/);
  if (editMsg && request.method === 'POST') {
    if (!can(principal, 'messages:approve')) {
      return json({ ok: false, error: 'Not permitted.' }, { status: 403 });
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'Could not read that request.' }, { status: 400 });
    }
    return await handleMessageEdit(env, ctx, principal, Number(editMsg[1]), body.body_text);
  }

  const previewMatch = pathname.match(/^\/api\/message\/(\d+)\/preview$/);
  if (previewMatch && request.method === 'GET') {
    if (!can(principal, 'messages:approve')) {
      return json({ ok: false, error: 'Not permitted.' }, { status: 403 });
    }
    return await renderPreview(env, Number(previewMatch[1]));
  }

  return htmlResponse(
    page({
      title: 'Not found',
      principal,
      nav: NAV,
      body: `<h1>Not found</h1><p class="sub">No admin page at ${esc(pathname)}.</p>`,
    }),
    { status: 404 }
  );
}

async function handleMedicalRead(env, ctx, principal, registrationId) {
  if (!can(principal, 'roster:medical')) {
    // Audited even when refused. An attempt to read fifty medical notes by a
    // role that cannot is exactly the pattern worth being able to see later.
    ctx.waitUntil(
      audit(env, {
        actor: principal.email,
        action: 'medical.denied',
        subjectType: 'registration',
        subjectId: registrationId,
        detail: { role: principal.role },
      })
    );
    return json(
      { ok: false, error: 'Medical notes are limited to academy admins. Ask Jacob.' },
      { status: 403 }
    );
  }

  const row = await env.DB.prepare(
    `SELECT id, player_name, medical_notes
       FROM registrations
      WHERE id = ?1 AND event_id = ?2`
  )
    .bind(registrationId, env.EVENT_ID)
    .first();

  if (!row) {
    return json({ ok: false, error: 'No such registration.' }, { status: 404 });
  }

  // The audit records WHICH note was read and by whom, never WHAT it said.
  // Copying the text into audit_log would put the most sensitive field in the
  // database into a second table with different access rules — the precise
  // thing logging the access was meant to avoid.
  ctx.waitUntil(
    audit(env, {
      actor: principal.email,
      action: 'medical.read',
      subjectType: 'registration',
      subjectId: registrationId,
      detail: { had_note: Boolean(row.medical_notes) },
    })
  );

  return json({
    ok: true,
    registration_id: row.id,
    player_name: row.player_name,
    medical_notes: row.medical_notes || null,
  });
}

async function handleEvalSave(request, env, ctx, principal, registrationId) {
  if (!can(principal, 'notes:write')) {
    return json({ ok: false, error: 'This role cannot write evaluations.' }, { status: 403 });
  }

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

/**
 * Render one queued message exactly as the family will receive it.
 *
 * Reads the SNAPSHOT — body_html as frozen at build time — rather than
 * recomposing. Recomposing for the preview would defeat the entire purpose:
 * you would be reviewing a fresh render while a different, older one sits
 * queued to send.
 *
 * Player name and parent email are shown together above the message, because
 * the catastrophic failure in this system is one family receiving another
 * child's feedback, and the only reliable way to catch it is to see the pair
 * side by side.
 */
async function renderPreview(env, messageId) {
  const m = await env.DB.prepare(
    `SELECT m.id, m.subject, m.body_html, m.send_state, r.player_name, r.parent_email,
            COALESCE(d.decision, 'undecided') AS decision
       FROM parent_messages m
       JOIN registrations r ON r.id = m.registration_id
       LEFT JOIN decisions d ON d.registration_id = m.registration_id
      WHERE m.id = ?1`
  )
    .bind(messageId)
    .first();

  if (!m) return json({ ok: false, error: 'No such message.' }, { status: 404 });

  return json({
    ok: true,
    id: m.id,
    to: m.parent_email,
    player_name: m.player_name,
    decision: m.decision,
    subject: m.subject,
    send_state: m.send_state,
    body_html: m.body_html,
  });
}

/**
 * Save an edited message body.
 *
 * Only while the message is a draft. Once approved the bytes are frozen — that
 * is what makes "what you previewed is what sends" true, and an edit after
 * approval would quietly break it.
 *
 * The gate runs again on the edited text, so a trim that removes the child's
 * name or empties the body is refused rather than saved.
 */
async function handleMessageEdit(env, ctx, principal, messageId, bodyText) {
  const text = typeof bodyText === 'string' ? bodyText.trim() : '';
  if (!text) {
    return json({ ok: false, error: 'The message cannot be empty.' }, { status: 400 });
  }

  const m = await env.DB.prepare(
    `SELECT m.id, m.send_state, r.player_name, r.parent_email,
            COALESCE(d.decision, 'undecided') AS decision,
            SUM(CASE WHEN TRIM(COALESCE(f.strengths,   '')) != '' THEN 1 ELSE 0 END) AS with_strengths,
            SUM(CASE WHEN TRIM(COALESCE(f.growth_area, '')) != '' THEN 1 ELSE 0 END) AS with_growth
       FROM parent_messages m
       JOIN registrations r ON r.id = m.registration_id
       LEFT JOIN decisions d ON d.registration_id = m.registration_id
       LEFT JOIN eval_feedback f ON f.registration_id = m.registration_id
      WHERE m.id = ?1
      GROUP BY m.id`
  )
    .bind(messageId)
    .first();

  if (!m) return json({ ok: false, error: 'No such message.' }, { status: 404 });
  if (m.send_state !== 'draft') {
    return json(
      { ok: false, error: `This message is ${m.send_state} and can no longer be edited.` },
      { status: 409 }
    );
  }

  const gate = gateMessage({
    decision: m.decision,
    draft: {
      strengths: Array(Number(m.with_strengths) || 0),
      growth: Array(Number(m.with_growth) || 0),
    },
    bodyText: text,
    parentEmail: m.parent_email,
    playerName: m.player_name,
  });

  if (!gate.ok) {
    return json({ ok: false, error: gate.problems.join(' ') }, { status: 400 });
  }

  const now = new Date().toISOString();

  // Editing counts as reading it. Requiring a separate "mark read" click after
  // someone has just rewritten the message would be ceremony, and ceremony is
  // what gets clicked through without looking.
  await env.DB.prepare(
    `UPDATE parent_messages
        SET body_text = ?2, body_html = ?3, edited_by = ?4, edited_at = ?5,
            reviewed_by = ?4, reviewed_at = ?5
      WHERE id = ?1 AND send_state = 'draft'`
  )
    .bind(messageId, text, textToHtml(text), principal.email, now)
    .run();

  ctx.waitUntil(
    audit(env, {
      actor: principal.email,
      action: 'message.edit',
      subjectType: 'message',
      subjectId: messageId,
      detail: { chars: text.length },
    })
  );

  return json({ ok: true });
}

async function renderDecisions(env, principal) {
  const rows = await decisionGrid(env);

  // The most recent batch for this event. Only one can be in flight at a time,
  // enforced by a partial unique index, so "most recent" is unambiguous.
  const batch = await env.DB.prepare(
    `SELECT id, state, approved_by, approved_at FROM decision_batches
      WHERE event_id = ?1 ORDER BY created_at DESC LIMIT 1`
  )
    .bind(env.EVENT_ID)
    .first();

  let messages = [];
  let pre = null;

  if (batch) {
    const res = await env.DB.prepare(
      // stale_notes is computed in SQL so the screen and the server agree by
      // construction rather than by two implementations happening to match.
      `SELECT m.id, m.registration_id, m.send_state, m.subject, m.body_text,
              m.reviewed_at, m.reviewed_by, m.edited_at, m.last_error,
              m.composed_for_decision,
              CASE WHEN m.composed_from_notes IS NULL
                     OR m.composed_from_notes != (
                          SELECT COUNT(*) || ':' || COALESCE(MAX(f.updated_at), '')
                            FROM eval_feedback f
                           WHERE f.registration_id = m.registration_id)
                   THEN 1 ELSE 0 END AS stale_notes
         FROM parent_messages m WHERE m.batch_id = ?1`
    )
      .bind(batch.id)
      .all();
    messages = res.results || [];
    pre = await preflight(env, batch.id);
  }

  const html = page({
    title: 'Decisions',
    principal,
    nav: NAV,
    current: '/decisions',
    extraStyles: DECISION_STYLES,
    body: decisionsBody({
      rows,
      batch,
      messages,
      pre,
      canSend: can(principal, 'messages:send'),
    }),
  });

  return new Response(html, {
    headers: adminHeaders({ 'Content-Security-Policy': await decisionsCsp() }),
  });
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

function renderWhoami(principal) {
  return htmlResponse(
    page({
      title: 'Profile',
      principal,
      nav: NAV,
      current: '/profile',
      body: `
  <h1>Signed in</h1>
  <p class="sub">What this account can see and do.</p>
  <div class="panel"><div class="scroll"><table>
    <tbody>
      <tr><th>Email</th><td>${esc(principal.email)}</td></tr>
      <tr><th>Name</th><td>${esc(principal.displayName)}</td></tr>
      <tr><th>Credited to parents as</th><td>${esc(principal.authorLabel)}</td></tr>
      <tr><th>Role</th><td>${esc(principal.role)}</td></tr>
      <tr><th>Contact details</th><td>${can(principal, 'roster:contact') ? 'visible' : 'hidden'}</td></tr>
      <tr><th>Medical notes</th><td>${can(principal, 'roster:medical') ? 'readable (audited)' : 'flag only'}</td></tr>
    </tbody>
  </table></div></div>`,
    })
  );
}

async function renderRoster(env, principal) {
  const [rows, availability] = await Promise.all([
    rosterView(env, principal),
    getAvailability(env),
  ]);

  const window = registrationWindow(env);
  const capacity = slotCapacity(env);
  const times = sessionTimes(env);

  const count = (time, status) =>
    rows.filter((r) => r.session_time === time && r.status === status).length;

  const confirmed = rows.filter((r) => r.status === 'confirmed').length;
  const waitlisted = rows.filter((r) => r.status === 'waitlist').length;
  const cancelled = rows.filter((r) => r.status === 'cancelled').length;
  const medical = rows.filter((r) => r.has_medical_notes === 1).length;

  const showsContact = can(principal, 'roster:contact');

  const cards = [
    { n: `${confirmed} / ${capacity * times.length}`, l: 'Confirmed' },
    { n: waitlisted, l: 'Waiting list' },
    { n: cancelled, l: 'Cancelled' },
    { n: medical, l: 'Medical note on file' },
  ]
    .map((c) => `<div class="card"><div class="n">${esc(c.n)}</div><div class="l">${esc(c.l)}</div></div>`)
    .join('');

  const sessionRows = times
    .map((t) => {
      const c = count(t, 'confirmed');
      const w = count(t, 'waitlist');
      const full = availability.sessions.find((s) => s.session_time === t)?.full;
      return `<tr>
        <td data-label="Session"><strong>${esc(t)}</strong></td>
        <td data-label="Confirmed">${c} of ${capacity}</td>
        <td data-label="Availability">${full ? '<span class="pill waitlist">full</span>' : `<span class="pill confirmed">${capacity - c} open</span>`}</td>
        <td data-label="Waiting list">${w} waiting</td>
      </tr>`;
    })
    .join('');

  const headers = ['Player', 'Grade', 'Yrs', 'Session', 'Status', 'School']
    .concat(showsContact ? ['Parent', 'Email', 'Phone'] : [])
    .concat(['Flags'])
    .map((h) => `<th>${esc(h)}</th>`)
    .join('');

  const body = rows.length
    ? rows
        .map((r) => {
          const contact = showsContact
            ? `<td data-label="Parent">${esc(r.parent_name)}</td><td data-label="Email">${esc(r.parent_email)}</td><td data-label="Phone">${esc(r.phone)}</td>`
            : '';
          // The flag, never the text. A coach needs to know the note exists;
          // reading it goes through the audited admin endpoint.
          const flag = r.has_medical_notes
            ? '<span class="med">medical note — see Jacob</span>'
            : '';
          return `<tr>
        <td data-label="Player"><strong>${esc(r.player_name)}</strong></td>
        <td data-label="Grade">${esc(r.grade)}</td>
        <td data-label="Yrs">${esc(r.years_experience ?? '')}</td>
        <td data-label="Session">${esc(r.session_time)}</td>
        <td data-label="Status"><span class="pill ${esc(r.status)}">${esc(r.status)}</span></td>
        <td data-label="School">${esc(r.school)}</td>
        ${contact}
        <td data-label="Flags">${flag}</td>
      </tr>`;
        })
        .join('')
    : '';

  const table = rows.length
    ? `<div class="scroll"><table class="stack"><thead><tr>${headers}</tr></thead><tbody>${body}</tbody></table></div>`
    : `<div class="empty">No registrations yet for this event.</div>`;

  const windowNote = window.open
    ? `Registration is open until ${esc(new Date(window.closesAt).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' }))} Central.`
    : 'Registration is closed.';

  return htmlResponse(
    page({
      title: 'Roster',
      principal,
      nav: NAV,
      current: '/',
      body: `
  <h1>${esc(env.EVENT_LABEL || env.EVENT_ID)}</h1>
  <p class="sub">${windowNote}</p>

  <div class="cards">${cards}</div>

  <div class="panel">
    <h2>Sessions</h2>
    <div class="scroll"><table class="stack">
      <thead><tr><th>Session</th><th>Confirmed</th><th>Availability</th><th>Waiting list</th></tr></thead>
      <tbody>${sessionRows}</tbody>
    </table></div>
  </div>

  <div class="panel">
    <h2>Registrations</h2>
    ${table}
  </div>

  ${
    showsContact
      ? ''
      : `<div class="notice">Contact details and medical notes are not shown to this role.
         If you need to reach a family, or a player has a medical note, ask Jacob.</div>`
  }`,
    })
  );
}
