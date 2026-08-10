-- Migration 005 — fingerprint the coach notes a draft was composed from
--
-- ORDER: schema.sql, then 001..004, then this.
--
--   npx wrangler d1 execute tnsaints --local  --file=./migrations/005_notes_fingerprint.sql
--   npx wrangler d1 execute tnsaints --remote --file=./migrations/005_notes_fingerprint.sql
--
-- Re-running fails with "duplicate column name". Harmless.

-- ---------------------------------------------------------------------------
-- Migration 004 caught the decision changing after a draft was written. This
-- catches the NOTES changing, which is the more dangerous half.
--
-- The scenario is not hypothetical — it is the exact mistake the on-behalf-of
-- transcription path exists to repair. A coach types Marcus's observations into
-- Devin's evaluation form. Build runs that night, so Devin's snapshot now holds
-- another child's feedback. It reads perfectly plausibly, so it gets marked
-- read. The next day the notes are corrected. Nothing marks the draft stale,
-- both players still have a non-zero count of strengths and growth areas so the
-- gate passes, and Devin's family is mailed Marcus's evaluation.
--
-- The same mechanism ships a phrase a coach deliberately softened: change
-- "struggles to keep up physically" to something kinder after Build, and the
-- original wording is what the parent reads.
--
-- Counting rows is not enough, because a correction changes content without
-- changing the count. The fingerprint is COUNT(*) || ':' || MAX(updated_at) over
-- that player's eval_feedback, which moves on an add, an edit, or a delete —
-- saveEvaluation always bumps updated_at on upsert.
-- ---------------------------------------------------------------------------
ALTER TABLE parent_messages ADD COLUMN composed_from_notes TEXT;

-- Existing drafts cannot be proven current, so they are marked with a value no
-- real fingerprint can equal. They fail the check and must be rebuilt.
UPDATE parent_messages
   SET composed_from_notes = 'unknown-pre-migration'
 WHERE composed_from_notes IS NULL
   AND send_state IN ('draft', 'skipped');
