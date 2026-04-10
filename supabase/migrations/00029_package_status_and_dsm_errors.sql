-- Allow DSM system errors as an alert source.
ALTER TABLE smon_alerts
  DROP CONSTRAINT IF EXISTS smon_alerts_source_check;

ALTER TABLE smon_alerts
  ADD CONSTRAINT smon_alerts_source_check
    CHECK (source IN ('metric', 'security', 'storage', 'ai', 'agent', 'dsm'));

-- Package status: one row per (nas_id, package_id), upserted on every collection.
-- Gives a current-state inventory of all installed DSM packages.
CREATE TABLE IF NOT EXISTS smon_package_status (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  nas_id       UUID        NOT NULL REFERENCES smon_nas_units(id) ON DELETE CASCADE,
  package_id   TEXT        NOT NULL,
  display_name TEXT,
  version      TEXT,
  status       TEXT,            -- running / stopped / broken / installing / etc.
  pkg_type     TEXT,
  checked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (nas_id, package_id)
);

CREATE INDEX IF NOT EXISTS idx_smon_package_status_nas
  ON smon_package_status (nas_id, checked_at DESC);

ALTER TABLE smon_package_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated users read package status"
  ON smon_package_status FOR SELECT TO authenticated USING (true);

CREATE POLICY "service role manages package status"
  ON smon_package_status FOR ALL TO service_role USING (true) WITH CHECK (true);

-- DSM error events: warning/error/critical level events from DSM Log Center.
-- Populated by the agent's watermark-deduplicated system log collector.
-- Separate from smon_logs to make DSM errors queryable and alertable without
-- having to filter the high-volume general log stream.
CREATE TABLE IF NOT EXISTS smon_dsm_errors (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  nas_id     UUID        NOT NULL REFERENCES smon_nas_units(id) ON DELETE CASCADE,
  level      TEXT        NOT NULL,   -- warning / error / critical
  message    TEXT        NOT NULL,
  who        TEXT,
  log_name   TEXT,
  logged_at  TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_smon_dsm_errors_nas_time
  ON smon_dsm_errors (nas_id, logged_at DESC);

ALTER TABLE smon_dsm_errors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated users read dsm errors"
  ON smon_dsm_errors FOR SELECT TO authenticated USING (true);

CREATE POLICY "service role manages dsm errors"
  ON smon_dsm_errors FOR ALL TO service_role USING (true) WITH CHECK (true);
