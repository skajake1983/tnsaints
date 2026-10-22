-- Migration 024 — sign-ups for events: interest, team entries, and what a
-- registration agreed to
--
-- ORDER: schema.sql, then 001..023, then this.
--
--   npx wrangler d1 execute tnsaints --local  --file=./migrations/024_events_signups.sql
--   npx wrangler d1 execute tnsaints --remote --file=./migrations/024_events_signups.sql
--
-- The Events plan (owner, 2026-10-21), phase EV3:
--
--   event_interest   "register interest" (scrimmages; tournaments we enter): a
--                    child and a parent's contact, no place claimed, no waiver
--                    or medical detail asked for (a place is confirmed later)
--   event_teams      a team entered in a tournament we host, by its coach, in
--                    a division (one of the event's groups), with the entry
--                    agreement signed
--   registrations    + group_id (the session, by id, not only by name), the
--                    waiver version and text hash the family agreed to, and
--                    where the sign-up came from
--   crm_activities   + kinds 'event' (signed up, registered interest, entered
--                    a team), 'invite' and 'unsubscribe' (EV5). Rebuilt for
--                    the CHECK; nothing points at crm_activities, so D1 allows
--                    it (unlike programs: see 023).
--
-- Safe to re-run: the tables are IF NOT EXISTS; the crm_activities rebuild
-- keeps every row; the registrations ALTERs come last and stop a re-run there
-- with "duplicate column name".

CREATE TABLE IF NOT EXISTS event_interest (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id           TEXT    NOT NULL REFERENCES programs(id),
  player_name        TEXT    NOT NULL,
  player_name_norm   TEXT    NOT NULL,
  grade              TEXT    NOT NULL,
  parent_name        TEXT    NOT NULL,
  parent_email       TEXT    NOT NULL,
  parent_email_norm  TEXT    NOT NULL,
  phone              TEXT    NOT NULL,
  notes              TEXT,
  -- interested -> confirmed (staff) | declined (staff) | withdrawn (the family)
  status             TEXT    NOT NULL DEFAULT 'interested'
                       CHECK (status IN ('interested', 'confirmed', 'declined', 'withdrawn')),
  cancel_token       TEXT    NOT NULL,
  ip_hash            TEXT,
  player_id          INTEGER REFERENCES players(id),
  decided_by         TEXT,
  decided_at         TEXT,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_interest_one
  ON event_interest (event_id, parent_email_norm, player_name_norm) WHERE status != 'withdrawn';
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_interest_token ON event_interest (cancel_token);
CREATE INDEX IF NOT EXISTS idx_event_interest_event ON event_interest (event_id, status, created_at);

CREATE TABLE IF NOT EXISTS event_teams (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id           TEXT    NOT NULL REFERENCES programs(id),
  group_id           INTEGER NOT NULL REFERENCES program_groups(id),
  team_name          TEXT    NOT NULL,
  team_name_norm     TEXT    NOT NULL,
  coach_name         TEXT    NOT NULL,
  coach_email        TEXT    NOT NULL,
  coach_email_norm   TEXT    NOT NULL,
  coach_phone        TEXT    NOT NULL,
  players_count      INTEGER NOT NULL CHECK (players_count BETWEEN 1 AND 30),
  notes              TEXT,
  -- entered (a place in the division) | waitlist (division full) | withdrawn
  status             TEXT    NOT NULL CHECK (status IN ('entered', 'waitlist', 'withdrawn')),
  waiver_version_id  TEXT    REFERENCES waiver_versions(id),
  waiver_sha256      TEXT,
  agreement          INTEGER NOT NULL CHECK (agreement = 1),
  signature          TEXT    NOT NULL,
  signed_at          TEXT    NOT NULL,
  cancel_token       TEXT    NOT NULL,
  ip_hash            TEXT,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_teams_one
  ON event_teams (event_id, team_name_norm) WHERE status != 'withdrawn';
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_teams_token ON event_teams (cancel_token);
CREATE INDEX IF NOT EXISTS idx_event_teams_group ON event_teams (group_id, status, created_at);

-- crm_activities: new kinds. Copy, recreate, restore (nothing references it).
CREATE TABLE IF NOT EXISTS crm_activities_024 AS SELECT * FROM crm_activities;
DROP TABLE crm_activities;
CREATE TABLE crm_activities (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT    NOT NULL CHECK (kind IN
                    ('note', 'call', 'email', 'text', 'meeting', 'stage', 'linked', 'enrolled', 'merge', 'import', 'dnc',
                     'event', 'invite', 'unsubscribe')),
  body            TEXT,
  detail          TEXT,
  contact_id      INTEGER REFERENCES crm_contacts(id),
  household_id    INTEGER REFERENCES households(id),
  opportunity_id  INTEGER REFERENCES crm_opportunities(id),
  -- Staff email, or 'system' for the reconcile job.
  actor           TEXT    NOT NULL,
  -- When it happened (a call logged afterwards keeps the call's date).
  occurred_at     TEXT    NOT NULL,
  created_at      TEXT    NOT NULL,
  CHECK (contact_id IS NOT NULL OR household_id IS NOT NULL)
);
INSERT INTO crm_activities (id, kind, body, detail, contact_id, household_id, opportunity_id, actor, occurred_at, created_at)
  SELECT id, kind, body, detail, contact_id, household_id, opportunity_id, actor, occurred_at, created_at FROM crm_activities_024;
DROP TABLE crm_activities_024;
CREATE INDEX IF NOT EXISTS idx_crm_activities_contact ON crm_activities (contact_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_crm_activities_household ON crm_activities (household_id, occurred_at);

ALTER TABLE registrations ADD COLUMN group_id INTEGER REFERENCES program_groups(id);
ALTER TABLE registrations ADD COLUMN waiver_version_id TEXT REFERENCES waiver_versions(id);
ALTER TABLE registrations ADD COLUMN waiver_sha256 TEXT;
ALTER TABLE registrations ADD COLUMN source TEXT;
