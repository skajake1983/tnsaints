-- Migration 020 — Stripe (owner's decision, 2026-10-07)
--
-- ORDER: schema.sql, then 001..019, then this.
--
--   npx wrangler d1 execute tnsaints --local  --file=./migrations/020_stripe.sql
--   npx wrangler d1 execute tnsaints --remote --file=./migrations/020_stripe.sql
--
-- Stripe takes over from PayPal for everything families pay: the academy's
-- monthly fee, camps and clinics. PayPal keeps working until every family has
-- moved, so both live side by side for a while; which one a new payment uses
-- is the app setting 'payments.provider' (Admin -> Billing).
--
-- Environments: Stripe's test mode ("sandbox") and live mode are kept apart
-- the same way as PayPal's, with the same two words, so a test payment can
-- never activate a live place.
--
-- The CREATE statements are IF NOT EXISTS. The ALTERs come last, so a re-run
-- that stops on "duplicate column name" has already applied everything.

-- One Stripe customer per family per environment. Only the paying guardian's
-- name and email go to Stripe — never a child's.
CREATE TABLE IF NOT EXISTS stripe_customers (
  household_id  INTEGER NOT NULL REFERENCES households(id),
  environment   TEXT    NOT NULL CHECK (environment IN ('live', 'sandbox')),
  customer_id   TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  PRIMARY KEY (household_id, environment)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_customer_id ON stripe_customers (environment, customer_id);

-- Every Checkout Session started from the portal, so one the family never
-- came back from (closed the tab) is still found and finished by the sweep.
CREATE TABLE IF NOT EXISTS stripe_checkouts (
  session_id     TEXT    PRIMARY KEY,
  environment    TEXT    NOT NULL CHECK (environment IN ('live', 'sandbox')),
  enrollment_id  INTEGER NOT NULL REFERENCES enrollments(id),
  household_id   INTEGER NOT NULL REFERENCES households(id),
  -- place: paying for an offered place; move: an existing place moving from
  -- PayPal; one_time: a camp or clinic.
  purpose        TEXT    NOT NULL CHECK (purpose IN ('place', 'move', 'one_time')),
  status         TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'complete', 'expired')),
  created_by     TEXT    NOT NULL,
  created_at     TEXT    NOT NULL,
  completed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_stripe_checkouts_open ON stripe_checkouts (status, created_at);
CREATE INDEX IF NOT EXISTS idx_stripe_checkouts_enrollment ON stripe_checkouts (enrollment_id);

-- Stripe subscriptions as last read from Stripe (statuses are Stripe's own:
-- incomplete, incomplete_expired, trialing, active, past_due, canceled,
-- unpaid, paused).
CREATE TABLE IF NOT EXISTS stripe_subscriptions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id       TEXT    NOT NULL,
  environment           TEXT    NOT NULL CHECK (environment IN ('live', 'sandbox')),
  enrollment_id         INTEGER REFERENCES enrollments(id),
  household_id          INTEGER REFERENCES households(id),
  customer_id           TEXT,
  status                TEXT    NOT NULL,
  cancel_at_period_end  INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
  current_period_end    TEXT,
  -- The coupon on the subscription, as we last set or read it (sibling and
  -- scholarship discounts combine into one percentage).
  coupon_id             TEXT,
  last_synced_at        TEXT,
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_subscription_id ON stripe_subscriptions (environment, subscription_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stripe_one_live_per_enrollment
  ON stripe_subscriptions (enrollment_id)
  WHERE enrollment_id IS NOT NULL AND status IN ('incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'paused');
CREATE INDEX IF NOT EXISTS idx_stripe_subscriptions_household ON stripe_subscriptions (household_id);
CREATE INDEX IF NOT EXISTS idx_stripe_subscriptions_sync ON stripe_subscriptions (last_synced_at);

-- Webhook events, for idempotency. Identifiers only: the event body (which
-- holds the payer's name and email) is never stored.
CREATE TABLE IF NOT EXISTS stripe_events (
  event_id      TEXT    PRIMARY KEY,
  environment   TEXT    NOT NULL CHECK (environment IN ('live', 'sandbox')),
  event_type    TEXT    NOT NULL,
  object_id     TEXT,
  received_at   TEXT    NOT NULL,
  processed_at  TEXT,
  outcome       TEXT    CHECK (outcome IN ('synced', 'ignored', 'error')),
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_stripe_events_received ON stripe_events (received_at);

-- Payments from both providers share one table (retention, exports and the
-- CRM read it). For a Stripe payment, paypal_transaction_id holds Stripe's id
-- (an invoice, or "<invoice>:setup" for the setup-fee part of a first invoice,
-- or a charge for a refund): the column predates Stripe.
ALTER TABLE payments ADD COLUMN provider TEXT NOT NULL DEFAULT 'paypal' CHECK (provider IN ('paypal', 'stripe'));

-- A Stripe product per program per environment (prices are given inline from
-- the program's own price; the product is what a sibling coupon applies to).
ALTER TABLE programs ADD COLUMN stripe_product_sandbox TEXT;
ALTER TABLE programs ADD COLUMN stripe_product_live TEXT;

-- Per place: a scholarship (percent off the monthly fee, set by an admin);
-- for a family moving from PayPal, the last day their PayPal payments cover
-- (the first Stripe charge is the 1st after it) and when staff cancelled the
-- PayPal subscription.
ALTER TABLE enrollments ADD COLUMN scholarship_percent INTEGER CHECK (scholarship_percent IS NULL OR scholarship_percent BETWEEN 1 AND 100);
ALTER TABLE enrollments ADD COLUMN outside_paid_through TEXT;
ALTER TABLE enrollments ADD COLUMN paypal_cancelled_at TEXT;
