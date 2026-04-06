-- Custom metric collection schedules: the resolution agent can request
-- the system to start collecting specific metrics on a recurring basis.
-- This lets the AI gather time-series evidence before making a fix decision.

CREATE TABLE IF NOT EXISTS smon_custom_metric_schedules (
  id                uuid    DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at        timestamptz DEFAULT now(),
  created_by        text,                                  -- userId (text, not FK — same as other tables)
  resolution_id     uuid    REFERENCES smon_resolutions(id) ON DELETE SET NULL,
  name              text    NOT NULL,
  description       text    NOT NULL DEFAULT '',
  nas_id            text    NOT NULL,
  collection_command text   NOT NULL,                      -- read-only SSH command to run
  interval_minutes  int     NOT NULL DEFAULT 5,
  is_active         boolean NOT NULL DEFAULT true,
  last_run_at       timestamptz,
  next_run_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS smon_custom_metric_data (
  id           uuid    DEFAULT gen_random_uuid() PRIMARY KEY,
  schedule_id  uuid    NOT NULL REFERENCES smon_custom_metric_schedules(id) ON DELETE CASCADE,
  captured_at  timestamptz DEFAULT now(),
  nas_id       text    NOT NULL,
  raw_output   text,
  error        text
);

-- Indexes for efficient polling
CREATE INDEX IF NOT EXISTS idx_smon_metric_schedules_due
  ON smon_custom_metric_schedules (next_run_at)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_smon_metric_data_schedule
  ON smon_custom_metric_data (schedule_id, captured_at DESC);

-- RLS
ALTER TABLE smon_custom_metric_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE smon_custom_metric_data      ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated users manage metric schedules"
  ON smon_custom_metric_schedules FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY "authenticated users manage metric data"
  ON smon_custom_metric_data FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
