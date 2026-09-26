-- Migration 007 — parent accounts, sign-in, sessions, households, medical
--
-- ORDER: schema.sql, then 001..006, then this.
--
--   npx wrangler d1 execute tnsaints --local  --file=./migrations/007_identity_households.sql
--   npx wrangler d1 execute tnsaints --remote --file=./migrations/007_identity_households.sql
--
-- Every statement is IF NOT EXISTS, so re-running is safe. Nothing reads these
-- tables until the portal ships behind PORTAL_ENABLED.
--
-- NUMBERING. The portal plan reserved 007 for per-lane email budget tables.
-- Those were dropped: the lanes fold into one conditional upsert on the
-- existing email_budget table (src/email-budget.js), because an extra query per
-- send would push the batch drain past D1's 50-queries-per-invocation limit.
-- The rest of the plan's migrations moved up one number.
--
-- CONVENTIONS for everything below:
--   - Timestamps are ISO-8601 UTC text, like the rest of the schema.
--   - Every secret (sign-in token, session id, invite token, OIDC state) is
--     stored only as an HMAC keyed with AUTH_PEPPER, never raw. A database
--     leak alone cannot sign anyone in, and rotating the pepper invalidates
--     every outstanding one at once.
--   - Emails are keyed by `email_norm` = lower(trim(email)), exactly as
--     registrations.parent_email_norm and staff.email_norm, so the three can be
--     joined without a second normalisation that might disagree.
--   - Parents appear in audit_log as `account:<id>`, never by address.

-- ---------------------------------------------------------------------------
-- A parent's login. One per email address. Not staff: staff live in `staff`,
-- behind Cloudflare Access, and nothing here grants any admin capability.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL,
  email_norm    TEXT    NOT NULL,
  display_name  TEXT,
  status        TEXT    NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'disabled', 'deleted')),
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  last_login_at TEXT
);

-- Deleting an account overwrites email_norm with 'deleted:<id>', so the
-- address is free to sign up again and this index stays total.
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email ON accounts (email_norm);

-- ---------------------------------------------------------------------------
-- The ways an account can prove who it is. `subject` is the email_norm for
-- magic links and Google's stable `sub` for Google — never Google's email
-- claim, which can change hands (a recycled Workspace address).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_identities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  provider      TEXT    NOT NULL CHECK (provider IN ('email', 'google')),
  subject       TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  last_used_at  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_identities_subject
  ON account_identities (provider, subject);
CREATE INDEX IF NOT EXISTS idx_identities_account
  ON account_identities (account_id);

-- ---------------------------------------------------------------------------
-- Magic-link tokens. 15 minutes, single use. `binding_hash` ties the link to
-- the browser that asked for it; opened elsewhere, the page asks "you're signing
-- in as j•••@gmail.com — continue?" instead of signing in silently (login CSRF).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_login_tokens (
  token_hash    TEXT    PRIMARY KEY,
  email_norm    TEXT    NOT NULL,
  purpose       TEXT    NOT NULL CHECK (purpose IN ('login', 'link_google')),
  binding_hash  TEXT,
  created_at    TEXT    NOT NULL,
  expires_at    TEXT    NOT NULL,
  consumed_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_login_tokens_expiry ON auth_login_tokens (expires_at);

