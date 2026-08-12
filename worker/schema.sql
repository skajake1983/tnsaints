-- Tennessee Saints — evaluation registration schema (Cloudflare D1 / SQLite)
--
-- Capacity is never stored as a counter. It is always derived from
-- COUNT(*) of confirmed rows, so deleting a bogus registration
-- automatically reopens that spot with no extra bookkeeping.
--
-- ---------------------------------------------------------------------------
-- DELETION ORDER — read this before deleting a registration.
--
-- D1 enforces foreign keys. Once a player has notes, `DELETE FROM
-- registrations` fails with SQLITE_CONSTRAINT_FOREIGNKEY rather than silently
-- orphaning them. That is the correct behaviour — a note about a child who is
-- not in the event is a bug — but it means deletes go child-first:
--
--   DELETE FROM eval_notes_internal WHERE registration_id = ?;
--   DELETE FROM eval_feedback       WHERE registration_id = ?;
--   DELETE FROM registrations       WHERE id = ?;
--
-- To remove a test registration that has no notes, the third line alone is
-- enough. `npm run db:reset:local` already does the full order.
--
-- Prefer cancelling to deleting for anything real: status='cancelled' frees the
-- capacity, keeps the record, and touches no foreign key.
-- ---------------------------------------------------------------------------

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

  -- NOTE: registrations.player_id is deliberately NOT here. It is added by
  -- migrations/001_add_player_id.sql, for both fresh and existing databases.
  --
  -- Putting it here as well looked tidier and was wrong: this file is re-run
  -- against live databases, where CREATE TABLE IF NOT EXISTS is skipped
  -- entirely once the table exists — so the column never appeared, while the
  -- index below it referenced a column that was not there and the whole run
  -- errored. One column, one place that creates it.
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

-- ---------------------------------------------------------------------------
-- Staff and authorization (Phase A)
--
-- Cloudflare Access answers "may this human come through the door". This table
-- answers "what may they do once inside".
--
-- The reason to keep those separate is containment. Access policies are edited
-- in a dashboard by whoever holds the Cloudflare account; this table changes
-- through a reviewed command in the repo. A signed-in email that is absent
-- here, or has active = 0, gets 403 even though Access admitted it — so
-- widening the Access policy to "anyone with an @tnsaints.com address", which
-- is a two-click mistake, does not by itself grant anyone a thing.
--
-- It also keeps authorization independent of the identity provider. Every
-- coach currently has an @tnsaints.com mailbox and arrives through Entra, but
-- the first guest coach, contractor, or evaluator who does not will arrive some
-- other way, carrying whatever claims that method happens to supply. Roles
-- living here means adding that person is one INSERT rather than a rethink of
-- how authorization works.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff (
  -- Lowercased, trimmed. The JWT email claim is normalised the same way before
  -- lookup, so casing in the identity provider cannot lock someone out.
  email_norm   TEXT    PRIMARY KEY,
  display_name TEXT    NOT NULL,
  -- How this person is credited to parents: "Coach Turner". Stored rather than
  -- derived, because "Coach " + surname is wrong often enough to matter and a
  -- parent-facing label is not something to guess at.
  author_label TEXT    NOT NULL,
  role         TEXT    NOT NULL CHECK (role IN ('admin', 'coach', 'viewer')),
  -- Soft revocation. Deleting the row would orphan authored notes; this keeps
  -- attribution intact while ending access immediately.
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  -- Timestamp of the first successful sign-in, stamped once by loadStaff and
  -- never updated after. NULL means "invited but never signed in", which is the
  -- only state where the Users screen still offers "Re-send email" — once
  -- they are in, re-sending a welcome email is meaningless.
  first_seen_at TEXT
);

-- ---------------------------------------------------------------------------
-- Audit trail.
--
-- detail holds JSON of identifiers only — never the values being looked at. An
-- audit log that records what a medical note said has copied the sensitive data
-- into a second, less-guarded place, which defeats the point of logging the
-- access in the first place.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT    NOT NULL,
  -- The authenticated principal: an email, or 'token:automation' for the
  -- ADMIN_TOKEN runbook path, which has no human identity behind it.
  actor        TEXT    NOT NULL,
  action       TEXT    NOT NULL,
  subject_type TEXT,
  subject_id   TEXT,
  detail       TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor, at);

