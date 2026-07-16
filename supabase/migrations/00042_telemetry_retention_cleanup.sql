-- Retention for high-volume telemetry.
--
-- The app mostly reads these tables in short windows (minutes to days). Keep
-- raw incident/security/history data longer, but trim point-in-time collector
-- streams that otherwise grow without bound.

CREATE TABLE IF NOT EXISTS telemetry_retention_policies (
  table_name text PRIMARY KEY,
  timestamp_column text NOT NULL,
  retain_for interval NOT NULL,
  extra_where text,
  enabled boolean NOT NULL DEFAULT true,
  notes text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION cleanup_table_by_age(
  p_table_name text,
  p_timestamp_column text,
  p_retain_for interval,
  p_extra_where text DEFAULT NULL,
  p_batch_limit integer DEFAULT 50000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  table_reg regclass;
  delete_sql text;
  deleted_count integer := 0;
BEGIN
  PERFORM set_config('statement_timeout', '120s', true);

  table_reg := to_regclass('public.' || p_table_name);
  IF table_reg IS NULL THEN
    RETURN 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = p_table_name
      AND column_name = p_timestamp_column
  ) THEN
    RAISE EXCEPTION 'Column %.% does not exist', p_table_name, p_timestamp_column;
  END IF;

  delete_sql := format(
    'WITH doomed AS (
       SELECT tableoid, ctid
       FROM %s
       WHERE %I < now() - $1
       %s
       LIMIT %s
     )
     DELETE FROM %s t
     USING doomed d
     WHERE t.tableoid = d.tableoid
       AND t.ctid = d.ctid',
    table_reg,
    p_timestamp_column,
    CASE
      WHEN p_extra_where IS NULL OR btrim(p_extra_where) = '' THEN ''
      ELSE 'AND (' || p_extra_where || ')'
    END,
    greatest(p_batch_limit, 1),
    table_reg
  );

  EXECUTE delete_sql USING p_retain_for;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

