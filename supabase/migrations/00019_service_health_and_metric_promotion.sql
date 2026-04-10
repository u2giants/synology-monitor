-- Service health tracking: the agent monitors key DSM services
CREATE TABLE IF NOT EXISTS smon_service_health (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  nas_id       text NOT NULL,
  service_name text NOT NULL,
  status       text NOT NULL, -- running, stopped, not_found
  captured_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_smon_service_health_recent
  ON smon_service_health (nas_id, captured_at DESC);

ALTER TABLE smon_service_health ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated users manage service health"
  ON smon_service_health FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- Track how often each custom metric is referenced in analysis
-- When referenced_count >= 3, the metric is consistently useful
-- and should be promoted to a built-in agent collector.
ALTER TABLE smon_custom_metric_schedules
  ADD COLUMN IF NOT EXISTS referenced_count int NOT NULL DEFAULT 0;
