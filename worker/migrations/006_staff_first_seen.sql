-- Migration 006 — record each staff member's first successful sign-in
--
-- ORDER: schema.sql, then 001..005, then this.
--
--   npx wrangler d1 execute tnsaints --local  --file=./migrations/006_staff_first_seen.sql
--   npx wrangler d1 execute tnsaints --remote --file=./migrations/006_staff_first_seen.sql
--
-- Re-running fails with "duplicate column name". Harmless.

-- ---------------------------------------------------------------------------
-- The Users screen offers "Re-send email" on every active person, which is
-- noise for anyone already signed in — the welcome email only matters until it
-- has done its job. loadStaff stamps this once, on the first authenticated
-- request, and never touches it again; the screen hides the button once it is
-- set.
-- ---------------------------------------------------------------------------
ALTER TABLE staff ADD COLUMN first_seen_at TEXT;

-- Best-effort backfill so the change reflects reality on day one instead of
-- waiting for each person to sign in again. Performing an audited action is
-- only possible once signed in, so the earliest audit row for a person is a
-- safe lower bound on their first login. This can only ADD a stamp for someone
-- provably signed in; anyone who has never acted (or only ever viewed pages,
-- which is not audited) stays NULL and is stamped on their next sign-in.
UPDATE staff
   SET first_seen_at = (
     SELECT MIN(a.at) FROM audit_log a WHERE a.actor = staff.email_norm
   )
 WHERE first_seen_at IS NULL
   AND EXISTS (SELECT 1 FROM audit_log a WHERE a.actor = staff.email_norm);
