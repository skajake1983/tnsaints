-- Migration 013 — CRM screens: the activity timeline, and the CRM's one
-- overlay on portal families
--
-- ORDER: schema.sql, then 001..012, then this.
--
--   npx wrangler d1 execute tnsaints --local  --file=./migrations/013_crm_screens.sql
--   npx wrangler d1 execute tnsaints --remote --file=./migrations/013_crm_screens.sql
--
-- Every statement is IF NOT EXISTS, so re-running is safe.

-- ---------------------------------------------------------------------------
-- The timeline: what staff did and what the system noticed, per contact or
-- per family. Staff text (`body`) lives here and NEVER in audit_log, which
-- holds identifiers only. `detail` is JSON of identifiers and stage names.
--   note / call / email / text / meeting   logged by staff
--   stage      a card moved (detail: from, to, via)
--   linked     a contact matched a portal family
--   enrolled   a card closed as won because the child is enrolled
--   merge      another contact was merged into this one
--   import     created from a past evaluation registration
--   dnc        do-not-contact turned on or off
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_activities (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT    NOT NULL CHECK (kind IN
                    ('note', 'call', 'email', 'text', 'meeting', 'stage', 'linked', 'enrolled', 'merge', 'import', 'dnc')),
  body            TEXT,
  detail          TEXT,
  contact_id      INTEGER REFERENCES crm_contacts(id),
  household_id    INTEGER REFERENCES households(id),
  opportunity_id  INTEGER REFERENCES crm_opportunities(id),
  -- Staff email, or 'system' for the reconcile job.
  actor           TEXT    NOT NULL,
  -- When it happened (a call logged afterwards keeps the call's date).
  occurred_at     TEXT    NOT NULL,
  created_at      TEXT    NOT NULL,
  CHECK (contact_id IS NOT NULL OR household_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_crm_activities_contact ON crm_activities (contact_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_crm_activities_household ON crm_activities (household_id, occurred_at);

-- ---------------------------------------------------------------------------
-- The only CRM data kept about a portal family: who on staff looks after
-- them, and whether they asked not to be contacted. Everything else about a
-- family is read live from the portal tables.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_household_meta (
  household_id    INTEGER PRIMARY KEY REFERENCES households(id),
  owner_email     TEXT,
  do_not_contact  INTEGER NOT NULL DEFAULT 0 CHECK (do_not_contact IN (0, 1)),
  updated_by      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

-- Lookups the screens and the reconcile job make.
CREATE INDEX IF NOT EXISTS idx_crm_opps_player ON crm_opportunities (player_id);
CREATE INDEX IF NOT EXISTS idx_crm_opps_household ON crm_opportunities (household_id);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_contact ON crm_tasks (contact_id, status);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_household ON crm_tasks (household_id, status);
CREATE INDEX IF NOT EXISTS idx_crm_prospects_player ON crm_prospect_players (player_id);
