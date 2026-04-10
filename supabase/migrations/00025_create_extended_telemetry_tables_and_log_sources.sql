create table if not exists smon_scheduled_tasks (
  id uuid default gen_random_uuid() primary key,
  nas_id uuid not null references smon_nas_units(id) on delete cascade,
  task_id integer not null,
  task_name text not null,
  task_type text,
  owner text,
  enabled boolean not null default true,
  status text,
  last_run_time text,
  next_run_time text,
  last_result integer not null default 0,
  captured_at timestamptz not null default now()
);

create index if not exists idx_smon_scheduled_tasks_recent
  on smon_scheduled_tasks (nas_id, captured_at desc);

create index if not exists idx_smon_scheduled_tasks_task
  on smon_scheduled_tasks (nas_id, task_id, captured_at desc);

create table if not exists smon_backup_tasks (
  id uuid default gen_random_uuid() primary key,
  nas_id uuid not null references smon_nas_units(id) on delete cascade,
  task_id text not null,
  task_name text not null,
  enabled boolean not null default true,
  status text,
  last_result text,
  last_run_time text,
  next_run_time text,
  dest_type text,
  dest_name text,
  total_bytes bigint default 0,
  transferred_bytes bigint default 0,
  speed_bps bigint default 0,
  captured_at timestamptz not null default now()
);

create index if not exists idx_smon_backup_tasks_recent
  on smon_backup_tasks (nas_id, captured_at desc);

create index if not exists idx_smon_backup_tasks_task
  on smon_backup_tasks (nas_id, task_id, captured_at desc);

create table if not exists smon_snapshot_replicas (
  id uuid default gen_random_uuid() primary key,
  nas_id uuid not null references smon_nas_units(id) on delete cascade,
  task_id text not null,
  task_name text,
  status text,
  src_share text,
  dst_share text,
  dst_host text,
  last_result text,
  last_run_time text,
  next_run_time text,
  captured_at timestamptz not null default now()
);

create index if not exists idx_smon_snapshot_replicas_recent
  on smon_snapshot_replicas (nas_id, captured_at desc);

create index if not exists idx_smon_snapshot_replicas_task
  on smon_snapshot_replicas (nas_id, task_id, captured_at desc);

create table if not exists smon_container_io (
  id uuid default gen_random_uuid() primary key,
  nas_id uuid not null references smon_nas_units(id) on delete cascade,
  container_id text not null,
  container_name text not null,
  read_bps bigint not null default 0,
  write_bps bigint not null default 0,
  read_ops bigint not null default 0,
  write_ops bigint not null default 0,
  captured_at timestamptz not null default now()
);

create index if not exists idx_smon_container_io_recent
  on smon_container_io (nas_id, captured_at desc);

create index if not exists idx_smon_container_io_container
  on smon_container_io (nas_id, container_id, captured_at desc);

alter table smon_scheduled_tasks enable row level security;
alter table smon_backup_tasks enable row level security;
alter table smon_snapshot_replicas enable row level security;
alter table smon_container_io enable row level security;

drop policy if exists "authenticated users manage scheduled tasks" on smon_scheduled_tasks;
create policy "authenticated users manage scheduled tasks"
  on smon_scheduled_tasks for all to authenticated
  using (true) with check (true);

drop policy if exists "authenticated users manage backup tasks" on smon_backup_tasks;
create policy "authenticated users manage backup tasks"
  on smon_backup_tasks for all to authenticated
  using (true) with check (true);

drop policy if exists "authenticated users manage snapshot replicas" on smon_snapshot_replicas;
create policy "authenticated users manage snapshot replicas"
  on smon_snapshot_replicas for all to authenticated
  using (true) with check (true);

drop policy if exists "authenticated users manage container io" on smon_container_io;
create policy "authenticated users manage container io"
  on smon_container_io for all to authenticated
  using (true) with check (true);

alter table smon_logs
  drop constraint if exists smon_logs_source_check;

alter table smon_logs
  add constraint smon_logs_source_check
  check (
    source in (
      'system',
      'security',
      'connection',
      'package',
      'docker',
      'drive',
      'drive_server',
      'drive_sharesync',
      'smb',
      'backup',
      'webapi',
      'storage',
      'share',
      'kernel',
      'system_info',
      'service',
      'kernel_health',
      'share_health',
      'share_config',
      'share_quota',
      'package_health',
      'dsm_system_log',
      'drive_admin_stats',
      'scheduled_task',
      'hyperbackup',
      'service_restart',
      'btrfs_error',
      'sharesync_detail'
    )
  );
