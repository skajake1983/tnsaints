-- Tennessee Saints — evaluation registration schema (Cloudflare D1 / SQLite)
--
-- Capacity is never stored as a counter. It is always derived from
-- COUNT(*) of confirmed rows, so deleting a bogus registration
-- automatically reopens that spot with no extra bookkeeping.

CREATE TABLE IF NOT EXISTS registrations (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,

  event_id                TEXT    NOT NULL,
  session_time            TEXT    NOT NULL,
  -- Cancelling sets status rather than deleting the row. Capacity counts only
  -- 'confirmed', so a cancellation frees the spot immediately while the record
  -- and the family's reason are preserved.
  status                  TEXT    NOT NULL CHECK (status IN ('confirmed', 'waitlist', 'cancelled')),

  -- Unguessable per-registration token, the only credential in the cancel
  -- link. 32 random bytes, so it cannot be enumerated.
  cancel_token            TEXT    NOT NULL,
  cancelled_at            TEXT,
  cancel_reason           TEXT,

  player_name             TEXT    NOT NULL,
  player_name_norm        TEXT    NOT NULL,
  grade                   TEXT    NOT NULL,
  years_experience        INTEGER,

  parent_name             TEXT    NOT NULL,
  parent_email            TEXT    NOT NULL,
  parent_email_norm       TEXT    NOT NULL,
  phone                   TEXT    NOT NULL,
  school                  TEXT    NOT NULL,

  emergency_contact_name  TEXT    NOT NULL,
  emergency_contact_phone TEXT    NOT NULL,
  medical_notes           TEXT,

  -- Participation acknowledgements captured at registration.
  --
  -- The CHECK constraints make the two required ones unfalsifiable at the
  -- storage layer: a row that did not affirmatively acknowledge risk and
  -- authorize emergency care cannot exist in this table at all.
  --
  -- photo_release is deliberately NOT constrained to 1 — media consent for a
  -- minor should be a real choice, so 0 is a valid, recorded answer.
  assumption_of_risk      INTEGER NOT NULL CHECK (assumption_of_risk = 1),
  medical_release         INTEGER NOT NULL CHECK (medical_release = 1),
  photo_release           INTEGER NOT NULL CHECK (photo_release IN (0, 1)),
  signature               TEXT    NOT NULL,
  signed_at               TEXT    NOT NULL,

  highlight_link          TEXT,
  player_notes            TEXT,

  created_at              TEXT    NOT NULL,
  -- Salted hash, never the raw address. Rate limiting needs to correlate
  -- requests without the site storing visitor IPs as PII.
  ip_hash                 TEXT
);

-- One registration per player per event. This is the single strongest bot
-- control: even a request that defeats Turnstile cannot claim a second spot
-- under the same parent email + player name.
-- Partial index: cancelled rows are excluded so a family who cancels can
-- register again later. Without the WHERE clause their own cancelled row would
-- block them, which is the opposite of helpful.
CREATE UNIQUE INDEX IF NOT EXISTS idx_registrations_unique
  ON registrations (event_id, parent_email_norm, player_name_norm)
  WHERE status != 'cancelled';

-- Cancel-link lookups hit this on every click.
CREATE UNIQUE INDEX IF NOT EXISTS idx_registrations_cancel_token
  ON registrations (cancel_token);

-- Backs the capacity COUNT(*) inside the atomic insert, which filters on
-- (event_id, session_time, status) — all three columns are in the WHERE.
CREATE INDEX IF NOT EXISTS idx_registrations_slot
  ON registrations (event_id, session_time, status);

-- Backs getAvailability(), which filters on (event_id, status) and GROUPs BY
-- session_time. The index above CANNOT serve that query: with no session_time
-- in the WHERE clause, SQLite has to scan every row for the event — confirmed
-- AND waitlist — and D1 bills rows *scanned*, not rows returned.
--
-- That made daily reads scale as page_views x total_rows, so a locally viral
-- post would raise both factors at once and could blow the 5M rows/day free
-- limit, taking registration down entirely while the Workers dashboard still
-- showed single-digit utilisation.
--
-- With status ahead of session_time, the query seeks straight to
-- (event_id, 'confirmed') and scans only confirmed rows — capped at 50 by
-- design, no matter how large the waitlist grows.
CREATE INDEX IF NOT EXISTS idx_registrations_avail
  ON registrations (event_id, status, session_time);

-- Daily outbound email budget.
--
-- Resend's free plan allows 100 emails/day. At two emails per registration
-- (academy alert + parent receipt) a full 50-seat day lands exactly on that
-- ceiling, and waitlist signups past it would send nothing with no error
-- surfaced anywhere. This table lets the Worker spend the budget
-- deliberately, protecting the academy alert above all else.
CREATE TABLE IF NOT EXISTS email_budget (
  day  TEXT    PRIMARY KEY,
  sent INTEGER NOT NULL DEFAULT 0
);

-- Backs the per-IP rate limit lookup.
CREATE INDEX IF NOT EXISTS idx_registrations_rate
  ON registrations (ip_hash, created_at);
