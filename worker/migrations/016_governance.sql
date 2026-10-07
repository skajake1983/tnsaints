-- Migration 016 — Non-profit governance: the board, its meetings, motions and
-- votes, minutes, action items, documents, conflict-of-interest disclosures,
-- and the compliance calendar
--
-- ORDER: schema.sql, then 001..015, then this.
--
--   npx wrangler d1 execute tnsaints --local  --file=./migrations/016_governance.sql
--   npx wrangler d1 execute tnsaints --remote --file=./migrations/016_governance.sql
--
-- Every statement is IF NOT EXISTS / OR IGNORE, so re-running is safe.
-- Nothing here holds children's data: the board role sees none.

-- Board members, per term. They sign in like staff (Cloudflare Access + the
-- staff list, role 'board'); this table is who serves, in what office, when.
CREATE TABLE IF NOT EXISTS board_members (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  office      TEXT    NOT NULL CHECK (office IN ('chair', 'vice_chair', 'secretary', 'treasurer', 'director')),
  voting      INTEGER NOT NULL DEFAULT 1 CHECK (voting IN (0, 1)),
  term_start  TEXT    NOT NULL,
  term_end    TEXT,
  ended_at    TEXT,
  created_by  TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  CHECK (term_end IS NULL OR term_end > term_start)
);
CREATE INDEX IF NOT EXISTS idx_board_members_email ON board_members (email);

-- Meetings. Minutes move draft -> circulated -> approved, and approved
-- minutes are LOCKED (triggers below): the record of what the board decided
-- is not edited afterwards. A correction is a motion at the next meeting.
CREATE TABLE IF NOT EXISTS board_meetings (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                 TEXT    NOT NULL CHECK (kind IN ('regular', 'special', 'annual', 'committee')),
  title                TEXT    NOT NULL,
  starts_at            TEXT    NOT NULL,
  location             TEXT,
  agenda               TEXT,
  status               TEXT    NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'held', 'cancelled')),
  -- Snapshot when attendance is taken: voting members serving, and how many
  -- of them were present (in person or remote).
  voting_members       INTEGER,
  quorum_present       INTEGER,
  minutes              TEXT,
  minutes_status       TEXT    NOT NULL DEFAULT 'none'
                         CHECK (minutes_status IN ('none', 'draft', 'circulated', 'approved')),
  minutes_approved_at  TEXT,
  minutes_approved_by  TEXT,
  created_by           TEXT    NOT NULL,
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_board_meetings_starts ON board_meetings (starts_at);

CREATE TRIGGER IF NOT EXISTS board_minutes_locked
BEFORE UPDATE OF minutes, minutes_status, minutes_approved_at, minutes_approved_by ON board_meetings
WHEN OLD.minutes_status = 'approved'
BEGIN
  SELECT RAISE(ABORT, 'approved minutes are locked; record a correction at the next meeting');
END;

CREATE TABLE IF NOT EXISTS meeting_attendance (
  meeting_id       INTEGER NOT NULL REFERENCES board_meetings(id),
  board_member_id  INTEGER NOT NULL REFERENCES board_members(id),
  status           TEXT    NOT NULL CHECK (status IN ('present', 'remote', 'absent', 'excused')),
  recorded_by      TEXT    NOT NULL,
  recorded_at      TEXT    NOT NULL,
  PRIMARY KEY (meeting_id, board_member_id)
);

-- Motions and roll-call votes. A recusal is recorded with its reason, so a
-- conflict of interest shows in the record.
CREATE TABLE IF NOT EXISTS board_motions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id    INTEGER NOT NULL REFERENCES board_meetings(id),
  title         TEXT    NOT NULL,
  body          TEXT,
  moved_by      INTEGER REFERENCES board_members(id),
  seconded_by   INTEGER REFERENCES board_members(id),
  status        TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'carried', 'failed', 'withdrawn', 'tabled')),
  decided_at    TEXT,
  created_by    TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_board_motions_meeting ON board_motions (meeting_id);

