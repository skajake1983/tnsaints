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
import { checkEditedBody, loadSafetySources, checkAgainstSources, checkBulkInsertion } from './safety.js';
import { reserveSend, sendComposedMessage, emailConfigured } from '../email.js';

/**
 * Fingerprint of the coach notes behind one player's draft.
 *
 * COUNT plus the latest updated_at: moves when a note is added, edited, or
 * deleted, because saveEvaluation always bumps updated_at on upsert. Counting
 * alone would miss a correction, which is the case that matters most — a note
 * typed into the wrong player's form and fixed the next day leaves the count
 * unchanged while the content is now somebody else's child.
 */
async function notesFingerprint(env, registrationId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), '') AS latest
       FROM eval_feedback WHERE registration_id = ?1`
  )
    .bind(registrationId)
    .first();
  return `${Number(row?.n || 0)}:${row?.latest || ''}`;
}

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

  // A decision cannot change once it has been committed to a family.
  //
  // Without this, a stale tab rendered before approval still has live decision
  // buttons (they are disabled in markup, which is not a control), and flipping
  // one after approval changed nothing about the frozen body — the staleness
  // UPDATE below only matches drafts. The screen said "Decision saved" in green
  // while the queued email still said the opposite, and the audit log then
  // disagreed with what the family actually received.
  const committed = await env.DB.prepare(
    `SELECT send_state FROM parent_messages
      WHERE registration_id = ?1 AND send_state IN ('queued', 'sending', 'sent')
      LIMIT 1`
  )
    .bind(registrationId)
    .first();

  if (committed) {
    return {
      ok: false,
      error:
        committed.send_state === 'sent'
          ? 'This family has already been emailed, so the decision can no longer be changed.'
          : 'This message is already approved and waiting to send. Reopen the batch before changing the decision.',
    };
  }

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

  // Any draft written for a DIFFERENT decision is now a lie, so un-read it.
  //
  // Clearing reviewed_at is what makes this safe rather than merely tidy:
  // approveBatch refuses while anything is unread, so flipping a decision after
  // reading everything cannot slip through on the strength of a read that
  // happened when the text said the opposite.
  const staled = await env.DB.prepare(
    `UPDATE parent_messages
        SET reviewed_at = NULL, reviewed_by = NULL
      WHERE registration_id = ?1
        AND send_state = 'draft'
        AND COALESCE(composed_for_decision, '') != ?2`
  )
    .bind(registrationId, decision)
    .run();

  return { ok: true, staleDraft: staled.meta.changes > 0 };
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

  // REUSE the open draft rather than minting a new id.
  //
  // batchId() is derived from the current second, so every Build used to create
  // a fresh batch — which meant the DELETE below, commented "replace any
  // previous drafts", targeted the brand-new id and matched nothing. Old draft
  // batches survived intact and independently approvable, with their Approve
  // URL live in any tab left open. Fix a bad note, rebuild, click Approve in
  // the wrong tab, and the exact text you rebuilt to remove is what sends.
  const openDraft = await env.DB.prepare(
    `SELECT id FROM decision_batches WHERE event_id = ?1 AND state = 'draft'
      ORDER BY created_at DESC LIMIT 1`
  )
    .bind(env.EVENT_ID)
    .first();

  const id = openDraft ? openDraft.id : batchId(env.EVENT_ID, now);

  if (!openDraft) {
    await env.DB.prepare(
      `INSERT INTO decision_batches (id, event_id, state, created_by, created_at)
       VALUES (?1, ?2, 'draft', ?3, ?4)
       ON CONFLICT (id) DO NOTHING`
    )
      .bind(id, env.EVENT_ID, actor, now)
      .run();
  }

  // PRESERVE HAND-EDITED DRAFTS THAT ARE STILL CORRECT.
  //
  // Rebuilding used to delete every draft and recompose from scratch. After an
  // admin had rewritten forty of fifty messages into their own voice, changing
  // one player's decision and pressing Rebuild would have destroyed all forty
  // with no warning — and rewriting a "not yet" is the most careful work anyone
  // does in this product.
  //
  // An edited draft survives a rebuild as long as it is still composed for the
  // current decision. Anything unedited, stale, or blocked is regenerated.
  const keep = await env.DB.prepare(
    `SELECT m.registration_id
       FROM parent_messages m
       LEFT JOIN decisions d ON d.registration_id = m.registration_id
      WHERE m.batch_id = ?1
        AND m.send_state = 'draft'
        AND m.edited_at IS NOT NULL
        AND m.composed_for_decision = COALESCE(d.decision, 'undecided')
        -- The notes must ALSO still match, or a preserved edit becomes a
        -- deadlock: the screen tells the admin to rebuild, the rebuild
        -- preserves the row unchanged, and approve then refuses the whole
        -- batch on the fingerprint. Nobody finds the escape at 11pm, and every
        -- family gets nothing.
        AND m.composed_from_notes = (
          SELECT COUNT(*) || ':' || COALESCE(MAX(f.updated_at), '')
            FROM eval_feedback f WHERE f.registration_id = m.registration_id)`
  )
    .bind(id)
    .all();

  const preserved = new Set((keep.results || []).map((r) => Number(r.registration_id)));

  // Deliberately never touches queued/sending/sent — those are commitments.
  await env.DB.prepare(
    `DELETE FROM parent_messages
      WHERE batch_id = ?1 AND send_state IN ('draft', 'skipped')
        AND edited_at IS NULL`
  )
    .bind(id)
    .run();

  // Stale edited drafts go too — a rewritten message for the wrong decision is
  // worse than a fresh template one, because it reads as deliberate.
  await env.DB.prepare(
    `DELETE FROM parent_messages
      WHERE batch_id = ?1 AND send_state IN ('draft', 'skipped')
        AND registration_id NOT IN (SELECT value FROM json_each(?2))`
  )
    .bind(id, JSON.stringify([...preserved]))
    .run();

  // Already-sent families are excluded outright. The unique index added in
  // migration 003 makes a duplicate impossible at the database level; this is
  // the readable half, so the screen can say who was skipped and why.
  const alreadySent = await env.DB.prepare(
    `SELECT registration_id FROM parent_messages
      WHERE event_id = ?1 AND kind = 'evaluation_decision' AND send_state = 'sent'`
  )
    .bind(env.EVENT_ID)
    .all();
  const sentTo = new Set((alreadySent.results || []).map((r) => Number(r.registration_id)));

  const problems = [];
  let composed = 0;
  let skippedAlreadySent = 0;
  let keptEdited = 0;

  for (const row of rows) {
    if (sentTo.has(Number(row.id))) {
      skippedAlreadySent += 1;
      continue;
    }
    if (preserved.has(Number(row.id))) {
      keptEdited += 1;
      composed += 1;
      continue;
    }
    const draft = await composeDraft(env, row.id, row.decision);
    const bodyText = defaultBodyText(draft, row.player_name, env);

    const gate = gateMessage({
      decision: row.decision,
      draft,
      bodyText,
      parentEmail: row.parent_email,
      playerName: row.player_name,
    });

    const playerId = await resolvePlayerId(env, row.id);

    if (!gate.ok || !playerId) {
      const why = playerId ? gate.problems : ['Could not resolve this player’s identity record.'];
      problems.push({ registration_id: row.id, player_name: row.player_name, problems: why });

      // PERSIST the block rather than only returning it.
      //
      // These used to be pushed onto a transient array and `continue`d, so a
      // blocked family left no trace anywhere: the batch still approved, still
      // sent, still reported success, and nobody found out that a child had
      // been evaluated and never answered until the parent phoned. A row in
      // 'skipped' makes the omission visible in the table and countable by the
      // coverage check in approveBatch().
      if (playerId) {
        await env.DB.prepare(
          `INSERT INTO parent_messages
             (player_id, registration_id, event_id, batch_id, kind, subject,
              body_html, body_text, send_state, last_error, created_by, created_at,
              composed_for_decision)
           VALUES (?1, ?2, ?3, ?4, 'evaluation_decision', ?5, '', '', 'skipped', ?6, ?7, ?8, ?9)
           ON CONFLICT (batch_id, registration_id)
             WHERE batch_id IS NOT NULL AND registration_id IS NOT NULL
           DO UPDATE SET send_state            = 'skipped',
                         last_error            = excluded.last_error,
                         composed_for_decision = excluded.composed_for_decision`
        )
          .bind(
            playerId,
            row.id,
            env.EVENT_ID,
            id,
            subjectFor(String(row.player_name).split(/\s+/)[0], env),
            why.join(' ').slice(0, 300),
            actor,
            now,
            row.decision
          )
          .run();
      }
      continue;
    }

    await env.DB.prepare(
      `INSERT INTO parent_messages
         (player_id, registration_id, event_id, batch_id, kind, subject,
          body_html, body_text, send_state, created_by, created_at, composed_for_decision,
          composed_from_notes)
       VALUES (?1, ?2, ?3, ?4, 'evaluation_decision', ?5, ?6, ?7, 'draft', ?8, ?9, ?10, ?11)
       -- The WHERE is not decoration: idx_messages_one_per_batch is a PARTIAL
       -- unique index, and SQLite only matches an ON CONFLICT target to a
       -- partial index when the clause is repeated here verbatim. Without it
       -- the statement fails outright with "does not match any PRIMARY KEY or
       -- UNIQUE constraint".
       ON CONFLICT (batch_id, registration_id)
         WHERE batch_id IS NOT NULL AND registration_id IS NOT NULL
       DO UPDATE SET
         subject               = excluded.subject,
         body_html             = excluded.body_html,
         body_text             = excluded.body_text,
         composed_for_decision = excluded.composed_for_decision,
         composed_from_notes   = excluded.composed_from_notes,
         -- A regenerated body has not been read, whatever was true before.
         reviewed_at           = NULL,
         reviewed_by           = NULL`
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
        now,
        row.decision,
        await notesFingerprint(env, row.id)
      )
      .run();

    composed += 1;
  }

  return { ok: true, batchId: id, composed, keptEdited, problems, skippedAlreadySent, total: rows.length };
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

  // 'approved' is allowed as well as 'draft', so that reopening ONE message to
  // fix it can be followed by approving just that one. Without this, a
  // selective reopen left the batch approved, approveBatch refused, and the
  // reopened message could never be sent -- the fix made the problem permanent.
  if (!['draft', 'approved'].includes(batch.state)) {
    return { ok: false, error: `Batch is already ${batch.state}.` };
  }

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

  // COVERAGE: is there a message for every confirmed player?
  //
  // The undecided count above checks decisions; this checks messages, and they
  // are not the same thing. A player can be decided and still have no message —
  // blocked at build, or added after the batch was composed. Without this, a
  // batch covering 38 of 50 families approves and sends and reports success,
  // and the twelve who hear nothing surface as phone calls a week later.
  const uncovered = await env.DB.prepare(
    `SELECT r.player_name
       FROM registrations r
      WHERE r.event_id = ?1 AND r.status = 'confirmed'
        AND NOT EXISTS (
          SELECT 1 FROM parent_messages m
           WHERE m.batch_id = ?2 AND m.registration_id = r.id
             AND m.send_state != 'skipped'
        )
      ORDER BY r.player_name`
  )
    .bind(env.EVENT_ID, id)
    .all();

  const missing = (uncovered.results || []).map((r) => r.player_name);
  if (missing.length) {
    return {
      ok: false,
      error: `${missing.length} player(s) have no message in this batch and would hear nothing.`,
      problems: missing.map((player_name) => ({
        player_name,
        problems: ['No message was composed — a coach still needs to write a strength and a growth area.'],
      })),
    };
  }

  // Readiness is re-derived from eval_feedback here, not trusted from build
  // time. Notes can be edited or deleted in the window between building and
  // approving, and closing that window is the entire reason the snapshot
  // exists.
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.body_text, m.registration_id, m.reviewed_at,
            m.composed_for_decision, m.composed_from_notes,
            r.player_name, r.parent_email,
            COALESCE(d.decision, 'undecided') AS decision,
            SUM(CASE WHEN TRIM(COALESCE(f.strengths,   '')) != '' THEN 1 ELSE 0 END) AS with_strengths,
            SUM(CASE WHEN TRIM(COALESCE(f.growth_area, '')) != '' THEN 1 ELSE 0 END) AS with_growth
       FROM parent_messages m
       JOIN registrations r ON r.id = m.registration_id
       LEFT JOIN decisions d ON d.registration_id = m.registration_id
       LEFT JOIN eval_feedback f ON f.registration_id = m.registration_id
      WHERE m.batch_id = ?1 AND m.send_state = 'draft'
      GROUP BY m.id`
  )
    .bind(id)
    .all();

  const messages = results || [];
  if (!messages.length) return { ok: false, error: 'This batch has no draft messages.' };

  const problems = [];
  const unread = [];
  const stale = [];

  for (const m of messages) {
    // THE CONTRADICTION CHECK.
    //
    // The body says one thing; the decision now says another. Without this,
    // flipping a decision after building sends an accepted family a rejection —
    // the gate below cannot see it, because it inspects the text, the address
    // and the coach prose, none of which change when a decision does.
    if (m.composed_for_decision !== m.decision) {
      stale.push(m.player_name);
      continue;
    }

    // The notes moved after this was written. Same treatment: it may now
    // describe a different child entirely.
    if (m.composed_from_notes !== (await notesFingerprint(env, m.registration_id))) {
      stale.push(m.player_name);
      continue;
    }
    const gate = gateMessage({
      decision: m.decision,
      draft: { strengths: Array(Number(m.with_strengths) || 0), growth: Array(Number(m.with_growth) || 0) },
      bodyText: m.body_text,
      parentEmail: m.parent_email,
      playerName: m.player_name,
    });
    if (!gate.ok) problems.push({ player_name: m.player_name, problems: gate.problems });

    // Edit is not the last writer, so the content checks run again here.
    const safe = await checkEditedBody(env, {
      registrationId: m.registration_id,
      bodyText: m.body_text,
      playerName: m.player_name,
    });
    if (!safe.ok) problems.push({ player_name: m.player_name, problems: [safe.error] });

    if (!m.reviewed_at) unread.push(m.player_name);
  }

  if (stale.length) {
    return {
      ok: false,
      error: `${stale.length} message(s) were written for a different decision and are out of date.`,
      problems: stale.map((player_name) => ({
        player_name,
        problems: ['The decision changed after this was written. Rebuild drafts, then read it again.'],
      })),
    };
  }

  if (problems.length) return { ok: false, error: 'Some messages did not pass review.', problems };

  // NOBODY APPROVES WHAT THEY HAVE NOT READ.
  //
  // This is the enforcement; the screen's read-tracking is only the convenience
  // that makes it satisfiable. Without a server-side refusal, "I reviewed them"
  // is an assertion about a tired person at 11pm rather than a fact.
  if (unread.length) {
    return {
      ok: false,
      error: `${unread.length} message(s) have not been read yet.`,
      problems: unread.map((player_name) => ({
        player_name,
        problems: ['Open this message and mark it read before approving.'],
      })),
    };
  }

  const now = new Date().toISOString();

  // BATCH ROW FIRST, MESSAGES SECOND.
  //
  // These were two independent auto-committed statements in the opposite order,
  // and the second ignored meta.changes. If another batch was already approved,
  // the messages flipped to 'queued' and then the batch UPDATE violated
  // idx_batch_one_active and threw - leaving fifty messages queued under a
  // batch still marked 'draft': undrainable, un-approvable, and repairable only
  // by hand on the night it matters.
  //
  // Claiming the batch first means the unique index rejects the attempt before
  // a single message moves.
  const [batchUpdate] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE decision_batches SET state = 'approved', approved_by = ?2, approved_at = ?3
        WHERE id = ?1 AND state IN ('draft', 'approved')`
    ).bind(id, actor, now),
    env.DB.prepare(
      `UPDATE parent_messages
          SET send_state = 'queued', approved_by = ?2, approved_at = ?3
        WHERE batch_id = ?1 AND send_state = 'draft'`
    ).bind(id, actor, now),
  ]);

  if (batchUpdate.meta.changes === 0) {
    return {
      ok: false,
      error: 'This batch was approved or reopened by someone else. Reload and try again.',
    };
  }

  return { ok: true, queued: messages.length };
}

/**
 * Send approved messages back to draft so they can be edited again.
 *
 * Approval freezes the text, which is what makes "what you read is what sends"
 * true - but frozen with no way back meant that spotting one bad message after
 * approving left two options: send it anyway, or delete the child's
 * registration and every coach note about them. That is not a choice anyone
 * should be offered at 11pm.
 *
 * Only 'queued' messages can come back. Anything already sent is gone, and
 * anything mid-send is left alone rather than raced.
 *
 * reviewed_at is cleared, because a message being reopened in order to change
 * it is a message whose earlier reading no longer describes what will send.
 *
 * @param {number[]|null} messageIds specific messages, or null for the whole batch
 */
export async function reopenMessages(env, { batchId, messageIds = null, actor }) {
  const batch = await env.DB.prepare(`SELECT id, state FROM decision_batches WHERE id = ?1`)
    .bind(batchId)
    .first();

  if (!batch) return { ok: false, error: 'No such batch.' };
  if (batch.state === 'draft') return { ok: false, error: 'This batch is already open for editing.' };

  const selective = Array.isArray(messageIds) && messageIds.length > 0;

  const res = selective
    ? await env.DB.prepare(
        `UPDATE parent_messages
            SET send_state = 'draft', reviewed_at = NULL, reviewed_by = NULL,
                approved_by = NULL, approved_at = NULL
          WHERE batch_id = ?1 AND send_state = 'queued'
            AND id IN (SELECT value FROM json_each(?2))`
      )
        .bind(batchId, JSON.stringify(messageIds.map(Number)))
        .run()
    : await env.DB.prepare(
        `UPDATE parent_messages
            SET send_state = 'draft', reviewed_at = NULL, reviewed_by = NULL,
                approved_by = NULL, approved_at = NULL
          WHERE batch_id = ?1 AND send_state = 'queued'`
      )
        .bind(batchId)
        .run();

  const reopened = res.meta.changes;
  if (reopened === 0) {
    return { ok: false, error: 'Nothing to reopen - those messages have already been sent.' };
  }

  // The batch reopens only if nothing is still committed. A partially sent
  // batch stays where it is so the remaining queue can still drain.
  const stillCommitted = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM parent_messages
      WHERE batch_id = ?1 AND send_state IN ('queued', 'sending')`
  )
    .bind(batchId)
    .first();

  if (Number(stillCommitted?.n || 0) === 0) {
    await env.DB.prepare(
      `UPDATE decision_batches
          SET state = 'draft', approved_by = NULL, approved_at = NULL, finished_at = NULL
        WHERE id = ?1 AND state IN ('approved', 'sending', 'partial', 'sent')`
    )
      .bind(batchId)
      .run();
  }

  return { ok: true, reopened };
}

