-- ============================================
-- AI Analysis Pipeline (pg_cron + pg_net)
-- ============================================

-- Store OpenAI API key in vault (set via Supabase dashboard)
-- insert into vault.secrets (name, secret) values ('openai_api_key', 'sk-...');

-- Helper: get OpenAI API key from vault
create or replace function smon_get_openai_key()
returns text
language plpgsql
security definer
as $$
declare
  api_key text;
begin
  select decrypted_secret into api_key
  from vault.decrypted_secrets
  where name = 'smon_openai_api_key'
  limit 1;
  return api_key;
end;
$$;

-- Helper: create an alert from AI findings
create or replace function smon_create_alert(
  p_nas_id uuid,
  p_severity text,
  p_title text,
  p_message text,
  p_details jsonb default null
)
returns uuid
language plpgsql
as $$
declare
  alert_id uuid;
begin
  insert into smon_alerts (nas_id, severity, status, source, title, message, details)
  values (p_nas_id, p_severity, 'active', 'ai', p_title, p_message, p_details)
  returning id into alert_id;
  return alert_id;
end;
$$;

-- Anomaly detection: aggregate metrics and send to GPT if anomalous
create or replace function smon_run_anomaly_detection()
returns void
language plpgsql
security definer
as $$
declare
  api_key text;
  metrics_summary jsonb;
  nas record;
  prompt_text text;
  has_anomaly boolean := false;
begin
  api_key := smon_get_openai_key();
  if api_key is null then
    raise notice 'smon: OpenAI API key not configured in vault';
    return;
  end if;

  for nas in select id, name from smon_nas_units where status != 'offline'
  loop
    -- Aggregate last hour of metrics
    select jsonb_agg(jsonb_build_object(
      'metric', type,
      'avg', round(avg_val::numeric, 2),
      'max', round(max_val::numeric, 2),
      'min', round(min_val::numeric, 2),
      'stddev', round(coalesce(stddev_val, 0)::numeric, 2),
      'current', round(latest_val::numeric, 2),
      'unit', unit
    ))
    into metrics_summary
    from (
      select
        type,
        unit,
        avg(value) as avg_val,
        max(value) as max_val,
        min(value) as min_val,
        stddev(value) as stddev_val,
        (array_agg(value order by recorded_at desc))[1] as latest_val
      from smon_metrics
      where nas_id = nas.id
        and recorded_at > now() - interval '1 hour'
      group by type, unit
    ) agg;

    -- Skip if no metrics or everything is within 1 stddev
    if metrics_summary is null then
      continue;
    end if;

    -- Check if any metric's current value is > 1.5 stddev from mean
    select exists(
      select 1 from jsonb_array_elements(metrics_summary) elem
      where (elem->>'stddev')::float > 0
        and abs((elem->>'current')::float - (elem->>'avg')::float) > 1.5 * (elem->>'stddev')::float
    ) into has_anomaly;

    if not has_anomaly then
      continue;
    end if;

    prompt_text := format(
      'You are a NAS monitoring AI. Analyze these metrics from NAS "%s" (last hour aggregates) and identify anomalies. '
      'For each anomaly, provide severity (info/warning/critical), category, description, and recommended action. '
      'Respond in JSON format: {"anomalies": [{"severity": "...", "category": "...", "description": "...", "recommendation": "..."}], "summary": "..."}'
      E'\n\nMetrics:\n%s',
      nas.name,
      metrics_summary::text
    );

    -- Fire async request to OpenAI via pg_net
    perform net.http_post(
      url := 'https://api.openai.com/v1/chat/completions',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || api_key
      ),
      body := jsonb_build_object(
        'model', 'gpt-5.4-mini',
        'max_tokens', 1000,
        'response_format', jsonb_build_object('type', 'json_object'),
        'messages', jsonb_build_array(
          jsonb_build_object('role', 'system', 'content', 'You are a NAS infrastructure monitoring AI. Respond only in valid JSON.'),
          jsonb_build_object('role', 'user', 'content', prompt_text)
        )
      )
    );
  end loop;
end;
$$;

-- Daily health report
create or replace function smon_run_daily_health()
returns void
language plpgsql
security definer
as $$
declare
  api_key text;
  report_data jsonb;
  prompt_text text;
