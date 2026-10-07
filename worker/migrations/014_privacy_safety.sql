-- Migration 014 — Privacy and safety baseline: legal holds, and coach and
-- volunteer clearances
--
-- ORDER: schema.sql, then 001..013, then this.
--
--   npx wrangler d1 execute tnsaints --local  --file=./migrations/014_privacy_safety.sql
--   npx wrangler d1 execute tnsaints --remote --file=./migrations/014_privacy_safety.sql
--
-- Every statement is IF NOT EXISTS, so re-running is safe.

-- ---------------------------------------------------------------------------
-- A legal hold stops the retention job (src/privacy/retention.js) removing
-- anything about its subject — for a dispute, an insurance claim, a
-- safeguarding concern — until staff release it. A hold on a family covers its
-- children, payments and waivers; a hold on a child covers their medical
-- answers, evaluation registrations and waivers.
-- `reason` is short staff text: never medical or safeguarding detail.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS legal_holds (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type  TEXT    NOT NULL CHECK (subject_type IN ('household', 'player', 'crm_contact', 'registration')),
  subject_id    INTEGER NOT NULL,
  reason        TEXT    NOT NULL CHECK (length(reason) BETWEEN 3 AND 200),
  placed_by     TEXT    NOT NULL,
  placed_at     TEXT    NOT NULL,
  released_by   TEXT,
  released_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_legal_holds_active
  ON legal_holds (subject_type, subject_id) WHERE released_at IS NULL;

-- ---------------------------------------------------------------------------
-- Clearances for anyone who works with children: background check,
-- abuse-prevention training, concussion training. One row per completion;
-- the newest unrevoked row of a kind is the person's status. Coaches without
-- current clearances cannot be assigned to a team (plan phase G1).
-- `reference` is the provider's confirmation number, if any — never the
-- report itself.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clearances (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  person_email   TEXT    NOT NULL,
  person_name    TEXT    NOT NULL,
  kind           TEXT    NOT NULL CHECK (kind IN ('background_check', 'abuse_prevention', 'concussion_training')),
  completed_on   TEXT    NOT NULL,
  -- NULL = does not expire.
  expires_on     TEXT,
  provider       TEXT,
  reference      TEXT,
  recorded_by    TEXT    NOT NULL,
  recorded_at    TEXT    NOT NULL,
  revoked_at     TEXT,
  revoked_by     TEXT,
  CHECK (expires_on IS NULL OR expires_on > completed_on)
);

CREATE INDEX IF NOT EXISTS idx_clearances_person ON clearances (person_email, kind, completed_on);
CREATE INDEX IF NOT EXISTS idx_clearances_expiry ON clearances (expires_on) WHERE revoked_at IS NULL;
