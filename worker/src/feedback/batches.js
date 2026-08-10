/**
 * Decision batches: review everyone, approve once, send as one run.
 *
 * The batch exists because of a human problem rather than a technical one.
 * Reading fifty "not yet" messages in a single sitting is the only reliable way
 * to notice that one of them reads as a rejection — sending them one at a time
 * as each is written means nobody ever sees them side by side, and the worst
 * one goes out unnoticed.
 */

import { composeDraft, defaultBodyText, textToHtml, subjectFor, gateMessage } from './compose.js';
import { resolvePlayerId } from './players.js';
import { reserveSend, sendComposedMessage, emailConfigured } from '../email.js';

/** Batch ids are readable on purpose: they appear in audit rows and logs. */
function batchId(eventId, now) {
  return `${eventId}-${now.replace(/[-:T]/g, '').slice(0, 14)}`;
}

export async function setDecision(env, { registrationId, decision, actor }) {
  if (!['undecided', 'accept', 'not_yet'].includes(decision)) {
    return { ok: false, error: 'Unknown decision.' };
  }

  const reg = await env.DB.prepare(
    `SELECT id, event_id FROM registrations WHERE id = ?1 AND event_id = ?2`
  )
    .bind(registrationId, env.EVENT_ID)
    .first();

  if (!reg) return { ok: false, error: 'No such player in this event.' };

  await env.DB.prepare(
    `INSERT INTO decisions (registration_id, event_id, decision, decided_by, decided_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (registration_id) DO UPDATE SET
       decision   = excluded.decision,
       decided_by = excluded.decided_by,
       decided_at = excluded.decided_at`
  )
    .bind(registrationId, reg.event_id, decision, actor, new Date().toISOString())
    .run();

  return { ok: true };
}

/**
 * Everyone in the event with their decision and readiness.
 */
