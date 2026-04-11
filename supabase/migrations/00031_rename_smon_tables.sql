-- ============================================================
-- Migration 00031: Remove smon_ prefix from all tables
-- ============================================================
-- PostgreSQL ALTER TABLE ... RENAME TO automatically updates
-- all FK constraints pointing to the renamed table (by OID).
-- Using IF EXISTS throughout so this is safe to re-run.
-- ============================================================

-- ── Core / foundational ──────────────────────────────────────
ALTER TABLE IF EXISTS smon_nas_units              RENAME TO nas_units;
ALTER TABLE IF EXISTS smon_alerts                 RENAME TO alerts;
ALTER TABLE IF EXISTS smon_metrics                RENAME TO metrics;
ALTER TABLE IF EXISTS smon_logs                   RENAME TO nas_logs;
ALTER TABLE IF EXISTS smon_storage_snapshots      RENAME TO storage_snapshots;
ALTER TABLE IF EXISTS smon_container_status       RENAME TO container_status;
ALTER TABLE IF EXISTS smon_security_events        RENAME TO security_events;
ALTER TABLE IF EXISTS smon_push_subscriptions     RENAME TO push_subscriptions;
ALTER TABLE IF EXISTS smon_ai_analyses            RENAME TO ai_analyses;
ALTER TABLE IF EXISTS smon_ai_settings            RENAME TO ai_settings;
ALTER TABLE IF EXISTS smon_user_roles             RENAME TO user_roles;

-- ── Drive / sync ─────────────────────────────────────────────
ALTER TABLE IF EXISTS smon_drive_team_folders             RENAME TO drive_team_folders;
ALTER TABLE IF EXISTS smon_drive_team_folders_partitioned RENAME TO drive_team_folders_partitioned;
ALTER TABLE IF EXISTS smon_drive_activities               RENAME TO drive_activities;
ALTER TABLE IF EXISTS smon_sync_remediations              RENAME TO sync_remediations;
ALTER TABLE IF EXISTS smon_sync_task_snapshots            RENAME TO sync_task_snapshots;

-- ── Analysis & health ────────────────────────────────────────
ALTER TABLE IF EXISTS smon_analysis_runs       RENAME TO analysis_runs;
ALTER TABLE IF EXISTS smon_analyzed_problems   RENAME TO analyzed_problems;
ALTER TABLE IF EXISTS smon_service_health      RENAME TO service_health;
ALTER TABLE IF EXISTS smon_capability_state    RENAME TO capability_state;
ALTER TABLE IF EXISTS smon_ingestion_health    RENAME TO ingestion_health;
ALTER TABLE IF EXISTS smon_ingestion_events    RENAME TO ingestion_events;
ALTER TABLE IF EXISTS smon_facts               RENAME TO facts;
ALTER TABLE IF EXISTS smon_fact_sources        RENAME TO fact_sources;

-- ── Extended telemetry ───────────────────────────────────────
ALTER TABLE IF EXISTS smon_process_snapshots   RENAME TO process_snapshots;
ALTER TABLE IF EXISTS smon_disk_io_stats       RENAME TO disk_io_stats;
ALTER TABLE IF EXISTS smon_net_connections     RENAME TO net_connections;
ALTER TABLE IF EXISTS smon_container_io        RENAME TO container_io;
ALTER TABLE IF EXISTS smon_scheduled_tasks     RENAME TO scheduled_tasks;
ALTER TABLE IF EXISTS smon_backup_tasks        RENAME TO backup_tasks;
ALTER TABLE IF EXISTS smon_snapshot_replicas   RENAME TO snapshot_replicas;
ALTER TABLE IF EXISTS smon_package_status      RENAME TO package_status;
ALTER TABLE IF EXISTS smon_dsm_errors          RENAME TO dsm_errors;

-- ── Custom metrics ───────────────────────────────────────────
ALTER TABLE IF EXISTS smon_custom_metric_schedules RENAME TO custom_metric_schedules;
ALTER TABLE IF EXISTS smon_custom_metric_data      RENAME TO custom_metric_data;

