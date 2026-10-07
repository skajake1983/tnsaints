-- Migration 015 — Programs manager: one-time payments, teams, schedules
--
-- ORDER: schema.sql, then 001..014, then this.
--
--   npx wrangler d1 execute tnsaints --local  --file=./migrations/015_programs_teams.sql
--   npx wrangler d1 execute tnsaints --remote --file=./migrations/015_programs_teams.sql
--
-- The CREATE statements are IF NOT EXISTS. The one ALTER is last, so a re-run
-- that fails on "duplicate column name" has already applied everything else.

-- ---------------------------------------------------------------------------
-- PayPal Orders for one-time programs (payments/orders.js). Created by the
-- Worker with the amount from the program row; identifiers and amounts only —
-- the payer's details stay at PayPal.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paypal_orders (
  order_id       TEXT    NOT NULL,
  environment    TEXT    NOT NULL CHECK (environment IN ('live', 'sandbox')),
  enrollment_id  INTEGER NOT NULL REFERENCES enrollments(id),
  amount_cents   INTEGER NOT NULL CHECK (amount_cents > 0),
  currency       TEXT    NOT NULL,
  status         TEXT    NOT NULL,
  capture_id     TEXT,
  created_at     TEXT    NOT NULL,
  captured_at    TEXT,
  PRIMARY KEY (environment, order_id)
);

CREATE INDEX IF NOT EXISTS idx_paypal_orders_enrollment ON paypal_orders (enrollment_id);
CREATE INDEX IF NOT EXISTS idx_paypal_orders_open ON paypal_orders (environment, status, created_at);

-- ---------------------------------------------------------------------------
-- Teams. A team is a group of a 'team' program; its roster is the children
-- enrolled in it. Coaches are assigned per team — only while their clearances
-- are current (safety/clearances.js), checked when assigned.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS team_coaches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id     INTEGER NOT NULL REFERENCES program_groups(id),
  staff_email  TEXT    NOT NULL,
  role         TEXT    NOT NULL CHECK (role IN ('head', 'assistant')),
  assigned_by  TEXT    NOT NULL,
  assigned_at  TEXT    NOT NULL,
  removed_by   TEXT,
  removed_at   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_team_coaches_active
  ON team_coaches (group_id, staff_email) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_team_coaches_staff ON team_coaches (staff_email) WHERE removed_at IS NULL;

-- Practices, games and tournaments. Times are ISO instants; families see them
-- in Central time and can subscribe to the team's calendar feed.
CREATE TABLE IF NOT EXISTS team_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id      INTEGER NOT NULL REFERENCES program_groups(id),
  kind          TEXT    NOT NULL CHECK (kind IN ('practice', 'game', 'tournament', 'other')),
  title         TEXT,
  starts_at     TEXT    NOT NULL,
  ends_at       TEXT,
  location      TEXT,
  opponent      TEXT,
  notes         TEXT,
  cancelled_at  TEXT,
  created_by    TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_team_events_group ON team_events (group_id, starts_at);

-- A per-team secret mixed into the calendar feed's link, so one team's link
-- can be replaced (if it is shared too widely) without touching the others.
ALTER TABLE program_groups ADD COLUMN calendar_salt TEXT;
