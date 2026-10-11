-- Migration 019 — places staff add for families who already pay outside the portal
--
-- ORDER: schema.sql, then 001..018, then this.
--
--   npx wrangler d1 execute tnsaints --local  --file=./migrations/019_places_paid_outside.sql
--   npx wrangler d1 execute tnsaints --remote --file=./migrations/019_places_paid_outside.sql
--
-- Families already in the academy pay through the old Join page's PayPal
-- button (or by other arrangement). Staff give each child a place directly
-- (Admin -> Families -> Add a place) so the family can sign the waiver and
-- keep its medical and emergency details current in the portal. These two
-- columns say how such a place is paid today, so the move to Stripe can find
-- every one of them and cancel the right PayPal subscription afterwards.
--
--   billed_outside      NULL for a place paid through the portal;
--                       'paypal_join' (the old Join page) or 'other'
--                       (cash, check, scholarship, ...).
--   outside_reference   The PayPal subscription id (I-...), when known.
--
-- ALTER-only: a second run fails with "duplicate column name", which means it
-- was already applied.

ALTER TABLE enrollments ADD COLUMN billed_outside TEXT
  CHECK (billed_outside IS NULL OR billed_outside IN ('paypal_join', 'other'));

ALTER TABLE enrollments ADD COLUMN outside_reference TEXT;
