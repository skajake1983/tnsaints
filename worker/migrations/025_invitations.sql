-- Migration 025 — invitations to events, and unsubscribes
--
-- ORDER: schema.sql, then 001..024, then this.
--
--   npx wrangler d1 execute tnsaints --local  --file=./migrations/025_invitations.sql
--   npx wrangler d1 execute tnsaints --remote --file=./migrations/025_invitations.sql
--
-- The Events plan (owner, 2026-10-21), phase EV5: staff invite people from
-- the CRM and from rosters to an event. An invitation is written as a DRAFT
-- campaign; nothing is sent until someone with messages:approve approves it
-- (the owner: no email goes out without their approval), and the sender runs
-- only while INVITES_ENABLED is "true".
--
--   invite_campaigns     one invitation run: the words, who it is for (the
--                        sources chosen, never the addresses), who approved it
--   event_invitations    one row per address per event (an address is never
--                        invited to the same event twice); the token in its
--                        sign-up and unsubscribe links; whether it was sent and
--                        whether that person signed up. The address itself is
--                        cleared by retention after the event; email_hash
--                        (a keyed HMAC) stays, so an unsubscribe still works.
--   email_suppressions   addresses that said "no more invitations", by keyed
--                        hash only: no address is stored, and it survives a
--                        family deleting its data.
--   registrations, event_interest
--                        + invitation_id: the invitation that brought them
--
-- Safe to re-run: the tables are IF NOT EXISTS; the ALTERs come last and stop
-- a re-run there with "duplicate column name".

CREATE TABLE IF NOT EXISTS invite_campaigns (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id      TEXT    NOT NULL REFERENCES programs(id),
  subject       TEXT    NOT NULL CHECK (length(subject) BETWEEN 1 AND 120),
  message       TEXT    NOT NULL CHECK (length(message) BETWEEN 1 AND 1500),
  -- Which sources and filters were chosen (JSON). Never addresses.
  audience      TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'cancelled')),
  created_by    TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  approved_by   TEXT,
  approved_at   TEXT,
  cancelled_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_invite_campaigns_event ON invite_campaigns (event_id, created_at);

CREATE TABLE IF NOT EXISTS event_invitations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id   INTEGER NOT NULL REFERENCES invite_campaigns(id),
  event_id      TEXT    NOT NULL REFERENCES programs(id),
  email         TEXT,
  email_norm    TEXT,
  email_hash    TEXT    NOT NULL,
  name          TEXT,
  contact_id    INTEGER REFERENCES crm_contacts(id),
  token         TEXT    NOT NULL,
  -- held (draft) -> queued (approved) -> sending -> sent | failed; cancelled
  send_state    TEXT    NOT NULL DEFAULT 'held'
                  CHECK (send_state IN ('held', 'queued', 'sending', 'sent', 'failed', 'cancelled')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  sent_at       TEXT,
  registered_at TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_invitations_one ON event_invitations (event_id, email_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_invitations_token ON event_invitations (token);
CREATE INDEX IF NOT EXISTS idx_event_invitations_send ON event_invitations (send_state, campaign_id);
CREATE INDEX IF NOT EXISTS idx_event_invitations_campaign ON event_invitations (campaign_id, send_state);

CREATE TABLE IF NOT EXISTS email_suppressions (
  email_hash    TEXT    PRIMARY KEY,
  reason        TEXT    NOT NULL CHECK (reason IN ('unsubscribe', 'bounce', 'staff')),
  source        TEXT,
  created_at    TEXT    NOT NULL
);

ALTER TABLE registrations ADD COLUMN invitation_id INTEGER REFERENCES event_invitations(id);
ALTER TABLE event_interest ADD COLUMN invitation_id INTEGER REFERENCES event_invitations(id);