CREATE TABLE IF NOT EXISTS motion_votes (
  motion_id        INTEGER NOT NULL REFERENCES board_motions(id),
  board_member_id  INTEGER NOT NULL REFERENCES board_members(id),
  vote             TEXT    NOT NULL CHECK (vote IN ('yes', 'no', 'abstain', 'recused')),
  recusal_reason   TEXT,
  recorded_by      TEXT    NOT NULL,
  recorded_at      TEXT    NOT NULL,
  PRIMARY KEY (motion_id, board_member_id),
  CHECK (vote != 'recused' OR (recusal_reason IS NOT NULL AND length(trim(recusal_reason)) > 0))
);

-- A decided motion's votes are the record too.
CREATE TRIGGER IF NOT EXISTS motion_votes_locked_update
BEFORE UPDATE ON motion_votes
WHEN (SELECT status FROM board_motions WHERE id = OLD.motion_id) != 'pending'
BEGIN
  SELECT RAISE(ABORT, 'votes on a decided motion are locked');
END;
CREATE TRIGGER IF NOT EXISTS motion_votes_locked_insert
BEFORE INSERT ON motion_votes
WHEN (SELECT status FROM board_motions WHERE id = NEW.motion_id) != 'pending'
BEGIN
  SELECT RAISE(ABORT, 'votes on a decided motion are locked');
END;

-- Approved minutes close the meeting's record: its attendance, quorum,
-- motions and votes cannot change afterwards either.
CREATE TRIGGER IF NOT EXISTS board_meeting_record_locked
BEFORE UPDATE OF voting_members, quorum_present, status ON board_meetings
WHEN OLD.minutes_status = 'approved'
BEGIN
  SELECT RAISE(ABORT, 'the record of a meeting with approved minutes is locked');
END;
CREATE TRIGGER IF NOT EXISTS meeting_attendance_locked_insert
BEFORE INSERT ON meeting_attendance
WHEN (SELECT minutes_status FROM board_meetings WHERE id = NEW.meeting_id) = 'approved'
BEGIN
  SELECT RAISE(ABORT, 'the record of a meeting with approved minutes is locked');
END;
CREATE TRIGGER IF NOT EXISTS meeting_attendance_locked_update
BEFORE UPDATE ON meeting_attendance
WHEN (SELECT minutes_status FROM board_meetings WHERE id = OLD.meeting_id) = 'approved'
BEGIN
  SELECT RAISE(ABORT, 'the record of a meeting with approved minutes is locked');
END;
CREATE TRIGGER IF NOT EXISTS board_motions_locked_insert
BEFORE INSERT ON board_motions
WHEN (SELECT minutes_status FROM board_meetings WHERE id = NEW.meeting_id) = 'approved'
BEGIN
  SELECT RAISE(ABORT, 'the record of a meeting with approved minutes is locked');
END;
CREATE TRIGGER IF NOT EXISTS board_motions_locked_update
BEFORE UPDATE ON board_motions
WHEN (SELECT minutes_status FROM board_meetings WHERE id = OLD.meeting_id) = 'approved'
BEGIN
  SELECT RAISE(ABORT, 'the record of a meeting with approved minutes is locked');
END;
CREATE TRIGGER IF NOT EXISTS motion_votes_meeting_locked
BEFORE INSERT ON motion_votes
WHEN (SELECT me.minutes_status FROM board_motions mo JOIN board_meetings me ON me.id = mo.meeting_id
       WHERE mo.id = NEW.motion_id) = 'approved'
BEGIN
  SELECT RAISE(ABORT, 'the record of a meeting with approved minutes is locked');
END;

CREATE TABLE IF NOT EXISTS board_action_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id    INTEGER REFERENCES board_meetings(id),
  title         TEXT    NOT NULL,
  owner_email   TEXT,
  due_on        TEXT,
  status        TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dropped')),
  created_by    TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  completed_at  TEXT,
  completed_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_board_actions_status ON board_action_items (status, due_on);

