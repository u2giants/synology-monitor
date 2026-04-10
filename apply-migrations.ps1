# Apply Supabase Migrations Script
# Run this script to apply the migrations to your Supabase database

$supabaseUrl = "https://qnjimovrsaacneqkggsn.supabase.co"
$serviceKey = "replace_with_service_role_key_from_supabase_dashboard"  # Project Settings > API > service_role key

# Read migration files
$migrations = @(
    @{
        name = "00008_create_drive_tables"
        sql = @"
-- Drive Team Folders - snapshot of team folder state
CREATE TABLE IF NOT EXISTS smon_drive_team_folders (
  id UUID DEFAULT gen_random_uuid(),
  nas_id UUID NOT NULL,
  folder_id TEXT NOT NULL,
  folder_name TEXT NOT NULL,
  folder_path TEXT,
  quota_bytes BIGINT DEFAULT 0,
  used_bytes BIGINT DEFAULT 0,
  usage_percent DOUBLE PRECISION DEFAULT 0,
  member_count INT DEFAULT 0,
  sync_count INT DEFAULT 0,
  is_external BOOLEAN DEFAULT false,
  priority TEXT,
  status TEXT,
  recorded_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (nas_id, folder_id, recorded_at)
);

-- Drive User Activities - individual user actions
CREATE TABLE IF NOT EXISTS smon_drive_activities (
  id UUID DEFAULT gen_random_uuid(),
  nas_id UUID NOT NULL,
  user TEXT NOT NULL,
  login_time TIMESTAMPTZ,
  ip TEXT,
  device TEXT,
  action TEXT NOT NULL,
  file_path TEXT,
  timestamp TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (nas_id, user, action, timestamp, recorded_at)
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS smon_drive_team_folders_nas_time ON smon_drive_team_folders (nas_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS smon_drive_team_folders_folder ON smon_drive_team_folders (nas_id, folder_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS smon_drive_activities_nas_time ON smon_drive_activities (nas_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS smon_drive_activities_user ON smon_drive_activities (nas_id, user, recorded_at DESC);
CREATE INDEX IF NOT EXISTS smon_drive_activities_action ON smon_drive_activities (nas_id, action, recorded_at DESC);

-- Enable RLS
ALTER TABLE smon_drive_team_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE smon_drive_activities ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "smon_drive_team_folders_read" ON smon_drive_team_folders FOR SELECT TO authenticated USING (true);
CREATE POLICY "smon_drive_activities_read" ON smon_drive_activities FOR SELECT TO authenticated USING (true);
"@
    },
    @{
        name = "00009_create_sync_anomaly_detection"
        sql = @"
-- Helper: get OpenAI API key from vault
CREATE OR REPLACE FUNCTION smon_get_openai_key() RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE api_key TEXT;
BEGIN SELECT decrypted_secret INTO api_key FROM vault.decrypted_secrets WHERE name = 'smon_openai_api_key' LIMIT 1;
RETURN api_key;
END;
$$;

-- Helper: create an alert from AI findings
CREATE OR REPLACE FUNCTION smon_create_alert(p_nas_id UUID, p_severity TEXT, p_title TEXT, p_message TEXT, p_details JSONB DEFAULT NULL) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE alert_id UUID;
BEGIN INSERT INTO smon_alerts (nas_id, severity, status, source, title, message, details) VALUES (p_nas_id, p_severity, 'active', 'ai', p_title, p_message, p_details) RETURNING id INTO alert_id;
RETURN alert_id;
END;
$$;

-- Detect sync anomalies
CREATE OR REPLACE FUNCTION smon_detect_sync_anomalies() RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE conflict_count INT; empty_folder_count INT; sync_error_count INT; rapid_delete_count INT; nas RECORD;
BEGIN FOR nas IN SELECT id, name FROM smon_nas_units WHERE status != 'offline' LOOP SELECT count(*) INTO conflict_count FROM smon_logs WHERE nas_id = nas.id AND source IN ('drive', 'drive_sharesync') AND message ILIKE '%conflict%' AND ingested_at > now() - interval '1 hour';
SELECT count(*) INTO empty_folder_count FROM smon_logs WHERE nas_id = nas.id AND source IN ('drive', 'drive_sharesync') AND (message ILIKE '%mkdir%' OR message ILIKE '%create%folder%') AND message NOT ILIKE '%file%' AND ingested_at > now() - interval '1 hour';
SELECT count(*) INTO sync_error_count FROM smon_logs WHERE nas_id = nas.id AND source IN ('drive', 'drive_sharesync', 'drive_server') AND severity IN ('error', 'critical') AND ingested_at > now() - interval '1 hour';
SELECT count(*) INTO rapid_delete_count FROM smon_logs WHERE nas_id = nas.id AND source IN ('drive', 'drive_sharesync') AND (message ILIKE '%delete%' OR message ILIKE '%remove%') AND ingested_at > now() - interval '5 minutes';
IF conflict_count > 3 THEN INSERT INTO smon_alerts (nas_id, severity, status, source, title, message, details) VALUES (nas.id, 'warning', 'active', 'ai', 'High Sync Conflict Rate Detected', format('%s sync conflicts detected in the last hour on NAS %s. This may indicate concurrent edits or sync configuration issues.', conflict_count, nas.name), jsonb_build_object('conflict_count', conflict_count, 'time_window', '1 hour', 'suggestion', 'Review recent activity to identify conflicting files.'));
END IF;
IF empty_folder_count > 5 THEN INSERT INTO smon_alerts (nas_id, severity, status, source, title, message, details) VALUES (nas.id, 'info', 'active', 'ai', 'Potential Empty Folder Creation', format('%s potential empty folder operations detected in the last hour on NAS %s.', empty_folder_count, nas.name), jsonb_build_object('empty_folder_count', empty_folder_count, 'time_window', '1 hour'));
END IF;
IF sync_error_count > 0 THEN INSERT INTO smon_alerts (nas_id, severity, status, source, title, message, details) VALUES (nas.id, 'error', 'active', 'ai', 'Sync Errors Detected', format('%s sync errors detected in the last hour on NAS %s.', sync_error_count, nas.name), jsonb_build_object('error_count', sync_error_count));
END IF;
IF rapid_delete_count > 5 THEN INSERT INTO smon_alerts (nas_id, severity, status, source, title, message, details) VALUES (nas.id, 'warning', 'active', 'ai', 'Rapid Delete Activity', format('%s delete operations in 5 minutes on NAS %s. This could indicate automated cleanup or potential data loss.', rapid_delete_count, nas.name), jsonb_build_object('delete_count', rapid_delete_count));
END IF;
END LOOP;
END;
$$;

-- Schedule sync anomaly detection (every 15 minutes)
SELECT cron.schedule('smon-sync-anomaly-detection', '*/15 * * * *', $$SELECT smon_detect_sync_anomalies()$$);
"@
    }
)

Write-Host "Applying Supabase Migrations..." -ForegroundColor Cyan
Write-Host ""

# Apply each migration
foreach ($migration in $migrations) {
    Write-Host "Applying: $($migration.name)" -ForegroundColor Yellow
    
    # Since we can't execute DDL directly via REST API without a custom function,
    # this script shows what needs to be done
    Write-Host "  SQL to execute:" -ForegroundColor Gray
    $migration.sql -split ";" | ForEach-Object { 
        $stmt = $_.Trim()
        if ($stmt -and $stmt.Length -gt 10) {
            Write-Host "    $($stmt.Substring(0, [Math]::Min(80, $stmt.Length)))..." -ForegroundColor DarkGray
        }
    }
    Write-Host ""
}

Write-Host "NOTE: To apply these migrations, you need to either:" -ForegroundColor Cyan
Write-Host "1. Go to Supabase Dashboard > SQL Editor and run the migration files manually" -ForegroundColor White
Write-Host "2. Or provide a Supabase personal access token (sbp_...)" -ForegroundColor White
Write-Host ""
Write-Host "Migration files location:" -ForegroundColor Cyan
Write-Host "  C:\Users\ahazan2\Desktop\synology-monitor\supabase\migrations\00008_create_drive_tables.sql" -ForegroundColor White
Write-Host "  C:\Users\ahazan2\Desktop\synology-monitor\supabase\migrations\00009_create_sync_anomaly_detection.sql" -ForegroundColor White