/**
 * Replace a run of text across many messages at once.
 *
 * The case this exists for: the footer is wrong on all fifty. Rebuilding cannot
 * fix it, because buildBatch deliberately PRESERVES hand-edited drafts -- so
 * after an admin has rewritten forty messages in their own voice, a global
 * correction would mean editing forty footers by hand, at the exact hour when
 * care is scarcest.
 *
 * Three properties make it safe enough to hand someone at 11pm:
 *
 *   1. PREVIEW FIRST. Nothing is written until the caller has been told how
 *      many messages match and shown one before/after. A find string that
 *      matches more than expected is the main way this could go wrong, and the
 *      count is what reveals it.
 *
 *   2. ALL OR NOTHING. Every result is re-checked with the same gate and safety
 *      rules an individual edit passes through. If any single message would
 *      come out invalid -- a lost player name, a leaked internal note -- the
 *      whole operation is refused rather than leaving the batch half-changed
 *      and half-not, which nobody would notice.
 *
 *   3. DRAFTS ONLY. Approved messages are frozen by definition. Reopen them
 *      first; that is a deliberate act with its own confirmation.
 */
export async function bulkReplace(env, { batchId, messageIds, find, replace, preview, actor }) {
  const needle = typeof find === 'string' ? find : '';
  const swap = typeof replace === 'string' ? replace : '';

  // A short needle is the dangerous one: "a" or "he" would rewrite every
  // message into nonsense, and the damage is only visible by reading fifty
  // messages again. Long enough to be a deliberate phrase.
  if (needle.trim().length < 8) {
    return { ok: false, error: 'Enter at least 8 characters to find, so this cannot match by accident.' };
  }

  const selective = Array.isArray(messageIds) && messageIds.length > 0;

  const { results } = selective
    ? await env.DB.prepare(
        `SELECT m.id, m.body_text, m.registration_id, r.player_name, r.parent_email,
                COALESCE(d.decision, 'undecided') AS decision
           FROM parent_messages m
           JOIN registrations r ON r.id = m.registration_id
           LEFT JOIN decisions d ON d.registration_id = m.registration_id
          WHERE m.batch_id = ?1 AND m.send_state = 'draft'
            AND m.id IN (SELECT value FROM json_each(?2))`
      )
        .bind(batchId, JSON.stringify(messageIds.map(Number)))
        .all()
    : await env.DB.prepare(
        `SELECT m.id, m.body_text, m.registration_id, r.player_name, r.parent_email,
                COALESCE(d.decision, 'undecided') AS decision
           FROM parent_messages m
           JOIN registrations r ON r.id = m.registration_id
           LEFT JOIN decisions d ON d.registration_id = m.registration_id
          WHERE m.batch_id = ?1 AND m.send_state = 'draft'`
      )
        .bind(batchId)
        .all();

  const rows = results || [];
  const hits = rows.filter((r) => String(r.body_text).includes(needle));
  const missed = rows.filter((r) => !String(r.body_text).includes(needle));

  if (hits.length === 0) {
    return { ok: false, error: 'No draft message contains that text.' };
  }

  // Sources fetched ONCE. Two queries, not two per message.
  const sources = await loadSafetySources(env);

  // A string being inserted into many messages is checked against EVERY
  // internal note in the event, not just each recipient's own — see
  // checkBulkInsertion.
  const bulkSafe = checkBulkInsertion(sources, swap);
  if (!bulkSafe.ok) return { ok: false, error: bulkSafe.error };

  // Validate every result BEFORE writing any of them.
  const problems = [];
  const updates = [];

  for (const row of hits) {
    const next = String(row.body_text).split(needle).join(swap);

    const gate = gateMessage({
      decision: row.decision,
      bodyText: next,
      parentEmail: row.parent_email,
      playerName: row.player_name,
    });
    if (!gate.ok) {
      problems.push({ player_name: row.player_name, problems: gate.problems });
      continue;
    }

    const safe = checkAgainstSources(sources, {
      registrationId: row.registration_id,
      bodyText: next,
      playerName: row.player_name,
    });
    if (!safe.ok) {
      problems.push({ player_name: row.player_name, problems: [safe.error] });
      continue;
    }

    updates.push({ id: row.id, next, player_name: row.player_name });
  }

  if (problems.length) {
    return {
      ok: false,
      error: `That replacement would break ${problems.length} message(s), so nothing was changed.`,
      problems,
    };
  }

  if (preview) {
    // A window around the match, not the head of the body.
    //
    // Truncating at 400 characters made the preview useless for the exact case
    // it was built for: the footer sits at roughly character 843 of a "not yet"
    // message, so before and after rendered byte-identical and the admin had
    // nothing to check but a count.
    const excerpt = (text) => {
      const at = text.indexOf(needle);
      const from = Math.max(0, at - 90);
      const to = Math.min(text.length, at + needle.length + 90);
      return (from > 0 ? '…' : '') + text.slice(from, to) + (to < text.length ? '…' : '');
    };

    return {
      ok: true,
      preview: true,
      matched: hits.length,
      of: rows.length,
      // Named, so a partial match is visible. Someone who reflowed the sign-off
      // has a body the needle does not match, and a bare count would let their
      // family keep the wrong footer with nobody the wiser.
      missed: missed.map((r) => r.player_name),
      samples: hits.slice(0, 8).map((r) => ({
        player_name: r.player_name,
        before: excerpt(String(r.body_text)),
        after: excerpt(String(r.body_text).split(needle).join(swap)),
      })),
    };
  }

  const now = new Date().toISOString();

  // ONE batch, not N awaited statements. Fifty separate UPDATEs would blow the
  // subrequest ceiling and leave the batch half-changed, which is the opposite
  // of what this function claims to guarantee.
  //
  // reviewed_at is cleared on purpose: fifty messages just changed, and a read
  // recorded before the change describes text that no longer exists.
  await env.DB.batch(
    updates.map((u) =>
      env.DB.prepare(
        `UPDATE parent_messages
            SET body_text = ?2, body_html = ?3, edited_by = ?4, edited_at = ?5,
                reviewed_at = NULL, reviewed_by = NULL
          WHERE id = ?1 AND send_state = 'draft'`
      ).bind(u.id, u.next, textToHtml(u.next), actor, now)
    )
  );

  return {
    ok: true,
    changed: updates.length,
    of: rows.length,
    missed: missed.map((r) => r.player_name),
  };
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
export async function drainBatch(env, id, { max = 5 } = {}) {
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

  // Reclaim anything stranded in 'sending'.
  //
  // A tab closed mid-drain, or a request that hit the subrequest ceiling,
  // leaves a row claimed but never resolved. The pending query only looked at
  // 'queued' and the completion count only summed 'queued' and 'failed', so a
  // stranded row was invisible AND let the batch report itself finished - that
  // family's outcome becoming unknowable, which is worse than a visible
  // failure. send_attempts still bounds how often this can repeat.
  await env.DB.prepare(
    `UPDATE parent_messages
        SET send_state = 'queued', last_error = 'Reclaimed after an interrupted send.'
      WHERE batch_id = ?1 AND send_state = 'sending' AND send_attempts < 3`
  )
    .bind(id)
    .run();

  await env.DB.prepare(
    `UPDATE parent_messages
        SET send_state = 'failed', last_error = 'Interrupted repeatedly; needs attention.'
      WHERE batch_id = ?1 AND send_state = 'sending' AND send_attempts >= 3`
  )
    .bind(id)
    .run();

  // Retire anything queued for a family who has since withdrawn. Left in place
  // they hold the batch open forever: the completion count only looks at
  // 'queued', while decisionGrid hides cancelled players, so the screen shows a
  // permanent "1 queued" belonging to nobody visible.
  await env.DB.prepare(
    `UPDATE parent_messages
        SET send_state = 'skipped', last_error = 'registration cancelled after approval'
      WHERE batch_id = ?1 AND send_state = 'queued'
        AND registration_id IN (
          SELECT id FROM registrations WHERE status != 'confirmed'
        )`
  )
    .bind(id)
    .run();

  const { results } = await env.DB.prepare(
    `SELECT m.id, m.subject, m.body_html, m.body_text, m.registration_id,
            m.composed_for_decision, m.composed_from_notes,
            COALESCE(d.decision, 'undecided') AS decision,
            r.parent_email, r.parent_name, r.player_name
       FROM parent_messages m
       JOIN registrations r ON r.id = m.registration_id
       LEFT JOIN decisions d ON d.registration_id = m.registration_id
      WHERE m.batch_id = ?1
        -- 'failed' is retried up to three attempts rather than being terminal.
        -- Resend rate-limiting three of fifty near-identical messages used to
        -- mean three families never heard anything, with the only trace being
        -- one word in a fifty-row table.
        AND (m.send_state = 'queued' OR (m.send_state = 'failed' AND m.send_attempts < 3))
        -- A family who withdrew must not receive their child's decision. Cancel
        -- flips registrations.status but leaves any queued message live and
        -- invisible, because decisionGrid filters cancelled players out of the
        -- screen entirely.
        AND r.status = 'confirmed'
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
        WHERE id = ?1 AND send_state IN ('queued', 'failed')`
    )
      .bind(message.id)
      .run();

    if (claim.meta.changes === 0) continue;

    // LAST GATE BEFORE A REAL EMAIL.
    //
    // Approve checked this too, but approve can be minutes or days before the
    // send — the free email tier splits fifty messages across two days — and
    // nothing upstream is trusted at the point of no return. A contradiction
    // here becomes a visible failure rather than a silent skip, because a
    // message that quietly never sends is the failure nobody notices.
    const currentNotes = await notesFingerprint(env, message.registration_id);
    const safe = await checkEditedBody(env, {
      registrationId: message.registration_id,
      bodyText: message.body_text,
      playerName: message.player_name,
    });
    if (
      message.composed_for_decision !== message.decision ||
      message.composed_from_notes !== currentNotes ||
      !safe.ok
    ) {
      await env.DB.prepare(
        `UPDATE parent_messages
            SET send_state = 'failed',
                last_error = ?2
          WHERE id = ?1`
      )
        .bind(
          message.id,
          safe.ok
            ? 'The decision or the coach notes changed after approval. Rebuild and re-approve.'
            : safe.error
        )
        .run();
      continue;
    }

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
       SUM(CASE WHEN send_state IN ('queued', 'sending', 'draft') THEN 1 ELSE 0 END) AS queued,
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
