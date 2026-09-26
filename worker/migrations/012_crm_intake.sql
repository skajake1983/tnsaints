-- Migration 012 — CRM intake: contacts, inquiries, prospect children,
-- pipeline cards and follow-up tasks
--
-- ORDER: schema.sql, then 001..011, then this.
--
--   npx wrangler d1 execute tnsaints --local  --file=./migrations/012_crm_intake.sql
--   npx wrangler d1 execute tnsaints --remote --file=./migrations/012_crm_intake.sql
--
-- Every statement is IF NOT EXISTS / OR IGNORE, so re-running is safe.
--
-- PRINCIPLE: the CRM tracks relationships and work, not a second copy of
-- customer data. A lead's details live in crm_contacts only until the family
-- has a portal account; then the household is authoritative, and the contact's
-- copies of name, email and phone are cleared (status 'converted'). Staff
-- notes and call logs (crm_activities, with the CRM screens) never go in
-- audit_log.
--
-- Written by website lead capture (POST /api/lead) from Phase 1, so the
-- pipeline fills before the CRM screens exist.

-- ---------------------------------------------------------------------------
-- Pipelines are data. Adding a stage is an INSERT, not a deploy.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_stages (
  pipeline  TEXT    NOT NULL CHECK (pipeline IN ('family', 'coach', 'volunteer', 'sponsor', 'donor')),
  stage     TEXT    NOT NULL,
  label     TEXT    NOT NULL,
  position  INTEGER NOT NULL,
  -- NULL for stages still in progress.
  outcome   TEXT    CHECK (outcome IN ('won', 'paused', 'lost')),
  PRIMARY KEY (pipeline, stage)
);

INSERT OR IGNORE INTO crm_stages (pipeline, stage, label, position, outcome) VALUES
  -- One card per child.
  ('family', 'new',             'New',                    10, NULL),
  ('family', 'contacted',       'Contacted',              20, NULL),
  ('family', 'eval_registered', 'Evaluation registered',  30, NULL),
  ('family', 'eval_attended',   'Evaluation attended',    40, NULL),
  ('family', 'applied',         'Applied',                50, NULL),
  ('family', 'offered',         'Offered a seat',         60, NULL),
  ('family', 'enrolled',        'Enrolled',               70, 'won'),
  ('family', 'not_now',         'Not now',                80, 'paused'),
  ('family', 'lost',            'Lost',                   90, 'lost'),

  ('coach', 'new',              'New',                    10, NULL),
  ('coach', 'contacted',        'Contacted',              20, NULL),
  ('coach', 'conversation',     'In conversation',        30, NULL),
  ('coach', 'clearance',        'Background check & training', 40, NULL),
  ('coach', 'onboarded',        'Onboarded',              50, 'won'),
  ('coach', 'not_now',          'Not now',                80, 'paused'),
  ('coach', 'lost',             'Lost',                   90, 'lost'),

  ('volunteer', 'new',          'New',                    10, NULL),
  ('volunteer', 'contacted',    'Contacted',              20, NULL),
  ('volunteer', 'conversation', 'In conversation',        30, NULL),
  ('volunteer', 'clearance',    'Background check & training', 40, NULL),
  ('volunteer', 'onboarded',    'Onboarded',              50, 'won'),
  ('volunteer', 'not_now',      'Not now',                80, 'paused'),
  ('volunteer', 'lost',         'Lost',                   90, 'lost'),

  ('sponsor', 'new',            'New',                    10, NULL),
  ('sponsor', 'contacted',      'Contacted',              20, NULL),
  ('sponsor', 'proposal',       'Proposal sent',          30, NULL),
  ('sponsor', 'committed',      'Committed',              40, NULL),
  ('sponsor', 'fulfilled',      'Fulfilled',              50, 'won'),
  ('sponsor', 'not_now',        'Not now',                80, 'paused'),
  ('sponsor', 'lost',           'Lost',                   90, 'lost'),

  -- Used only once the IRS determination letter exists (plan phase D1).
  ('donor', 'new',              'New',                    10, NULL),
  ('donor', 'contacted',        'Contacted',              20, NULL),
  ('donor', 'cultivating',      'Cultivating',            30, NULL),
  ('donor', 'pledged',          'Pledged',                40, NULL),
  ('donor', 'gave',             'Gave',                   50, 'won'),
  ('donor', 'not_now',          'Not now',                80, 'paused'),
  ('donor', 'lost',             'Lost',                   90, 'lost');