-- ---------------------------------------------------------------------------
-- In-flight "Sign in with Google" attempts. 10 minutes, single use. The PKCE
-- verifier is not stored: it is derived from the browser's flow cookie and
-- AUTH_PEPPER, so a database read alone cannot complete a stolen flow.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_oidc_flows (
  state_hash    TEXT    PRIMARY KEY,
  nonce_hash    TEXT    NOT NULL,
  binding_hash  TEXT    NOT NULL,
  return_to     TEXT,
  created_at    TEXT    NOT NULL,
  expires_at    TEXT    NOT NULL,
  consumed_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_oidc_flows_expiry ON auth_oidc_flows (expires_at);

-- ---------------------------------------------------------------------------
-- Signed-in browsers. The cookie carries the session id; only its HMAC is here.
-- 14 days idle, 30 days absolute (tunable). `auth_at` is the last time the
-- person actually proved who they are — export, deletion, invites and claiming
-- a subscription require it within the last 12 hours.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id_hash              TEXT    PRIMARY KEY,
  account_id           INTEGER NOT NULL REFERENCES accounts(id),
  auth_method          TEXT    NOT NULL CHECK (auth_method IN ('email', 'google')),
  auth_at              TEXT    NOT NULL,
  created_at           TEXT    NOT NULL,
  last_seen_at         TEXT    NOT NULL,
  idle_expires_at      TEXT    NOT NULL,
  absolute_expires_at  TEXT    NOT NULL,
  -- Coarse, for the device list ("Safari on iPhone"). Never the raw User-Agent.
  device_label         TEXT,
  revoked_at           TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions (account_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (absolute_expires_at);

-- ---------------------------------------------------------------------------
-- Fixed-window rate limits. One atomic upsert per check. `key_hash` is an HMAC
-- of scope + subject, so no email address or IP is stored here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limits (
  key_hash      TEXT    NOT NULL,
  window_start  TEXT    NOT NULL,
  hits          INTEGER NOT NULL,
  expires_at    TEXT    NOT NULL,
  PRIMARY KEY (key_hash, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_expiry ON rate_limits (expires_at);

-- ---------------------------------------------------------------------------
-- A family. Children belong to a household, never directly to an account, so a
-- second guardian sees the same children and a guardian leaving does not orphan
-- anyone's records.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS households (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name  TEXT,
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- THE AUTHORIZATION TABLE for the portal. Every portal query that touches a
-- child, enrollment, consent or payment embeds
--     household_id IN (SELECT household_id FROM household_members WHERE account_id = ?)
-- in the same statement (src/portal/data.js). A row here is what "this is my
-- family" means; nothing else grants it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS household_members (
  household_id  INTEGER NOT NULL REFERENCES households(id),
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  role          TEXT    NOT NULL CHECK (role IN ('owner', 'guardian')),
  relationship  TEXT,
  phone         TEXT,
  created_at    TEXT    NOT NULL,
  PRIMARY KEY (household_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_household_members_account
  ON household_members (account_id, household_id);

-- ---------------------------------------------------------------------------
-- Co-guardian invitations. 7 days. Accepting requires signing in as the
-- invited address, which proves the invitee controls that mailbox.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS household_invites (
  token_hash            TEXT    PRIMARY KEY,
  household_id          INTEGER NOT NULL REFERENCES households(id),
  invited_email_norm    TEXT    NOT NULL,
  invited_by_account_id INTEGER NOT NULL REFERENCES accounts(id),
  created_at            TEXT    NOT NULL,
  expires_at            TEXT    NOT NULL,
  accepted_at           TEXT,
  accepted_account_id   INTEGER REFERENCES accounts(id),
  revoked_at            TEXT
);

CREATE INDEX IF NOT EXISTS idx_household_invites_household
  ON household_invites (household_id);

-- ---------------------------------------------------------------------------
-- Emergency contacts, per household, up to three in order of who to call.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS household_emergency_contacts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id  INTEGER NOT NULL REFERENCES households(id),
  priority      INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 3),
  name          TEXT    NOT NULL,
  phone         TEXT    NOT NULL,
  relationship  TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_emergency_contacts_order
  ON household_emergency_contacts (household_id, priority);

-- ---------------------------------------------------------------------------
-- A child's medical information — the most sensitive row in the database.
--
-- Its own table, one row per child, so that reading it is always a deliberate,
-- audited query (the roster reveal pattern) and never rides along with a SELECT
-- of the player. Coaches see only whether one exists.
--
-- "Nothing to declare" is an affirmative answer, not a blank: a missing row
-- means the parent has not answered, and enrollment requires an answer.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS player_medical (
  player_id     INTEGER PRIMARY KEY REFERENCES players(id),
  status        TEXT    NOT NULL CHECK (status IN ('none_declared', 'declared')),
  notes         TEXT,
  -- `account:<id>` or a staff email. Identifier only.
  updated_by    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  -- Last time a guardian confirmed it is still current (re-asked each season).
  confirmed_at  TEXT    NOT NULL,
  CHECK (
    (status = 'none_declared' AND notes IS NULL) OR
    (status = 'declared' AND notes IS NOT NULL AND length(trim(notes)) > 0)
  )
);

-- ---------------------------------------------------------------------------
-- Privacy requests (export, deletion), one design for portal families and CRM
-- leads. `result_counts` records how many rows of each class were exported or
-- purged — counts only, never the data.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS data_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT    NOT NULL CHECK (kind IN ('export', 'deletion')),
  subject_type    TEXT    NOT NULL CHECK (subject_type IN ('household', 'lead')),
  subject_id      TEXT    NOT NULL,
  requested_by    TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'received' CHECK (status IN
                    ('received', 'verified', 'scheduled', 'completed', 'rejected', 'cancelled')),
  -- How identity was established: 'recent_sign_in', 'staff_verified', ...
  verification    TEXT,
  purge_after     TEXT,
  result_counts   TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  completed_at    TEXT,
  completed_by    TEXT
);

CREATE INDEX IF NOT EXISTS idx_data_requests_status ON data_requests (status, created_at);
