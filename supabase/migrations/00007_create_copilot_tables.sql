create table if not exists smon_user_roles (
  user_id uuid primary key,
  email text not null,
  role text not null check (role in ('viewer', 'operator', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists smon_copilot_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  title text not null default 'NAS Copilot Session',
  reasoning_effort text not null default 'high' check (reasoning_effort in ('high', 'xhigh')),
  lookback_hours integer not null default 2 check (lookback_hours in (1, 2, 6, 24)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists smon_copilot_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references smon_copilot_sessions(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('user', 'assistant', 'tool')),
  content text not null,
  evidence jsonb not null default '[]'::jsonb,
  message_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists smon_copilot_actions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references smon_copilot_sessions(id) on delete cascade,
  assistant_message_id uuid not null references smon_copilot_messages(id) on delete cascade,
  user_id uuid not null,
  target text not null check (target in ('edgesynology1', 'edgesynology2')),
  title text not null,
  tool_name text not null,
  command_preview text not null,
  reason text not null,
  risk text not null check (risk in ('low', 'medium', 'high')),
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected', 'executed', 'failed', 'expired')),
  approval_token_hash text,
  result_text text,
  metadata jsonb not null default '{}'::jsonb,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists smon_copilot_sessions_user_time
  on smon_copilot_sessions (user_id, updated_at desc);

create index if not exists smon_copilot_messages_session_order
  on smon_copilot_messages (session_id, message_order asc);

create index if not exists smon_copilot_actions_session_time
  on smon_copilot_actions (session_id, created_at asc);

alter table smon_user_roles enable row level security;
alter table smon_copilot_sessions enable row level security;
alter table smon_copilot_messages enable row level security;
alter table smon_copilot_actions enable row level security;

drop policy if exists "smon_user_roles_read_own" on smon_user_roles;
create policy "smon_user_roles_read_own"
  on smon_user_roles for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "smon_copilot_sessions_read_own" on smon_copilot_sessions;
create policy "smon_copilot_sessions_read_own"
  on smon_copilot_sessions for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "smon_copilot_sessions_insert_own" on smon_copilot_sessions;
create policy "smon_copilot_sessions_insert_own"
  on smon_copilot_sessions for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "smon_copilot_sessions_update_own" on smon_copilot_sessions;
create policy "smon_copilot_sessions_update_own"
  on smon_copilot_sessions for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "smon_copilot_messages_read_own" on smon_copilot_messages;
create policy "smon_copilot_messages_read_own"
  on smon_copilot_messages for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "smon_copilot_messages_insert_own" on smon_copilot_messages;
create policy "smon_copilot_messages_insert_own"
  on smon_copilot_messages for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "smon_copilot_actions_read_own" on smon_copilot_actions;
create policy "smon_copilot_actions_read_own"
  on smon_copilot_actions for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "smon_copilot_actions_insert_own" on smon_copilot_actions;
create policy "smon_copilot_actions_insert_own"
  on smon_copilot_actions for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "smon_copilot_actions_update_own" on smon_copilot_actions;
create policy "smon_copilot_actions_update_own"
  on smon_copilot_actions for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
