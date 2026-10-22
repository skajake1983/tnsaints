-- Migration 022 — the 8/29 evaluation, as a past event
--
-- ORDER: schema.sql, then 001..021, then this.
--
--   npx wrangler d1 execute tnsaints --local  --file=./migrations/022_events_past_evaluation.sql
--   npx wrangler d1 execute tnsaints --remote --file=./migrations/022_events_past_evaluation.sql
--
-- The Events plan (owner, 2026-10-21): every event is a program, so the
-- Events page can list past ones and Roster can show any of them. The 8/29
-- evaluation ran from wrangler.toml (EVENT_ID, SESSION_TIMES, SLOT_CAPACITY,
-- ALLOWED_GRADES, REGISTRATION_CLOSES_AT) before evaluations were programs;
-- this records it as one, CLOSED, with the same id, sessions, sizes, grades
-- and close time, so its registrations (event_id '2026-08-29-evaluation',
-- session_time '9:00 AM' / '10:00 AM') belong to it unchanged.
--
-- Nothing reads this to take registrations: it is closed, and it is not the
-- current evaluation. Safe to re-run (INSERT OR IGNORE; the group names are
-- unique per program).

INSERT OR IGNORE INTO programs (id, kind, name, status, enrollment_mode, billing, grade_min, grade_max, public,
                                registration_closes_at, waitlist_enabled, created_at, updated_at)
VALUES ('2026-08-29-evaluation', 'evaluation', 'Free Academy Evaluation - Saturday, August 29, 2026', 'closed', 'approval',
        'free', 3, 6, 0, '2026-08-28T04:59:59.000Z', 1, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');

INSERT OR IGNORE INTO program_groups (program_id, name, schedule_summary, weekday, start_time, end_time, location, starts_on,
                                      capacity, status, created_at, updated_at)
VALUES ('2026-08-29-evaluation', '9:00 AM', 'Saturday, August 29, 9:00–10:00 AM', 6, '09:00', '10:00',
        'Grassland Heights Baptist Church, 2316 Hillsboro Rd, Franklin, TN 37069', '2026-08-29', 25, 'active',
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
       ('2026-08-29-evaluation', '10:00 AM', 'Saturday, August 29, 10:00–11:00 AM', 6, '10:00', '11:00',
        'Grassland Heights Baptist Church, 2316 Hillsboro Rd, Franklin, TN 37069', '2026-08-29', 25, 'active',
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
