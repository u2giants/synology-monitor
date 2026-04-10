-- Persist staged issue-workflow outputs so the pipeline is inspectable.

create table if not exists smon_issue_stage_runs (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references smon_issues(id) on delete cascade,
  user_id uuid not null,
  stage_key text not null check (
    stage_key in (
      'capability_refresh',
      'fact_refresh',
      'hypothesis_rank',
      'next_step_plan',
      'operator_explanation',
      'verification'
    )
  ),
  status text not null default 'completed' check (status in ('running', 'completed', 'failed', 'skipped')),
  model_name text,
  model_tier text,
  input_summary jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  error_text text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_smon_issue_stage_runs_issue_created
  on smon_issue_stage_runs (issue_id, created_at desc);

create index if not exists idx_smon_issue_stage_runs_issue_stage
  on smon_issue_stage_runs (issue_id, stage_key, created_at desc);

alter table smon_issue_stage_runs enable row level security;

drop policy if exists "smon_issue_stage_runs_owner" on smon_issue_stage_runs;
create policy "smon_issue_stage_runs_owner" on smon_issue_stage_runs
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
