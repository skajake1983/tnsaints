-- Migration 026 — paying for an event online (camps; tournament entry fees)
--
-- ORDER: schema.sql, then 001..025, then this.
--
--   npx wrangler d1 execute tnsaints --local  --file=./migrations/026_event_payments.sql
--   npx wrangler d1 execute tnsaints --remote --file=./migrations/026_event_payments.sql
--
-- The Events plan (owner, 2026-10-21), phase EV6: a camp (or a tournament
-- that charges an entry fee) can be paid online when the family signs up,
-- through Stripe Checkout, before the place is theirs. Until Stripe is live,
-- events are free or paid at check-in.
--
--   registrations, event_teams
--     payment_state    NULL (free) | at_check_in | pending (held while they pay)
--                      | paid | expired (the hold lapsed unpaid; the place went back)
--     hold_expires_at  when an unpaid hold lets go of the place
--     amount_due_cents what is owed (at check-in, or online)
--   event_checkouts    one Stripe Checkout Session per attempt to pay: which
--                      sign-up it is for, a random reference (never a child's
--                      name: only the parent's email and the event's name go
--                      to Stripe), and how it ended
--   payments           + the sign-up a payment was for
--
-- ALTER-only plus one new table (programs, registrations and event_teams are
-- pointed at by other tables, so none is rebuilt: see 023). A re-run stops at
-- the first ALTER with "duplicate column name".

ALTER TABLE registrations ADD COLUMN payment_state TEXT
  CHECK (payment_state IS NULL OR payment_state IN ('at_check_in', 'pending', 'paid', 'expired'));
ALTER TABLE registrations ADD COLUMN hold_expires_at TEXT;
ALTER TABLE registrations ADD COLUMN amount_due_cents INTEGER CHECK (amount_due_cents IS NULL OR amount_due_cents >= 0);
ALTER TABLE event_teams ADD COLUMN payment_state TEXT
  CHECK (payment_state IS NULL OR payment_state IN ('at_check_in', 'pending', 'paid', 'expired'));
ALTER TABLE event_teams ADD COLUMN hold_expires_at TEXT;
ALTER TABLE event_teams ADD COLUMN amount_due_cents INTEGER CHECK (amount_due_cents IS NULL OR amount_due_cents >= 0);
ALTER TABLE payments ADD COLUMN registration_id INTEGER REFERENCES registrations(id);
ALTER TABLE payments ADD COLUMN event_team_id INTEGER REFERENCES event_teams(id);

CREATE TABLE IF NOT EXISTS event_checkouts (
  session_id       TEXT    PRIMARY KEY,
  environment      TEXT    NOT NULL CHECK (environment IN ('live', 'sandbox')),
  event_id         TEXT    NOT NULL REFERENCES programs(id),
  registration_id  INTEGER REFERENCES registrations(id),
  team_id          INTEGER REFERENCES event_teams(id),
  ref              TEXT    NOT NULL,
  amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
  status           TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'complete', 'expired')),
  created_at       TEXT    NOT NULL,
  completed_at     TEXT,
  CHECK ((registration_id IS NULL) != (team_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_checkouts_ref ON event_checkouts (ref);
CREATE INDEX IF NOT EXISTS idx_registrations_holds ON registrations (payment_state, hold_expires_at);
CREATE INDEX IF NOT EXISTS idx_event_teams_holds ON event_teams (payment_state, hold_expires_at);