export async function decisionGrid(env) {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.player_name, r.session_time, r.grade, r.parent_email,
            COALESCE(d.decision, 'undecided') AS decision,
            d.decided_by,
            COUNT(DISTINCT f.author_email) AS coach_count,
            SUM(CASE WHEN TRIM(COALESCE(f.strengths,   '')) != '' THEN 1 ELSE 0 END) AS with_strengths,
            SUM(CASE WHEN TRIM(COALESCE(f.growth_area, '')) != '' THEN 1 ELSE 0 END) AS with_growth
       FROM registrations r
       LEFT JOIN decisions     d ON d.registration_id = r.id
       LEFT JOIN eval_feedback f ON f.registration_id = r.id
      WHERE r.event_id = ?1 AND r.status = 'confirmed'
      GROUP BY r.id
      ORDER BY r.session_time, r.player_name`
  )
    .bind(env.EVENT_ID)
    .all();

  return results || [];
}

/**
 * Build a draft batch: compose one message per confirmed player and run the
 * gate over all of them.
 *
 * Nothing is queued here. This produces drafts and a list of problems, so the
 * admin sees every objection at once rather than discovering them one at a time
 * while trying to send.
 */
export async function buildBatch(env, actor) {
  const rows = await decisionGrid(env);
  if (!rows.length) return { ok: false, error: 'No confirmed players in this event.' };

  const existing = await env.DB.prepare(
    `SELECT id, state FROM decision_batches
      WHERE event_id = ?1 AND state IN ('approved', 'sending')`
  )
    .bind(env.EVENT_ID)
    .first();

  if (existing) {
    return { ok: false, error: `A batch is already ${existing.state} (${existing.id}).` };
  }

  const now = new Date().toISOString();
  const id = batchId(env.EVENT_ID, now);

  await env.DB.prepare(
    `INSERT INTO decision_batches (id, event_id, state, created_by, created_at)
     VALUES (?1, ?2, 'draft', ?3, ?4)
     ON CONFLICT (id) DO NOTHING`
  )
    .bind(id, env.EVENT_ID, actor, now)
    .run();

  // Replace any previous drafts for this batch, so rebuilding after edits
  // reflects the current notes rather than layering on stale copies.
  await env.DB.prepare(`DELETE FROM parent_messages WHERE batch_id = ?1 AND send_state = 'draft'`)
    .bind(id)
    .run();

  const problems = [];
  let composed = 0;

  for (const row of rows) {
    const draft = await composeDraft(env, row.id, row.decision);
    const bodyText = defaultBodyText(draft, row.player_name, env);

    const gate = gateMessage({
      decision: row.decision,
      bodyText,
      parentEmail: row.parent_email,
      playerName: row.player_name,
    });

    if (!gate.ok) {
      problems.push({ registration_id: row.id, player_name: row.player_name, problems: gate.problems });
      continue;
    }

    const playerId = await resolvePlayerId(env, row.id);
    if (!playerId) continue;

    await env.DB.prepare(
      `INSERT INTO parent_messages
         (player_id, registration_id, event_id, batch_id, kind, subject,
          body_html, body_text, send_state, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, 'evaluation_decision', ?5, ?6, ?7, 'draft', ?8, ?9)
       -- The WHERE is not decoration: idx_messages_one_per_batch is a PARTIAL
       -- unique index, and SQLite only matches an ON CONFLICT target to a
       -- partial index when the clause is repeated here verbatim. Without it
       -- the statement fails outright with "does not match any PRIMARY KEY or
       -- UNIQUE constraint".
       ON CONFLICT (batch_id, registration_id)
         WHERE batch_id IS NOT NULL AND registration_id IS NOT NULL
       DO UPDATE SET
         subject   = excluded.subject,
         body_html = excluded.body_html,
         body_text = excluded.body_text`
    )
      .bind(
        playerId,
        row.id,
        env.EVENT_ID,
        id,
        subjectFor(String(row.player_name).split(/\s+/)[0], env),
        textToHtml(bodyText),
        bodyText,
        actor,
        now
      )
      .run();

    composed += 1;
  }

  return { ok: true, batchId: id, composed, problems, total: rows.length };
}

/**
 * Approve a batch and queue it.
 *
 * The gate runs again here rather than trusting the build, because notes can
 * change between building and approving — which is the exact window the
 * snapshot exists to close.
 *
 * On success every message moves draft -> queued, and the frozen body_html is
 * what will send. What was previewed is byte-identical to what goes out.
 */
export async function approveBatch(env, id, actor) {
  const batch = await env.DB.prepare(`SELECT id, state FROM decision_batches WHERE id = ?1`)
    .bind(id)
    .first();

  if (!batch) return { ok: false, error: 'No such batch.' };
  if (batch.state !== 'draft') return { ok: false, error: `Batch is already ${batch.state}.` };

  const undecided = await env.DB.prepare(
    `SELECT COUNT(*) AS n
       FROM registrations r
       LEFT JOIN decisions d ON d.registration_id = r.id
      WHERE r.event_id = ?1 AND r.status = 'confirmed'
        AND COALESCE(d.decision, 'undecided') = 'undecided'`
  )
    .bind(env.EVENT_ID)
    .first();

  if (Number(undecided?.n || 0) > 0) {
    return { ok: false, error: `${undecided.n} player(s) still have no decision.` };
  }

  const { results } = await env.DB.prepare(
    `SELECT m.id, m.body_text, m.registration_id, r.player_name, r.parent_email,
            COALESCE(d.decision, 'undecided') AS decision
       FROM parent_messages m
       JOIN registrations r ON r.id = m.registration_id
       LEFT JOIN decisions d ON d.registration_id = m.registration_id
      WHERE m.batch_id = ?1 AND m.send_state = 'draft'`
  )
    .bind(id)
    .all();

  const messages = results || [];
  if (!messages.length) return { ok: false, error: 'This batch has no draft messages.' };

  const problems = [];
  for (const m of messages) {
    const gate = gateMessage({
      decision: m.decision,
      bodyText: m.body_text,
      parentEmail: m.parent_email,
      playerName: m.player_name,
    });
    if (!gate.ok) problems.push({ player_name: m.player_name, problems: gate.problems });
  }

  if (problems.length) return { ok: false, error: 'Some messages did not pass review.', problems };

  const now = new Date().toISOString();

  await env.DB.prepare(
    `UPDATE parent_messages
        SET send_state = 'queued', approved_by = ?2, approved_at = ?3
      WHERE batch_id = ?1 AND send_state = 'draft'`
  )
    .bind(id, actor, now)
    .run();

  await env.DB.prepare(
    `UPDATE decision_batches SET state = 'approved', approved_by = ?2, approved_at = ?3
      WHERE id = ?1 AND state = 'draft'`
  )
    .bind(id, actor, now)
    .run();

  return { ok: true, queued: messages.length };
}

/**
 * What sending this batch would cost, shown BEFORE the button.
 *
 * Discovering the daily email cap at message 27 of 50 leaves half the families
 * waiting on a promise with no indication anything went wrong. This is the
 * check that turns that into a decision made in advance.
 */
export async function preflight(env, id) {
  const queued = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM parent_messages WHERE batch_id = ?1 AND send_state = 'queued'`
  )
    .bind(id)
    .first();

  const limit = parseInt(env.EMAIL_DAILY_LIMIT, 10) || 0;
  const day = new Date().toISOString().slice(0, 10);
  const spent = await env.DB.prepare(`SELECT sent FROM email_budget WHERE day = ?1`)
    .bind(day)
    .first();

  const used = Number(spent?.sent || 0);
  const remaining = Math.max(0, limit - used);
  const toSend = Number(queued?.n || 0);

  return {
    to_send: toSend,
    budget_limit: limit,
    budget_used: used,
    budget_remaining: remaining,
    enough: toSend <= remaining,
    shortfall: Math.max(0, toSend - remaining),
  };
}

