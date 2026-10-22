-- Migration 023 — events on programs
--
-- ORDER: schema.sql, then 001..022, then this.
--
--   npx wrangler d1 execute tnsaints --local  --file=./migrations/023_events_programs.sql
--   npx wrangler d1 execute tnsaints --remote --file=./migrations/023_events_programs.sql
--
-- The Events plan (owner, 2026-10-21): an event is a program — an
-- evaluation, open gym, camp, scrimmage or tournament — and a program gains
-- what an event needs on the website:
--
--   event_kind        the event's kind (NULL for portal programs: the academy, teams, portal camps)
--   signup_mode       enroll    a portal program: apply/offer/pay (every existing program but evaluations)
--                     spot      a public sign-up for a place in a session, capped, with a waiting list
--                     interest  "register interest": no place is claimed; staff confirm and invite
--                     team      a coach enters a team (a tournament we host)
--   starts_on/ends_on the event's first and last day (YYYY-MM-DD); location
--   payment_policy    free | online (Stripe, before the place is confirmed) | at_check_in
--   banner_title/banner_text/share_text  what the website banner and share wording say
--   series_id         the open gyms created together by "repeat weekly"
--   notify_each_signup  email staff on every sign-up (else the daily brief only)
--   published_at, created_from   when it first opened; the event it was copied from
--
-- WHY A NEW event_kind COLUMN, NOT NEW programs.kind VALUES: programs.kind's
-- CHECK cannot change without rebuilding the table, and D1 refuses to
-- rebuild a table other tables point at (program_groups, enrollments,
-- consent_records): it does not hold deferred foreign keys across a file.
-- Proven on a copy of production, 2026-10-21. So programs.kind keeps its
-- values ('clinic' stands in for an open gym or scrimmage there) and the
-- code reads COALESCE(event_kind, kind).
--
-- ALTER-only: a re-run fails at the first statement with "duplicate column
-- name", which means already applied (tests/migrate_local_db.py).

ALTER TABLE programs ADD COLUMN event_kind TEXT
  CHECK (event_kind IS NULL OR event_kind IN ('evaluation', 'open_gym', 'camp', 'scrimmage', 'tournament'));
ALTER TABLE programs ADD COLUMN signup_mode TEXT NOT NULL DEFAULT 'enroll'
  CHECK (signup_mode IN ('enroll', 'spot', 'interest', 'team'));
ALTER TABLE programs ADD COLUMN starts_on TEXT
  CHECK (starts_on IS NULL OR starts_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
ALTER TABLE programs ADD COLUMN ends_on TEXT
  CHECK (ends_on IS NULL OR ends_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
ALTER TABLE programs ADD COLUMN location TEXT;
ALTER TABLE programs ADD COLUMN payment_policy TEXT NOT NULL DEFAULT 'free'
  CHECK (payment_policy IN ('free', 'online', 'at_check_in'));
ALTER TABLE programs ADD COLUMN banner_title TEXT;
ALTER TABLE programs ADD COLUMN banner_text TEXT;
ALTER TABLE programs ADD COLUMN share_text TEXT;
ALTER TABLE programs ADD COLUMN series_id TEXT;
ALTER TABLE programs ADD COLUMN notify_each_signup INTEGER NOT NULL DEFAULT 1 CHECK (notify_each_signup IN (0, 1));
ALTER TABLE programs ADD COLUMN published_at TEXT;
ALTER TABLE programs ADD COLUMN created_from TEXT;

-- Evaluations always took public sign-ups for a place: they are events. Their
-- days and place come from their sessions.
UPDATE programs
   SET event_kind = 'evaluation',
       signup_mode = 'spot',
       starts_on = (SELECT MIN(g.starts_on) FROM program_groups g WHERE g.program_id = programs.id),
       ends_on = (SELECT MAX(g.starts_on) FROM program_groups g WHERE g.program_id = programs.id),
       location = (SELECT g.location FROM program_groups g WHERE g.program_id = programs.id AND g.location IS NOT NULL
                    ORDER BY g.id LIMIT 1)
 WHERE kind = 'evaluation';

CREATE INDEX IF NOT EXISTS idx_programs_events ON programs (signup_mode, status, starts_on);
