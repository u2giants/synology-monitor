-- Resource snapshot tables for deep I/O and process attribution
-- Run with: supabase db query --linked -f resource-snapshot-migration.sql

-- ============================================================
-- Per-process snapshots: top processes by CPU / mem / disk I/O
-- ============================================================
CREATE TABLE IF NOT EXISTS smon_process_snapshots (
  id            UUID          DEFAULT gen_random_uuid() PRIMARY KEY,
  nas_id        UUID          NOT NULL,
  snapshot_grp  UUID          NOT NULL,  -- groups rows from same collection pass
  captured_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  pid           INTEGER       NOT NULL,
  name          TEXT          NOT NULL,
  cmdline       TEXT,
  username      TEXT,
  state         CHAR(1),                 -- R/S/D/Z/T
  cpu_pct       FLOAT,
  mem_rss_kb    BIGINT,
  mem_pct       FLOAT,
  read_bps      BIGINT,                  -- disk read bytes/sec
  write_bps     BIGINT,                  -- disk write bytes/sec
  parent_service TEXT,                   -- mapped Synology service name
  cgroup        TEXT
);

CREATE INDEX IF NOT EXISTS smon_process_snapshots_nas_time
  ON smon_process_snapshots (nas_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS smon_process_snapshots_grp
  ON smon_process_snapshots (snapshot_grp);

ALTER TABLE smon_process_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "smon_process_snapshots_read" ON smon_process_snapshots;
CREATE POLICY "smon_process_snapshots_read"
  ON smon_process_snapshots FOR SELECT TO authenticated USING (true);

-- service_role INSERT (used by agent)
DROP POLICY IF EXISTS "smon_process_snapshots_insert" ON smon_process_snapshots;
CREATE POLICY "smon_process_snapshots_insert"
  ON smon_process_snapshots FOR INSERT TO service_role WITH CHECK (true);

-- ============================================================
-- Per-disk I/O stats: IOPS, throughput, await, utilisation
-- ============================================================
CREATE TABLE IF NOT EXISTS smon_disk_io_stats (
  id             UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  nas_id         UUID        NOT NULL,
  captured_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  device         TEXT        NOT NULL,   -- e.g. sda, md0
  volume_path    TEXT,                   -- mapped volume e.g. /volume1
  reads_ps       FLOAT,
  writes_ps      FLOAT,
  read_bps       BIGINT,
  write_bps      BIGINT,
  await_ms       FLOAT,                  -- avg I/O latency ms
  util_pct       FLOAT,                  -- % of time device was busy
  queue_depth    FLOAT                   -- avg request queue depth
);

CREATE INDEX IF NOT EXISTS smon_disk_io_stats_nas_time
  ON smon_disk_io_stats (nas_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS smon_disk_io_stats_device
  ON smon_disk_io_stats (nas_id, device, captured_at DESC);

ALTER TABLE smon_disk_io_stats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "smon_disk_io_stats_read" ON smon_disk_io_stats;
CREATE POLICY "smon_disk_io_stats_read"
  ON smon_disk_io_stats FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "smon_disk_io_stats_insert" ON smon_disk_io_stats;
CREATE POLICY "smon_disk_io_stats_insert"
  ON smon_disk_io_stats FOR INSERT TO service_role WITH CHECK (true);

-- ============================================================
-- ShareSync / Drive task snapshots
-- ============================================================
CREATE TABLE IF NOT EXISTS smon_sync_task_snapshots (
  id               UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  nas_id           UUID        NOT NULL,
  captured_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  task_id          TEXT        NOT NULL,
  task_name        TEXT,
  task_type        TEXT,       -- sharesync | drive | backup
  status           TEXT,       -- running | idle | error | stopped
  backlog_count    INTEGER,    -- files waiting to sync
  backlog_bytes    BIGINT,
  current_file     TEXT,       -- file currently being processed
  current_folder   TEXT,       -- folder currently being processed
  retry_count      INTEGER,
  last_error       TEXT,
  transferred_files INTEGER,
  transferred_bytes BIGINT,
  speed_bps        BIGINT,
  indexing_queue   INTEGER     -- pending indexing items
);

CREATE INDEX IF NOT EXISTS smon_sync_task_snapshots_nas_time
  ON smon_sync_task_snapshots (nas_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS smon_sync_task_snapshots_task
  ON smon_sync_task_snapshots (nas_id, task_id, captured_at DESC);

ALTER TABLE smon_sync_task_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "smon_sync_task_snapshots_read" ON smon_sync_task_snapshots;
CREATE POLICY "smon_sync_task_snapshots_read"
  ON smon_sync_task_snapshots FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "smon_sync_task_snapshots_insert" ON smon_sync_task_snapshots;
CREATE POLICY "smon_sync_task_snapshots_insert"
  ON smon_sync_task_snapshots FOR INSERT TO service_role WITH CHECK (true);

-- ============================================================
-- Active network connections: top remote peers by session count
-- ============================================================
CREATE TABLE IF NOT EXISTS smon_net_connections (
  id            UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  nas_id        UUID        NOT NULL,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  remote_ip     TEXT        NOT NULL,
  remote_host   TEXT,
  local_port    INTEGER,
  protocol      TEXT,       -- smb | nfs | drive | http | https | ssh | other
  conn_count    INTEGER,    -- number of concurrent connections from this IP
  username      TEXT        -- if mappable via SMB/NFS session
);

CREATE INDEX IF NOT EXISTS smon_net_connections_nas_time
  ON smon_net_connections (nas_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS smon_net_connections_remote_ip
  ON smon_net_connections (nas_id, remote_ip, captured_at DESC);

ALTER TABLE smon_net_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "smon_net_connections_read" ON smon_net_connections;
CREATE POLICY "smon_net_connections_read"
  ON smon_net_connections FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "smon_net_connections_insert" ON smon_net_connections;
CREATE POLICY "smon_net_connections_insert"
  ON smon_net_connections FOR INSERT TO service_role WITH CHECK (true);

-- ============================================================
-- Retention: keep only last 24 h in high-frequency tables.
-- Run manually or schedule via pg_cron:
--   SELECT cron.schedule('smon-resource-snapshot-cleanup', '0 * * * *', $$
--     DELETE FROM smon_process_snapshots WHERE captured_at < now() - interval '24 hours';
--     DELETE FROM smon_disk_io_stats     WHERE captured_at < now() - interval '24 hours';
--     DELETE FROM smon_net_connections   WHERE captured_at < now() - interval '24 hours';
--   $$);
-- ============================================================
