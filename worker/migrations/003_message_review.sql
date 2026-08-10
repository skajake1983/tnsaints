-- Migration 003 — message review, editing, and a duplicate-send guard
--
-- ORDER: schema.sql, then 001, 002, then this.
--
--   npx wrangler d1 execute tnsaints --local  --file=./migrations/003_message_review.sql
--   npx wrangler d1 execute tnsaints --remote --file=./migrations/003_message_review.sql
--
-- The ALTERs fail with "duplicate column name" if run twice. That is harmless
-- and means it was already applied.

-- ---------------------------------------------------------------------------
-- Who read this message, and who edited it.
--
-- approveBatch() refuses while any draft has reviewed_at IS NULL. That refusal
-- is the actual control: before it existed, Approve rendered on the single
-- condition "a batch was built", so fifty messages could be frozen for sending
-- without a human having opened one. The read-tracking in the UI is only what
-- makes the refusal satisfiable.
-- ---------------------------------------------------------------------------
ALTER TABLE parent_messages ADD COLUMN reviewed_by TEXT;
ALTER TABLE parent_messages ADD COLUMN reviewed_at TEXT;
ALTER TABLE parent_messages ADD COLUMN edited_by   TEXT;
ALTER TABLE parent_messages ADD COLUMN edited_at   TEXT;

-- ---------------------------------------------------------------------------
-- One live message per player per kind.
--
-- idx_messages_one_per_batch is keyed on batch_id, so it cannot see across
-- batches. The in-flight guard in buildBatch() only matches 'approved' and
-- 'sending' — so once a batch reached 'sent', a stale tab's "Rebuild drafts"
-- button would compose a second batch for all fifty families and mail every one
-- of them their child's decision a second time. For the families told "not
-- yet", twice.
--
-- Partial on the live states so a 'skipped' or 'failed' row never blocks a
-- legitimate retry.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_one_live_per_kind
  ON parent_messages (registration_id, kind)
  WHERE send_state IN ('queued', 'sending', 'sent');

-- Backs the unread/coverage checks in approveBatch().
CREATE INDEX IF NOT EXISTS idx_messages_batch_review
  ON parent_messages (batch_id, send_state, reviewed_at);
