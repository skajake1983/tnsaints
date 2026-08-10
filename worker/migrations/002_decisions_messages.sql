-- Migration 002 — decisions, batches, and outbound parent messages
--
-- ORDER: schema.sql first, then 001, then this.
--
--   npx wrangler d1 execute tnsaints --local  --file=./migrations/002_decisions_messages.sql
--   npx wrangler d1 execute tnsaints --remote --file=./migrations/002_decisions_messages.sql
--
-- Every statement is IF NOT EXISTS, so re-running is safe.

-- ---------------------------------------------------------------------------
-- A batch is the unit of review. Decisions are made across the whole event and
-- sent together, because reading fifty "not yet" messages in one sitting is the
-- only reliable way to notice that one of them reads as a rejection.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decision_batches (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN
                ('draft', 'approved', 'sending', 'sent', 'partial', 'cancelled')),
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  finished_at TEXT,
  note        TEXT
);

-- At most one batch in flight per event. Without this, a second approval while
-- the first is draining sends some families two messages and others none, and
-- the state that decides who already got one is spread across both batches.
CREATE UNIQUE INDEX IF NOT EXISTS idx_batch_one_active
  ON decision_batches (event_id)
  WHERE state IN ('approved', 'sending');

CREATE TABLE IF NOT EXISTS decisions (
  registration_id INTEGER PRIMARY KEY REFERENCES registrations(id),
  event_id        TEXT NOT NULL,
  decision        TEXT NOT NULL DEFAULT 'undecided'
                    CHECK (decision IN ('undecided', 'accept', 'not_yet')),
  decided_by      TEXT,
  decided_at      TEXT,
  batch_id        TEXT REFERENCES decision_batches(id)
);

CREATE INDEX IF NOT EXISTS idx_decisions_event ON decisions (event_id, decision);

-- ---------------------------------------------------------------------------
-- Every outbound message to a family, of any kind.
--
-- The rendered body is snapshotted HERE rather than composed at send time, and
-- that is the point: what an admin previewed is byte-identical to what sends. It
-- kills the entire class of bug where a coach edits a note between preview and
-- send, and the family receives something nobody read.
--
-- `kind` rather than a decision-specific table, so October's progress update is
-- a new value rather than a parallel mechanism. reply_token is generated now and
-- consumed later, when parents can reply.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parent_messages (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id           INTEGER NOT NULL REFERENCES players(id),
  registration_id     INTEGER REFERENCES registrations(id),
  event_id            TEXT,
  batch_id            TEXT REFERENCES decision_batches(id),
  kind                TEXT NOT NULL,

  subject             TEXT NOT NULL,
  body_html           TEXT NOT NULL,
  body_text           TEXT NOT NULL,

  send_state          TEXT NOT NULL DEFAULT 'draft' CHECK (send_state IN
                        ('draft', 'queued', 'sending', 'sent', 'failed', 'skipped')),
  send_attempts       INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  reply_token         TEXT,

  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  approved_by         TEXT,
  approved_at         TEXT,
  sent_at             TEXT,
  provider_message_id TEXT
);

-- Backs the drain: find the next queued message in this batch.
CREATE INDEX IF NOT EXISTS idx_messages_drain
  ON parent_messages (batch_id, send_state);

CREATE INDEX IF NOT EXISTS idx_messages_player
  ON parent_messages (player_id, created_at);

-- One message per registration per batch. A double-approve or a retried compose
-- must not queue a second copy for the same family.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_one_per_batch
  ON parent_messages (batch_id, registration_id)
  WHERE batch_id IS NOT NULL AND registration_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Designed, not built. Nothing writes here yet — it exists so that adding
-- inbound parent replies later is a new writer against an existing shape rather
-- than a migration of everything already sent.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parent_feedback (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id         INTEGER NOT NULL REFERENCES players(id),
  parent_message_id INTEGER REFERENCES parent_messages(id),
  body              TEXT NOT NULL,
  rating            INTEGER CHECK (rating BETWEEN 1 AND 5),
  created_at        TEXT NOT NULL
);
