-- Migration 021 — an invitation that signs the family straight in
--
-- ORDER: schema.sql, then 001..020, then this.
--
--   npx wrangler d1 execute tnsaints --local  --file=./migrations/021_invite_signin.sql
--   npx wrangler d1 execute tnsaints --remote --file=./migrations/021_invite_signin.sql
--
-- Staff inviting a family used to send a plain "go to the portal" email; the
-- family then asked for a sign-in link, a second email for the same proof
-- (owner, 2026-10-20: "very duplicative"). The invitation now carries a
-- one-time sign-in link of its own, purpose 'invite': single use, valid 7
-- days, the token in the URL fragment and stored only as an HMAC, and the
-- landing page inert until "Continue" (auth/magic.js). Co-guardian
-- invitations are unchanged: they open an existing family's children, so the
-- invitee still signs in as the invited address first.
--
-- SQLite cannot widen the purpose CHECK in place, so the table is rebuilt.
-- Nothing references it by foreign key, and its rows are short-lived sign-in
-- links (copied across, so a link already in someone's inbox keeps working).
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS auth_login_tokens_021 (
  token_hash    TEXT    PRIMARY KEY,
  email_norm    TEXT    NOT NULL,
  purpose       TEXT    NOT NULL CHECK (purpose IN ('login', 'link_google', 'invite')),
  binding_hash  TEXT,
  created_at    TEXT    NOT NULL,
  expires_at    TEXT    NOT NULL,
  consumed_at   TEXT
);

INSERT OR IGNORE INTO auth_login_tokens_021 (token_hash, email_norm, purpose, binding_hash, created_at, expires_at, consumed_at)
SELECT token_hash, email_norm, purpose, binding_hash, created_at, expires_at, consumed_at FROM auth_login_tokens;

DROP TABLE auth_login_tokens;

ALTER TABLE auth_login_tokens_021 RENAME TO auth_login_tokens;

CREATE INDEX IF NOT EXISTS idx_login_tokens_expiry ON auth_login_tokens (expires_at);
