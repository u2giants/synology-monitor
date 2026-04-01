-- Fix severity values in sync anomaly detection function
-- Valid severity values are: info, warning, critical

CREATE OR REPLACE FUNCTION smon_detect_sync_anomalies()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  conflict_count INT;
  empty_folder_count INT;
  sync_error_count INT;
  rapid_delete_count INT;
  nas RECORD;
BEGIN
  FOR nas IN SELECT id, name FROM smon_nas_units WHERE status != 'offline'
  LOOP
    SELECT count(*) INTO conflict_count
    FROM smon_logs
    WHERE nas_id = nas.id
      AND source IN ('drive', 'drive_sharesync')
      AND message ILIKE '%conflict%'
      AND ingested_at > now() - interval '1 hour';

    SELECT count(*) INTO empty_folder_count
    FROM smon_logs
    WHERE nas_id = nas.id
      AND source IN ('drive', 'drive_sharesync')
      AND (message ILIKE '%mkdir%' OR message ILIKE '%create%folder%')
      AND message NOT ILIKE '%file%'
      AND ingested_at > now() - interval '1 hour';

    SELECT count(*) INTO sync_error_count
    FROM smon_logs
    WHERE nas_id = nas.id
      AND source IN ('drive', 'drive_sharesync', 'drive_server')
      AND severity IN ('error', 'critical')
      AND ingested_at > now() - interval '1 hour';

    SELECT count(*) INTO rapid_delete_count
    FROM smon_logs
    WHERE nas_id = nas.id
      AND source IN ('drive', 'drive_sharesync')
      AND (message ILIKE '%delete%' OR message ILIKE '%remove%')
      AND ingested_at > now() - interval '5 minutes';

    IF conflict_count > 3 THEN
      INSERT INTO smon_alerts (nas_id, severity, status, source, title, message, details)
      VALUES (
        nas.id,
        'warning',
        'active',
        'ai',
        'High Sync Conflict Rate Detected',
        format('%s sync conflicts detected in the last hour on NAS %s. This may indicate concurrent edits or sync configuration issues.', conflict_count, nas.name),
        jsonb_build_object('conflict_count', conflict_count, 'time_window', '1 hour', 'suggestion', 'Review recent activity to identify conflicting files.')
      );
    END IF;

    IF empty_folder_count > 5 THEN
      INSERT INTO smon_alerts (nas_id, severity, status, source, title, message, details)
      VALUES (
        nas.id,
        'info',
        'active',
        'ai',
        'Potential Empty Folder Creation',
        format('%s potential empty folder operations detected in the last hour on NAS %s.', empty_folder_count, nas.name),
        jsonb_build_object('empty_folder_count', empty_folder_count, 'time_window', '1 hour')
      );
    END IF;

    IF sync_error_count > 0 THEN
      INSERT INTO smon_alerts (nas_id, severity, status, source, title, message, details)
      VALUES (
        nas.id,
        'critical',
        'active',
        'ai',
        'Sync Errors Detected',
        format('%s sync errors detected in the last hour on NAS %s.', sync_error_count, nas.name),
        jsonb_build_object('error_count', sync_error_count)
      );
    END IF;

    IF rapid_delete_count > 5 THEN
      INSERT INTO smon_alerts (nas_id, severity, status, source, title, message, details)
      VALUES (
        nas.id,
        'warning',
        'active',
        'ai',
        'Rapid Delete Activity',
        format('%s delete operations in 5 minutes on NAS %s. This could indicate automated cleanup or potential data loss.', rapid_delete_count, nas.name),
        jsonb_build_object('delete_count', rapid_delete_count)
      );
    END IF;
  END LOOP;
END;
$$;
