-- pg_partman maintenance cron: run_maintenance_proc() is a PROCEDURE in pg_partman 5.3.1,
-- so `select public.run_maintenance_proc()` failed every day from 2026-05-29 to 2026-11-11
-- and every row since 2026-06-13 landed in the DEFAULT partitions.
-- Apply only AFTER the DEFAULT partitions are drained (docs/telemetry-retention.md).
-- Drained live 2026-11-11 (swap the DEFAULT out, create weekly partitions, backfill by day,
-- verify row counts, drop the old DEFAULT; rows older than each table's partman retention
-- were not moved).

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'smon-partition-maintenance';
    perform cron.schedule('smon-partition-maintenance', '0 7 * * *', 'CALL public.run_maintenance_proc()');
  end if;
end $$;
