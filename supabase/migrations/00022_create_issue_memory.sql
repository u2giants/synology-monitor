-- Issue-centric AI workflow.
-- Replaces the brittle phase-machine approach with durable issue memory.

create table if not exists smon_issues (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  fingerprint text,
  origin_type text not null check (origin_type in ('manual', 'alert', 'problem', 'detected')),
  origin_id text,
  title text not null,
  summary text not null default '',
  severity text not null default 'warning' check (severity in ('critical', 'warning', 'info')),
  status text not null default 'open' check (status in ('open', 'running', 'waiting_on_user', 'waiting_for_approval', 'resolved', 'stuck', 'cancelled')),
  affected_nas text[] not null default '{}',
  current_hypothesis text not null default '',
  hypothesis_confidence text not null default 'low' check (hypothesis_confidence in ('high', 'medium', 'low')),
  next_step text not null default '',
  conversation_summary text not null default '',
  operator_constraints jsonb not null default '[]'::jsonb,
  blocked_tools text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  last_agent_message text,
  last_user_message text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_smon_issues_user_updated on smon_issues(user_id, updated_at desc);
create index if not exists idx_smon_issues_status on smon_issues(user_id, status, updated_at desc);
create unique index if not exists idx_smon_issues_user_fingerprint
  on smon_issues(user_id, fingerprint)
  where fingerprint is not null;

create table if not exists smon_issue_messages (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references smon_issues(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('user', 'agent', 'system')),
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_smon_issue_messages_issue_created
  on smon_issue_messages(issue_id, created_at);

create table if not exists smon_issue_evidence (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references smon_issues(id) on delete cascade,
  user_id uuid not null,
  source_kind text not null check (source_kind in ('telemetry', 'diagnostic', 'user_statement', 'analysis')),
  title text not null,
  detail text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_smon_issue_evidence_issue_created
  on smon_issue_evidence(issue_id, created_at);

create table if not exists smon_issue_actions (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references smon_issues(id) on delete cascade,
  user_id uuid not null,
  kind text not null check (kind in ('diagnostic', 'remediation')),
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected', 'running', 'completed', 'failed', 'skipped')),
  target text,
  tool_name text not null,
  command_preview text not null,
  summary text not null,
  reason text not null,
  expected_outcome text not null default '',
  rollback_plan text not null default '',
  risk text not null default 'low' check (risk in ('low', 'medium', 'high')),
  requires_approval boolean not null default true,
  result_text text,
  exit_code int,
  approval_token text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_smon_issue_actions_issue_created
  on smon_issue_actions(issue_id, created_at);

alter table smon_issues enable row level security;
alter table smon_issue_messages enable row level security;
alter table smon_issue_evidence enable row level security;
alter table smon_issue_actions enable row level security;

drop policy if exists "smon_issues_owner" on smon_issues;
create policy "smon_issues_owner" on smon_issues
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "smon_issue_messages_owner" on smon_issue_messages;
create policy "smon_issue_messages_owner" on smon_issue_messages
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "smon_issue_evidence_owner" on smon_issue_evidence;
create policy "smon_issue_evidence_owner" on smon_issue_evidence
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "smon_issue_actions_owner" on smon_issue_actions;
create policy "smon_issue_actions_owner" on smon_issue_actions
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
