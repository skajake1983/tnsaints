-- Migration 004 — record what a draft was composed FOR
--
-- ORDER: schema.sql, then 001, 002, 003, then this.
--
--   npx wrangler d1 execute tnsaints --local  --file=./migrations/004_draft_staleness.sql
--   npx wrangler d1 execute tnsaints --remote --file=./migrations/004_draft_staleness.sql
--
-- Re-running fails with "duplicate column name". Harmless.

-- ---------------------------------------------------------------------------
-- THE BUG THIS EXISTS TO CLOSE
--
-- The body is snapshotted at build time so that what an admin reads is exactly
-- what sends. But a snapshot of the WRONG thing is worse than no snapshot.
--
-- Change a player's decision from not_yet to accept after building, and the
-- stored draft still held the not_yet text: "We are not able to offer ZZ a spot
-- in the academy this season." Nothing regenerated it, nothing marked it stale,
-- and approveBatch's gate could not see the contradiction because it inspects
-- the body, the email and the coach prose — never whether the body still
-- corresponds to the decision it was written for.
--
-- Approving and sending would have told an ACCEPTED family they were turned
-- away. That is the worst outcome this system can produce.
--
-- Storing the decision the body was composed under makes the contradiction a
-- comparison rather than an assumption: if it no longer matches, the message is
-- stale and cannot be approved.
-- ---------------------------------------------------------------------------
ALTER TABLE parent_messages ADD COLUMN composed_for_decision TEXT;

-- Existing drafts predate the column and cannot be proven current, so they are
-- marked with a value that can never equal a real decision. They fail the
-- staleness check and must be rebuilt — which is the safe direction.
UPDATE parent_messages
   SET composed_for_decision = 'unknown-pre-migration'
 WHERE composed_for_decision IS NULL
   AND send_state IN ('draft', 'skipped');
