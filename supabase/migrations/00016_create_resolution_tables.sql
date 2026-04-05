-- Issue Resolution Agent tables
-- Persistent state machine for end-to-end problem resolution

-- Top-level: one row per issue the agent is working on
CREATE TABLE smon_issue_resolutions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL,

  -- Origin
  origin_type     text NOT NULL CHECK (origin_type IN ('problem', 'alert', 'manual')),
  origin_id       text,

  -- Issue description
  title           text NOT NULL,
  description     text NOT NULL,
  severity        text NOT NULL DEFAULT 'warning' CHECK (severity IN ('critical', 'warning', 'info')),
  affected_nas    text[] NOT NULL DEFAULT '{}',

  -- State machine
  phase           text NOT NULL DEFAULT 'planning' CHECK (phase IN (
    'planning', 'diagnosing', 'analyzing', 'proposing_fix',
    'awaiting_fix_approval', 'applying_fix', 'verifying',
    'resolved', 'stuck', 'cancelled'
  )),

  -- Agent state
  diagnosis_summary   text,
  root_cause          text,
  fix_summary         text,
  verification_result text,
  stuck_reason        text,
  attempt_count       int NOT NULL DEFAULT 0,
  max_attempts        int NOT NULL DEFAULT 3,

  -- Settings
  auto_approve_reads  boolean NOT NULL DEFAULT true,
  lookback_hours      int NOT NULL DEFAULT 2,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);

ALTER TABLE smon_issue_resolutions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_all" ON smon_issue_resolutions
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE INDEX idx_resolutions_user_phase ON smon_issue_resolutions(user_id, phase);

-- Steps: each action the agent plans/runs
CREATE TABLE smon_resolution_steps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resolution_id   uuid NOT NULL REFERENCES smon_issue_resolutions(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL,

  step_order      int NOT NULL,
  batch           int NOT NULL DEFAULT 0,
  category        text NOT NULL CHECK (category IN ('diagnostic', 'fix', 'verification')),

  title           text NOT NULL,
  target          text NOT NULL,
  tool_name       text NOT NULL,
  command_preview  text NOT NULL,
  reason          text NOT NULL,
  risk            text NOT NULL DEFAULT 'low' CHECK (risk IN ('low', 'medium', 'high')),

  approval_token   text,
  requires_approval boolean NOT NULL DEFAULT true,

  status          text NOT NULL DEFAULT 'planned' CHECK (status IN (
    'planned', 'approved', 'running', 'completed', 'failed', 'skipped', 'rejected'
  )),
  result_text     text,
  exit_code       int,
  started_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smon_resolution_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_all" ON smon_resolution_steps
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE INDEX idx_steps_resolution ON smon_resolution_steps(resolution_id, step_order);

-- Audit log: append-only record of agent activity
CREATE TABLE smon_resolution_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resolution_id   uuid NOT NULL REFERENCES smon_issue_resolutions(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL,

  entry_type      text NOT NULL CHECK (entry_type IN (
    'phase_change', 'plan', 'diagnosis', 'analysis', 'fix_proposal',
    'step_result', 'verification', 'stuck', 'user_input', 'error'
  )),
  content         text NOT NULL,
  technical_detail text,

  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smon_resolution_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_all" ON smon_resolution_log
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE INDEX idx_resolution_log ON smon_resolution_log(resolution_id, created_at);
