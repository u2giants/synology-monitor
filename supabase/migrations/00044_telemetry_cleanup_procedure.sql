-- Make telemetry cleanup safe for hourly cron by committing per batch.
--
-- 00042's cleanup_high_volume_telemetry() is a FUNCTION, so it runs in a single
-- transaction and cannot COMMIT. The hourly cron therefore deletes up to
-- 13 policies x 10 batches x 25000 rows = 3.25M rows in one transaction,
-- producing a large WAL burst and a long-lived snapshot. This migration adds a
-- PROCEDURE that commits after every batch, and repoints the pg_cron job to use
-- it. The old function is left in place for manual one-off drains.
--
-- This procedure is intentionally NOT SECURITY DEFINER and has no SET
-- search_path clause. Either of those prevents COMMIT inside a PL/pgSQL
-- procedure on Postgres 17, and per-batch COMMIT is the entire point. All
-- object references are schema-qualified to public, and the privileged DELETE
-- is still performed by the SECURITY DEFINER cleanup_table_by_age function.

CREATE OR REPLACE PROCEDURE cleanup_high_volume_telemetry_proc(
  p_max_batches_per_table integer DEFAULT 10,
  p_batch_limit integer DEFAULT 25000
)
LANGUAGE plpgsql
AS $$
DECLARE
  policy record;
  batch_index integer;
  batch_deleted integer;
  total_deleted bigint;
BEGIN
  FOR policy IN
    SELECT p.*
    FROM public.telemetry_retention_policies p
    WHERE p.enabled
    ORDER BY p.table_name
  LOOP
    total_deleted := 0;

    FOR batch_index IN 1..greatest(p_max_batches_per_table, 1) LOOP
      batch_deleted := public.cleanup_table_by_age(
        policy.table_name,
        policy.timestamp_column,
        policy.retain_for,
        policy.extra_where,
        p_batch_limit
      );

      total_deleted := total_deleted + batch_deleted;
      COMMIT;
      EXIT WHEN batch_deleted < p_batch_limit;
    END LOOP;

    RAISE NOTICE 'cleanup %: deleted % rows', policy.table_name, total_deleted;
  END LOOP;
END;
$$;

-- SECURITY: new procedures in public are EXECUTE-able by PUBLIC/anon/authenticated
-- by default, and PostgREST would publish this as an RPC. Revoke first, then grant.
REVOKE ALL ON PROCEDURE cleanup_high_volume_telemetry_proc(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE cleanup_high_volume_telemetry_proc(integer, integer) TO service_role;

-- Repoint the hourly cron job to the per-batch-commit procedure.
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
      $sql$CALL public.cleanup_high_volume_telemetry_proc(10, 25000);$sql$
    );
  END IF;
EXCEPTION
  WHEN undefined_function OR invalid_parameter_value THEN
    PERFORM cron.schedule(
      'telemetry-retention-cleanup',
      '17 * * * *',
      $sql$CALL public.cleanup_high_volume_telemetry_proc(10, 25000);$sql$
    );
END;
$do$;