-- Documents stay in SharePoint (owner's decision); this is the register of
-- links, limited to allowed hosts.
CREATE TABLE IF NOT EXISTS board_documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT    NOT NULL,
  category     TEXT    NOT NULL CHECK (category IN
                 ('bylaws', 'policy', 'minutes', 'financials', 'filings', 'insurance', 'other')),
  url          TEXT    NOT NULL,
  effective_on TEXT,
  notes        TEXT,
  added_by     TEXT    NOT NULL,
  added_at     TEXT    NOT NULL,
  archived_at  TEXT,
  archived_by  TEXT
);

-- Annual conflict-of-interest disclosures, one per member per year, signed.
CREATE TABLE IF NOT EXISTS coi_disclosures (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  board_member_id  INTEGER NOT NULL REFERENCES board_members(id),
  year             INTEGER NOT NULL CHECK (year BETWEEN 2020 AND 2100),
  has_conflicts    INTEGER NOT NULL CHECK (has_conflicts IN (0, 1)),
  details          TEXT,
  signature        TEXT    NOT NULL CHECK (length(trim(signature)) > 0),
  signed_at        TEXT    NOT NULL,
  UNIQUE (board_member_id, year),
  CHECK (has_conflicts = 0 OR (details IS NOT NULL AND length(trim(details)) > 0))
);

-- The compliance calendar. Recurring items create the next one when marked
-- done. Due dates the accountant has not confirmed yet are NULL ("needs a
-- date") — the seed list below is TAKEN ON TRUST from planning research and
-- must be checked with the accountant (plan item O15).
CREATE TABLE IF NOT EXISTS compliance_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT    NOT NULL,
  category      TEXT    NOT NULL CHECK (category IN ('federal', 'state', 'insurance', 'payroll', 'safety', 'other')),
  due_on        TEXT,
  recurrence    TEXT    NOT NULL DEFAULT 'annual' CHECK (recurrence IN ('once', 'monthly', 'quarterly', 'annual')),
  owner_email   TEXT,
  notes         TEXT,
  status        TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  completed_on  TEXT,
  completed_by  TEXT,
  seed_key      TEXT    UNIQUE,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compliance_due ON compliance_items (status, due_on);

INSERT OR IGNORE INTO compliance_items (title, category, due_on, recurrence, notes, seed_key, created_at, updated_at) VALUES
  ('IRS Form 990 / 990-EZ / 990-N', 'federal', NULL, 'annual',
   'Due the 15th day of the 5th month after the fiscal year ends. Which form depends on revenue. Missing three years in a row revokes exemption. Confirm the fiscal year end with the accountant.',
   'irs-990', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Tennessee annual report (Secretary of State)', 'state', NULL, 'annual',
   'Due by the 1st day of the 4th month after the fiscal year ends (to confirm with the accountant).',
   'tn-annual-report', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Tennessee charitable solicitation registration', 'state', NULL, 'annual',
   'Register before soliciting donations, then renew yearly (Division of Charitable Solicitations). Confirm with the attorney.',
   'tn-charitable', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('General liability insurance renewal', 'insurance', NULL, 'annual', 'Set the date from the policy.',
   'insurance-gl', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Directors and officers insurance renewal', 'insurance', NULL, 'annual', 'Set the date from the policy.',
   'insurance-do', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('1099-NEC forms for contractors paid $600 or more', 'payroll', NULL, 'annual',
   'Due to recipients and the IRS by January 31.',
   'irs-1099', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Annual conflict-of-interest disclosures from every board member', 'other', NULL, 'annual',
   'Collected on the Board -> Disclosures page.',
   'coi-annual', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Review coach and volunteer clearances', 'safety', NULL, 'quarterly',
   'The Clearances page lists anyone lapsed or lapsing.',
   'clearances-review', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
