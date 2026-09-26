-- Migration 009 — programs, groups with capacity, waivers, consents, enrollments
--
-- ORDER: schema.sql, then 001..008, then this.
--
--   npx wrangler d1 execute tnsaints --local  --file=./migrations/009_programs_enrollment.sql
--   npx wrangler d1 execute tnsaints --remote --file=./migrations/009_programs_enrollment.sql
--
-- Every statement is IF NOT EXISTS / OR IGNORE, so re-running is safe.
--
-- THE RULE THIS SCHEMA EXISTS TO ENFORCE: nobody pays without a seat in a
-- scheduled group. A family applies; staff offer a seat in a specific group
-- only while that group has room; the pay page exists only while that offer is
-- unexpired. Capacity is derived by COUNT, never stored as a counter, exactly
-- like evaluation sessions (schema.sql), so a cancelled or expired row frees
-- its seat with no bookkeeping.

-- ---------------------------------------------------------------------------
-- Waiver text, versioned and immutable. A signature is only meaningful against
-- the exact words signed, so a version is never edited: new words are a new
-- row, and families re-consent. `body_sha256` is the hex SHA-256 of body_text,
-- computed when the version is seeded and checked by the app on read.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS waiver_versions (
  id            TEXT    PRIMARY KEY,
  -- The party the family is agreeing with. Changes when the LLC becomes the
  -- non-profit, which is exactly why it is on the version and not in config.
  legal_entity  TEXT    NOT NULL,
  title         TEXT    NOT NULL,
  body_text     TEXT    NOT NULL,
  body_sha256   TEXT    NOT NULL CHECK (length(body_sha256) = 64),
  effective_at  TEXT    NOT NULL,
  created_at    TEXT    NOT NULL
);

CREATE TRIGGER IF NOT EXISTS waiver_versions_immutable
BEFORE UPDATE ON waiver_versions
BEGIN
  SELECT RAISE(ABORT, 'waiver versions are immutable; add a new version instead');
END;

