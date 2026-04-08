-- Rebuild foundation schema.
-- Adds capability state, ingestion health/events, normalized facts, issue job queue,
-- and explicit issue state transition history.

create table if not exists smon_capability_state (
  id uuid primary key default gen_random_uuid(),
  nas_id uuid not null references smon_nas_units(id) on delete cascade,
  capability_key text not null,
  state text not null check (state in ('supported', 'unsupported', 'unverified', 'degraded')),
  source_kind text not null default 'collector',
  evidence text not null default '',
  raw_error text,
  metadata jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (nas_id, capability_key)
);

create index if not exists idx_smon_capability_state_nas_checked
  on smon_capability_state (nas_id, checked_at desc);

create table if not exists smon_ingestion_health (
  id uuid primary key default gen_random_uuid(),
  nas_id uuid references smon_nas_units(id) on delete cascade,
  component_key text not null,
  state text not null check (state in ('healthy', 'degraded', 'failed', 'unknown')),
  summary text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (nas_id, component_key)
);

create index if not exists idx_smon_ingestion_health_component
  on smon_ingestion_health (component_key, updated_at desc);

create table if not exists smon_ingestion_events (
  id uuid primary key default gen_random_uuid(),
  nas_id uuid references smon_nas_units(id) on delete cascade,
  component_key text not null,
  event_type text not null,
  severity text not null default 'warning' check (severity in ('info', 'warning', 'error', 'critical')),
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_smon_ingestion_events_component_created
  on smon_ingestion_events (component_key, created_at desc);

create table if not exists smon_facts (
  id uuid primary key default gen_random_uuid(),
  nas_id uuid references smon_nas_units(id) on delete cascade,
  fact_type text not null,
  fact_key text not null,
  severity text not null default 'warning' check (severity in ('info', 'warning', 'critical')),
  status text not null default 'active' check (status in ('active', 'resolved', 'expired')),
  title text not null,
  detail text not null,
  value jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_smon_facts_type_observed
  on smon_facts (fact_type, observed_at desc);

create index if not exists idx_smon_facts_nas_status
  on smon_facts (nas_id, status, observed_at desc);

create table if not exists smon_fact_sources (
  id uuid primary key default gen_random_uuid(),
  fact_id uuid not null references smon_facts(id) on delete cascade,
  source_kind text not null,
  source_table text,
  source_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_smon_fact_sources_fact
  on smon_fact_sources (fact_id, created_at desc);

create table if not exists smon_issue_facts (
  issue_id uuid not null references smon_issues(id) on delete cascade,
  fact_id uuid not null references smon_facts(id) on delete cascade,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (issue_id, fact_id)
);

create index if not exists idx_smon_issue_facts_user
  on smon_issue_facts (user_id, created_at desc);

create table if not exists smon_issue_jobs (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references smon_issues(id) on delete cascade,
  user_id uuid not null,
  job_type text not null check (job_type in ('run_issue', 'user_message', 'approval_decision', 'detect_issue')),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  priority integer not null default 100,
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  run_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_smon_issue_jobs_queue
  on smon_issue_jobs (status, run_at, priority desc, created_at);

create index if not exists idx_smon_issue_jobs_issue
  on smon_issue_jobs (issue_id, created_at desc);

create table if not exists smon_issue_state_transitions (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references smon_issues(id) on delete cascade,
  user_id uuid not null,
  from_status text,
  to_status text not null,
  reason text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_smon_issue_state_transitions_issue
  on smon_issue_state_transitions (issue_id, created_at desc);

alter table smon_capability_state enable row level security;
alter table smon_ingestion_health enable row level security;
alter table smon_ingestion_events enable row level security;
alter table smon_facts enable row level security;
alter table smon_fact_sources enable row level security;
alter table smon_issue_facts enable row level security;
alter table smon_issue_jobs enable row level security;
alter table smon_issue_state_transitions enable row level security;

drop policy if exists "authenticated users manage capability state" on smon_capability_state;
create policy "authenticated users manage capability state"
  on smon_capability_state for all to authenticated
  using (true) with check (true);

drop policy if exists "authenticated users manage ingestion health" on smon_ingestion_health;
create policy "authenticated users manage ingestion health"
  on smon_ingestion_health for all to authenticated
  using (true) with check (true);

drop policy if exists "authenticated users manage ingestion events" on smon_ingestion_events;
create policy "authenticated users manage ingestion events"
  on smon_ingestion_events for all to authenticated
  using (true) with check (true);

drop policy if exists "authenticated users manage facts" on smon_facts;
create policy "authenticated users manage facts"
  on smon_facts for all to authenticated
  using (true) with check (true);

drop policy if exists "authenticated users manage fact sources" on smon_fact_sources;
create policy "authenticated users manage fact sources"
  on smon_fact_sources for all to authenticated
  using (true) with check (true);

drop policy if exists "smon_issue_facts_owner" on smon_issue_facts;
create policy "smon_issue_facts_owner" on smon_issue_facts
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "smon_issue_jobs_owner" on smon_issue_jobs;
create policy "smon_issue_jobs_owner" on smon_issue_jobs
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "smon_issue_state_transitions_owner" on smon_issue_state_transitions;
create policy "smon_issue_state_transitions_owner" on smon_issue_state_transitions
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