/**
 * Send a slice of a batch.
 *
 * NEVER sends the whole batch in one invocation. Workers cap subrequests per
 * request (50 on the free plan) and D1 calls count toward it, so fifty sends
 * plus fifty state writes would blow the limit and leave a half-sent batch with
 * no record of where it stopped. Draining in ticks makes the stopping point a
 * row in the database rather than a guess.
 *
 * Each send is claimed with the same guarded UPDATE idiom as claimSpot():
 * proceed only if meta.changes > 0. Two concurrent drains cannot double-send,
 * and a family cannot receive two copies.
 */
export async function drainBatch(env, id, { max = 10 } = {}) {
  const batch = await env.DB.prepare(`SELECT id, state FROM decision_batches WHERE id = ?1`)
    .bind(id)
    .first();

  if (!batch) return { ok: false, error: 'No such batch.' };
  if (!['approved', 'sending'].includes(batch.state)) {
    return { ok: false, error: `Batch is ${batch.state}; nothing to send.` };
  }

  // Refuse before claiming anything. Claiming messages and then failing every
  // send would burn send_attempts and leave the batch looking half-broken when
  // the only problem is a missing API key.
  if (!emailConfigured(env)) {
    return { ok: false, error: 'Email is not configured, so nothing can be sent.' };
  }

  await env.DB.prepare(`UPDATE decision_batches SET state = 'sending' WHERE id = ?1 AND state = 'approved'`)
    .bind(id)
    .run();

  const { results } = await env.DB.prepare(
    `SELECT m.id, m.subject, m.body_html, m.body_text, r.parent_email, r.parent_name
       FROM parent_messages m
       JOIN registrations r ON r.id = m.registration_id
      WHERE m.batch_id = ?1 AND m.send_state = 'queued'
      ORDER BY m.id
      LIMIT ?2`
  )
    .bind(id, max)
    .all();

  const pending = results || [];
  let sent = 0;
  let budgetStopped = false;

  for (const message of pending) {
    // Claim it. Losing this race means another drain already has it.
    const claim = await env.DB.prepare(
      `UPDATE parent_messages
          SET send_state = 'sending', send_attempts = send_attempts + 1
        WHERE id = ?1 AND send_state = 'queued'`
    )
      .bind(message.id)
      .run();

    if (claim.meta.changes === 0) continue;

    if (!(await reserveSend(env))) {
      // Back to 'queued', NOT 'failed'. Nothing is wrong with this message and
      // it must go out tomorrow untouched. Marking it failed would invite
      // someone to "fix" a message that was never broken.
      await env.DB.prepare(
        `UPDATE parent_messages SET send_state = 'queued', last_error = 'budget' WHERE id = ?1`
      )
        .bind(message.id)
        .run();
      budgetStopped = true;
      break;
    }

    // Resolved from the registration at SEND time, never carried through the
    // UI. This is the guard against the catastrophic failure: the wrong child's
    // feedback reaching a family.
    const result = await sendComposedMessage(env, {
      to: message.parent_email,
      subject: message.subject,
      html: message.body_html,
      text: message.body_text,
      replyTo: env.NOTIFY_EMAIL_TO,
    });

    if (result?.ok) {
      await env.DB.prepare(
        `UPDATE parent_messages
            SET send_state = 'sent', sent_at = ?2, provider_message_id = ?3, last_error = NULL
          WHERE id = ?1`
      )
        .bind(message.id, new Date().toISOString(), result.id || null)
        .run();
      sent += 1;
    } else {
      await env.DB.prepare(
        `UPDATE parent_messages SET send_state = 'failed', last_error = ?2 WHERE id = ?1`
      )
        .bind(message.id, String(result?.error || 'unknown').slice(0, 300))
        .run();
    }
  }

  const remaining = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN send_state = 'queued' THEN 1 ELSE 0 END) AS queued,
       SUM(CASE WHEN send_state = 'failed' THEN 1 ELSE 0 END) AS failed
     FROM parent_messages WHERE batch_id = ?1`
  )
    .bind(id)
    .first();

  const stillQueued = Number(remaining?.queued || 0);
  const failed = Number(remaining?.failed || 0);

  if (stillQueued === 0) {
    await env.DB.prepare(
      `UPDATE decision_batches SET state = ?2, finished_at = ?3 WHERE id = ?1 AND state = 'sending'`
    )
      .bind(id, failed > 0 ? 'partial' : 'sent', new Date().toISOString())
      .run();
  }

  return { ok: true, sent, queued: stillQueued, failed, budgetStopped };
}
