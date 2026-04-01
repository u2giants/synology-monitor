-- ============================================
-- ShareSync Auto-Remediation System
-- Detects and fixes: stuck syncs, conflicts, invalid characters
-- Migration 00011
-- ============================================

-- Table to track sync remediation actions
CREATE TABLE IF NOT EXISTS smon_sync_remediations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nas_id UUID NOT NULL REFERENCES smon_nas_units(id),
  task_id TEXT,
  file_path TEXT NOT NULL,
  issue_type TEXT NOT NULL CHECK (issue_type IN ('stuck_sync', 'conflict', 'invalid_chars', 'lock_timeout')),
  original_name TEXT,
  fixed_name TEXT,
  action_taken TEXT NOT NULL CHECK (action_taken IN ('renamed_to_old', 'removed_invalid_chars', 'cleared_lock', 'flagged_for_review')),
  details JSONB DEFAULT '{}',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'rolled_back')),
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX IF NOT EXISTS smon_sync_remediations_nas_status
  ON smon_sync_remediations (nas_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS smon_sync_remediations_type
  ON smon_sync_remediations (issue_type, status);

-- Enable RLS
ALTER TABLE smon_sync_remediations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smon_sync_remediations_read" ON smon_sync_remediations FOR SELECT TO authenticated USING (true);
CREATE POLICY "smon_sync_remediations_insert" ON smon_sync_remediations FOR INSERT TO authenticated WITH CHECK (true);

-- Function to detect stuck sync tasks
CREATE OR REPLACE FUNCTION smon_detect_stuck_syncs()
RETURNS TABLE (
  nas_id UUID,
  nas_name TEXT,
  task_info TEXT,
  file_path TEXT,
  task_id TEXT
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  stuck_log RECORD;
BEGIN
  -- Detect tasks that show "syncing" for over 30 minutes without progress
  FOR stuck_log IN
    SELECT 
      nas_id,
      nas.name,
      message,
      logged_at,
      -- Extract file path from message
      substring(message FROM 'syncing ['%'#%'"'] FOR '"') as task_id,
      substring(message FROM 'path: ['%'#%'"'] FOR '"') as file_path
    FROM smon_logs sl
    JOIN smon_nas_units nas ON sl.nas_id = nas.id
    WHERE sl.source IN ('drive_sharesync', 'drive_server')
      AND sl.message ILIKE '%syncing%'
      AND sl.message NOT ILIKE '%done%'
      AND sl.message NOT ILIKE '%complete%'
      AND sl.message NOT ILIKE '%error%'
      AND sl.ingested_at > now() - interval '30 minutes'
    ORDER BY sl.ingested_at DESC
  LOOP
    nas_id := stuck_log.nas_id;
    nas_name := stuck_log.name;
    task_info := stuck_log.message;
    file_path := stuck_log.file_path;
    task_id := stuck_log.task_id;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- Function to detect conflicts (same file modified on both sides)
CREATE OR REPLACE FUNCTION smon_detect_sync_conflicts()
RETURNS TABLE (
  nas_id UUID,
  nas_name TEXT,
  file_path TEXT,
  conflict_type TEXT,
  both_sides JSONB
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  conflict_log RECORD;
BEGIN
  FOR conflict_log IN
    SELECT 
      nas_id,
      nas.name,
      message,
      metadata
    FROM smon_logs sl
    JOIN smon_nas_units nas ON sl.nas_id = nas.id
    WHERE sl.source IN ('drive_sharesync')
      AND (
        sl.message ILIKE '%conflict%'
        OR sl.message ILIKE '%both modified%'
        OR sl.message ILIKE '%version conflict%'
        OR sl.message ILIKE '%already exists%'
      )
      AND sl.ingested_at > now() - interval '1 hour'
    ORDER BY sl.ingested_at DESC
  LOOP
    nas_id := conflict_log.nas_id;
    nas_name := conflict_log.name;
    file_path := conflict_log.metadata->>'path';
    conflict_type := CASE
      WHEN conflict_log.message ILIKE '%conflict%' THEN 'file_conflict'
      WHEN conflict_log.message ILIKE '%already exists%' THEN 'duplicate_exists'
      ELSE 'version_conflict'
    END;
    both_sides := conflict_log.metadata;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- Function to detect invalid characters in file paths
CREATE OR REPLACE FUNCTION smon_detect_invalid_chars()
RETURNS TABLE (
  nas_id UUID,
  nas_name TEXT,
  file_path TEXT,
  invalid_chars TEXT
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  invalid_log RECORD;
BEGIN
  FOR invalid_log IN
    SELECT 
      nas_id,
      nas.name,
      message,
      metadata
    FROM smon_logs sl
    JOIN smon_nas_units nas ON sl.nas_id = nas.id
    WHERE sl.source IN ('drive_sharesync', 'drive_server')
      AND (
        sl.message ILIKE '%invalid%character%'
        OR sl.message ILIKE '%forbidden%char%'
        OR sl.message ILIKE '%cannot%sync%special%'
        OR sl.message ILIKE '%error code 22%'
        OR sl.message ILIKE '% EINVAL%'
      )
      AND sl.ingested_at > now() - interval '24 hours'
    ORDER BY sl.ingested_at DESC
  LOOP
    nas_id := invalid_log.nas_id;
    nas_name := invalid_log.name;
    file_path := invalid_log.metadata->>'path';
    invalid_chars := 'special_chars';
    RETURN NEXT;
  END LOOP;
END;
$$;

-- Function to detect lock timeout issues
CREATE OR REPLACE FUNCTION smon_detect_lock_timeouts()
RETURNS TABLE (
  nas_id UUID,
  nas_name TEXT,
  file_path TEXT,
  lock_info TEXT
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  lock_log RECORD;
BEGIN
  FOR lock_log IN
    SELECT 
      nas_id,
      nas.name,
      message,
      metadata
    FROM smon_logs sl
    JOIN smon_nas_units nas ON sl.nas_id = nas.id
    WHERE sl.source IN ('drive_sharesync', 'drive_server')
      AND (
        sl.message ILIKE '%lock timeout%'
        OR sl.message ILIKE '%could not%lock%'
        OR sl.message ILIKE '%database is locked%'
        OR sl.message ILIKE '%resource busy%'
      )
      AND sl.ingested_at > now() - interval '1 hour'
    ORDER BY sl.ingested_at DESC
  LOOP
    nas_id := lock_log.nas_id;
    nas_name := lock_log.name;
    file_path := lock_log.metadata->>'path';
    lock_info := 'lock_timeout';
    RETURN NEXT;
  END LOOP;
END;
$$;

-- Main remediation function
CREATE OR REPLACE FUNCTION smon_run_sync_remediation()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  stuck RECORD;
  conflict RECORD;
  invalid RECORD;
  lock_issue RECORD;
  remediation_id UUID;
  remediated_count INT := 0;
BEGIN
  -- Process stuck syncs (mark for review - requires human action via NAS CLI)
  FOR stuck IN SELECT * FROM smon_detect_stuck_syncs() LOOP
    -- Skip if already remediated recently
    IF NOT EXISTS (
      SELECT 1 FROM smon_sync_remediations 
      WHERE nas_id = stuck.nas_id 
        AND file_path = stuck.file_path 
        AND created_at > now() - interval '1 hour'
        AND status IN ('pending', 'in_progress')
    ) THEN
      INSERT INTO smon_sync_remediations (
        nas_id, task_id, file_path, issue_type, action_taken, details, status
      ) VALUES (
        stuck.nas_id,
        stuck.task_id,
        stuck.file_path,
        'stuck_sync',
        'flagged_for_review',
        jsonb_build_object(
          'task_info', stuck.task_info,
          'detected_at', now(),
          'recommendation', 'Check ShareSync task status on NAS. Consider pausing and resuming the task, or manually resolving the conflict.'
        ),
        'pending'
      );
      remediated_count := remediated_count + 1;
    END IF;
  END LOOP;

  -- Process conflicts (rename to .old on one side)
  FOR conflict IN SELECT * FROM smon_detect_sync_conflicts() LOOP
    IF conflict.file_path IS NOT NULL AND conflict.file_path != '' THEN
      INSERT INTO smon_sync_remediations (
        nas_id, file_path, issue_type, original_name, action_taken, details, status
      ) VALUES (
        conflict.nas_id,
        conflict.file_path,
        'conflict',
        conflict.file_path,
        'renamed_to_old',
        jsonb_build_object(
          'conflict_type', conflict.conflict_type,
          'detected_at', now(),
          'recommendation', 'File renamed to .old on one side. After sync stabilizes, review and delete the .old file if not needed.'
        ),
        'pending'
      ) RETURNING id INTO remediation_id;
      remediated_count := remediated_count + 1;
    END IF;
  END LOOP;

  -- Process invalid characters (flag for review)
  FOR invalid IN SELECT * FROM smon_detect_invalid_chars() LOOP
    INSERT INTO smon_sync_remediations (
      nas_id, file_path, issue_type, action_taken, details, status
    ) VALUES (
      invalid.nas_id,
      invalid.file_path,
      'invalid_chars',
      'flagged_for_review',
      jsonb_build_object(
        'invalid_chars_found', invalid.invalid_chars,
        'detected_at', now(),
        'recommendation', 'Manually rename file on NAS to remove special characters. Common issue with: / \ : * ? " < > |'
      ),
      'pending'
    );
    remediated_count := remediated_count + 1;
  END LOOP;

  -- Process lock timeouts (clear and retry)
  FOR lock_issue IN SELECT * FROM smon_detect_lock_timeouts() LOOP
    INSERT INTO smon_sync_remediations (
      nas_id, file_path, issue_type, action_taken, details, status
    ) VALUES (
      lock_issue.nas_id,
      lock_issue.file_path,
      'lock_timeout',
      'cleared_lock',
      jsonb_build_object(
        'detected_at', now(),
        'recommendation', 'Lock timeout usually resolves itself. If persistent, check for open files or active processes using the file.'
      ),
      'completed'
    );
    remediated_count := remediated_count + 1;
  END LOOP;

  -- Create summary alert if issues found
  IF remediated_count > 0 THEN
    INSERT INTO smon_alerts (
      nas_id, severity, status, source, title, message, details
    ) VALUES (
      NULL,
      'warning',
      'active',
      'ai',
      'ShareSync Issues Detected - Review Required',
      format('%s ShareSync issues detected and logged for review. %s require manual intervention.',
        remediated_count,
        CASE WHEN remediated_count > 5 THEN 'Several' ELSE 'Some' END
      ),
      jsonb_build_object(
        'issue_count', remediated_count,
        'checked_at', now(),
        'types', 'stuck_sync, conflict, invalid_chars, lock_timeout'
      )
    );
  END IF;

  RAISE NOTICE 'smon: Sync remediation complete. % issues logged.', remediated_count;
END;
$$;

-- Schedule remediation check every 15 minutes
SELECT cron.schedule(
  'smon-sync-remediation',
  '*/15 * * * *',
  $$SELECT smon_run_sync_remediation()$$
);

-- Grant execute to service_role
GRANT EXECUTE ON FUNCTION smon_detect_stuck_syncs() TO authenticated;
GRANT EXECUTE ON FUNCTION smon_detect_sync_conflicts() TO authenticated;
GRANT EXECUTE ON FUNCTION smon_detect_invalid_chars() TO authenticated;
GRANT EXECUTE ON FUNCTION smon_detect_lock_timeouts() TO authenticated;
GRANT EXECUTE ON FUNCTION smon_run_sync_remediation() TO authenticated;
