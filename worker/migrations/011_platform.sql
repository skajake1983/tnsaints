-- Migration 011 — runtime settings and the scheduled-job ledger
--
-- ORDER: schema.sql, then 001..010, then this.
--
--   npx wrangler d1 execute tnsaints --local  --file=./migrations/011_platform.sql
--   npx wrangler d1 execute tnsaints --remote --file=./migrations/011_platform.sql
--
-- Every statement is IF NOT EXISTS, so re-running is safe.

-- ---------------------------------------------------------------------------
-- Settings staff change from the admin without a deploy (e.g. the CRM owner
-- for each inquiry purpose). Kill switches and security modes are NOT here:
-- those live in wrangler.toml, where changing one is a reviewed commit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT    PRIMARY KEY,
  value       TEXT    NOT NULL,
  updated_by  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- One row per job per run. The cron fires once a day; the runner claims a job
-- by INSERTing its (job, run_key) — a duplicate means another invocation has it
-- — so a retried or overlapping trigger can never run the same job twice.
-- Each job gets a query budget (45) under D1's 50-per-invocation limit and
-- records how far it got, so work that does not fit resumes next run.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_runs (
  job          TEXT    NOT NULL,
  -- Usually the Central date: '2026-09-26'.
  run_key      TEXT    NOT NULL,
  status       TEXT    NOT NULL CHECK (status IN ('running', 'done', 'partial', 'failed')),
  started_at   TEXT    NOT NULL,
  finished_at  TEXT,
  -- Counts and cursors only. Never names, emails or message text.
  detail       TEXT,
  PRIMARY KEY (job, run_key)
);

CREATE INDEX IF NOT EXISTS idx_job_runs_started ON job_runs (started_at);
