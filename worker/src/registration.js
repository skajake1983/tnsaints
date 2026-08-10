/**
 * Registration capacity, waitlist overflow, and the registration window.
 *
 * Capacity is never a stored counter. Every decision derives from a live
 * COUNT(*) of confirmed rows, which means deleting a bogus registration
 * reopens that spot immediately with no reconciliation step.
 */

const INSERT_COLUMNS = `
  event_id, session_time, status,
  player_name, player_name_norm, grade, years_experience,
  parent_name, parent_email, parent_email_norm, phone, school,
  emergency_contact_name, emergency_contact_phone, medical_notes,
  assumption_of_risk, medical_release, photo_release, signature, signed_at,
  highlight_link, player_notes, created_at, ip_hash, cancel_token
`;

const INSERT_PLACEHOLDERS =
  '?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25';

/**
 * The only credential in a cancel link, so it has to be unguessable rather
 * than merely unique — 32 bytes from the platform CSPRNG, never Math.random.
 */
export function newCancelToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function sessionTimes(env) {
  return String(env.SESSION_TIMES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function slotCapacity(env) {
  const n = parseInt(env.SLOT_CAPACITY, 10);
  return Number.isFinite(n) && n > 0 ? n : 25;
}

/**
 * Authoritative registration window check. The banner on the site does the
 * same arithmetic for display, but only this result can actually stop a
 * submission — a visitor can change their own clock, not the server's.
 */
export function registrationWindow(env, now = new Date()) {
  const closesAtRaw = env.REGISTRATION_CLOSES_AT;
  const closesAt = closesAtRaw ? new Date(closesAtRaw) : null;

  if (!closesAt || Number.isNaN(closesAt.getTime())) {
    // Misconfiguration must not silently mean "open forever".
    console.error('REGISTRATION_CLOSES_AT is missing or unparseable:', closesAtRaw);
    return { open: false, reason: 'misconfigured', closesAt: null };
  }

  if (now > closesAt) {
    return { open: false, reason: 'closed', closesAt };
  }

  return { open: true, closesAt };
}

/**
 * Confirmed counts per session for the current event.
 */
export async function getAvailability(env) {
  const capacity = slotCapacity(env);
  const times = sessionTimes(env);

  const { results } = await env.DB.prepare(
    `SELECT session_time, COUNT(*) AS taken
       FROM registrations
      WHERE event_id = ?1 AND status = 'confirmed'
      GROUP BY session_time`
  )
    .bind(env.EVENT_ID)
    .all();

  const taken = new Map((results || []).map((r) => [r.session_time, Number(r.taken)]));

  const sessions = times.map((time) => {
    const used = taken.get(time) || 0;
    return {
      session_time: time,
      capacity,
      taken: used,
      remaining: Math.max(0, capacity - used),
      full: used >= capacity,
    };
  });

  return {
    event_id: env.EVENT_ID,
    event_label: env.EVENT_LABEL || '',
    sessions,
    all_full: sessions.length > 0 && sessions.every((s) => s.full),
  };
}

/**
 * Rate limit by hashed IP over a rolling window.
 */
export async function isRateLimited(env, ipHash) {
  const max = parseInt(env.RATE_LIMIT_MAX, 10) || 3;
  const windowMinutes = parseInt(env.RATE_LIMIT_WINDOW_MINUTES, 10) || 10;
  if (!ipHash) return false;

  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();

  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS recent
       FROM registrations
      WHERE ip_hash = ?1 AND created_at >= ?2`
  )
    .bind(ipHash, since)
    .first();

  return Number(row?.recent || 0) >= max;
}

function bindValues(env, data, status, createdAt, ipHash, cancelToken) {
  return [
    env.EVENT_ID,
    data.session_time,
    status,
    data.player_name,
    data.player_name_norm,
    data.grade,
    data.years_experience,
    data.parent_name,
    data.parent_email,
    data.parent_email_norm,
    data.phone,
    data.school,
    data.emergency_contact_name,
    data.emergency_contact_phone,
    data.medical_notes,
    data.assumption_of_risk,
    data.medical_release,
    data.photo_release,
    data.signature,
    createdAt, // signed_at — same instant the record is created
    data.highlight_link,
    data.player_notes,
    createdAt,
    ipHash,
    cancelToken,
  ];
}

/**
 * Read-only lookup behind a cancel link.
 *
 * Deliberately separate from the cancel itself, and deliberately GET-safe.
 * Corporate mail scanners (Outlook Safe Links, for one) fetch every URL in an
 * inbound message. If clicking a link were what cancelled a registration, those
 * scanners would silently cancel families the moment the email arrived. The
 * mutation is a POST the visitor has to trigger from the page.
 */
export async function lookupByCancelToken(env, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;

  return await env.DB.prepare(
    `SELECT player_name, session_time, status, grade, parent_name, cancelled_at
       FROM registrations
      WHERE cancel_token = ?1 AND event_id = ?2`
  )
    .bind(token, env.EVENT_ID)
    .first();
}

/**
 * Cancel by token. Sets status rather than deleting, so the record and the
 * family's reason survive; capacity counts only 'confirmed', so the spot frees
 * itself the moment this lands.
 *
 * The UPDATE is guarded on the current status, so a double submit — or a
 * second tab — cannot cancel twice or resurrect a row.
 */
export async function cancelByToken(env, token, reason) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
    return { ok: false, code: 'invalid' };
  }

  const existing = await lookupByCancelToken(env, token);
  if (!existing) return { ok: false, code: 'not-found' };
  if (existing.status === 'cancelled') {
    return { ok: false, code: 'already-cancelled', registration: existing };
  }

  const trimmed = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';

  const res = await env.DB.prepare(
    `UPDATE registrations
        SET status = 'cancelled', cancelled_at = ?2, cancel_reason = ?3
      WHERE cancel_token = ?1 AND status != 'cancelled'`
  )
    .bind(token, new Date().toISOString(), trimmed || null)
    .run();

  if (res.meta.changes === 0) {
    return { ok: false, code: 'already-cancelled', registration: existing };
  }

  // Only a confirmed seat frees capacity. Someone leaving the waiting list
  // changes nothing about who is in the session.
  const promoted =
    existing.status === 'confirmed'
      ? await promoteFirstWaitlisted(env, existing.session_time)
      : null;

  const waiting = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM registrations
      WHERE event_id = ?1 AND session_time = ?2 AND status = 'waitlist'`
  )
    .bind(env.EVENT_ID, existing.session_time)
    .first();

  return {
    ok: true,
    registration: existing,
    reason: trimmed,
    promoted,
    waitlistForSession: Number(waiting?.n || 0),
  };
}

/**
 * Move the longest-waiting family in a session into the freed seat.
 *
 * Ordered by created_at then id, so it is strictly the order people signed up
 * — id breaks ties when two land in the same millisecond.
 *
 * The UPDATE re-checks capacity and re-checks that the row is still on the
 * waiting list, so two cancellations landing at once cannot promote the same
 * family twice or push a session past its cap.
 *
 * @returns {Promise<object|null>} the promoted registration, or null
 */
export async function promoteFirstWaitlisted(env, sessionTime) {
  const capacity = slotCapacity(env);

  const next = await env.DB.prepare(
    `SELECT id, player_name, grade, parent_name, parent_email, session_time, cancel_token
       FROM registrations
      WHERE event_id = ?1 AND session_time = ?2 AND status = 'waitlist'
      ORDER BY created_at, id
      LIMIT 1`
  )
    .bind(env.EVENT_ID, sessionTime)
    .first();

  if (!next) return null;

  const res = await env.DB.prepare(
    `UPDATE registrations
        SET status = 'confirmed'
      WHERE id = ?1
        AND status = 'waitlist'
        AND (
          SELECT COUNT(*) FROM registrations
           WHERE event_id = ?2 AND session_time = ?3 AND status = 'confirmed'
        ) < ?4`
  )
    .bind(next.id, env.EVENT_ID, sessionTime, capacity)
    .run();

  return res.meta.changes > 0 ? next : null;
}

/**
 * Cancel a registration from the admin surface, by id rather than by token.
 *
 * Same effect as a family cancelling themselves — status flips, the seat frees,
 * and the longest-waiting family in that session is promoted — but reachable
 * without holding their cancel link.
 *
 * CANCEL IS THE DEFAULT, DELETE IS NOT. The row survives, which matters: the
 * waiver acknowledgement, the signature, and the timestamp are the record that
 * a parent agreed to those terms for that child on that date. Deleting destroys
 * that; cancelling keeps it while freeing the place.
 */
export async function adminCancelRegistration(env, registrationId, reason) {
  const existing = await env.DB.prepare(
    `SELECT id, player_name, session_time, status FROM registrations
      WHERE id = ?1 AND event_id = ?2`
  )
    .bind(registrationId, env.EVENT_ID)
    .first();

  if (!existing) return { ok: false, code: 'not-found' };
  if (existing.status === 'cancelled') {
    return { ok: false, code: 'already-cancelled', registration: existing };
  }

  const trimmed = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';

  const res = await env.DB.prepare(
    `UPDATE registrations
        SET status = 'cancelled', cancelled_at = ?2, cancel_reason = ?3
      WHERE id = ?1 AND status != 'cancelled'`
  )
    .bind(registrationId, new Date().toISOString(), trimmed || null)
    .run();

  if (res.meta.changes === 0) {
    return { ok: false, code: 'already-cancelled', registration: existing };
  }

  const promoted =
    existing.status === 'confirmed'
      ? await promoteFirstWaitlisted(env, existing.session_time)
      : null;

  return { ok: true, registration: existing, promoted };
}

/**
 * Permanently delete a registration and everything written about it.
 *
 * For test rows and genuine mistakes only. Deletes child-first because D1
 * enforces foreign keys — notes reference the registration, so the parent row
 * cannot go while they exist.
 *
 * Returns what it destroyed so the caller can audit it and the UI can say so
 * plainly. This is the one operation here with no undo.
 */
export async function adminDeleteRegistration(env, registrationId) {
  const existing = await env.DB.prepare(
    `SELECT id, player_name, session_time, status FROM registrations
      WHERE id = ?1 AND event_id = ?2`
  )
    .bind(registrationId, env.EVENT_ID)
    .first();

  if (!existing) return { ok: false, code: 'not-found' };

  const counts = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM eval_feedback       WHERE registration_id = ?1) AS feedback,
       (SELECT COUNT(*) FROM eval_notes_internal WHERE registration_id = ?1) AS internal,
       (SELECT COUNT(*) FROM parent_messages     WHERE registration_id = ?1) AS messages`
  )
    .bind(registrationId)
    .first();

  // A registration that has already been mailed is not a mistake to erase — it
  // is a record of something a family received. Refuse rather than quietly
  // destroying the only evidence of what was sent.
  const sent = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM parent_messages
      WHERE registration_id = ?1 AND send_state = 'sent'`
  )
    .bind(registrationId)
    .first();

  if (Number(sent?.n || 0) > 0) {
    return { ok: false, code: 'already-messaged' };
  }

  await env.DB.prepare(`DELETE FROM eval_notes_internal WHERE registration_id = ?1`)
    .bind(registrationId)
    .run();
  await env.DB.prepare(`DELETE FROM eval_feedback WHERE registration_id = ?1`)
    .bind(registrationId)
    .run();
  await env.DB.prepare(`DELETE FROM parent_messages WHERE registration_id = ?1`)
    .bind(registrationId)
    .run();
  await env.DB.prepare(`DELETE FROM decisions WHERE registration_id = ?1`)
    .bind(registrationId)
    .run();
  await env.DB.prepare(`DELETE FROM registrations WHERE id = ?1`).bind(registrationId).run();

  const promoted =
    existing.status === 'confirmed'
      ? await promoteFirstWaitlisted(env, existing.session_time)
      : null;

  return {
    ok: true,
    registration: existing,
    destroyed: {
      feedback: Number(counts?.feedback || 0),
      internal: Number(counts?.internal || 0),
      messages: Number(counts?.messages || 0),
    },
    promoted,
  };
}