CREATE OR REPLACE FUNCTION cleanup_high_volume_telemetry(
  p_max_batches_per_table integer DEFAULT 20,
  p_batch_limit integer DEFAULT 50000
)
RETURNS TABLE(table_name text, deleted_rows bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  policy record;
  batch_index integer;
  batch_deleted integer;
  total_deleted bigint;
BEGIN
  FOR policy IN
    SELECT p.*
    FROM telemetry_retention_policies p
    WHERE p.enabled
    ORDER BY p.table_name
  LOOP
    total_deleted := 0;

    FOR batch_index IN 1..greatest(p_max_batches_per_table, 1) LOOP
      batch_deleted := cleanup_table_by_age(
        policy.table_name,
        policy.timestamp_column,
        policy.retain_for,
        policy.extra_where,
        p_batch_limit
      );

      total_deleted := total_deleted + batch_deleted;
      EXIT WHEN batch_deleted < p_batch_limit;
    END LOOP;

    table_name := policy.table_name;
    deleted_rows := total_deleted;
    RETURN NEXT;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION cleanup_table_by_age(text, text, interval, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION cleanup_high_volume_telemetry(integer, integer) TO service_role;

DROP FUNCTION IF EXISTS telemetry_retention_estimates();

CREATE OR REPLACE FUNCTION telemetry_retention_estimates()
RETURNS TABLE(
  table_name text,
  retain_for text,
  cutoff_at timestamptz,
  estimated_rows bigint,
  extra_where text,
  notes text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  policy record;
  table_reg regclass;
  row_estimate bigint;
BEGIN
  FOR policy IN
    SELECT p.*
    FROM telemetry_retention_policies p
    WHERE p.enabled
    ORDER BY p.table_name
  LOOP
    table_reg := to_regclass('public.' || policy.table_name);
    IF table_reg IS NULL THEN
      CONTINUE;
    END IF;

    SELECT COALESCE(s.n_live_tup, 0)
    INTO row_estimate
    FROM pg_stat_user_tables s
    WHERE s.schemaname = 'public'
      AND s.relname = policy.table_name;

    table_name := policy.table_name;
    retain_for := policy.retain_for::text;
    cutoff_at := now() - policy.retain_for;
    estimated_rows := COALESCE(row_estimate, 0);
    extra_where := policy.extra_where;
    notes := policy.notes;
    RETURN NEXT;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION telemetry_retention_estimates() TO service_role;

CREATE INDEX IF NOT EXISTS idx_process_snapshots_retention
  ON process_snapshots (captured_at);

CREATE INDEX IF NOT EXISTS idx_disk_io_stats_retention
  ON disk_io_stats (captured_at);

CREATE INDEX IF NOT EXISTS idx_net_connections_retention
  ON net_connections (captured_at);

CREATE INDEX IF NOT EXISTS idx_service_health_retention
  ON service_health (captured_at);

CREATE INDEX IF NOT EXISTS idx_container_io_retention
  ON container_io (captured_at);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_retention
  ON scheduled_tasks (captured_at);

CREATE INDEX IF NOT EXISTS idx_backup_tasks_retention
  ON backup_tasks (captured_at);

CREATE INDEX IF NOT EXISTS idx_custom_metric_data_retention
  ON custom_metric_data (captured_at);

INSERT INTO telemetry_retention_policies
  (table_name, timestamp_column, retain_for, extra_where, notes)
VALUES
  ('process_snapshots', 'captured_at', interval '3 days', NULL,
   'Top-N process attribution emitted every 15s; UI/agents use latest to 6h windows.'),
  ('net_connections', 'captured_at', interval '14 days', NULL,
   'Point-in-time active connection summaries; Copilot uses last 15m.'),
  ('disk_io_stats', 'captured_at', interval '14 days', NULL,
   'High-frequency device I/O; UI and agents use recent windows.'),
  ('container_io', 'captured_at', interval '7 days', NULL,
   'Container I/O is a live diagnostic stream.'),
  ('service_health', 'captured_at', interval '14 days', NULL,
   'Polling stream of service state; current/fact tables preserve durable signal.'),
  ('scheduled_tasks', 'captured_at', interval '30 days', NULL,
   'Repeated DSM task snapshots; issues/facts preserve notable failures.'),
  ('backup_tasks', 'captured_at', interval '30 days', NULL,
   'Repeated Hyper Backup snapshots; current state matters most.'),
  ('snapshot_replicas', 'captured_at', interval '30 days', NULL,
   'Repeated Snapshot Replication task snapshots.'),
  ('sync_task_snapshots', 'captured_at', interval '14 days', NULL,
   'Drive/ShareSync live backlog snapshots.'),
  ('custom_metric_data', 'captured_at', interval '14 days', NULL,
   'Ad hoc metric output; promoted metrics should move into normal metrics/facts.'),
  ('container_status', 'recorded_at', interval '30 days', NULL,
   'Container status polling; docker page uses latest rows.'),
  ('metrics', 'recorded_at', interval '90 days', NULL,
   'Raw metrics beyond 90d should be rolled up before keeping long-term.'),
  ('storage_snapshots', 'recorded_at', interval '90 days', NULL,
   'Storage history is useful, but raw per-minute rows beyond 90d are low value.'),
  ('drive_team_folders', 'recorded_at', interval '30 days', NULL,
   'Team-folder state snapshots; latest state dominates.'),
  ('drive_activities', 'recorded_at', interval '180 days', NULL,
   'User file-operation history is higher-value forensic data.'),
  ('dsm_errors', 'logged_at', interval '180 days', NULL,
   'DSM warning/error stream; keep longer than routine telemetry.'),
  ('nas_logs', 'ingested_at', interval '30 days',
   $$severity = 'info' AND source IN (
       'share_config',
       'package_health',
       'drive_admin_stats',
       'dsm_system_log',
       'backup',
       'service',
       'system_info'
     )$$,
   'Aggressively trim routine info logs from noisy polling sources; keep warning/error/critical longer.')
ON CONFLICT (table_name) DO UPDATE
SET timestamp_column = EXCLUDED.timestamp_column,
    retain_for = EXCLUDED.retain_for,
    extra_where = EXCLUDED.extra_where,
    notes = EXCLUDED.notes,
    updated_at = now();

-- Keep pg_partman retention aligned for the partitioned parents that already
-- have partition management. Some child partitions still have smon_* names
-- after the parent rename, so update both possible parent names defensively.
UPDATE part_config
SET retention = '90 days',
    retention_keep_table = false,
    retention_keep_index = false
WHERE parent_table IN ('public.metrics', 'public.smon_metrics');

UPDATE part_config
SET retention = '180 days',
    retention_keep_table = false,
    retention_keep_index = false
WHERE parent_table IN ('public.nas_logs', 'public.smon_logs');

UPDATE part_config
SET retention = '90 days',
    retention_keep_table = false,
    retention_keep_index = false
WHERE parent_table IN ('public.storage_snapshots', 'public.smon_storage_snapshots');

UPDATE part_config
SET retention = '30 days',
    retention_keep_table = false,
    retention_keep_index = false
WHERE parent_table IN ('public.container_status', 'public.smon_container_status');

DO $do$
DECLARE
  existing_job_id bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    SELECT jobid
    INTO existing_job_id
    FROM cron.job
    WHERE jobname = 'telemetry-retention-cleanup'
    LIMIT 1;

    IF existing_job_id IS NOT NULL THEN
      PERFORM cron.unschedule(existing_job_id);
    END IF;

    PERFORM cron.schedule(
      'telemetry-retention-cleanup',
      '17 * * * *',
      $sql$SELECT * FROM public.cleanup_high_volume_telemetry(10, 25000);$sql$
    );
  END IF;
EXCEPTION
  WHEN undefined_function OR invalid_parameter_value THEN
    PERFORM cron.schedule(
      'telemetry-retention-cleanup',
      '17 * * * *',
      $sql$SELECT * FROM public.cleanup_high_volume_telemetry(10, 25000);$sql$
    );
END;
$do$;