begin
  api_key := smon_get_openai_key();
  if api_key is null then return; end if;

  -- Build comprehensive report data
  select jsonb_build_object(
    'nas_units', (select jsonb_agg(jsonb_build_object('name', name, 'status', status, 'last_seen', last_seen)) from smon_nas_units),
    'metrics_24h', (
      select jsonb_agg(jsonb_build_object(
        'nas_name', n.name, 'metric', m.type,
        'avg', round(avg(m.value)::numeric, 2),
        'max', round(max(m.value)::numeric, 2),
        'min', round(min(m.value)::numeric, 2)
      ))
      from smon_metrics m join smon_nas_units n on m.nas_id = n.id
      where m.recorded_at > now() - interval '24 hours'
      group by n.name, m.type
    ),
    'storage', (
      select jsonb_agg(distinct_on_vol)
      from (
        select distinct on (nas_id, volume_id)
          jsonb_build_object(
            'nas_name', n.name, 'volume', s.volume_path,
            'used_pct', round((s.used_bytes::numeric / nullif(s.total_bytes, 0) * 100), 1),
            'status', s.status, 'raid_type', s.raid_type
          ) as distinct_on_vol
        from smon_storage_snapshots s join smon_nas_units n on s.nas_id = n.id
        order by nas_id, volume_id, recorded_at desc
      ) latest
    ),
    'active_alerts', (select count(*) from smon_alerts where status = 'active'),
    'security_events_24h', (select count(*) from smon_security_events where detected_at > now() - interval '24 hours'),
    'recent_security', (
      select jsonb_agg(jsonb_build_object('type', type, 'severity', severity, 'title', title))
      from (select type, severity, title from smon_security_events where detected_at > now() - interval '24 hours' order by detected_at desc limit 10) recent
    )
  ) into report_data;

  prompt_text := format(
    'Generate a daily health report for my Synology NAS infrastructure. '
    'Summarize the overall health, highlight any concerns, predict potential issues, and provide recommendations. '
    'Respond in JSON: {"overall_status": "healthy|warning|critical", "summary": "...", "findings": [{"severity": "...", "category": "...", "description": "..."}], "recommendations": ["..."], "storage_predictions": [{"volume": "...", "days_until_full": ..., "recommendation": "..."}]}'
    E'\n\nData:\n%s',
    report_data::text
  );

  perform net.http_post(
    url := 'https://api.openai.com/v1/chat/completions',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || api_key
    ),
    body := jsonb_build_object(
      'model', 'gpt-5.4-mini',
      'max_tokens', 1500,
      'response_format', jsonb_build_object('type', 'json_object'),
      'messages', jsonb_build_array(
        jsonb_build_object('role', 'system', 'content', 'You are a NAS infrastructure monitoring AI. Respond only in valid JSON.'),
        jsonb_build_object('role', 'user', 'content', prompt_text)
      )
    )
  );
end;
$$;

-- Process completed AI responses from pg_net
create or replace function smon_process_ai_responses()
returns void
language plpgsql
security definer
as $$
declare
  resp record;
  body jsonb;
  choices jsonb;
  content jsonb;
  analysis_type text;
  finding jsonb;
begin
  -- Check for completed OpenAI responses
  for resp in
    select id, status_code, body::jsonb as response_body
    from net._http_response
    where status_code is not null
      and body::text like '%"choices"%'
      and id not in (select (details->>'pg_net_id')::bigint from smon_ai_analyses where details ? 'pg_net_id')
    order by created desc
    limit 10
  loop
    begin
      body := resp.response_body;
      choices := body->'choices';

      if choices is null or jsonb_array_length(choices) = 0 then
        continue;
      end if;

      content := (choices->0->'message'->>'content')::jsonb;

      -- Determine analysis type from content
      if content ? 'anomalies' then
        analysis_type := 'anomaly_detection';
      elsif content ? 'overall_status' then
        analysis_type := 'daily_health';
      elsif content ? 'security_findings' then
        analysis_type := 'security_review';
      elsif content ? 'storage_predictions' then
        analysis_type := 'storage_prediction';
      else
        analysis_type := 'anomaly_detection';
      end if;

      -- Insert analysis record
      insert into smon_ai_analyses (type, summary, findings, recommendations, model, tokens_used, details)
      values (
        analysis_type,
        coalesce(content->>'summary', content->>'overall_status', 'Analysis complete'),
        coalesce(content->'findings', content->'anomalies', '[]'::jsonb),
        coalesce(content->'recommendations', '[]'::jsonb),
        'gpt-5.4-mini',
        coalesce((body->'usage'->>'total_tokens')::int, 0),
        jsonb_build_object('pg_net_id', resp.id)
      );

      -- Create alerts from critical/warning findings
      for finding in select * from jsonb_array_elements(coalesce(content->'findings', content->'anomalies', '[]'::jsonb))
      loop
        if finding->>'severity' in ('warning', 'critical') then
          perform smon_create_alert(
            null,
            finding->>'severity',
            format('AI: %s', coalesce(finding->>'category', finding->>'description')),
            coalesce(finding->>'description', ''),
            finding
          );
        end if;
      end loop;

    exception when others then
      raise notice 'smon: Error processing AI response %: %', resp.id, sqlerrm;
      continue;
    end;
  end loop;
end;
$$;

-- Schedule AI jobs
-- Anomaly detection every 15 minutes
select cron.schedule(
  'smon-anomaly-detection',
  '*/15 * * * *',
  $$select smon_run_anomaly_detection()$$
);

-- Daily health report at 7:00 AM ET (12:00 UTC in summer, 12:00 UTC in winter)
select cron.schedule(
  'smon-daily-health',
  '0 12 * * *',
  $$select smon_run_daily_health()$$
);

-- Process AI responses every minute
select cron.schedule(
  'smon-process-ai-responses',
  '* * * * *',
  $$select smon_process_ai_responses()$$
);
