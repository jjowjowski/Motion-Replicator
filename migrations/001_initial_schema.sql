-- Initial schema for Motion Replicator.

-- Tasks the user wants scheduled. Rows stay (status = 'done') after completion
-- so history is kept, but done tasks are never scheduled again.
CREATE TABLE tasks (
  id                 SERIAL PRIMARY KEY,
  title              TEXT        NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  priority           TEXT        NOT NULL CHECK (priority IN ('high', 'medium', 'low')),
  duration_minutes   INTEGER     NOT NULL CHECK (duration_minutes BETWEEN 5 AND 6000),
  -- Deadline is stored as local Pacific/Auckland wall-clock values.
  deadline_date      DATE        NOT NULL,
  deadline_time      TIME,       -- NULL = end of that day
  notes              TEXT,
  status             TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  completed_at       TIMESTAMPTZ,
  -- Result of the latest planner run:
  --   scheduled  fully placed before its deadline
  --   partial    deadline is beyond the planning window; rest planned on later runs
  --   at_risk    could not fully fit before its deadline (warning shown)
  --   overdue    deadline already passed (warning shown)
  --   NULL       not planned yet
  schedule_status    TEXT CHECK (schedule_status IN ('scheduled', 'partial', 'at_risk', 'overdue')),
  scheduled_minutes  INTEGER NOT NULL DEFAULT 0,
  schedule_warning   TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tasks_open_idx ON tasks (status, deadline_date);

-- Single row holding the Google connection. The refresh token is encrypted
-- with AES-256-GCM using TOKEN_ENCRYPTION_KEY before being stored.
CREATE TABLE google_account (
  id                 SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  email              TEXT,
  refresh_token_enc  TEXT NOT NULL,
  scopes             TEXT,
  tasks_calendar_id  TEXT,
  needs_reauth       BOOLEAN NOT NULL DEFAULT false,
  connected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every event this app created in the Tasks calendar. The planner only ever
-- deletes events listed here, and only in the Tasks calendar.
CREATE TABLE scheduled_events (
  id                 SERIAL PRIMARY KEY,
  task_id            INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  calendar_id        TEXT        NOT NULL,
  google_event_id    TEXT        NOT NULL,
  start_at           TIMESTAMPTZ NOT NULL,
  end_at             TIMESTAMPTZ NOT NULL,
  chunk_index        INTEGER     NOT NULL DEFAULT 1,
  chunk_count        INTEGER     NOT NULL DEFAULT 1,
  is_late            BOOLEAN     NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (calendar_id, google_event_id)
);

CREATE INDEX scheduled_events_start_idx ON scheduled_events (start_at);
CREATE INDEX scheduled_events_task_idx ON scheduled_events (task_id);

-- Audit log of planner runs (cron and manual).
CREATE TABLE schedule_runs (
  id                 SERIAL PRIMARY KEY,
  trigger            TEXT        NOT NULL CHECK (trigger IN ('cron', 'manual')),
  status             TEXT        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'error')),
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at        TIMESTAMPTZ,
  events_created     INTEGER,
  events_deleted     INTEGER,
  warnings           INTEGER,
  error              TEXT
);

-- Session store used by connect-pg-simple.
CREATE TABLE session (
  sid     VARCHAR      NOT NULL PRIMARY KEY,
  sess    JSON         NOT NULL,
  expire  TIMESTAMP(6) NOT NULL
);

CREATE INDEX session_expire_idx ON session (expire);