-- ---------------------------------------------------------------------------
-- Players (Phase B)
--
-- A durable person, separate from the event-scoped registration row. A child
-- evaluated in August and coached through May is ONE person with one history;
-- notes, feedback, and every future message anchor here rather than to a
-- registration, so a second event next spring extends that history instead of
-- starting a new one.
--
-- Adding this now costs a table and a join. Adding it in November means
-- migrating every note and message already written.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS players (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name      TEXT    NOT NULL,
  name_norm         TEXT    NOT NULL,
  parent_email_norm TEXT    NOT NULL,
  grade             TEXT,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
);

-- Identity is (parent email, player name), reusing exactly the normalisation
-- the registration duplicate-guard already computes. Two children under one
-- parent email stay distinct because the name differs; the same child
-- registering twice with different capitalisation resolves to one row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_players_identity
  ON players (parent_email_norm, name_norm);

-- ---------------------------------------------------------------------------
-- Coach notes — INTERNAL ONLY.
--
-- NOTHING in this table is ever passed to an email composer. That is enforced
-- structurally rather than by a visibility column: a single forgotten
-- `WHERE visibility = 'parent'` on a shared table would send a coach's candid
-- assessment to the child's family, and there is no undo for that. Two tables
-- mean a careless SELECT * on the parent-facing one is safe by construction.
--
-- worker/src/feedback/compose.js imports no accessor that can read this table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS eval_notes_internal (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id       INTEGER NOT NULL REFERENCES players(id),
  registration_id INTEGER NOT NULL REFERENCES registrations(id),
  event_id        TEXT    NOT NULL,
  -- Who the note is ATTRIBUTED to. May differ from who typed it when an admin
  -- transcribes from paper — audit_log records the actual typist.
  author_email    TEXT    NOT NULL,
  body            TEXT    NOT NULL,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

-- One row per coach per player, upserted. A coach revisiting on Tuesday edits
-- Saturday's note rather than adding a second one, which is what makes the
-- multi-day refinement window work without the record turning into a thread.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_one
  ON eval_notes_internal (registration_id, author_email);

CREATE INDEX IF NOT EXISTS idx_notes_event
  ON eval_notes_internal (event_id, registration_id);

-- ---------------------------------------------------------------------------
-- Parent-facing evaluation feedback.
--
-- INVARIANT: every column here is safe to show a parent. SELECT * is safe.
-- Anything a family should not read belongs in eval_notes_internal above.
-- Adding a column here is a decision to show that column to a family.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS eval_feedback (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id           INTEGER NOT NULL REFERENCES players(id),
  registration_id     INTEGER NOT NULL REFERENCES registrations(id),
  event_id            TEXT    NOT NULL,
  author_email        TEXT    NOT NULL,
  -- Snapshotted from staff.author_label at write time. If a coach later leaves
  -- and their row is deactivated, feedback already sent still reads correctly.
  author_label        TEXT    NOT NULL,

  rating_skill        INTEGER CHECK (rating_skill        BETWEEN 1 AND 5),
  rating_effort       INTEGER CHECK (rating_effort       BETWEEN 1 AND 5),
  rating_coachability INTEGER CHECK (rating_coachability BETWEEN 1 AND 5),
  rating_decisions    INTEGER CHECK (rating_decisions    BETWEEN 1 AND 5),

  -- Required before a decision batch can be approved, not required to save a
  -- draft. Coaches on the day capture ratings in seconds and write prose later;
  -- forcing prose at the gym is how you get "good kid" fifty times.
  strengths           TEXT,
  growth_area         TEXT,
  parent_note         TEXT,

  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_one
  ON eval_feedback (registration_id, author_email);

CREATE INDEX IF NOT EXISTS idx_feedback_event
  ON eval_feedback (event_id, registration_id);