-- ── Issue management ─────────────────────────────────────────
ALTER TABLE IF EXISTS smon_issues                RENAME TO issues;
ALTER TABLE IF EXISTS smon_issue_messages        RENAME TO issue_messages;
ALTER TABLE IF EXISTS smon_issue_evidence        RENAME TO issue_evidence;
ALTER TABLE IF EXISTS smon_issue_actions         RENAME TO issue_actions;
ALTER TABLE IF EXISTS smon_issue_facts           RENAME TO issue_facts;
ALTER TABLE IF EXISTS smon_issue_jobs            RENAME TO issue_jobs;
ALTER TABLE IF EXISTS smon_issue_state_transitions RENAME TO issue_state_transitions;
ALTER TABLE IF EXISTS smon_issue_stage_runs      RENAME TO issue_stage_runs;
ALTER TABLE IF EXISTS smon_issue_resolutions     RENAME TO issue_resolutions;
ALTER TABLE IF EXISTS smon_resolution_steps      RENAME TO resolution_steps;
ALTER TABLE IF EXISTS smon_resolution_log        RENAME TO resolution_log;
ALTER TABLE IF EXISTS smon_resolution_messages   RENAME TO resolution_messages;

-- ── Copilot ──────────────────────────────────────────────────
ALTER TABLE IF EXISTS smon_copilot_sessions  RENAME TO copilot_sessions;
ALTER TABLE IF EXISTS smon_copilot_messages  RENAME TO copilot_messages;
ALTER TABLE IF EXISTS smon_copilot_actions   RENAME TO copilot_actions;

-- ── Agent memory (may already be named correctly if 00030 ran fresh) ──
ALTER TABLE IF EXISTS smon_agent_memory RENAME TO agent_memory;

-- ── Wire up agent_memory.source_issue_id → issues(id) ───────
-- Deferred from 00030 because issues didn't have its final name yet.
ALTER TABLE IF EXISTS agent_memory
  ADD COLUMN IF NOT EXISTS source_issue_id UUID REFERENCES issues(id) ON DELETE SET NULL;


-- ============================================================
-- Rename major indexes (cosmetic but keeps naming consistent)
-- ============================================================

ALTER INDEX IF EXISTS idx_smon_nas_units_user          RENAME TO idx_nas_units_user;
ALTER INDEX IF EXISTS idx_smon_alerts_nas              RENAME TO idx_alerts_nas;
ALTER INDEX IF EXISTS idx_smon_alerts_status           RENAME TO idx_alerts_status;
ALTER INDEX IF EXISTS idx_smon_metrics_nas_type        RENAME TO idx_metrics_nas_type;
ALTER INDEX IF EXISTS idx_smon_logs_nas_source         RENAME TO idx_nas_logs_nas_source;
ALTER INDEX IF EXISTS idx_smon_logs_ingested           RENAME TO idx_nas_logs_ingested;
ALTER INDEX IF EXISTS idx_smon_process_snapshots_nas   RENAME TO idx_process_snapshots_nas;
ALTER INDEX IF EXISTS idx_smon_disk_io_stats_nas       RENAME TO idx_disk_io_stats_nas;
ALTER INDEX IF EXISTS idx_smon_net_connections_nas     RENAME TO idx_net_connections_nas;
ALTER INDEX IF EXISTS idx_smon_container_io_nas        RENAME TO idx_container_io_nas;
ALTER INDEX IF EXISTS idx_smon_scheduled_tasks_nas     RENAME TO idx_scheduled_tasks_nas;
ALTER INDEX IF EXISTS idx_smon_backup_tasks_nas        RENAME TO idx_backup_tasks_nas;
ALTER INDEX IF EXISTS idx_smon_snapshot_replicas_nas   RENAME TO idx_snapshot_replicas_nas;
ALTER INDEX IF EXISTS idx_smon_package_status_nas      RENAME TO idx_package_status_nas;
ALTER INDEX IF EXISTS idx_smon_dsm_errors_nas_time     RENAME TO idx_dsm_errors_nas_time;
ALTER INDEX IF EXISTS idx_smon_issues_user             RENAME TO idx_issues_user;
ALTER INDEX IF EXISTS idx_smon_issues_status           RENAME TO idx_issues_status;
ALTER INDEX IF EXISTS idx_smon_issue_messages_issue    RENAME TO idx_issue_messages_issue;
ALTER INDEX IF EXISTS idx_smon_issue_evidence_issue    RENAME TO idx_issue_evidence_issue;
ALTER INDEX IF EXISTS idx_smon_issue_actions_issue     RENAME TO idx_issue_actions_issue;
ALTER INDEX IF EXISTS idx_smon_issue_stage_runs_issue  RENAME TO idx_issue_stage_runs_issue;
ALTER INDEX IF EXISTS idx_smon_capability_state_nas    RENAME TO idx_capability_state_nas;
ALTER INDEX IF EXISTS idx_smon_sync_remediations_nas   RENAME TO idx_sync_remediations_nas;
ALTER INDEX IF EXISTS idx_smon_agent_memory_user_nas   RENAME TO idx_agent_memory_user_nas;
ALTER INDEX IF EXISTS idx_smon_agent_memory_user_created RENAME TO idx_agent_memory_user_created;