function isUniqueViolation(err) {
  return /UNIQUE constraint failed/i.test(err?.message || '') ||
         /SQLITE_CONSTRAINT/i.test(err?.message || '');
}

/**
 * Claim a spot, falling back to the waitlist when the session is full.
 *
 * The confirmed insert carries its own capacity check in the same statement:
 *
 *   INSERT ... SELECT ... WHERE (SELECT COUNT(*) ...) < capacity
 *
 * SQLite evaluates that as a single atomic statement and D1 serializes
 * writes, so two people submitting at the same instant cannot both claim
 * spot 25. Whichever loses gets changes === 0 and lands on the waitlist.
 *
 * @returns {Promise<{status: 'confirmed'|'waitlist'|'duplicate', position?: number}>}
 */
export async function claimSpot(env, data, ipHash) {
  const createdAt = new Date().toISOString();
  const capacity = slotCapacity(env);

  try {
    const cancelToken = newCancelToken();

    const confirmed = await env.DB.prepare(
      `INSERT INTO registrations (${INSERT_COLUMNS})
       SELECT ${INSERT_PLACEHOLDERS}
        WHERE (
          SELECT COUNT(*) FROM registrations
           WHERE event_id = ?1 AND session_time = ?2 AND status = 'confirmed'
        ) < ?26`
    )
      .bind(...bindValues(env, data, 'confirmed', createdAt, ipHash, cancelToken), capacity)
      .run();

    if (confirmed.meta.changes > 0) {
      return { status: 'confirmed', cancelToken };
    }

    // Session filled — record as waitlist instead of rejecting outright.
    await env.DB.prepare(
      `INSERT INTO registrations (${INSERT_COLUMNS}) VALUES (${INSERT_PLACEHOLDERS})`
    )
      .bind(...bindValues(env, data, 'waitlist', createdAt, ipHash, cancelToken))
      .run();

    // Scoped to the session, because promotion is per-session. Counting the
    // whole event told a family first in line for 10:00 AM that they were
    // "position 4" when three people were queued for 9:00 AM — the opposite of
    // the truth, and discouraging enough that someone might stop watching for
    // the email.
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS position
         FROM registrations
        WHERE event_id = ?1
          AND session_time = ?2
          AND status = 'waitlist'
          AND created_at <= ?3`
    )
      .bind(env.EVENT_ID, data.session_time, createdAt)
      .first();

    return { status: 'waitlist', position: Number(row?.position || 1), cancelToken };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { status: 'duplicate' };
    }
    throw err;
  }
}
