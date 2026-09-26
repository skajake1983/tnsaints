-- Migration 010 — PayPal subscriptions, webhook events, payments
--
-- ORDER: schema.sql, then 001..009, then this.
--
--   npx wrangler d1 execute tnsaints --local  --file=./migrations/010_billing.sql
--   npx wrangler d1 execute tnsaints --remote --file=./migrations/010_billing.sql
--
-- Every statement is IF NOT EXISTS, so re-running is safe.
--
-- NO PAYER PII. PayPal's payloads carry the payer's name, email and address.
-- None of it is stored: these tables hold PayPal's identifiers, statuses and
-- amounts, and link them to an enrollment or household that already holds the
-- family's details. Anything else is fetched live from PayPal when staff look.
--
-- STATE COMES FROM PAYPAL, NEVER FROM THE EVENT. A webhook only says "go and
-- look"; the Worker re-fetches the subscription from PayPal and records what
-- PayPal says now. A forged, replayed or out-of-order event can therefore only
-- cause a harmless re-sync.

-- ---------------------------------------------------------------------------
-- Every PayPal subscription the system has ever seen, linked or not.
-- Unlinked rows are the reconciliation queue: join.html subscribers from
-- before the portal, and anything that arrived by webhook with no enrollment.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_subscriptions (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  paypal_subscription_id  TEXT    NOT NULL,
  environment             TEXT    NOT NULL CHECK (environment IN ('live', 'sandbox')),
  plan_id                 TEXT,
  -- PayPal's own status, mirrored: APPROVAL_PENDING, APPROVED, ACTIVE,
  -- SUSPENDED, CANCELLED, EXPIRED.
  status                  TEXT    NOT NULL,
  -- What we sent as custom_id: an enrollment ref, or 'joinpage'.
  custom_id               TEXT,
  enrollment_id           INTEGER REFERENCES enrollments(id),
  household_id            INTEGER REFERENCES households(id),
  source                  TEXT    NOT NULL CHECK (source IN
                            ('portal', 'joinpage', 'admin_paste', 'webhook', 'parent_claim')),
  next_billing_at         TEXT,
  last_payment_at         TEXT,
  last_synced_at          TEXT,
  linked_by               TEXT,
  linked_at               TEXT,
  created_at              TEXT    NOT NULL,
  updated_at              TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_paypal_id
  ON billing_subscriptions (environment, paypal_subscription_id);

-- One live subscription per enrollment. A cancelled one followed by a new one
-- for the same child is allowed; two paying at once is not.
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_one_live_per_enrollment
  ON billing_subscriptions (enrollment_id)
  WHERE enrollment_id IS NOT NULL
    AND status IN ('APPROVAL_PENDING', 'APPROVED', 'ACTIVE', 'SUSPENDED');

-- The reconciliation queue and the daily "re-sync the stalest" sweep.
CREATE INDEX IF NOT EXISTS idx_billing_unlinked
  ON billing_subscriptions (enrollment_id, household_id, created_at);
CREATE INDEX IF NOT EXISTS idx_billing_sync ON billing_subscriptions (last_synced_at);

-- ---------------------------------------------------------------------------
-- Webhook deliveries, for idempotency. Identifiers only: the raw payload holds
-- payer PII and is never stored.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paypal_events (
  event_id      TEXT    PRIMARY KEY,
  environment   TEXT    NOT NULL CHECK (environment IN ('live', 'sandbox')),
  event_type    TEXT    NOT NULL,
  resource_id   TEXT,
  received_at   TEXT    NOT NULL,
  processed_at  TEXT,
  outcome       TEXT    CHECK (outcome IN ('synced', 'ignored', 'error')),
  error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_paypal_events_received ON paypal_events (received_at);

-- ---------------------------------------------------------------------------
-- Money that actually moved. One row per PayPal transaction.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  paypal_transaction_id    TEXT    NOT NULL,
  environment              TEXT    NOT NULL CHECK (environment IN ('live', 'sandbox')),
  billing_subscription_id  INTEGER REFERENCES billing_subscriptions(id),
  enrollment_id            INTEGER REFERENCES enrollments(id),
  household_id             INTEGER REFERENCES households(id),
  -- Parsed from PayPal's decimal STRING to exact cents. Refunds are negative.
  amount_cents             INTEGER NOT NULL,
  currency                 TEXT    NOT NULL,
  kind                     TEXT    NOT NULL CHECK (kind IN ('setup_fee', 'recurring', 'one_time', 'refund')),
  status                   TEXT    NOT NULL,
  paid_at                  TEXT    NOT NULL,
  created_at               TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_txn
  ON payments (environment, paypal_transaction_id);
CREATE INDEX IF NOT EXISTS idx_payments_household ON payments (household_id, paid_at);
CREATE INDEX IF NOT EXISTS idx_payments_subscription ON payments (billing_subscription_id, paid_at);