-- ============================================================
-- Update stored functions — rewrite bodies with new table names
-- ============================================================

CREATE OR REPLACE FUNCTION smon_get_openai_key()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE api_key text;
BEGIN
  SELECT decrypted_secret INTO api_key FROM vault.decrypted_secrets
  WHERE name = 'smon_openai_api_key' LIMIT 1;
  RETURN api_key;
END;
$$;

CREATE OR REPLACE FUNCTION smon_create_alert(
  p_nas_id uuid, p_severity text, p_title text, p_message text, p_details jsonb DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE alert_id uuid;
BEGIN
  INSERT INTO alerts (nas_id, severity, status, source, title, message, details)
  VALUES (p_nas_id, p_severity, 'active', 'ai', p_title, p_message, p_details)
  RETURNING id INTO alert_id;
  RETURN alert_id;
END;
$$;

CREATE OR REPLACE FUNCTION smon_run_anomaly_detection()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  api_key text;
  metrics_summary jsonb;
  nas record;
  prompt_text text;
  has_anomaly boolean := false;
BEGIN
  api_key := smon_get_openai_key();
  IF api_key IS NULL THEN RETURN; END IF;

  FOR nas IN SELECT id, name FROM nas_units WHERE status != 'offline' LOOP
    SELECT jsonb_agg(jsonb_build_object(
      'metric', type, 'avg', round(avg_val::numeric,2), 'max', round(max_val::numeric,2),
      'min', round(min_val::numeric,2), 'stddev', round(coalesce(stddev_val,0)::numeric,2),
      'current', round(latest_val::numeric,2), 'unit', unit
    ))
    INTO metrics_summary
    FROM (
      SELECT type, unit, avg(value) AS avg_val, max(value) AS max_val, min(value) AS min_val,
             stddev(value) AS stddev_val, (array_agg(value ORDER BY recorded_at DESC))[1] AS latest_val
      FROM metrics WHERE nas_id = nas.id AND recorded_at > now() - interval '1 hour'
      GROUP BY type, unit
    ) agg;

    IF metrics_summary IS NULL THEN CONTINUE; END IF;

    SELECT exists(
      SELECT 1 FROM jsonb_array_elements(metrics_summary) elem
      WHERE (elem->>'stddev')::float > 0
        AND abs((elem->>'current')::float - (elem->>'avg')::float) > 1.5*(elem->>'stddev')::float
    ) INTO has_anomaly;

    IF NOT has_anomaly THEN CONTINUE; END IF;

    prompt_text := format(
      'You are a NAS monitoring AI. Analyze these metrics from NAS "%s" and identify anomalies. '
      'Respond in JSON: {"anomalies":[{"severity":"...","category":"...","description":"...","recommendation":"..."}],"summary":"..."}'
      E'\n\nMetrics:\n%s', nas.name, metrics_summary::text
    );

    PERFORM net.http_post(
      url := 'https://api.openai.com/v1/chat/completions',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||api_key),
      body := jsonb_build_object(
        'model','gpt-5.4-mini','max_tokens',1000,
        'response_format',jsonb_build_object('type','json_object'),
        'messages',jsonb_build_array(
          jsonb_build_object('role','system','content','You are a NAS infrastructure monitoring AI. Respond only in valid JSON.'),
          jsonb_build_object('role','user','content',prompt_text)
        )
      )
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION smon_run_daily_health()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  api_key text;
  report_data jsonb;
  prompt_text text;
BEGIN
  api_key := smon_get_openai_key();
  IF api_key IS NULL THEN RETURN; END IF;

  SELECT jsonb_build_object(
    'nas_units', (SELECT jsonb_agg(jsonb_build_object('name',name,'status',status,'last_seen',last_seen)) FROM nas_units),
    'metrics_24h', (
      SELECT jsonb_agg(jsonb_build_object(
        'nas_name',n.name,'metric',m.type,
        'avg',round(avg(m.value)::numeric,2),'max',round(max(m.value)::numeric,2),'min',round(min(m.value)::numeric,2)
      ))
      FROM metrics m JOIN nas_units n ON m.nas_id = n.id
      WHERE m.recorded_at > now() - interval '24 hours' GROUP BY n.name, m.type
    ),
    'storage', (
      SELECT jsonb_agg(distinct_on_vol) FROM (
        SELECT DISTINCT ON (nas_id, volume_id)
          jsonb_build_object('nas_name',n.name,'volume',s.volume_path,
            'used_pct',round((s.used_bytes::numeric/nullif(s.total_bytes,0)*100),1),
            'status',s.status,'raid_type',s.raid_type) AS distinct_on_vol
        FROM storage_snapshots s JOIN nas_units n ON s.nas_id = n.id
        ORDER BY nas_id, volume_id, recorded_at DESC
      ) latest
    ),
    'active_alerts', (SELECT count(*) FROM alerts WHERE status = 'active'),
    'security_events_24h', (SELECT count(*) FROM security_events WHERE detected_at > now() - interval '24 hours'),
    'recent_security', (
      SELECT jsonb_agg(jsonb_build_object('type',type,'severity',severity,'title',title))
      FROM (SELECT type,severity,title FROM security_events WHERE detected_at > now() - interval '24 hours' ORDER BY detected_at DESC LIMIT 10) r
    )
  ) INTO report_data;

  prompt_text := format(
    'Generate a daily health report for my Synology NAS infrastructure. '
    'Respond in JSON: {"overall_status":"healthy|warning|critical","summary":"...","findings":[{"severity":"...","category":"...","description":"..."}],"recommendations":["..."],"storage_predictions":[{"volume":"...","days_until_full":0,"recommendation":"..."}]}'
    E'\n\nData:\n%s', report_data::text
  );

  PERFORM net.http_post(
    url := 'https://api.openai.com/v1/chat/completions',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||api_key),
    body := jsonb_build_object(
      'model','gpt-5.4-mini','max_tokens',1500,
      'response_format',jsonb_build_object('type','json_object'),
      'messages',jsonb_build_array(
        jsonb_build_object('role','system','content','You are a NAS infrastructure monitoring AI. Respond only in valid JSON.'),
        jsonb_build_object('role','user','content',prompt_text)
      )
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION smon_process_ai_responses()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  resp record; body jsonb; choices jsonb; content jsonb;
  analysis_type text; finding jsonb;
BEGIN
  FOR resp IN
    SELECT id, status_code, body::jsonb AS response_body FROM net._http_response
    WHERE status_code IS NOT NULL AND body::text LIKE '%"choices"%'
      AND id NOT IN (SELECT (details->>'pg_net_id')::bigint FROM ai_analyses WHERE details ? 'pg_net_id')
    ORDER BY created DESC LIMIT 10
  LOOP
    BEGIN
      body := resp.response_body; choices := body->'choices';
      IF choices IS NULL OR jsonb_array_length(choices) = 0 THEN CONTINUE; END IF;
      content := (choices->0->'message'->>'content')::jsonb;
      analysis_type := CASE
        WHEN content ? 'anomalies' THEN 'anomaly_detection'
        WHEN content ? 'overall_status' THEN 'daily_health'
        WHEN content ? 'security_findings' THEN 'security_review'
        WHEN content ? 'storage_predictions' THEN 'storage_prediction'
        ELSE 'anomaly_detection' END;

      INSERT INTO ai_analyses (type, summary, findings, recommendations, model, tokens_used, details)
      VALUES (
        analysis_type,
        coalesce(content->>'summary', content->>'overall_status', 'Analysis complete'),
        coalesce(content->'findings', content->'anomalies', '[]'::jsonb),
        coalesce(content->'recommendations', '[]'::jsonb),
        'gpt-5.4-mini', coalesce((body->'usage'->>'total_tokens')::int, 0),
        jsonb_build_object('pg_net_id', resp.id)
      );

      FOR finding IN SELECT * FROM jsonb_array_elements(coalesce(content->'findings', content->'anomalies', '[]'::jsonb)) LOOP
        IF finding->>'severity' IN ('warning','critical') THEN
          PERFORM smon_create_alert(null, finding->>'severity',
            format('AI: %s', coalesce(finding->>'category', finding->>'description')),
            coalesce(finding->>'description',''), finding);
        END IF;
      END LOOP;
    EXCEPTION WHEN others THEN CONTINUE;
    END;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION smon_detect_sync_anomalies()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  conflict_count int; empty_folder_count int; sync_error_count int; rapid_delete_count int; nas record;
BEGIN
  FOR nas IN SELECT id, name FROM nas_units WHERE status != 'offline' LOOP
    SELECT count(*) INTO conflict_count FROM nas_logs
    WHERE nas_id=nas.id AND source IN ('drive','drive_sharesync')
      AND message ILIKE '%conflict%' AND ingested_at > now()-interval '1 hour';

    SELECT count(*) INTO empty_folder_count FROM nas_logs
    WHERE nas_id=nas.id AND source IN ('drive','drive_sharesync')
      AND (message ILIKE '%mkdir%' OR message ILIKE '%create%folder%')
      AND message NOT ILIKE '%file%' AND ingested_at > now()-interval '1 hour';

    SELECT count(*) INTO sync_error_count FROM nas_logs
    WHERE nas_id=nas.id AND source IN ('drive','drive_sharesync','drive_server')
      AND severity IN ('error','critical') AND ingested_at > now()-interval '1 hour';

    SELECT count(*) INTO rapid_delete_count FROM nas_logs
    WHERE nas_id=nas.id AND source IN ('drive','drive_sharesync')
      AND (message ILIKE '%delete%' OR message ILIKE '%remove%')
      AND ingested_at > now()-interval '5 minutes';

    IF conflict_count > 3 THEN
      INSERT INTO alerts (nas_id,severity,status,source,title,message,details) VALUES
        (nas.id,'warning','active','ai','High Sync Conflict Rate Detected',
         format('%s sync conflicts in last hour on %s.',conflict_count,nas.name),
         jsonb_build_object('conflict_count',conflict_count,'time_window','1 hour'));
    END IF;
    IF sync_error_count > 0 THEN
      INSERT INTO alerts (nas_id,severity,status,source,title,message,details) VALUES
        (nas.id,'error','active','ai','Sync Errors Detected',
         format('%s sync errors in last hour on %s.',sync_error_count,nas.name),
         jsonb_build_object('error_count',sync_error_count,'time_window','1 hour'));
    END IF;
    IF rapid_delete_count > 5 THEN
      INSERT INTO alerts (nas_id,severity,status,source,title,message,details) VALUES
        (nas.id,'warning','active','ai','Rapid Delete Activity',
         format('%s deletes in 5 min on %s.',rapid_delete_count,nas.name),
         jsonb_build_object('delete_count',rapid_delete_count,'time_window','5 minutes'));
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION smon_analyze_sync_health()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  api_key text; analysis_data jsonb; nas record; recent_logs jsonb; prompt_text text;
BEGIN
  api_key := smon_get_openai_key();
  IF api_key IS NULL THEN RETURN; END IF;

  FOR nas IN SELECT id, name FROM nas_units WHERE status != 'offline' LIMIT 1 LOOP
    SELECT jsonb_agg(jsonb_build_object(
      'source',source,'severity',severity,'message',substring(message,1,500),
      'user',metadata->>'user','action',metadata->>'action','path',metadata->>'path','logged_at',logged_at
    )) INTO recent_logs
    FROM nas_logs WHERE nas_id=nas.id AND source IN ('drive','drive_sharesync','drive_server')
      AND ingested_at > now()-interval '24 hours' ORDER BY ingested_at DESC LIMIT 100;

    IF recent_logs IS NULL OR jsonb_array_length(recent_logs) = 0 THEN CONTINUE; END IF;

    INSERT INTO ai_analyses (nas_id,type,summary,findings,recommendations,model,details) VALUES
      (nas.id,'anomaly_detection','Sync health analysis in progress','[]'::jsonb,'[]'::jsonb,'gpt-5.4',
       jsonb_build_object('sync_analysis',true,'nas_name',nas.name,'created_by','smon_analyze_sync_health'));
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION smon_generate_weekly_sync_report()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE report_data jsonb;
BEGIN
  SELECT jsonb_build_object(
    'total_sync_events', (SELECT count(*) FROM nas_logs WHERE source IN ('drive','drive_sharesync','drive_server') AND ingested_at > now()-interval '7 days'),
    'total_conflicts',   (SELECT count(*) FROM nas_logs WHERE source IN ('drive','drive_sharesync','drive_server') AND message ILIKE '%conflict%' AND ingested_at > now()-interval '7 days'),
    'total_errors',      (SELECT count(*) FROM nas_logs WHERE source IN ('drive','drive_sharesync','drive_server') AND severity IN ('error','critical') AND ingested_at > now()-interval '7 days'),
    'active_users',      (SELECT count(DISTINCT metadata->>'user') FROM nas_logs WHERE source IN ('drive','drive_sharesync') AND metadata->>'user' IS NOT NULL AND ingested_at > now()-interval '7 days')
  ) INTO report_data;

  INSERT INTO alerts (nas_id,severity,status,source,title,message,details) VALUES
    (null,'info','active','ai','Weekly Sync Report Generated',
     format('Weekly sync analysis complete. Events: %s, Conflicts: %s, Errors: %s',
       report_data->>'total_sync_events', report_data->>'total_conflicts', report_data->>'total_errors'),
     report_data);
END;
$$;

CREATE OR REPLACE FUNCTION smon_detect_stuck_syncs()
RETURNS TABLE (nas_id UUID, nas_name TEXT, task_info TEXT, file_path TEXT, task_id TEXT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE stuck_log RECORD;
BEGIN
  FOR stuck_log IN
    SELECT sl.nas_id, nas.name, sl.message, sl.logged_at
    FROM nas_logs sl JOIN nas_units nas ON sl.nas_id = nas.id
    WHERE sl.source IN ('drive_sharesync','drive_server')
      AND sl.message ILIKE '%syncing%' AND sl.message NOT ILIKE '%done%'
      AND sl.message NOT ILIKE '%complete%' AND sl.message NOT ILIKE '%error%'
      AND sl.ingested_at > now()-interval '30 minutes'
    ORDER BY sl.ingested_at DESC
  LOOP
    nas_id := stuck_log.nas_id; nas_name := stuck_log.name;
    task_info := stuck_log.message; file_path := null; task_id := null;
    RETURN NEXT;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION smon_detect_sync_conflicts()
RETURNS TABLE (nas_id UUID, nas_name TEXT, file_path TEXT, conflict_type TEXT, both_sides JSONB)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE conflict_log RECORD;
BEGIN
  FOR conflict_log IN
    SELECT sl.nas_id, nas.name, sl.message, sl.metadata
    FROM nas_logs sl JOIN nas_units nas ON sl.nas_id = nas.id
    WHERE sl.source IN ('drive_sharesync')
      AND (sl.message ILIKE '%conflict%' OR sl.message ILIKE '%both modified%'
        OR sl.message ILIKE '%version conflict%' OR sl.message ILIKE '%already exists%')
      AND sl.ingested_at > now()-interval '1 hour'
    ORDER BY sl.ingested_at DESC
  LOOP
    nas_id := conflict_log.nas_id; nas_name := conflict_log.name;
    file_path := conflict_log.metadata->>'path';
    conflict_type := CASE WHEN conflict_log.message ILIKE '%conflict%' THEN 'file_conflict'
                          WHEN conflict_log.message ILIKE '%already exists%' THEN 'duplicate_exists'
                          ELSE 'version_conflict' END;
    both_sides := conflict_log.metadata;
    RETURN NEXT;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION smon_detect_invalid_chars()
RETURNS TABLE (nas_id UUID, nas_name TEXT, file_path TEXT, invalid_chars TEXT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE invalid_log RECORD;
BEGIN
  FOR invalid_log IN
    SELECT sl.nas_id, nas.name, sl.message, sl.metadata
    FROM nas_logs sl JOIN nas_units nas ON sl.nas_id = nas.id
    WHERE sl.source IN ('drive_sharesync','drive_server')
      AND (sl.message ILIKE '%invalid%character%' OR sl.message ILIKE '%forbidden%char%'
        OR sl.message ILIKE '%error code 22%' OR sl.message ILIKE '% EINVAL%')
      AND sl.ingested_at > now()-interval '24 hours'
    ORDER BY sl.ingested_at DESC
  LOOP
    nas_id := invalid_log.nas_id; nas_name := invalid_log.name;
    file_path := invalid_log.metadata->>'path'; invalid_chars := 'special_chars';
    RETURN NEXT;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION smon_detect_lock_timeouts()
RETURNS TABLE (nas_id UUID, nas_name TEXT, file_path TEXT, lock_info TEXT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE lock_log RECORD;
BEGIN
  FOR lock_log IN
    SELECT sl.nas_id, nas.name, sl.message, sl.metadata
    FROM nas_logs sl JOIN nas_units nas ON sl.nas_id = nas.id
    WHERE sl.source IN ('drive_sharesync','drive_server')
      AND (sl.message ILIKE '%lock timeout%' OR sl.message ILIKE '%could not%lock%'
        OR sl.message ILIKE '%database is locked%' OR sl.message ILIKE '%resource busy%')
      AND sl.ingested_at > now()-interval '1 hour'
    ORDER BY sl.ingested_at DESC
  LOOP
    nas_id := lock_log.nas_id; nas_name := lock_log.name;
    file_path := lock_log.metadata->>'path'; lock_info := 'lock_timeout';
    RETURN NEXT;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION smon_run_sync_remediation()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  stuck RECORD; conflict RECORD; invalid RECORD; lock_issue RECORD;
  remediated_count INT := 0;
BEGIN
  FOR stuck IN SELECT * FROM smon_detect_stuck_syncs() LOOP
    IF NOT EXISTS (SELECT 1 FROM sync_remediations WHERE nas_id=stuck.nas_id AND file_path=stuck.file_path
        AND created_at > now()-interval '1 hour' AND status IN ('pending','in_progress')) THEN
      INSERT INTO sync_remediations (nas_id,task_id,file_path,issue_type,action_taken,details,status)
      VALUES (stuck.nas_id,stuck.task_id,stuck.file_path,'stuck_sync','flagged_for_review',
        jsonb_build_object('task_info',stuck.task_info,'detected_at',now()),'pending');
      remediated_count := remediated_count + 1;
    END IF;
  END LOOP;

  FOR conflict IN SELECT * FROM smon_detect_sync_conflicts() LOOP
    IF conflict.file_path IS NOT NULL AND conflict.file_path != '' THEN
      INSERT INTO sync_remediations (nas_id,file_path,issue_type,original_name,action_taken,details,status)
      VALUES (conflict.nas_id,conflict.file_path,'conflict',conflict.file_path,'renamed_to_old',
        jsonb_build_object('conflict_type',conflict.conflict_type,'detected_at',now()),'pending');
      remediated_count := remediated_count + 1;
    END IF;
  END LOOP;

  FOR invalid IN SELECT * FROM smon_detect_invalid_chars() LOOP
    INSERT INTO sync_remediations (nas_id,file_path,issue_type,action_taken,details,status)
    VALUES (invalid.nas_id,invalid.file_path,'invalid_chars','flagged_for_review',
      jsonb_build_object('invalid_chars_found',invalid.invalid_chars,'detected_at',now()),'pending');
    remediated_count := remediated_count + 1;
  END LOOP;

  FOR lock_issue IN SELECT * FROM smon_detect_lock_timeouts() LOOP
    INSERT INTO sync_remediations (nas_id,file_path,issue_type,action_taken,details,status)
    VALUES (lock_issue.nas_id,lock_issue.file_path,'lock_timeout','cleared_lock',
      jsonb_build_object('detected_at',now()),'completed');
    remediated_count := remediated_count + 1;
  END LOOP;

  IF remediated_count > 0 THEN
    INSERT INTO alerts (nas_id,severity,status,source,title,message,details) VALUES
      (null,'warning','active','ai','ShareSync Issues Detected - Review Required',
       format('%s ShareSync issues detected and logged.',remediated_count),
       jsonb_build_object('issue_count',remediated_count,'checked_at',now()));
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION increment_metric_references(schedule_ids uuid[])
RETURNS void LANGUAGE sql AS $$
  UPDATE custom_metric_schedules SET referenced_count = referenced_count + 1 WHERE id = ANY(schedule_ids);
$$;


-- ============================================================
-- Update pg_cron job names and function references
-- ============================================================

-- Remove old cron jobs (safe if pg_cron is installed; silently skips if not)
DO $outer$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    DELETE FROM cron.job WHERE jobname IN (
      'smon-partition-maintenance',
      'smon-anomaly-detection',
      'smon-daily-health',
      'smon-process-ai-responses',
      'smon-sync-anomaly-detection',
      'smon-sync-health-analysis',
      'smon-weekly-sync-report',
      'smon-sync-remediation'
    );

    -- Re-register with clean names
    PERFORM cron.schedule('partition-maintenance',  '0 7 * * *',   'SELECT public.run_maintenance_proc()');
    PERFORM cron.schedule('anomaly-detection',      '*/15 * * * *', 'SELECT smon_run_anomaly_detection()');
    PERFORM cron.schedule('daily-health',           '0 12 * * *',  'SELECT smon_run_daily_health()');
    PERFORM cron.schedule('process-ai-responses',   '* * * * *',   'SELECT smon_process_ai_responses()');
    PERFORM cron.schedule('sync-anomaly-detection', '*/15 * * * *', 'SELECT smon_detect_sync_anomalies()');
    PERFORM cron.schedule('sync-health-analysis',   '0 */4 * * *', 'SELECT smon_analyze_sync_health()');
    PERFORM cron.schedule('weekly-sync-report',     '0 8 * * 0',   'SELECT smon_generate_weekly_sync_report()');
    PERFORM cron.schedule('sync-remediation',       '*/15 * * * *', 'SELECT smon_run_sync_remediation()');
  END IF;
END;
$outer$;
