-- Timestamps are stored as TEXT in "YYYY-MM-DD HH:MM:SS" (UTC), via sqlite_now() below, so
-- every place that slices/compares these strings elsewhere in the app is a plain string op.
-- Dates the business cares about (pay period weeks) are also TEXT YYYY-MM-DD.

CREATE OR REPLACE FUNCTION sqlite_now() RETURNS TEXT AS $$
  SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
$$ LANGUAGE SQL;

-- ----------------------------------------------------------------------------------------
-- Cleaners
-- ----------------------------------------------------------------------------------------

-- No login and no separate roster page in this version, see CLAUDE.md. This table exists only
-- so payroll has somewhere to look up a cleaner's email and offer "add a cleaner to this week"
-- for room turns/touch-ups that never reach ConvertLabs. Add rows directly in the database for
-- now (or via a future simple admin screen), there is no UI for managing this list yet.
CREATE TABLE IF NOT EXISTS cleaners (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  email      TEXT,
  created_at TEXT NOT NULL DEFAULT sqlite_now(),
  updated_at TEXT NOT NULL DEFAULT sqlite_now()
);

-- ----------------------------------------------------------------------------------------
-- Cleaner payroll
-- ----------------------------------------------------------------------------------------

-- ConvertLabs has no payout/wage data in its API, so what a cleaner is actually paid for a
-- given job has nowhere else to live. One row per ConvertLabs booking, entered by hand each pay
-- period. cleaner_name matches the ConvertLabs teams[0].title convention (e.g. "Gina T.").
CREATE TABLE IF NOT EXISTS payroll_job_pay (
  id           SERIAL PRIMARY KEY,
  week_start   TEXT NOT NULL,
  booking_id   INTEGER NOT NULL UNIQUE,
  cleaner_name TEXT NOT NULL,
  amount       REAL NOT NULL DEFAULT 0,
  service_name TEXT,
  created_at   TEXT NOT NULL DEFAULT sqlite_now(),
  updated_at   TEXT NOT NULL DEFAULT sqlite_now()
);

-- Extra line items per cleaner per pay period that aren't tied to a single booking: room
-- turns, a missed prior payment, a correction. amount can be negative (a deduction).
CREATE TABLE IF NOT EXISTS payroll_adjustments (
  id           SERIAL PRIMARY KEY,
  week_start   TEXT NOT NULL,
  cleaner_name TEXT NOT NULL,
  label        TEXT NOT NULL,
  amount       REAL NOT NULL,
  created_at   TEXT NOT NULL DEFAULT sqlite_now()
);

-- Presence of a row means that pay period is closed out (money's already gone out), so
-- payroll_job_pay/payroll_adjustments reject further writes for it until someone deliberately
-- deletes this row to reopen it. No row means the week is open/editable. locked_by is free text
-- (there's no login to attribute it to a user id).
CREATE TABLE IF NOT EXISTS payroll_week_locks (
  week_start TEXT PRIMARY KEY,
  locked_at  TEXT NOT NULL DEFAULT sqlite_now(),
  locked_by  TEXT
);

-- One row every time someone clicks "Mark as sent" on a cleaner's pay statement email popup.
-- Not unique per week+cleaner on purpose, keeps a full history rather than just the latest.
-- total_at_send lets the UI flag a cleaner whose numbers changed after their statement went out.
CREATE TABLE IF NOT EXISTS payroll_sent_log (
  id            SERIAL PRIMARY KEY,
  week_start    TEXT NOT NULL,
  cleaner_name  TEXT NOT NULL,
  sent_at       TEXT NOT NULL DEFAULT sqlite_now(),
  sent_by       TEXT,
  total_at_send REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payroll_job_pay_week     ON payroll_job_pay(week_start);
CREATE INDEX IF NOT EXISTS idx_payroll_adjustments_week ON payroll_adjustments(week_start, cleaner_name);
