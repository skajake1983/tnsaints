-- Migration 001 — add registrations.player_id
--
-- WHY THIS FILE EXISTS
--
-- schema.sql is written to be re-runnable: every statement is CREATE ... IF NOT
-- EXISTS, so applying it to a live database adds what is missing and skips what
-- is there. That property breaks down for a new COLUMN on an existing table:
-- once `registrations` exists, its CREATE TABLE is skipped entirely and the new
-- column in it is never created. SQLite has no ADD COLUMN IF NOT EXISTS.
--
-- So a fresh database gets player_id from schema.sql, and an existing one gets
-- it from here. Both end up identical.
--
-- ORDER: always schema.sql FIRST, then every migration in number order. This
-- one needs `players` to exist for its foreign key, and schema.sql creates it.
--
-- RUN ONCE per database:
--
--   npx wrangler d1 execute tnsaints --local  --file=./migrations/001_add_player_id.sql
--   npx wrangler d1 execute tnsaints --remote --file=./migrations/001_add_player_id.sql
--
-- Running it twice fails with "duplicate column name: player_id". That error is
-- harmless and means the migration was already applied — nothing is changed by
-- the failed attempt.
--
-- This is the ONLY place registrations.player_id is created. An earlier version
-- also declared it in schema.sql's CREATE TABLE, which silently did nothing on
-- any database where the table already existed while the accompanying index
-- failed against a column that was therefore missing.

ALTER TABLE registrations ADD COLUMN player_id INTEGER REFERENCES players(id);

CREATE INDEX IF NOT EXISTS idx_registrations_player
  ON registrations (player_id);
