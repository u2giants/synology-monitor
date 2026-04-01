-- ============================================
-- Sync-Specific Anomaly Detection
-- Migration 00009
-- Focus on: conflicts, empty folders, missing files
-- ============================================

-- Helper: detect sync anomalies (conflicts, empty folders, missing files)
create or replace function smon_detect_sync_anomalies()
returns void
language plpgsql
security definer
as $$
declare
  conflict_count int;
  empty_folder_count int;
  sync_error_count int;
  rapid_delete_count int;
  nas record;
begin
  for nas in select id, name from smon_nas_units where status != 'offline'
  loop
    -- Count recent conflicts (last hour)
    select count(*) into conflict_count
    from smon_logs
    where nas_id = nas.id
      and source in ('drive', 'drive_sharesync')
      and message ilike '%conflict%'
      and ingested_at > now() - interval '1 hour';

    -- Count potential empty folder creation patterns (last hour)
    -- Empty folders often created when sync fails or during cleanup
    select count(*) into empty_folder_count
    from smon_logs
    where nas_id = nas.id
      and source in ('drive', 'drive_sharesync')
      and (
        message ilike '%mkdir%' 
        or message ilike '%create%folder%'
      )
      and message not ilike '%file%'
      and ingested_at > now() - interval '1 hour';

    -- Count sync errors (last hour)
    select count(*) into sync_error_count
    from smon_logs
    where nas_id = nas.id
      and source in ('drive', 'drive_sharesync', 'drive_server')
      and severity in ('error', 'critical')
      and ingested_at > now() - interval '1 hour';

    -- Count rapid delete patterns (possible issue - 5+ deletes in 5 minutes)
    select count(*) into rapid_delete_count
    from smon_logs
    where nas_id = nas.id
      and source in ('drive', 'drive_sharesync')
      and (message ilike '%delete%' or message ilike '%remove%')
      and ingested_at > now() - interval '5 minutes';

    -- Create alerts if thresholds exceeded
    if conflict_count > 3 then
      insert into smon_alerts (nas_id, severity, status, source, title, message, details)
      values (
        nas.id,
        'warning',
        'active',
        'ai',
        'High Sync Conflict Rate Detected',
        format('%s sync conflicts detected in the last hour on NAS %s. This may indicate concurrent edits or sync configuration issues.', conflict_count, nas.name),
        jsonb_build_object(
          'conflict_count', conflict_count,
          'time_window', '1 hour',
          'suggestion', 'Review recent activity to identify conflicting files. Consider implementing conflict resolution policies.'
        )
      );
    end if;

    if empty_folder_count > 5 then
      insert into smon_alerts (nas_id, severity, status, source, title, message, details)
      values (
        nas.id,
        'info',
        'active',
        'ai',
        'Potential Empty Folder Creation',
        format('%s potential empty folder operations detected in the last hour on NAS %s.', empty_folder_count, nas.name),
        jsonb_build_object(
          'empty_folder_count', empty_folder_count,
          'time_window', '1 hour',
          'suggestion', 'Verify these are intentional folder creations. Empty folders may indicate failed sync operations or cleanup scripts.'
        )
      );
    end if;

    if sync_error_count > 0 then
      insert into smon_alerts (nas_id, severity, status, source, title, message, details)
      values (
        nas.id,
        'error',
        'active',
        'ai',
        'Sync Errors Detected',
        format('%s sync errors detected in the last hour on NAS %s.', sync_error_count, nas.name),
        jsonb_build_object(
          'error_count', sync_error_count,
          'time_window', '1 hour',
          'suggestion', 'Review error logs to identify root cause. Check network connectivity and disk space.'
        )
      );
    end if;

    if rapid_delete_count > 5 then
      insert into smon_alerts (nas_id, severity, status, source, title, message, details)
      values (
        nas.id,
        'warning',
        'active',
        'ai',
        'Rapid Delete Activity',
        format('%s delete operations in 5 minutes on NAS %s. This could indicate automated cleanup or potential data loss.', rapid_delete_count, nas.name),
        jsonb_build_object(
          'delete_count', rapid_delete_count,
          'time_window', '5 minutes',
          'suggestion', 'Verify this is expected behavior. Check ShareSync configuration for cleanup policies.'
        )
      );
    end if;

    -- Log what we detected (for debugging)
    raise notice 'smon: Sync anomaly check for % - conflicts:%, empty_folders:%, errors:%, rapid_deletes:%',
      nas.name, conflict_count, empty_folder_count, sync_error_count, rapid_delete_count;

  end loop;
end;
$$;

-- AI-powered sync health analysis (runs less frequently - every 4 hours)
create or replace function smon_analyze_sync_health()
returns void
language plpgsql
security definer
as $$
declare
  api_key text;
  analysis_data jsonb;
  nas record;
  recent_logs jsonb;
  prompt_text text;