-- ---------------------------------------------------------------------------
-- People who are not (yet) portal families: leads, coaches, volunteers,
-- sponsors. One row per person, found by normalized email.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_contacts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT    NOT NULL CHECK (kind IN
                    ('family', 'coach', 'volunteer', 'sponsor', 'donor', 'other')),
  name            TEXT,
  email           TEXT,
  email_norm      TEXT,
  phone           TEXT,
  -- Digits only. A phone match only SUGGESTS a duplicate; families share
  -- phones, so it never merges anything by itself.
  phone_norm      TEXT,
  organization    TEXT,
  owner_email     TEXT,
  -- 'website:player', 'import:2026-08-29-evaluation', 'manual', ...
  source          TEXT    NOT NULL,
  household_id    INTEGER REFERENCES households(id),
  account_id      INTEGER REFERENCES accounts(id),
  do_not_contact  INTEGER NOT NULL DEFAULT 0 CHECK (do_not_contact IN (0, 1)),
  -- converted/merged/anonymized rows have their name, email and phone cleared.
  status          TEXT    NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'converted', 'merged', 'anonymized')),
  merged_into_id  INTEGER REFERENCES crm_contacts(id),
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_contacts_email
  ON crm_contacts (email_norm) WHERE email_norm IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_contacts_phone ON crm_contacts (phone_norm);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_household ON crm_contacts (household_id);

-- ---------------------------------------------------------------------------
-- Children named on a lead, before they are players. Minimal on purpose, and
-- short-lived: linked to `players` on conversion, purged if never converted.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_prospect_players (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id         INTEGER NOT NULL REFERENCES crm_contacts(id),
  name               TEXT    NOT NULL,
  grade_level        INTEGER CHECK (grade_level BETWEEN 0 AND 12),
  grade_school_year  INTEGER,
  school             TEXT,
  position           TEXT,
  player_id          INTEGER REFERENCES players(id),
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_crm_prospects_contact ON crm_prospect_players (contact_id);

-- ---------------------------------------------------------------------------
-- Every website form submission. `fields` is JSON of ALLOW-LISTED fields only,
-- validated per purpose; anything else the form sent is dropped. Also drives
-- the leads rate limit and the daily staff brief.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_inquiries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id    INTEGER REFERENCES crm_contacts(id),
  household_id  INTEGER REFERENCES households(id),
  purpose       TEXT    NOT NULL CHECK (purpose IN
                  ('general', 'player', 'coaching', 'sponsor', 'volunteer')),
  fields        TEXT    NOT NULL,
  message       TEXT,
  -- Salted hash, for the rate limit. Nulled after 30 days.
  ip_hash       TEXT,
  received_at   TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'handled', 'spam')),
  handled_by    TEXT,
  handled_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_crm_inquiries_received ON crm_inquiries (received_at);
CREATE INDEX IF NOT EXISTS idx_crm_inquiries_ip ON crm_inquiries (ip_hash, received_at);
CREATE INDEX IF NOT EXISTS idx_crm_inquiries_contact ON crm_inquiries (contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_inquiries_status ON crm_inquiries (status, received_at);

-- ---------------------------------------------------------------------------
-- Pipeline cards. For families, one card per CHILD, because two siblings can
-- be at different stages. At most one open card per prospect child and per
-- player, so an evaluation import or a repeated form cannot duplicate them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_opportunities (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline            TEXT    NOT NULL,
  stage               TEXT    NOT NULL,
  contact_id          INTEGER REFERENCES crm_contacts(id),
  household_id        INTEGER REFERENCES households(id),
  prospect_player_id  INTEGER REFERENCES crm_prospect_players(id),
  player_id           INTEGER REFERENCES players(id),
  owner_email         TEXT,
  source              TEXT,
  opened_at           TEXT    NOT NULL,
  closed_at           TEXT,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  FOREIGN KEY (pipeline, stage) REFERENCES crm_stages (pipeline, stage)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_opps_one_open_prospect
  ON crm_opportunities (prospect_player_id)
  WHERE closed_at IS NULL AND prospect_player_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_opps_one_open_player
  ON crm_opportunities (pipeline, player_id)
  WHERE closed_at IS NULL AND player_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_opps_board ON crm_opportunities (pipeline, stage, closed_at);
CREATE INDEX IF NOT EXISTS idx_crm_opps_contact ON crm_opportunities (contact_id);

-- ---------------------------------------------------------------------------
-- Follow-ups. Due dates are Central calendar dates, because "due Tuesday"
-- means Tuesday in Franklin.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT    NOT NULL,
  due_on        TEXT,
  owner_email   TEXT,
  status        TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  -- 'auto:inquiry', 'manual', ...
  origin        TEXT    NOT NULL,
  contact_id    INTEGER REFERENCES crm_contacts(id),
  household_id  INTEGER REFERENCES households(id),
  inquiry_id    INTEGER REFERENCES crm_inquiries(id),
  created_by    TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  completed_at  TEXT,
  completed_by  TEXT
);

CREATE INDEX IF NOT EXISTS idx_crm_tasks_due ON crm_tasks (status, due_on);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_owner ON crm_tasks (owner_email, status, due_on);
