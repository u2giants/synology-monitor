-- Fix two pg_cron jobs that failed on every run (found 2026-11-11):
--   job 4 process_ai_responses(): pg_net >= 0.10 renamed net._http_response.body -> content,
--         and 00031 renamed smon_ai_analyses -> ai_analyses.
--   job 5 detect_sync_anomalies(): 00031 renamed smon_nas_units/smon_logs/smon_alerts
--         -> nas_units/nas_logs/alerts, but this function body was never updated.
-- Also: 'error' is not an allowed alerts.severity (info/warning/critical), so sync errors
-- raise 'warning'; and each alert is de-duplicated to one active alert per NAS+title per hour
-- (the job runs every 15 minutes). The unused empty_folder_count scan is dropped.
-- search_path is pinned because both are SECURITY DEFINER.

create or replace function public.process_ai_responses()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  resp record;
  resp_body jsonb;
  choices jsonb;
  msg_content jsonb;
  analysis_type text;
  finding jsonb;
begin
  for resp in
    select r.id, r.status_code, r.content::jsonb as response_body
    from net._http_response r
    where r.status_code is not null
      and r.content like '%"choices"%'
      and r.id not in (select (a.details->>'pg_net_id')::bigint from public.ai_analyses a where a.details ? 'pg_net_id')
    order by r.created desc
    limit 10
  loop
    begin
      resp_body := resp.response_body;
      choices := resp_body->'choices';
      if choices is null or jsonb_array_length(choices) = 0 then continue; end if;
      msg_content := (choices->0->'message'->>'content')::jsonb;

      if msg_content ? 'anomalies' then analysis_type := 'anomaly_detection';
      elsif msg_content ? 'overall_status' then analysis_type := 'daily_health';
      elsif msg_content ? 'security_findings' then analysis_type := 'security_review';
      elsif msg_content ? 'storage_predictions' then analysis_type := 'storage_prediction';
      else analysis_type := 'anomaly_detection';
      end if;

      insert into public.ai_analyses (type, summary, findings, recommendations, model, tokens_used, details)
      values (
        analysis_type,
        coalesce(msg_content->>'summary', msg_content->>'overall_status', 'Analysis complete'),
        coalesce(msg_content->'findings', msg_content->'anomalies', '[]'::jsonb),
        coalesce(msg_content->'recommendations', '[]'::jsonb),
        'gpt-4.1-mini',
        coalesce((resp_body->'usage'->>'total_tokens')::int, 0),
        jsonb_build_object('pg_net_id', resp.id)
      );

      for finding in select * from jsonb_array_elements(coalesce(msg_content->'findings', msg_content->'anomalies', '[]'::jsonb))
      loop
        if finding->>'severity' in ('warning', 'critical') then
          perform public.smon_create_alert(null, finding->>'severity', format('AI: %s', coalesce(finding->>'category', finding->>'description')), coalesce(finding->>'description', ''), finding);
        end if;
      end loop;
    exception when others then
      raise notice 'smon: Error processing AI response %: %', resp.id, sqlerrm;
      continue;
    end;
  end loop;
end;
$function$;

create or replace function public.detect_sync_anomalies()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  conflict_count int;
  sync_error_count int;
  rapid_delete_count int;
  nas record;
begin
  for nas in select id, name from public.nas_units where status != 'offline'
  loop
    select count(*) into conflict_count from public.nas_logs where nas_id = nas.id and source in ('drive','drive_sharesync') and message ilike '%conflict%' and ingested_at > now() - interval '1 hour';
    select count(*) into sync_error_count from public.nas_logs where nas_id = nas.id and source in ('drive','drive_sharesync','drive_server') and severity in ('error','critical') and ingested_at > now() - interval '1 hour';
    select count(*) into rapid_delete_count from public.nas_logs where nas_id = nas.id and source in ('drive','drive_sharesync') and (message ilike '%delete%' or message ilike '%remove%') and ingested_at > now() - interval '5 minutes';

    if conflict_count > 3 and not exists (select 1 from public.alerts x where x.nas_id = nas.id and x.title = 'High Sync Conflict Rate Detected' and x.status = 'active' and x.created_at > now() - interval '1 hour') then
      insert into public.alerts (nas_id, severity, status, source, title, message, details) values (nas.id, 'warning', 'active', 'ai', 'High Sync Conflict Rate Detected', format('%s sync conflicts in last hour on %s.', conflict_count, nas.name), jsonb_build_object('conflict_count', conflict_count));
    end if;
    if sync_error_count > 0 and not exists (select 1 from public.alerts x where x.nas_id = nas.id and x.title = 'Sync Errors Detected' and x.status = 'active' and x.created_at > now() - interval '1 hour') then
      insert into public.alerts (nas_id, severity, status, source, title, message, details) values (nas.id, 'warning', 'active', 'ai', 'Sync Errors Detected', format('%s sync errors in last hour on %s.', sync_error_count, nas.name), jsonb_build_object('error_count', sync_error_count));
    end if;
    if rapid_delete_count > 5 and not exists (select 1 from public.alerts x where x.nas_id = nas.id and x.title = 'Rapid Delete Activity' and x.status = 'active' and x.created_at > now() - interval '1 hour') then
      insert into public.alerts (nas_id, severity, status, source, title, message, details) values (nas.id, 'warning', 'active', 'ai', 'Rapid Delete Activity', format('%s deletes in 5 min on %s.', rapid_delete_count, nas.name), jsonb_build_object('delete_count', rapid_delete_count));
    end if;
  end loop;
end;
$function$;

revoke all on function public.process_ai_responses() from public, anon, authenticated;
revoke all on function public.detect_sync_anomalies() from public, anon, authenticated;