begin
  api_key := smon_get_openai_key();
  if api_key is null then
    raise notice 'smon: OpenAI API key not configured';
    return;
  end if;

  for nas in select id, name from smon_nas_units where status != 'offline' limit 1
  loop
    -- Get recent sync logs for analysis
    select jsonb_agg(jsonb_build_object(
      'source', source,
      'severity', severity,
      'message', substring(message, 1, 500),
      'user', metadata->>'user',
      'action', metadata->>'action',
      'path', metadata->>'path',
      'logged_at', logged_at
    ))
    into recent_logs
    from smon_logs
    where nas_id = nas.id
      and source in ('drive', 'drive_sharesync', 'drive_server')
      and ingested_at > now() - interval '24 hours'
    order by ingested_at desc
    limit 100;

    if recent_logs is null or jsonb_array_length(recent_logs) = 0 then
      continue;
    end if;

    -- Build analysis prompt
    prompt_text := format(
      'You are a Synology Drive/Sync expert. Analyze these recent sync logs from NAS "%s" and identify: ' ||
      '1. Patterns that suggest problems (conflicts, repeated errors, unusual activity) ' ||
      '2. Users who may be having issues (many conflicts, failures) ' ||
      '3. Folders/shares that may have sync problems ' ||
      '4. Potential causes for any observed issues ' ||
      '5. Recommendations for the NAS administrator ' ||
      E'\n\nRespond ONLY in this JSON format:\n{"patterns_found": [{"severity": "info|warning|critical", "pattern": "...", "description": "...", "affected_users": ["..."], "affected_paths": ["..."], "recommendation": "..."}], "overall_health": "healthy|watch|problem", "summary": "..."}' ||
      E'\n\nRecent Logs:\n%s',
      nas.name,
      recent_logs::text
    );

    -- Store analysis request (will be processed by background job)
    insert into smon_ai_analyses (nas_id, type, summary, findings, recommendations, model, details)
    values (
      nas.id,
      'anomaly_detection',
      'Sync health analysis in progress',
      '[]'::jsonb,
      '[]'::jsonb,
      'gpt-5.4',
      jsonb_build_object(
        'sync_analysis', true,
        'nas_name', nas.name,
        'pending_prompt', prompt_text,
        'created_by', 'smon_analyze_sync_health'
      )
    );

    raise notice 'smon: Queued sync health analysis for %', nas.name;
  end loop;
end;
$$;

-- Weekly sync trends report
create or replace function smon_generate_weekly_sync_report()
returns void
language plpgsql
security definer
as $$
declare
  report_data jsonb;
  conflicts_by_user jsonb;
  conflicts_by_path jsonb;
  top_users jsonb;
  top_error_sources jsonb;
begin
  -- Build weekly sync report data
  select jsonb_build_object(
    'total_sync_events', (
      select count(*) from smon_logs 
      where source in ('drive', 'drive_sharesync', 'drive_server')
      and ingested_at > now() - interval '7 days'
    ),
    'total_conflicts', (
      select count(*) from smon_logs 
      where source in ('drive', 'drive_sharesync', 'drive_server')
      and message ilike '%conflict%'
      and ingested_at > now() - interval '7 days'
    ),
    'total_errors', (
      select count(*) from smon_logs 
      where source in ('drive', 'drive_sharesync', 'drive_server')
      and severity in ('error', 'critical')
      and ingested_at > now() - interval '7 days'
    ),
    'active_users', (
      select count(distinct (metadata->>'user'))
      from smon_logs 
      where source in ('drive', 'drive_sharesync')
      and metadata->>'user' is not null
      and ingested_at > now() - interval '7 days'
    ),
    'conflicts_by_day', (
      select jsonb_agg(day_count order by day)
      from (
        select date_trunc('day', ingested_at) as day, count(*) as day_count
        from smon_logs
        where source in ('drive', 'drive_sharesync', 'drive_server')
        and message ilike '%conflict%'
        and ingested_at > now() - interval '7 days'
        group by day
      ) daily
    )
  ) into report_data;

  -- Insert summary alert
  insert into smon_alerts (nas_id, severity, status, source, title, message, details)
  values (
    null,
    'info',
    'active',
    'ai',
    'Weekly Sync Report Generated',
    format('Weekly sync analysis complete. Total events: %, Conflicts: %, Errors: %',
      report_data->>'total_sync_events',
      report_data->>'total_conflicts',
      report_data->>'total_errors'
    ),
    report_data
  );

  raise notice 'smon: Weekly sync report generated';
end;
$$;

-- Schedule sync anomaly detection (every 15 minutes)
select cron.schedule(
  'smon-sync-anomaly-detection',
  '*/15 * * * *',
  $$select smon_detect_sync_anomalies()$$
);

-- Schedule sync health analysis (every 4 hours)
select cron.schedule(
  'smon-sync-health-analysis',
  '0 */4 * * *',
  $$select smon_analyze_sync_health()$$
);

-- Schedule weekly report (Sunday at 8 AM)
select cron.schedule(
  'smon-weekly-sync-report',
  '0 8 * * 0',
  $$select smon_generate_weekly_sync_report()$$
);
