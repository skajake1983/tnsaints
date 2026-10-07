-- Migration 018 — the 'board' staff role
--
-- ORDER: schema.sql, then 001..017, then this. Apply BEFORE deploying the code
-- that offers the board role (Admin -> Users), or adding a board member fails.
--
--   npx wrangler d1 execute tnsaints --local  --file=./migrations/018_staff_board_role.sql
--   npx wrangler d1 execute tnsaints --remote --file=./migrations/018_staff_board_role.sql
--
-- schema.sql limits staff.role to admin, coach and viewer with a CHECK, and
-- SQLite cannot change a CHECK in place. So the table is rebuilt: a copy with
-- the wider CHECK, every row copied, the old table dropped, the copy renamed.
-- Columns, types, defaults and the primary key are exactly as before
-- (schema.sql plus 006's first_seen_at). Nothing references staff by foreign
-- key, and it has no triggers or other indexes, so nothing else moves.
--
-- Safe to re-run: a second run rebuilds the table again with the same rows.
--
-- BEFORE running it on production, take a copy of the table:
--   npx wrangler d1 export tnsaints --remote --table=staff --output=staff-before-018.sql
-- If anything goes wrong, D1 Time Travel restores the database to a minute
-- before: npx wrangler d1 time-travel restore tnsaints --timestamp=<ISO time>

CREATE TABLE IF NOT EXISTS staff_rebuild_018 (
  email_norm    TEXT    PRIMARY KEY,
  display_name  TEXT    NOT NULL,
  author_label  TEXT    NOT NULL,
  -- 'board': the board's records and their own disclosure; nothing about
  -- children (src/auth/staff.js).
  role          TEXT    NOT NULL CHECK (role IN ('admin', 'coach', 'viewer', 'board')),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  first_seen_at TEXT
);

INSERT INTO staff_rebuild_018 (email_norm, display_name, author_label, role, active, created_at, updated_at, first_seen_at)
SELECT email_norm, display_name, author_label, role, active, created_at, updated_at, first_seen_at FROM staff;

DROP TABLE staff;

ALTER TABLE staff_rebuild_018 RENAME TO staff;
