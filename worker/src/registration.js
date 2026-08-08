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
  highlight_link, player_notes, created_at, ip_hash
`;

const INSERT_PLACEHOLDERS =
  '?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24';

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

function bindValues(env, data, status, createdAt, ipHash) {
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
  ];
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
    const confirmed = await env.DB.prepare(
      `INSERT INTO registrations (${INSERT_COLUMNS})
       SELECT ${INSERT_PLACEHOLDERS}
        WHERE (
          SELECT COUNT(*) FROM registrations
           WHERE event_id = ?1 AND session_time = ?2 AND status = 'confirmed'
        ) < ?25`
    )
      .bind(...bindValues(env, data, 'confirmed', createdAt, ipHash), capacity)
      .run();

    if (confirmed.meta.changes > 0) {
      return { status: 'confirmed' };
    }

    // Session filled — record as waitlist instead of rejecting outright.
    await env.DB.prepare(
      `INSERT INTO registrations (${INSERT_COLUMNS}) VALUES (${INSERT_PLACEHOLDERS})`
    )
      .bind(...bindValues(env, data, 'waitlist', createdAt, ipHash))
      .run();

    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS position
         FROM registrations
        WHERE event_id = ?1 AND status = 'waitlist' AND created_at <= ?2`
    )
      .bind(env.EVENT_ID, createdAt)
      .first();

    return { status: 'waitlist', position: Number(row?.position || 1) };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { status: 'duplicate' };
    }
    throw err;
  }
}
