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

-- SECURITY: a GRANT alone does NOT restrict anything here.
--
-- Postgres makes new functions EXECUTE-able by PUBLIC by default, and this
-- Supabase project additionally has ALTER DEFAULT PRIVILEGES granting EXECUTE on
-- new public functions to `anon` and `authenticated`. Since PostgREST exposes
-- public functions as RPC, and the anon key is public (it is baked into the
-- browser bundle), omitting the REVOKE publishes these to the internet.
--
-- These are SECURITY DEFINER and delete rows using a caller-supplied predicate.
-- Without the REVOKE below, anyone with the anon key could call
--   POST /rest/v1/rpc/cleanup_table_by_age
-- and delete arbitrary rows from arbitrary tables. Verified live on 2026-07-16:
-- it returned HTTP 200 to an anon caller before this was fixed. See 00043.
--
-- REVOKE FIRST, then GRANT. Never reorder.
REVOKE ALL ON FUNCTION cleanup_table_by_age(text, text, interval, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION cleanup_high_volume_telemetry(integer, integer) FROM PUBLIC, anon, authenticated;

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

REVOKE ALL ON FUNCTION telemetry_retention_estimates() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION telemetry_retention_estimates() TO service_role;

-- Retention indexes.
--
-- Guarded by to_regclass because process_snapshots, disk_io_stats,
-- net_connections and sync_task_snapshots have NO `CREATE TABLE` in any
-- migration — they were created out-of-band and are only ever renamed by
-- 00031. An unguarded CREATE INDEX here hard-fails a rebuild from scratch.
--
-- NOTE: on the big live tables (process_snapshots, disk_io_stats) do NOT let
-- this block build the index. A plain CREATE INDEX takes a lock that blocks
-- agent inserts for the whole build. Build those two by hand FIRST with
-- CREATE INDEX CONCURRENTLY (which cannot run inside a transaction block, so
-- not via the exec_sql RPC) — then this becomes a no-op via IF NOT EXISTS.
-- Full procedure: docs/telemetry-retention.md.
DO $idx$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT *
    FROM (VALUES
      ('process_snapshots',  'captured_at'),
      ('disk_io_stats',      'captured_at'),
      ('net_connections',    'captured_at'),
      ('service_health',     'captured_at'),
      ('container_io',       'captured_at'),
      ('scheduled_tasks',    'captured_at'),
      ('backup_tasks',       'captured_at'),
      ('custom_metric_data', 'captured_at')
    ) AS t(table_name, timestamp_column)
  LOOP
    IF to_regclass('public.' || target.table_name) IS NULL THEN
      RAISE NOTICE 'Skipping retention index: table %.% not present',
        'public', target.table_name;
      CONTINUE;
    END IF;

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I (%I)',
      'idx_' || target.table_name || '_retention',
      target.table_name,
      target.timestamp_column
    );
  END LOOP;
END;
$idx$;

INSERT INTO telemetry_retention_policies
  (table_name, timestamp_column, retain_for, extra_where, notes)
VALUES
  ('process_snapshots', 'captured_at', interval '3 days', NULL,
   'Top-N process attribution emitted every 15s; UI/agents use latest to 6h windows.'),
  ('net_connections', 'captured_at', interval '14 days', NULL,
   'Point-in-time active connection summaries; Copilot uses last 15m.'),
  ('disk_io_stats', 'captured_at', interval '35 days', NULL,
   'High-frequency device I/O. 35d, NOT 14d: the metrics page offers a 30d range '
   'over this table (apps/web/src/app/(dashboard)/metrics/page.tsx:18,114). '
   'Anything under 30d silently truncates that chart with no empty state. '
   'The 5d margin is deliberate headroom — do not trim it without removing the '
   '30d option from that panel first.'),
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
  ('drive_team_folders', 'recorded_at', interval '30 days', NULL,
   'Team-folder state snapshots; latest state dominates.'),
  ('drive_activities', 'recorded_at', interval '180 days', NULL,
   'User file-operation history is higher-value forensic data.'),
  ('dsm_errors', 'logged_at', interval '180 days', NULL,
   'DSM warning/error stream; keep longer than routine telemetry.')
ON CONFLICT (table_name) DO UPDATE
SET timestamp_column = EXCLUDED.timestamp_column,
    retain_for = EXCLUDED.retain_for,
    extra_where = EXCLUDED.extra_where,
    notes = EXCLUDED.notes,
    updated_at = now();

-- pg_partman owns the four partitioned parents, and only these four: metrics,
-- nas_logs, storage_snapshots, container_status (00003_create_partitions.sql —
-- exactly four create_parent calls). This migration deliberately does NOT touch
-- part_config and does NOT add row-level policies for them.
--
-- drive_activities is NOT partman-managed despite what older docs claimed — it is
-- a plain table (00008_create_drive_tables.sql:26, no PARTITION BY). The only
-- partitioned Drive object is drive_team_folders_partitioned, which has no child
-- partitions and no writes. So drive_activities DOES need a row-level policy and
-- has one below; do not "clean it up" on the assumption partman covers it.
--
-- Why (decided 2026-07-16, owner):
--   * Dropping a whole partition is far cheaper than deleting its rows one by one.
--   * The row policies here were partly dead anyway: partman already drops
--     metrics/storage_snapshots at 84d, so a 90d row policy could never fire.
--   * An earlier draft rewrote part_config for all four parents. That would have
--     LOOSENED metrics/storage_snapshots from partman's 84d to 90d, and reversed
--     container_status from a deliberate 180 days — "6 months for better pattern
--     analysis" (00003_create_partitions.sql:60) — down to 30 days, purely as a
--     side effect of treating it as ordinary telemetry. Do not reintroduce that.
--
-- To change retention on any of these five, edit part_config directly; do not add
-- them to telemetry_retention_policies.
--
-- Known gap: nas_logs routine `info` rows from noisy polling sources
-- (share_config, package_health, drive_admin_stats, dsm_system_log, backup,
-- service, system_info) now live the full partman 180d rather than being trimmed
-- at 30d, because severity-selective trimming is exactly what a partition drop
-- cannot express. If nas_logs proves to be a real space driver, that one policy is
-- the thing to reconsider — see docs/telemetry-retention.md.

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
