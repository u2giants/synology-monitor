create table smon_resolution_messages (
  id uuid primary key default gen_random_uuid(),
  resolution_id uuid references smon_issue_resolutions(id) on delete cascade not null,
  user_id uuid not null,
  role text not null check (role in ('user', 'agent')),
  content text not null,
  created_at timestamptz default now() not null
);
create index on smon_resolution_messages(resolution_id, created_at);
