-- Migration 017 — Donations: records, frozen acknowledgment receipts, annual
-- summaries
--
-- ORDER: schema.sql, then 001..016, then this.
--
--   npx wrangler d1 execute tnsaints --local  --file=./migrations/017_donations.sql
--   npx wrangler d1 execute tnsaints --remote --file=./migrations/017_donations.sql
--
-- Every statement is IF NOT EXISTS, so re-running is safe.
--
-- FOR AFTER THE IRS DETERMINATION LETTER. Receipts cannot be issued until
-- DONATIONS_ENABLED is "true" and the organisation's legal name, EIN and
-- determination date are entered (src/donations/donations.js).
--
-- PROGRAM FEES ARE NEVER DONATIONS. Donations are their own table with no link
-- to payments, and nothing moves a payment here: a family's fee for a place is
-- not tax-deductible, and no screen can make it look so.

CREATE TABLE IF NOT EXISTS donations (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The donor: a CRM contact (kind 'donor', 'sponsor' or any) or a portal family.
  contact_id                  INTEGER REFERENCES crm_contacts(id),
  household_id                INTEGER REFERENCES households(id),
  -- The donor's name and address as they should appear on the receipt, kept
  -- here because a receipt must stay true to the day it was issued.
  donor_name                  TEXT    NOT NULL,
  donor_address               TEXT,
  received_on                 TEXT    NOT NULL,
  kind                        TEXT    NOT NULL CHECK (kind IN ('cash', 'noncash')),
  -- Cash (any money: check, card, PayPal) in cents. Non-cash gifts are
  -- DESCRIBED, never valued by the academy — valuing them is the donor's job.
  amount_cents                INTEGER CHECK (amount_cents IS NULL OR amount_cents > 0),
  noncash_description         TEXT,
  method                      TEXT    CHECK (method IN ('check', 'cash', 'card', 'paypal', 'transfer', 'other')),
  -- Quid pro quo: what the donor received in return (a dinner ticket, a
  -- banner), and the academy's good-faith estimate of its value.
  goods_services_cents        INTEGER NOT NULL DEFAULT 0 CHECK (goods_services_cents >= 0),
  goods_services_description  TEXT,
  restricted_purpose          TEXT,
  notes                       TEXT,
  receipt_number              TEXT    UNIQUE,
  receipt_issued_at           TEXT,
  receipt_text                TEXT,
  voided_at                   TEXT,
  void_reason                 TEXT,
  recorded_by                 TEXT    NOT NULL,
  created_at                  TEXT    NOT NULL,
  updated_at                  TEXT    NOT NULL,
  CHECK (kind != 'cash' OR amount_cents IS NOT NULL),
  CHECK (kind != 'noncash' OR (noncash_description IS NOT NULL AND length(trim(noncash_description)) > 0)),
  CHECK (goods_services_cents = 0 OR (goods_services_description IS NOT NULL AND length(trim(goods_services_description)) > 0)),
  CHECK (voided_at IS NULL OR (void_reason IS NOT NULL AND length(trim(void_reason)) > 0))
);

CREATE INDEX IF NOT EXISTS idx_donations_received ON donations (received_on);
CREATE INDEX IF NOT EXISTS idx_donations_contact ON donations (contact_id);
CREATE INDEX IF NOT EXISTS idx_donations_household ON donations (household_id);

-- An issued receipt is frozen: what the donor was told is the record. A
-- mistake is corrected by voiding (with a reason) and recording again.
CREATE TRIGGER IF NOT EXISTS donations_receipt_frozen
BEFORE UPDATE OF donor_name, donor_address, received_on, kind, amount_cents, noncash_description, goods_services_cents,
                 goods_services_description, restricted_purpose, receipt_number, receipt_issued_at, receipt_text
ON donations
WHEN OLD.receipt_issued_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'an issued receipt is frozen; void it and record the gift again');
END;

CREATE TRIGGER IF NOT EXISTS donations_no_delete
BEFORE DELETE ON donations
WHEN OLD.receipt_issued_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a donation with an issued receipt cannot be deleted; void it');
END;
