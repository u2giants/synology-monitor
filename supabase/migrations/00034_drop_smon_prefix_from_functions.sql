-- ============================================================
-- Migration 00034: Finish removing the smon_ prefix
-- ============================================================
-- Background: migration 00031 already renamed every smon_* TABLE to its
-- unprefixed name (smon_metrics -> metrics, smon_logs -> nas_logs, ...).
-- This migration removes the remaining smon_ prefix from the database
-- FUNCTIONS that are safe to rename, and re-points the cron jobs that
-- call them.
--
-- NOT YET APPLIED. Review, then apply via your normal Supabase migration
-- process (or the Supabase MCP apply_migration tool). It is written to be
-- safe to re-run.
--
-- Scope decisions (intentional — read before "completing" the cleanup):
--   * 4 standalone functions are renamed below. They are only invoked by
--     cron, so renaming them + rescheduling cron is self-contained.
--   * smon_create_alert(...) and smon_get_openai_key() are NOT renamed.
--     Other functions call them by name; renaming them would break those
--     callers unless every caller body is rewritten in the same migration.
--     Low value (internal-only names), real risk — left in place on purpose.
--   * Index names (smon_*_pkey, smon_metrics_nas_type_time, ...) and the
--     weekly partition child tables (smon_metrics_p20260404, ...) still
--     carry smon_. They are invisible plumbing managed by pg_partman, whose
--     config references the old parent names. Renaming them here would be
--     high-churn and could desync partman. Left in place on purpose.
-- ============================================================

-- ── Rename the 4 standalone functions (re-runnable) ──────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'smon_run_anomaly_detection') THEN
    ALTER FUNCTION public.smon_run_anomaly_detection() RENAME TO run_anomaly_detection;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'smon_run_daily_health') THEN
    ALTER FUNCTION public.smon_run_daily_health() RENAME TO run_daily_health;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'smon_process_ai_responses') THEN
    ALTER FUNCTION public.smon_process_ai_responses() RENAME TO process_ai_responses;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'smon_detect_sync_anomalies') THEN
    ALTER FUNCTION public.smon_detect_sync_anomalies() RENAME TO detect_sync_anomalies;
  END IF;
END;
$$;

-- ── Re-point cron at the renamed functions ───────────────────
-- Unschedule ONLY the 4 function jobs by exact name (do NOT touch
-- 'smon-partition-maintenance' — that runs pg_partman and is handled
-- separately in the partman-repair migration). No-op if already gone.
SELECT cron.unschedule(jobname) FROM cron.job
WHERE jobname IN ('smon-anomaly-detection','smon-daily-health',
                  'smon-process-ai-responses','smon-sync-anomaly-detection');

SELECT cron.schedule('anomaly-detection',      '*/15 * * * *', 'SELECT public.run_anomaly_detection()');
SELECT cron.schedule('daily-health',           '0 12 * * *',   'SELECT public.run_daily_health()');
SELECT cron.schedule('process-ai-responses',   '* * * * *',    'SELECT public.process_ai_responses()');
SELECT cron.schedule('sync-anomaly-detection', '*/15 * * * *', 'SELECT public.detect_sync_anomalies()');
