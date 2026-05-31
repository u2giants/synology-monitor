-- Nightly disk health collection schedules.
--
-- Runs on weekdays at 2am UTC via the custom_metric_schedules mechanism.
-- The agent container collects /proc/diskstats (IOPS, latency, throughput
-- counters), /proc/mdstat (RAID state), and /sys/block/*/inflight (instantaneous
-- in-progress IOs) — the raw-kernel sources that complement SMART data.
--
-- The command self-skips on weekends to avoid competing with the weekly RAID
-- scrub (which Synology schedules on Sundays by default). interval_minutes=1440
-- keeps the schedule aligned: if the first run is Monday 2am UTC, subsequent
-- runs land on Tuesday 2am, Wednesday 2am, etc.
--
-- next_run_at is set to the next Monday at 02:00 UTC from migration time.

DO $$
DECLARE
  v_command text := $CMD$
if [ "$(date -u +%u)" -gt 5 ]; then
  echo "SKIP: weekend $(date -u)"
else
  echo "=== NAS DISK HEALTH SNAPSHOT $(date -u) ==="
  echo
  echo "-- /proc/diskstats (cumulative counters; cols: device reads_completed reads_merged sectors_read ms_reading writes_completed writes_merged sectors_written ms_writing ios_in_progress ms_doing_io ms_weighted_io) --"
  grep -E '^\s*[0-9]+ +[0-9]+ +(sd[a-z]+|md[0-9]+) ' /host/proc/diskstats
  echo
  echo "-- RAID (/proc/mdstat) --"
  cat /host/proc/mdstat
  echo
  echo "-- Inflight IOs (reads writes, instantaneous gauge) --"
  for f in /host/sys/block/sd*/inflight /host/sys/block/md*/inflight; do
    [ -f "$f" ] && printf '%-12s %s\n' "$(echo "$f" | sed 's|.*block/||;s|/inflight||')" "$(cat "$f")"
  done
fi
$CMD$;
  v_next_run timestamptz := date_trunc('week', now() + interval '1 week') + interval '2 hours';
BEGIN
  INSERT INTO custom_metric_schedules
    (name, description, nas_id, collection_command, interval_minutes, is_active, next_run_at)
  SELECT
    'nightly_disk_health',
    'Weekday 2am snapshot: /proc/diskstats counters, RAID state, and per-device inflight IOs. '
    'Captures raw-kernel data that SMART misses (latency distribution, queue saturation, '
    'in-progress IO counts). Skips weekends to avoid the RAID scrub window.',
    'edgesynology1',
    v_command,
    1440,
    true,
    v_next_run
  WHERE NOT EXISTS (
    SELECT 1 FROM custom_metric_schedules
    WHERE name = 'nightly_disk_health' AND nas_id = 'edgesynology1'
  );

  INSERT INTO custom_metric_schedules
    (name, description, nas_id, collection_command, interval_minutes, is_active, next_run_at)
  SELECT
    'nightly_disk_health',
    'Weekday 2am snapshot: /proc/diskstats counters, RAID state, and per-device inflight IOs. '
    'Captures raw-kernel data that SMART misses (latency distribution, queue saturation, '
    'in-progress IO counts). Skips weekends to avoid the RAID scrub window.',
    'edgesynology2',
    v_command,
    1440,
    true,
    v_next_run
  WHERE NOT EXISTS (
    SELECT 1 FROM custom_metric_schedules
    WHERE name = 'nightly_disk_health' AND nas_id = 'edgesynology2'
  );
END $$;
