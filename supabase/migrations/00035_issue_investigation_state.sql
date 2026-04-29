create table if not exists issue_working_sessions (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references issues(id) on delete cascade,
  user_id uuid not null,
  mode text not null check (mode in ('guided', 'deep')),
  status text not null default 'active' check (status in ('active', 'closed', 'rebased')),
  rebase_from_session_id uuid null references issue_working_sessions(id) on delete set null,
  started_at timestamptz not null default now(),
  ended_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_issue_working_sessions_issue_id on issue_working_sessions(issue_id, started_at desc);
create index if not exists idx_issue_working_sessions_user_id on issue_working_sessions(user_id, started_at desc);

alter table issue_working_sessions enable row level security;

create policy "issue_working_sessions_authenticated_read" on issue_working_sessions
  for select to authenticated using (auth.uid() = user_id);

create policy "issue_working_sessions_authenticated_write" on issue_working_sessions
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists issue_investigation_briefs (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references issues(id) on delete cascade,
  user_id uuid not null,
  source_session_id uuid null references issue_working_sessions(id) on delete set null,
  trigger_reason text not null,
  content_json jsonb not null default '{}'::jsonb,
  quality_score numeric(5,2) null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_issue_investigation_briefs_issue_id on issue_investigation_briefs(issue_id, created_at desc);

alter table issue_investigation_briefs enable row level security;

create policy "issue_investigation_briefs_authenticated_read" on issue_investigation_briefs
  for select to authenticated using (auth.uid() = user_id);

create policy "issue_investigation_briefs_authenticated_write" on issue_investigation_briefs
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists issue_escalation_events (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references issues(id) on delete cascade,
  user_id uuid not null,
  session_id uuid null references issue_working_sessions(id) on delete set null,
  kind text not null check (kind in ('higher_reasoning', 'stronger_model', 'expanded_context', 'deep_mode_switch')),
  from_model text null,
  to_model text null,
  from_reasoning text null,
  to_reasoning text null,
  estimated_cost numeric(12,6) null,
  approved_by_user boolean not null default false,
  decision_reason text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_issue_escalation_events_issue_id on issue_escalation_events(issue_id, created_at desc);

alter table issue_escalation_events enable row level security;

create policy "issue_escalation_events_authenticated_read" on issue_escalation_events
  for select to authenticated using (auth.uid() = user_id);

create policy "issue_escalation_events_authenticated_write" on issue_escalation_events
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists issue_token_usage (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references issues(id) on delete cascade,
  user_id uuid not null,
  session_id uuid null references issue_working_sessions(id) on delete set null,
  stage_key text not null,
  model_name text not null,
  input_tokens integer null,
  output_tokens integer null,
  reasoning_tokens integer null,
  estimated_cost numeric(12,6) null,
  created_at timestamptz not null default now()
);

create index if not exists idx_issue_token_usage_issue_id on issue_token_usage(issue_id, created_at desc);

alter table issue_token_usage enable row level security;

create policy "issue_token_usage_authenticated_read" on issue_token_usage
  for select to authenticated using (auth.uid() = user_id);

create policy "issue_token_usage_authenticated_write" on issue_token_usage
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
