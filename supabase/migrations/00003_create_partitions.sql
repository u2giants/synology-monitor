-- ============================================
-- Partition management for time-series tables
-- ============================================

-- Create initial partitions for smon_metrics (weekly, 12 weeks retention)
select public.create_parent(
  p_parent_table := 'public.smon_metrics',
  p_control := 'recorded_at',
  p_interval := '7 days',
  p_premake := 2,
  p_start_partition := (now() - interval '1 day')::text
);

update public.part_config
set retention = '84 days',  -- 12 weeks
    retention_keep_table = false,
    retention_keep_index = false
where parent_table = 'public.smon_metrics';

-- Create initial partitions for smon_logs (weekly, 6 months retention)
select public.create_parent(
  p_parent_table := 'public.smon_logs',
  p_control := 'ingested_at',
  p_interval := '7 days',
  p_premake := 2,
  p_start_partition := (now() - interval '1 day')::text
);

update public.part_config
set retention = '180 days',
    retention_keep_table = false,
    retention_keep_index = false
where parent_table = 'public.smon_logs';

-- Create initial partitions for smon_storage_snapshots (weekly, 12 weeks retention)
select public.create_parent(
  p_parent_table := 'public.smon_storage_snapshots',
  p_control := 'recorded_at',
  p_interval := '7 days',
  p_premake := 2,
  p_start_partition := (now() - interval '1 day')::text
);

update public.part_config
set retention = '84 days',
    retention_keep_table = false,
    retention_keep_index = false
where parent_table = 'public.smon_storage_snapshots';

-- Create initial partitions for smon_container_status (weekly, 6 months retention)
select public.create_parent(
  p_parent_table := 'public.smon_container_status',
  p_control := 'recorded_at',
  p_interval := '7 days',
  p_premake := 2,
  p_start_partition := (now() - interval '1 day')::text
);

update public.part_config
set retention = '180 days',  -- 6 months for better pattern analysis
    retention_keep_table = false,
    retention_keep_index = false
where parent_table = 'public.smon_container_status';

-- Schedule partition maintenance (run daily at 3 AM ET = 7 AM UTC)
select cron.schedule(
  'smon-partition-maintenance',
  '0 7 * * *',
  $$select public.run_maintenance_proc()$$
);
