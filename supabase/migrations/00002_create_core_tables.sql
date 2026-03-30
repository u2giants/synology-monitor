-- ============================================
-- Synology Monitor Core Tables (smon_ prefix)
-- ============================================

-- NAS units registry
create table smon_nas_units (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  model text not null default 'DS1621xs+',
  dsm_version text,
  hostname text,
  last_seen timestamptz,
  status text not null default 'offline' check (status in ('online', 'offline', 'degraded')),
  created_at timestamptz not null default now()
);

-- Time-series metrics (will be partitioned)
create table smon_metrics (
  id uuid not null default gen_random_uuid(),
  nas_id uuid not null references smon_nas_units(id) on delete cascade,
  type text not null,
  value double precision not null,
  unit text not null default '',
  metadata jsonb,
  recorded_at timestamptz not null default now(),
  primary key (recorded_at, id)
) partition by range (recorded_at);

-- Ingested log entries (will be partitioned)
create table smon_logs (
  id uuid not null default gen_random_uuid(),
  nas_id uuid not null references smon_nas_units(id) on delete cascade,
  source text not null check (source in ('system', 'security', 'connection', 'package', 'docker')),
  severity text not null default 'info' check (severity in ('info', 'warning', 'error', 'critical')),
  message text not null,
  metadata jsonb,
  logged_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  primary key (ingested_at, id)
) partition by range (ingested_at);

-- Storage snapshots (will be partitioned)
create table smon_storage_snapshots (
  id uuid not null default gen_random_uuid(),
  nas_id uuid not null references smon_nas_units(id) on delete cascade,
  volume_id text not null,
  volume_path text not null,
  total_bytes bigint not null,
  used_bytes bigint not null,
  status text not null default 'normal' check (status in ('normal', 'degraded', 'crashed', 'unknown')),
  raid_type text,
  disks jsonb not null default '[]'::jsonb,
  recorded_at timestamptz not null default now(),
  primary key (recorded_at, id)
) partition by range (recorded_at);

-- Docker container status (will be partitioned)
create table smon_container_status (
  id uuid not null default gen_random_uuid(),
  nas_id uuid not null references smon_nas_units(id) on delete cascade,
  container_id text not null,
  container_name text not null,
  image text not null,
  status text not null check (status in ('running', 'stopped', 'restarting', 'paused', 'exited')),
  cpu_percent double precision default 0,
  memory_bytes bigint default 0,
  memory_limit_bytes bigint default 0,
  uptime_seconds bigint default 0,
  recorded_at timestamptz not null default now(),
  primary key (recorded_at, id)
) partition by range (recorded_at);

-- Security events (not partitioned — kept indefinitely, low volume)
create table smon_security_events (
  id uuid primary key default gen_random_uuid(),
  nas_id uuid not null references smon_nas_units(id) on delete cascade,
  type text not null,
  severity text not null default 'warning' check (severity in ('info', 'warning', 'error', 'critical')),
  title text not null,
  description text not null default '',
  details jsonb not null default '{}'::jsonb,
  file_path text,
  source_ip text,
  "user" text,
  acknowledged boolean not null default false,
  detected_at timestamptz not null default now()
);

-- Alerts
create table smon_alerts (
  id uuid primary key default gen_random_uuid(),
  nas_id uuid references smon_nas_units(id) on delete set null,
  severity text not null default 'warning' check (severity in ('info', 'warning', 'critical')),
  status text not null default 'active' check (status in ('active', 'acknowledged', 'resolved')),
  source text not null check (source in ('metric', 'security', 'storage', 'ai', 'agent')),
  title text not null,
  message text not null default '',
  details jsonb,
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz
);

-- AI analysis results
create table smon_ai_analyses (
  id uuid primary key default gen_random_uuid(),
  nas_id uuid references smon_nas_units(id) on delete set null,
  type text not null check (type in ('anomaly_detection', 'daily_health', 'security_review', 'storage_prediction')),
  summary text not null,
  findings jsonb not null default '[]'::jsonb,
  recommendations jsonb not null default '[]'::jsonb,
  model text not null default 'gpt-5.4-mini',
  tokens_used integer default 0,
  created_at timestamptz not null default now()
);

-- Push notification subscriptions
create table smon_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now()
);

-- Enable RLS on all tables
alter table smon_nas_units enable row level security;
alter table smon_metrics enable row level security;
alter table smon_logs enable row level security;
alter table smon_storage_snapshots enable row level security;
alter table smon_container_status enable row level security;
alter table smon_security_events enable row level security;
alter table smon_alerts enable row level security;
alter table smon_ai_analyses enable row level security;
alter table smon_push_subscriptions enable row level security;

-- RLS policies: allow authenticated users to read everything
-- Service role (agent) bypasses RLS automatically
create policy "smon_nas_units_read" on smon_nas_units for select to authenticated using (true);
create policy "smon_metrics_read" on smon_metrics for select to authenticated using (true);
create policy "smon_logs_read" on smon_logs for select to authenticated using (true);
create policy "smon_storage_snapshots_read" on smon_storage_snapshots for select to authenticated using (true);
create policy "smon_container_status_read" on smon_container_status for select to authenticated using (true);
create policy "smon_security_events_read" on smon_security_events for select to authenticated using (true);
create policy "smon_alerts_read" on smon_alerts for select to authenticated using (true);
create policy "smon_ai_analyses_read" on smon_ai_analyses for select to authenticated using (true);
create policy "smon_push_subscriptions_read" on smon_push_subscriptions for select to authenticated using (true);

-- Allow authenticated users to manage alerts (acknowledge/resolve) and push subs
create policy "smon_alerts_update" on smon_alerts for update to authenticated using (true) with check (true);
create policy "smon_push_subscriptions_insert" on smon_push_subscriptions for insert to authenticated with check (true);
create policy "smon_push_subscriptions_delete" on smon_push_subscriptions for delete to authenticated using (true);
create policy "smon_security_events_update" on smon_security_events for update to authenticated using (true) with check (true);

-- Enable realtime on alerts, security events, and NAS units
alter publication supabase_realtime add table smon_alerts;
alter publication supabase_realtime add table smon_security_events;
alter publication supabase_realtime add table smon_nas_units;