-- ---------------------------------------------------------------------------
-- Anything a family can sign a child up for. Academy first; evaluations,
-- camps, tournaments, teams and clinics later, as rows rather than code.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS programs (
  -- Readable: 'academy'. Legacy evaluation ids ('2026-08-29-evaluation') fit
  -- unchanged when the evaluation moves onto programs.
  id                      TEXT    PRIMARY KEY,
  kind                    TEXT    NOT NULL CHECK (kind IN
                            ('academy', 'evaluation', 'camp', 'tournament', 'team', 'clinic')),
  name                    TEXT    NOT NULL,
  status                  TEXT    NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'open', 'closed', 'archived')),
  -- approval: apply -> staff offer a seat -> pay. self_serve: pick and pay
  -- (camps, later). The academy is approval, because paying without a
  -- schedule is the thing the owner ruled out.
  enrollment_mode         TEXT    NOT NULL DEFAULT 'approval'
                            CHECK (enrollment_mode IN ('approval', 'self_serve')),
  offer_hold_days         INTEGER NOT NULL DEFAULT 7 CHECK (offer_hold_days BETWEEN 1 AND 30),
  grade_min               INTEGER CHECK (grade_min BETWEEN 0 AND 12),
  grade_max               INTEGER CHECK (grade_max BETWEEN 0 AND 12),
  billing                 TEXT    NOT NULL CHECK (billing IN ('subscription', 'one_time', 'free')),
  -- Integer cents, never floats. PayPal amounts arrive as decimal STRINGS and
  -- are parsed to cents exactly.
  price_cents             INTEGER CHECK (price_cents >= 0),
  setup_fee_cents         INTEGER CHECK (setup_fee_cents >= 0),
  currency                TEXT    NOT NULL DEFAULT 'USD',
  paypal_plan_id_live     TEXT,
  paypal_plan_id_sandbox  TEXT,
  waiver_version_id       TEXT    REFERENCES waiver_versions(id),
  -- For the programs manager and the public site (later phases).
  public                  INTEGER NOT NULL DEFAULT 0 CHECK (public IN (0, 1)),
  registration_opens_at   TEXT,
  registration_closes_at  TEXT,
  waitlist_enabled        INTEGER NOT NULL DEFAULT 1 CHECK (waitlist_enabled IN (0, 1)),
  description             TEXT,
  preview_title           TEXT,
  preview_image           TEXT,
  created_at              TEXT    NOT NULL,
  updated_at              TEXT    NOT NULL,

  CHECK (grade_min IS NULL OR grade_max IS NULL OR grade_min <= grade_max),
  -- A program cannot be OPEN for families until it can actually be paid for
  -- and has a waiver to sign. Draft and closed programs may be incomplete.
  CHECK (status != 'open' OR billing = 'free' OR price_cents IS NOT NULL),
  CHECK (status != 'open' OR billing != 'subscription'
         OR paypal_plan_id_live IS NOT NULL OR paypal_plan_id_sandbox IS NOT NULL),
  CHECK (status != 'open' OR waiver_version_id IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- A scheduled group within a program: the thing that has a day, a time, a gym
-- and a number of seats. "Tuesdays 6:00-7:30 PM, 10 players."
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS program_groups (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id        TEXT    NOT NULL REFERENCES programs(id),
  name              TEXT    NOT NULL,
  -- What families read. Free text, so "Tue & Thu" needs no schema change.
  schedule_summary  TEXT    NOT NULL,
  weekday           INTEGER CHECK (weekday BETWEEN 0 AND 6),
  start_time        TEXT,
  end_time          TEXT,
  location          TEXT,
  -- First session. A subscription's monthly billing starts here; the setup fee
  -- is charged at signup.
  starts_on         TEXT,
  capacity          INTEGER NOT NULL CHECK (capacity > 0),
  grade_min         INTEGER CHECK (grade_min BETWEEN 0 AND 12),
  grade_max         INTEGER CHECK (grade_max BETWEEN 0 AND 12),
  status            TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  CHECK (grade_min IS NULL OR grade_max IS NULL OR grade_min <= grade_max)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_program_groups_name
  ON program_groups (program_id, name);

-- ---------------------------------------------------------------------------
-- Signed consents. Append-only: an UPDATE is refused, so a signature can never
-- be altered after the fact. A changed photo preference is a NEW row, and the
-- latest row is the one in force. DELETE is reserved for the retention job.
--
-- The hash must match the version signed, so a consent cannot be recorded
-- against words that were never shown.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consent_records (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id           INTEGER NOT NULL REFERENCES players(id),
  household_id        INTEGER NOT NULL REFERENCES households(id),
  account_id          INTEGER NOT NULL REFERENCES accounts(id),
  program_id          TEXT    NOT NULL REFERENCES programs(id),
  waiver_version_id   TEXT    NOT NULL REFERENCES waiver_versions(id),
  waiver_sha256       TEXT    NOT NULL,
  -- Typed full name, and who they are to the child.
  signature           TEXT    NOT NULL CHECK (length(trim(signature)) > 0),
  signer_relationship TEXT    NOT NULL,
  -- Same unfalsifiable-at-storage rule as registrations: a consent row that
  -- did not affirmatively accept these cannot exist.
  esign_consent       INTEGER NOT NULL CHECK (esign_consent = 1),
  assumption_of_risk  INTEGER NOT NULL CHECK (assumption_of_risk = 1),
  medical_release     INTEGER NOT NULL CHECK (medical_release = 1),
  -- A real choice for a minor: 0 is a valid, recorded answer.
  photo_release       INTEGER NOT NULL CHECK (photo_release IN (0, 1)),
  signed_at           TEXT    NOT NULL,
  ip_hash             TEXT
);

CREATE INDEX IF NOT EXISTS idx_consents_player ON consent_records (player_id, program_id, signed_at);

CREATE TRIGGER IF NOT EXISTS consent_records_append_only
BEFORE UPDATE ON consent_records
BEGIN
  SELECT RAISE(ABORT, 'consent records are append-only; insert a new record instead');
END;

CREATE TRIGGER IF NOT EXISTS consent_records_hash_matches
BEFORE INSERT ON consent_records
WHEN NEW.waiver_sha256 IS NOT (SELECT body_sha256 FROM waiver_versions WHERE id = NEW.waiver_version_id)
BEGIN
  SELECT RAISE(ABORT, 'consent does not match the waiver version text');
END;

-- ---------------------------------------------------------------------------
-- A child's place in a program, from application to the end.
--
--   applied   -> waitlist | offered | declined | cancelled
--   waitlist  -> offered | cancelled          (keeps its place: waitlisted_at)
--   offered   -> active (paid) | waitlist (offer expired) | cancelled
--   active    -> past_due | cancelled | ended
--   past_due  -> active | cancelled | ended
--
-- A seat is held by active, past_due and UNEXPIRED offered rows. The offer
-- insert counts those in the same statement (the claimSpot pattern), so two
-- staff offering the last seat at once cannot both succeed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS enrollments (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Unguessable, and the only identifier sent to PayPal (as custom_id) — no
  -- child's name ever leaves for the payment provider.
  ref                  TEXT    NOT NULL,
  player_id            INTEGER NOT NULL REFERENCES players(id),
  household_id         INTEGER NOT NULL REFERENCES households(id),
  program_id           TEXT    NOT NULL REFERENCES programs(id),
  group_id             INTEGER REFERENCES program_groups(id),
  -- JSON array of program_groups.id the family said would work, in order.
  preferred_group_ids  TEXT,
  status               TEXT    NOT NULL CHECK (status IN
                         ('applied', 'waitlist', 'offered', 'active', 'past_due',
                          'declined', 'cancelled', 'ended')),
  consent_record_id    INTEGER REFERENCES consent_records(id),
  offer_expires_at     TEXT,
  applied_at           TEXT    NOT NULL,
  waitlisted_at        TEXT,
  offered_at           TEXT,
  activated_at         TEXT,
  ended_at             TEXT,
  decided_by           TEXT,
  decided_at           TEXT,
  decline_reason       TEXT,
  -- `account:<id>` for a parent's application, a staff email when staff add a
  -- child directly (families invited out of band).
  created_by           TEXT    NOT NULL,
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL,

  CHECK (status != 'offered' OR (group_id IS NOT NULL AND offer_expires_at IS NOT NULL)),
  CHECK (status NOT IN ('active', 'past_due') OR group_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollments_ref ON enrollments (ref);

-- One live enrollment per child per program. Ended, cancelled and declined rows
-- stay as history and do not block a new application.
CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollments_live
  ON enrollments (player_id, program_id)
  WHERE status IN ('applied', 'waitlist', 'offered', 'active', 'past_due');

-- Backs the seat count inside the atomic offer.
CREATE INDEX IF NOT EXISTS idx_enrollments_group ON enrollments (group_id, status);
-- Backs the review queue and the demand view.
CREATE INDEX IF NOT EXISTS idx_enrollments_program ON enrollments (program_id, status, applied_at);
CREATE INDEX IF NOT EXISTS idx_enrollments_household ON enrollments (household_id);

-- ---------------------------------------------------------------------------
-- Seed: the academy, as a DRAFT. It cannot be opened until the monthly price
-- (plan item O5), its groups (O8) and a reviewed waiver version (O9) exist —
-- the CHECK constraints above refuse status='open' without them.
-- The live PayPal plan is the one on join.html today; $40 setup covers the shirt.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO programs
  (id, kind, name, status, enrollment_mode, offer_hold_days, grade_min, grade_max,
   billing, price_cents, setup_fee_cents, currency, paypal_plan_id_live,
   public, waitlist_enabled, created_at, updated_at)
VALUES
  ('academy', 'academy', 'Tennessee Saints Academy', 'draft', 'approval', 7, 3, 6,
   'subscription', NULL, 4000, 'USD', 'P-3A8355760P817903NNKZ4ZGQ',
   0, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
