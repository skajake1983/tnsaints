/**
 * Decisions and the outbound batch, plus cancelling or deleting a registration
 * and reviewing, editing and previewing each message.
 *
 * Everything here is admin-only. A coach records what they saw; deciding who
 * is offered a place, and mailing fifty families about it, is not that job.
 */

import { json } from '../../http.js';
import { can, audit } from '../../auth/staff.js';
import { adminCancelRegistration, adminDeleteRegistration } from '../../registration.js';
import { page, adminHeaders } from '../ui.js';
import { gateMessage, textToHtml } from '../../feedback/compose.js';
import { checkEditedBody } from '../../feedback/safety.js';
import {
  bulkReplace, reopenMessages, setDecision, decisionGrid, buildBatch, approveBatch, preflight, drainBatch,
} from '../../feedback/batches.js';
import { decisionsBody, DECISION_STYLES, decisionsCsp } from '../decisions-ui.js';
import { NAV, denyHtml, denyJson } from '../nav.js';

async function readJsonBody(request) {
  try {
    return { body: await request.json() };
  } catch {
    return { error: json({ ok: false, error: 'Could not read that request.' }, { status: 400 }) };
  }
}

export const routes = [
  {
    method: 'POST', path: /^\/api\/decision\/(\d+)$/, cap: 'decisions:set',
    deny: denyJson('Only academy admins set decisions.'),
    handler: async ({ request, env, ctx, principal }, m) => {
      const { body, error } = await readJsonBody(request);
      if (error) return error;
      const result = await setDecision(env, {
        registrationId: Number(m[1]),
        decision: body.decision,
        actor: principal.email,
      });
      if (result.ok) {
        ctx.waitUntil(
          audit(env, {
            actor: principal.email,
            action: 'decision.set',
            subjectType: 'registration',
            subjectId: Number(m[1]),
            detail: { decision: body.decision },
          })
        );
      }
      return json(result, { status: result.ok ? 200 : 400 });
    },
  },
  {
    method: 'POST', path: '/api/batch/build', cap: 'messages:approve',
    deny: denyJson('Only academy admins build batches.'),
    handler: async ({ env, ctx, principal }) => {
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
    },
  },
  {
    method: 'POST', path: /^\/api\/batch\/([\w.-]+)\/approve$/, cap: 'messages:approve',
    deny: denyJson('Only academy admins approve batches.'),
    handler: async ({ env, ctx, principal }, m) => {
      const result = await approveBatch(env, m[1], principal.email);
      if (result.ok) {
        ctx.waitUntil(
          audit(env, {
            actor: principal.email,
            action: 'batch.approve',
            subjectType: 'batch',
            subjectId: m[1],
            detail: { queued: result.queued },
          })
        );
      }
      return json(result, { status: result.ok ? 200 : 400 });
    },
  },
  // Send messages back a step so they can be edited again. Whole batch, or a
  // selection — "the signature is wrong on all of them" and "this one message
  // reads badly" are both real, and they need different sized answers.
  {
    method: 'POST', path: /^\/api\/batch\/([\w.-]+)\/reopen$/, cap: 'messages:approve',
    deny: denyJson('Only academy admins can reopen messages.'),
    handler: async ({ request, env, ctx, principal }, m) => {
      let body = {};
      try {
        body = await request.json();
      } catch {
        /* whole-batch reopen sends no body */
      }
      const ids = Array.isArray(body.message_ids) ? body.message_ids : null;
      const result = await reopenMessages(env, { batchId: m[1], messageIds: ids, actor: principal.email });
      if (result.ok) {
        ctx.waitUntil(
          audit(env, {
            actor: principal.email,
            action: 'batch.reopen',
            subjectType: 'batch',
            subjectId: m[1],
            detail: { reopened: result.reopened, selective: Boolean(ids) },
          })
        );
      }
      return json(result, { status: result.ok ? 200 : 400 });
    },
  },
  // Replace a run of text across many drafts at once — the "wrong footer on
  // every message" case, which rebuilding cannot fix because buildBatch
  // deliberately preserves hand-edited drafts.
  {
    method: 'POST', path: /^\/api\/batch\/([\w.-]+)\/replace$/, cap: 'messages:approve',
    deny: denyJson('Only academy admins can edit messages.'),
    handler: async ({ request, env, ctx, principal }, m) => {
      const { body, error } = await readJsonBody(request);
      if (error) return error;
      const result = await bulkReplace(env, {
        batchId: m[1],
        messageIds: Array.isArray(body.message_ids) ? body.message_ids : null,
        find: body.find,
        replace: body.replace,
        preview: Boolean(body.preview),
        actor: principal.email,
      });
      if (result.ok && !result.preview) {
        // Lengths and counts only. The find and replace strings are message
        // content and can carry a child's name; audit_log holds identifiers.
        ctx.waitUntil(
          audit(env, {
            actor: principal.email,
            action: 'messages.bulk_replace',
            subjectType: 'batch',
            subjectId: m[1],
            detail: {
              changed: result.changed,
              of: result.of,
              find_len: String(body.find || '').length,
              replace_len: String(body.replace || '').length,
            },
          })
        );
      }
      return json(result, { status: result.ok ? 200 : 400 });
    },
  },
  // Every other batch verb is admin-gated; this one once was open, leaking
  // operational metadata (queued count, email budget) to any staffer.
  {
    method: 'GET', path: /^\/api\/batch\/([\w.-]+)\/preflight$/, cap: 'messages:approve',
    deny: denyJson('Not permitted.'),
    handler: async ({ env }, m) => json({ ok: true, ...(await preflight(env, m[1])) }),
  },
  // The only endpoint in this system that mails families. Deliberately a
  // separate, explicit action from approval — approving says "these messages
  // are right", sending says "send them now", and collapsing the two removes
  // the last moment where someone can stop.
  {
    method: 'POST', path: /^\/api\/batch\/([\w.-]+)\/send$/, cap: 'messages:send',
    deny: denyJson('Only academy admins send batches.'),
    handler: async ({ env, ctx, principal }, m) => {
      const result = await drainBatch(env, m[1], { max: 10 });
      ctx.waitUntil(
        audit(env, {
          actor: principal.email,
          action: 'batch.send_tick',
          subjectType: 'batch',
          subjectId: m[1],
          detail: { sent: result.sent, queued: result.queued, failed: result.failed },
        })
      );
      return json(result, { status: result.ok ? 200 : 400 });
    },
  },
  {
    method: 'GET', path: '/decisions', cap: 'decisions:set',
    deny: denyHtml('Decisions', 'Decisions and sending are limited to academy admins.'),
    handler: ({ env, principal }) => renderDecisions(env, principal),
  },
  // Cancel keeps the record and frees the seat; delete destroys it. Both are
  // admin-only and both are audited. See registration.js for why cancel is the
  // default and delete refuses once a family has already been mailed.
  {
    method: 'POST', path: /^\/api\/registration\/(\d+)\/cancel$/, cap: 'decisions:set',
    deny: denyJson('Only academy admins can cancel a place.'),
    handler: async ({ request, env, ctx, principal }, m) => {
      let body = {};
      try {
        body = await request.json();
      } catch {
        /* reason is optional */
      }
      const result = await adminCancelRegistration(env, Number(m[1]), body.reason);
      if (!result.ok) {
        return json(
          {
            ok: false,
            error: result.code === 'already-cancelled' ? 'That place is already cancelled.' : 'No such player in this event.',
          },
          { status: result.code === 'already-cancelled' ? 409 : 404 }
        );
      }
      ctx.waitUntil(
        audit(env, {
          actor: principal.email,
          action: 'registration.cancel',
          subjectType: 'registration',
          subjectId: Number(m[1]),
          detail: { promoted: Boolean(result.promoted) },
        })
      );
      return json({ ok: true, promoted: Boolean(result.promoted) });
    },
  },
  {
    method: 'POST', path: /^\/api\/registration\/(\d+)\/delete$/, cap: 'decisions:set',
    deny: denyJson('Only academy admins can delete a player.'),
    handler: async ({ env, ctx, principal }, m) => {
      const result = await adminDeleteRegistration(env, Number(m[1]));
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
          subjectId: Number(m[1]),
          detail: { destroyed: result.destroyed, promoted: Boolean(result.promoted) },
        })
      );
      return json({ ok: true, destroyed: result.destroyed });
    },
  },
  // Mark one message read. approveBatch() refuses while any draft is unread,
  // so this is what makes approval reachable at all — and it can only be set by
  // opening the message, which is the point.
  {
    method: 'POST', path: /^\/api\/message\/(\d+)\/review$/, cap: 'messages:approve',
    deny: denyJson('Not permitted.'),
    handler: async ({ env, ctx, principal }, m) => {
      const res = await env.DB.prepare(
        `UPDATE parent_messages SET reviewed_by = ?2, reviewed_at = ?3
          WHERE id = ?1 AND send_state = 'draft'`
      )
        .bind(Number(m[1]), principal.email, new Date().toISOString())
        .run();
      if (res.meta.changes === 0) {
        return json({ ok: false, error: 'That message is no longer a draft, so it cannot be marked read.' }, { status: 409 });
      }
      ctx.waitUntil(
        audit(env, { actor: principal.email, action: 'message.review', subjectType: 'message', subjectId: Number(m[1]) })
      );
      return json({ ok: true });
    },
  },
  // Edit the message before it is frozen.
  //
  // This was missing entirely once, and its absence was the real defect behind
  // "families all got the same letter": compose.js promised that a human edits
  // the draft into one voice and that the edit is what sends, but there was no
  // surface to do it, so machine-assembled text went out verbatim.
  {
    method: 'POST', path: /^\/api\/message\/(\d+)\/edit$/, cap: 'messages:approve',
    deny: denyJson('Not permitted.'),
    handler: async ({ request, env, ctx, principal }, m) => {
      const { body, error } = await readJsonBody(request);
      if (error) return error;
      return handleMessageEdit(env, ctx, principal, Number(m[1]), body.body_text);
    },
  },
  {
    method: 'GET', path: /^\/api\/message\/(\d+)\/preview$/, cap: 'messages:approve',
    deny: denyJson('Not permitted.'),
    handler: ({ env }, m) => renderPreview(env, Number(m[1])),
  },
];

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
    `SELECT m.id, m.send_state, m.registration_id, r.player_name, r.parent_email,
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
    return json({ ok: false, error: `This message is ${m.send_state} and can no longer be edited.` }, { status: 409 });
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

  // Free text from a human, on a screen that also shows staff-only notes and
  // forty-nine other children's messages. See feedback/safety.js.
  const safe = await checkEditedBody(env, {
    registrationId: m.registration_id,
    bodyText: text,
    playerName: m.player_name,
  });
  if (!safe.ok) {
    return json({ ok: false, error: safe.error }, { status: 400 });
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
