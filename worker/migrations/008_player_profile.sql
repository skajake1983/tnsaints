-- Migration 008 — a player's profile, and which family they belong to
--
-- ORDER: schema.sql, then 001..007, then this. Needs `households` from 007.
--
--   npx wrangler d1 execute tnsaints --local  --file=./migrations/008_player_profile.sql
--   npx wrangler d1 execute tnsaints --remote --file=./migrations/008_player_profile.sql
--
-- Re-running fails with "duplicate column name". Harmless: nothing is changed
-- by the failed attempt.
--
-- Every new column is nullable. Players created by the August evaluation have
-- none of this, and must keep working exactly as they do; the portal fills it
-- in when a parent claims the child into their family.

-- Ownership. `parent_email_norm` stays as the legacy identity key the
-- evaluation pipeline joins on; household_id is who may see and change the
-- child from now on. They coexist until the evaluation moves onto programs.
ALTER TABLE players ADD COLUMN household_id INTEGER REFERENCES households(id);

-- YYYY-MM-DD. Required to enroll; used for age-group eligibility later.
ALTER TABLE players ADD COLUMN date_of_birth TEXT;

-- Grade as a number (0 = K) plus the school year it was true for (2026 means
-- 2026-27). The current grade is derived, so it advances every July 1 by
-- itself instead of being wrong from the first day of each school year.
ALTER TABLE players ADD COLUMN grade_level INTEGER CHECK (grade_level BETWEEN 0 AND 12);
ALTER TABLE players ADD COLUMN grade_school_year INTEGER CHECK (grade_school_year BETWEEN 2020 AND 2100);

ALTER TABLE players ADD COLUMN school TEXT;

-- Required to enroll: the $40 setup fee covers the practice shirt.
ALTER TABLE players ADD COLUMN shirt_size TEXT CHECK (shirt_size IN
  ('YXS', 'YS', 'YM', 'YL', 'YXL', 'AS', 'AM', 'AL', 'AXL', 'A2XL'));

-- One child of a given name per family. Legacy rows (no household yet) are
-- governed by idx_players_identity as before.
CREATE UNIQUE INDEX IF NOT EXISTS idx_players_household_name
  ON players (household_id, name_norm)
  WHERE household_id IS NOT NULL;
