-- ============================================
-- Synology Drive Tables for Team Folders and User Activities
-- Migration 00008
-- ============================================

-- Drive Team Folders - snapshot of team folder state
create table if not exists smon_drive_team_folders (
  id uuid not null default gen_random_uuid(),
  nas_id uuid not null references smon_nas_units(id) on delete cascade,
  folder_id text not null,
  folder_name text not null,
  folder_path text,
  quota_bytes bigint default 0,
  used_bytes bigint default 0,
  usage_percent double precision default 0,
  member_count integer default 0,
  sync_count integer default 0,
  is_external boolean default false,
  priority text,
  status text,
  recorded_at timestamptz not null default now(),
  primary key (nas_id, folder_id, recorded_at)
);

-- Drive User Activities - individual user actions
create table if not exists smon_drive_activities (
  id uuid not null default gen_random_uuid(),
  nas_id uuid not null references smon_nas_units(id) on delete cascade,
  user text not null,
  login_time timestamptz,
  ip text,
  device text,
  action text not null,
  file_path text,
  timestamp timestamptz,
  recorded_at timestamptz not null default now(),
  primary key (nas_id, user, action, timestamp, recorded_at)
);

-- Create partitions for time-series data
create table if not exists smon_drive_team_folders_partitioned (
  like smon_drive_team_folders including all
) partition by range (recorded_at);

-- Create indexes for common queries
create index if not exists smon_drive_team_folders_nas_time
  on smon_drive_team_folders (nas_id, recorded_at desc);

create index if not exists smon_drive_team_folders_folder
  on smon_drive_team_folders (nas_id, folder_id, recorded_at desc);

create index if not exists smon_drive_activities_nas_time
  on smon_drive_activities (nas_id, recorded_at desc);

create index if not exists smon_drive_activities_user
  on smon_drive_activities (nas_id, user, recorded_at desc);

create index if not exists smon_drive_activities_action
  on smon_drive_activities (nas_id, action, recorded_at desc);

-- Enable RLS
alter table smon_drive_team_folders enable row level security;
alter table smon_drive_activities enable row level security;

-- RLS policies - allow authenticated users to read
create policy "smon_drive_team_folders_read" on smon_drive_team_folders
  for select to authenticated using (true);

create policy "smon_drive_activities_read" on smon_drive_activities
  for select to authenticated using (true);

-- Enable realtime
alter publication supabase_realtime add table smon_drive_activities;
