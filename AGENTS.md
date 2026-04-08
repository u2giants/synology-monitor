# Synology Monitor: Project Guide

## Read This First

This repository monitors two Synology DS1621xs+ NAS devices. The core business priority is:

- Synology Drive reliability and ShareSync behavior
- Filesystem changes and user-attributed file operations
- Sync failures, conflicts, rename/move/delete activity
- I/O spike attribution — identifying which processes, disks, containers, and remote clients are causing heavy load
- Backup and scheduled task health (silent failures that produce no alerts)
- Ransomware-style behavior detection on shared storage

**Operating Rules:**
- GitHub is the source of truth
- Do NOT patch production code directly on the server
- All changes must be committed and pushed
- Deployments flow from GitHub → Coolify (web) or GitHub Actions (agent)
- Direct server-side hotfixes are forbidden unless explicitly approved

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Synology NAS (edgesynology1 & edgesynology2)                    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Go Agent Container (ghcr.io/u2giants/synology-monitor-  │    │
│  │                      agent:latest)                      │    │
│  │                                                         │    │
│  │  Collectors (17 goroutines started in main.go):         │    │
│  │  - system        → smon_metrics, smon_container_status  │    │
│  │  - storage       → smon_storage_snapshots (60s)         │    │
│  │  - docker        → smon_container_status (30s)          │    │
│  │  - drive         → smon_drive_team_folders, etc. (30s)  │    │
│  │  - process       → smon_process_snapshots (15s)         │    │
│  │  - diskstats     → smon_disk_io_stats (15s)             │    │
│  │  - connections   → smon_net_connections (30s)           │    │
│  │  - logwatcher    → smon_logs (10s)                      │    │
│  │  - sharehealth   → smon_logs, smon_metrics (2m)         │    │
│  │  - servicehealth → smon_service_health (60s)            │    │
│  │  - sysextras     → smon_metrics (30s)                   │    │
│  │  - custom        → smon_custom_metric_data (60s poll)   │    │
│  │  - security      → smon_security_events (event-driven)  │    │
│  │  - schedtasks    → smon_scheduled_tasks (5m)            │    │
│  │  - hyperbackup   → smon_backup_tasks (5m)               │    │
│  │  - storagepool   → smon_snapshot_replicas + metrics     │    │
│  │  - container_io  → smon_container_io (30s)              │    │
│  │                                                         │    │
│  │  Sender: SQLite WAL → Supabase (flush every 30s)        │    │
│  └──────────────────────────┬──────────────────────────────┘    │
└─────────────────────────────│────────────────────────────────────┘
                              │ HTTPS (Supabase REST API)
                              ▼
              ┌───────────────────────────────┐
              │  Supabase PostgreSQL           │
              │  project: qnjimovrsaacneqkggsn │
              │  smon_* tables                 │
              └───────────────┬───────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Next.js Web App (Coolify → https://mon.designflow.app)          │
│                                                                  │
│  - Dashboard                  - /sync-triage                     │
│  - /assistant (NAS Copilot)   - /ai-insights                     │
│                                                                  │
│  Issue Agent: issue-agent.ts — conversation-loop agent           │
│  - Maintains one hypothesis per issue                            │
│  - MAX_AGENT_CYCLES = 2 per tick                                 │
│  - Three-model AI via OpenRouter                                 │
│  - Queries 10 telemetry tables per agent cycle                   │
│                                                                  │
│  SSH diagnostics over Tailscale                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Current Live Infrastructure

| Component | URL / Identifier |
|-----------|-----------------|
| Web UI | https://mon.designflow.app |
| GitHub Repo | https://github.com/u2giants/synology-monitor |
| Coolify App UUID | `lrddgp8im0276gllujfu7wm3` |
| Supabase Project | `qnjimovrsaacneqkggsn` (dedicated, migrated from shared `popdam-prod` in April 2026) |
| Supabase URL | `https://qnjimovrsaacneqkggsn.supabase.co` |
| Agent Image | `ghcr.io/u2giants/synology-monitor-agent:latest` |

## NAS Endpoints (Tailscale)

| NAS | SSH Target | SSH Port | Container Dir |
|-----|-----------|----------|---------------|
| edgesynology1 | `popdam@100.107.131.35` | 22 | `/volume1/docker/synology-monitor-agent` |
| edgesynology2 | `popdam@100.107.131.36` | 1904 | `/volume1/docker/synology-monitor-agent` |

SSH user `popdam` has sudo access. The Docker binary is at `/var/packages/ContainerManager/target/usr/bin/docker` — it is not on the default PATH in remote sessions.

## Deployment Flow

### Web App (Next.js)
- Connected directly to Coolify — NOT deployed via GitHub Actions
- Push to `master` → Coolify webhook → automatic redeploy
- Check Coolify deployment history at `lrddgp8im0276gllujfu7wm3`, not GitHub Actions

### Agent Image (Go)
1. Code change committed and pushed to `master`
2. GitHub Actions workflow `.github/workflows/agent-image.yml` builds a multi-arch image
3. Image published to `ghcr.io/u2giants/synology-monitor-agent` with two tags:
   - `latest` — always the most recent build
   - `sha-<short-git-sha>` — immutable per-commit tag
4. Both NAS `.env` files use `AGENT_IMAGE_TAG=latest`
5. To deploy: SSH in and run `docker compose -f compose.yaml pull && docker stop synology-monitor-agent && docker rm synology-monitor-agent && docker compose -f compose.yaml up -d`

**IMPORTANT:** If `AGENT_IMAGE_TAG` in the NAS `.env` is set to a specific SHA (e.g. `sha-373b526`), `compose up -d` will use the OLD image even after pulling `latest`. Always set `AGENT_IMAGE_TAG=latest` unless intentionally pinning. After changing from a SHA pin to `latest`, you must stop and remove the container before running `up -d` — otherwise Docker reuses the existing container definition.

## Repository Structure

```
synology-monitor/
├── apps/
│   ├── web/                    # Next.js 15 dashboard
│   │   └── src/
│   │       ├── app/
│   │       │   ├── (dashboard)/
│   │       │   │   ├── page.tsx           # Main dashboard
│   │       │   │   ├── sync-triage/       # Sync errors & triage UI
│   │       │   │   ├── assistant/         # NAS Copilot chat
│   │       │   │   ├── ai-insights/       # AI analysis dashboard
│   │       │   │   └── settings/          # AI model config
│   │       │   ├── api/
│   │       │   │   ├── copilot/           # Copilot endpoints (chat, execute, session)
│   │       │   │   └── analysis/          # On-demand grouped analysis
│   │       │   └── login/
│   │       ├── components/
│   │       │   └── dashboard/
│   │       │       └── version-banner.tsx # Admin-only build SHA + date (top-right)
│   │       └── lib/
│   │           └── server/
│   │               ├── issue-agent.ts     # Issue conversation-loop agent (THE main AI logic)
│   │               ├── issue-store.ts     # DB CRUD for issues, actions, messages, evidence
│   │               ├── issue-detector.ts  # Auto-detects new issues from alerts/logs
│   │               ├── copilot.ts         # Copilot chat handler
│   │               ├── tools.ts           # All Copilot diagnostic tool definitions
│   │               ├── metric-collector.ts  # Custom metric context injection
│   │               └── nas.ts               # SSH diagnostics (runNasScript)
│   └── agent/                  # Go monitoring agent
│       ├── cmd/agent/
│       │   └── main.go         # Entry point — starts all 17 collector goroutines
│       └── internal/
│           ├── collector/      # All data collectors
│           │   ├── system.go        # CPU, mem, network metrics + Docker stats
│           │   ├── storage.go       # Volume and disk health
│           │   ├── drive.go         # Drive Admin API + ShareSync task parsing
│           │   ├── process.go       # Per-process CPU/mem/disk I/O (reads /proc)
│           │   ├── diskstats.go     # Per-disk IOPS/throughput/await (reads /proc/diskstats)
│           │   ├── connections.go   # Active TCP connections (reads /proc/net/tcp)
│           │   ├── sharehealth.go   # Share DB health, package status, DSM system logs, share quotas
│           │   ├── services.go      # DSM service status + restart detection + OOM/segfault events
│           │   ├── sysextras.go     # Memory pressure, inode, CPU temp, iowait%, NFS, vmstat, Btrfs
│           │   ├── custom.go        # AI-requested custom metric collection
│           │   ├── schedtasks.go    # All scheduled tasks (incl. failed) via DSM API
│           │   ├── hyperbackup.go   # Hyper Backup task state via DSM API
│           │   ├── storagepool.go   # RAID scrub/rebuild (mdstat) + snapshot replication
│           │   └── container_io.go  # Per-container block I/O via cgroup v1/v2
│           ├── config/         # Config loading from env vars
│           ├── dsm/            # DSM API client (SYNO.* API calls)
│           ├── logwatcher/     # Log file tailing & parsing (incl. rotated .1 files)
│           ├── security/       # Ransomware/entropy detection, fsnotify
│           └── sender/
│               ├── sender.go   # SQLite WAL buffer + Supabase flush
│               └── types.go    # Payload structs for all Supabase tables
├── supabase/
│   └── migrations/             # Database schema history
├── deploy/
│   └── synology/
│       ├── docker-compose.agent.yml  # Canonical compose spec (in repo)
│       ├── .env.agent.example
│       ├── nas-1.env.example
│       └── nas-2.env.example
└── .github/
    └── workflows/
        └── agent-image.yml     # Builds + publishes agent Docker image
```

**Note:** The live compose file on each NAS is at `/volume1/docker/synology-monitor-agent/compose.yaml`. It is a copy of `deploy/synology/docker-compose.agent.yml` with any local overrides applied. Keep them in sync.

## Database Schema (Supabase)

All tables are prefixed `smon_`. The Supabase project `qnjimovrsaacneqkggsn` is dedicated to this application.

### Core Telemetry Tables

| Table | Purpose | Populated by |
|-------|---------|-------------|
| `smon_nas_units` | NAS device registry + heartbeat | Agent on startup |
| `smon_metrics` | CPU, memory, network, inode, temperature, iowait, NFS, VM pressure | `system` + `sysextras` collectors |
| `smon_storage_snapshots` | Volume and disk state | `storage` collector (60s) |
| `smon_container_status` | Docker container state (180-day retention) | `system` collector (30s) |
| `smon_logs` | Ingested log events from NAS | `logwatcher` + `sharehealth` + `storagepool` + `schedtasks` + `hyperbackup` collectors |
| `smon_security_events` | Ransomware/entropy alerts | `security` watcher (event-driven) |
| `smon_alerts` | Active system alerts | SQL cron pipeline |
| `smon_service_health` | DSM service status snapshots | `servicehealth` collector (60s) |

### Resource Attribution Tables

| Table | Purpose | Populated by |
|-------|---------|-------------|
| `smon_process_snapshots` | Per-process CPU/mem/disk I/O | `process` collector (15s) |
| `smon_disk_io_stats` | Per-disk IOPS/throughput/await | `diskstats` collector (15s) |
| `smon_net_connections` | Active TCP connections by remote IP | `connections` collector (30s) |
| `smon_sync_task_snapshots` | ShareSync/Drive task state | `drive` collector (30s) |
| `smon_container_io` | Per-container block I/O (read/write BPS and OPS) | `container_io` collector (30s) |

### Backup and Task Tables

| Table | Purpose | Populated by |
|-------|---------|-------------|
| `smon_scheduled_tasks` | All DSM scheduled tasks with last exit code | `schedtasks` collector (5m) |
| `smon_backup_tasks` | Hyper Backup task state and progress | `hyperbackup` collector (5m) |
| `smon_snapshot_replicas` | Snapshot Replication task state | `storagepool` collector (5m) |

### AI Analysis Tables

| Table | Purpose |
|-------|---------|
| `smon_ai_analyses` | Legacy scheduled SQL-pipeline AI analyses |
| `smon_analysis_runs` | On-demand grouped analysis runs (google/gemini-2.5-flash) |
| `smon_analyzed_problems` | Root cause problems from grouped analysis |

### Copilot / Issue Tables

| Table | Purpose |
|-------|---------|
| `smon_issues` | Active issue records (one per detected or user-reported problem) |
| `smon_issue_actions` | Tool calls and remediation steps per issue |
| `smon_issue_messages` | Conversation thread between user and agent |
| `smon_issue_evidence` | Structured findings attached to an issue |
| `smon_copilot_sessions` | Chat session metadata |
| `smon_copilot_messages` | Individual chat messages |
| `smon_copilot_actions` | Approved/rejected NAS actions |

### Dynamic Metric Collection Tables

| Table | Purpose |
|-------|---------|
| `smon_custom_metric_schedules` | AI-requested collection commands (with `referenced_count`) |
| `smon_custom_metric_data` | Results of custom metric collections |

`referenced_count` in `smon_custom_metric_schedules` increments atomically (via `increment_metric_references` RPC) each time a custom metric's data is injected into an AI analysis context. When `referenced_count >= 3`, the metric has proven consistently useful and should be promoted to a built-in Go collector.

### Extra Tables (live, not in tracked migrations)

These tables exist in production but were not created by migrations in this repo:

| Table | Status |
|-------|--------|
| `smon_drive_activities` | Live — Drive user activity (individual file operations) |
| `smon_drive_team_folders` | Live — Drive team folder quota and usage snapshots |
| `smon_sync_remediations` | Live — remediation action records |

The SQL that created them is in `apply-migrations.ps1` (migrations 00008 and 00009).

## Agent Collectors (17 total)

The Go agent runs seventeen parallel goroutines. They are all started in `cmd/agent/main.go`.

### System Collector (`collector/system.go`)
- DSM API: CPU%, memory usage, network RX/TX
- Docker stats via DSM API (container CPU, memory, status)
- Writes to `smon_metrics` and `smon_container_status`
- Interval: 30s (`METRICS_INTERVAL` / `DOCKER_INTERVAL`)

### Storage Collector (`collector/storage.go`)
- DSM API: volume usage, disk health, SMART status
- Writes to `smon_storage_snapshots`
- Interval: 60s (`STORAGE_INTERVAL`)

### Drive Collector (`collector/drive.go`)
- DSM API: team folders, user activity, Drive stats
- Tries DSM API for ShareSync tasks; falls back to log parsing
- Also emits `sharesync_detail` log entries per task with remote_host, direction, local_share, remote_share, task_uuid for root-cause identification
- Log paths tried for ShareSync:
  - `/host/shares/@SynologyDriveShareSync/*/log/syncfolder.log`
  - `/host/shares/@synologydrive/*/log/syncfolder.log`
- Interval: 30s (uses `MetricsInterval`)

### Process Collector (`collector/process.go`)
- Reads `/host/proc/{pid}/stat`, `/status`, `/io`, `/cmdline` for every PID
- Calculates CPU% and bytes/sec I/O as deltas between samples
- Selects top-20 by CPU, top-20 by RSS, top-20 by total I/O — deduplicates by PID
- Maps process names to Synology service labels via `knownServices` map
- Resolves UIDs to usernames via `/host/etc/passwd` (cached in memory)
- Groups each pass with a `snapshot_grp` UUID for coherent point-in-time queries
- Interval: 15s (`PROCESS_INTERVAL`)
- **Requires:** `/proc:/host/proc:ro` and `/etc/passwd:/host/etc/passwd:ro` volume mounts

### Disk Stats Collector (`collector/diskstats.go`)
- Reads `/host/proc/diskstats`
- Emits per-device IOPS, throughput (MB/s), await (ms), utilisation (%), queue depth
- Filters: `sd*`, `hd*`, `nvme*`, `md*`, `xvd*`, `vd*` — excludes partitions
- `md0`→`/volume1`, `md1`→`/volume2`, `md2`→`/volume3`, `md3`→`/volume4`
- Interval: 15s (`DISKSTATS_INTERVAL`)
- **Requires:** `/proc:/host/proc:ro` volume mount

### Connections Collector (`collector/connections.go`)
- Parses `/host/proc/net/tcp` and `/host/proc/net/tcp6`
- Counts ESTABLISHED connections only (state `"01"`)
- Groups by `(remoteIP, localPort)` key; stores top-30 by connection count
- Skips loopback addresses
- Interval: 30s (`CONNECTIONS_INTERVAL`)
- **Requires:** `/proc:/host/proc:ro` volume mount

### Log Watcher (`logwatcher/watcher.go`)
- Tails log files in `LOG_DIR` (`/host/log`) and any `EXTRA_LOG_FILES`
- On startup, bootstraps multiple log sources (not just Drive):
  - drive sources: 200 lines, backup: 150, webapi/share/service: 100, storage/kernel: 75, package: 50
  - Also reads `.1` rotated file if the current file is < 8 KB (freshly rotated — old evidence preserved)
- Interval: 10s (`LOG_INTERVAL`)

Default log sources watched (13+ sources):

| Host file | `smon_logs.source` | Notes |
|-----------|---------------------|-------|
| `synologydrive.log` | `drive_server` | Main Drive server syslog |
| `@synologydrive/log/*.log` | `drive` / `drive_sharesync` | Per-folder Drive logs |
| `synolog/synowebapi.log` | `webapi` | **"Failed to SYNOShareGet" lives here** |
| `synolog/synostorage.log` | `storage` | Share/volume management |
| `synolog/synoshare.log` | `share` | Share database operations |
| `kern.log` | `kernel` | I/O stalls, SCSI errors, ATA errors |
| `synolog/synoinfo.log` | `system_info` | DSM config changes |
| `synolog/synoservice.log` | `service` | Service start/stop/crash |
| (samba, auth, etc.) | `smb`, `security`, etc. | Other DSM service logs |

### Share Health Collector (`collector/sharehealth.go`)
- Runs every 2 minutes via `SYNO.Core.*` DSM APIs
- **`GetShares()`** — enumerates all shared folders (encryption, recycle bin, path). If this fails, logs a `warning` to `smon_logs` source `share_health` (failure itself = diagnostic signal for corrupted share DB)
- **`GetInstalledPackages()`** — checks version and status of Drive, ShareSync, Docker, Container Manager, and other key packages → `smon_logs` source `package_health`
- **`GetRecentSystemLogs(200)`** — fetches structured DSM Log Center events (not in text log files) → `smon_logs` source `dsm_system_log`. Uses a `logWatermark` timestamp to avoid re-ingesting duplicate entries on each poll.
- **`collectShareQuotas()`** — reads quota_value/quota_used from share Additional fields, emits `share_quota_usage` metric. Logs at 85%=info, 90%=warning, 95%=error.
- Also emits: `share_config`, `share_health` log sources

### Service Health Collector (`collector/services.go`)
- Polls 12 key DSM services every 60 seconds:
  `SynologyDrive`, `SynologyDriveShareSync`, `smbd`, `nmbd`, `nginx`, `sshd`, `nfsd`, `pgsql`, `synoscgi`, `synoindexd`, `synologydrive-server`, `syslog-ng`
- Status check chain: `synoservicectl --status` → `synopkg status` → `pgrep -f` fallback
- **Restart detection:** tracks `prevStatus` across polls. `running→stopped` logs a `service_restart` warning; `stopped→running` logs a `service_restart` info. This catches restart events that are invisible in the service health table alone.
- **`getServiceUptime()`** — runs `ps -o etimes=` via pgrep to get process uptime in seconds, emits `service_uptime` metric
- Also scans `dmesg` for OOM kills and segfaults → `smon_logs` source `kernel_health`

### SysExtras Collector (`collector/sysextras.go`)
- Runs every 30 seconds
- **Memory pressure** from `/proc/meminfo`: MemAvailable%, SwapUsed%, Dirty+Writeback KB → `smon_metrics`
- **Inode usage** from `df -i /volume1` → `smon_metrics` (filesystem/total/used metadata)
- **CPU temperature** from `/sys/class/thermal/thermal_zone*/temp` → `smon_metrics`
- **CPU iowait%** from `/proc/stat` first `cpu` line — delta of iowait jiffies ÷ total jiffies. Metric type: `cpu_iowait_pct`. High iowait (>20%) means the CPU is waiting on disk.
- **NFS server stats** from `/proc/net/rpc/nfsd` — emits `nfs_read_bps`, `nfs_write_bps`, `nfs_calls_ps`. Skips silently if file absent (NFS not running).
- **VM page pressure** from `/proc/vmstat` — emits `vm_pgpgout_ps` (page writeback rate) and `vm_swap_out_ps`/`vm_swap_in_ps`. `vm_pgpgout_ps > 10000` means heavy memory pressure.
- **Btrfs errors** from `/sys/fs/btrfs/<uuid>/` — reads `corruption_errs`, `generation_errs`, `read_errs`, `write_errs`. Logs as `btrfs_error` source if any are nonzero.
- All paths try `/host/proc` and `/host/sys` first, then fall back to bare `/proc` / `/sys`.

### Custom Metric Collector (`collector/custom.go`)
The AI's mechanism for permanently expanding what the agent collects without a code change.

- Polls `smon_custom_metric_schedules` in Supabase every 60 seconds
- Filters schedules where `nas_id` matches `NAS_NAME` (the human-readable name like `edgesynology1`, NOT the UUID) and `next_run_at <= now()`
- Optimistic lock: PATCHes `next_run_at` atomically — only proceeds if the row was actually updated (prevents concurrent collection from multiple agents)
- Runs `sh -c <command>` natively inside the container (30-second timeout)
- Queues results via `sender.QueueCustomMetricData()` → `smon_custom_metric_data`

**How a schedule gets created:** The AI issue agent's `processMissingDataSuggestions()` function writes a schedule row when the analysis concludes data is missing. Schedules with `collection_command` get created automatically. Those requiring manual action (e.g., "enable DSM audit log") are logged as instructions instead.

**Promotion tracking:** Each time a custom metric's data is used in an AI analysis context, `referenced_count` increments atomically via the `increment_metric_references` Supabase RPC function. When `referenced_count >= 3`, the metric is consistently useful and should be promoted to a built-in Go collector (requires a code change + rebuild).

### Security Watcher (`security/watcher.go`)
- `fsnotify` on `WATCH_PATHS`
- Entropy-based ransomware detection on new/modified files
- Mass-rename detection
- Checksum-based integrity scanning on `CHECKSUM_PATHS`
- Event-driven; interval: 15m for background scans (`SECURITY_INTERVAL`)

### Scheduled Task Collector (`collector/schedtasks.go`)
- Calls `GetAllScheduledTasks()` via DSM API — returns ALL tasks regardless of run state (unlike the DSM UI which only shows running tasks)
- Queues every task as `ScheduledTaskPayload` → `smon_scheduled_tasks`
- Also logs tasks with `last_result != 0` as warnings to `smon_logs` source `scheduled_task_failure`
- **Why needed:** failed scheduled tasks (backup scripts, maintenance scripts) produce no alert anywhere in DSM. This is the only place that captures silent script failures.
- Interval: 5m

### Hyper Backup Collector (`collector/hyperbackup.go`)
- Calls `GetHyperBackupTasks()` via DSM API — tries `SYNO.Backup.Task v1`, falls back to `SYNO.Core.Backup.Task v1`; returns nil/nil if both fail (non-fatal, package may not be installed)
- Queues each task as `BackupTaskPayload` → `smon_backup_tasks`
- Logs tasks with `last_result` of "error", "failed", or "warning" as errors to `smon_logs`
- Fields: ID, Name, Enabled, Status, LastResult, LastRunTime, NextRunTime, DestType, DestName, TotalBytes, TransferredBytes, SpeedBPS
- Interval: 5m

### Storage Pool Collector (`collector/storagepool.go`)
- Uses two internal tickers (not a single interval argument):
  - **Every 60s:** parses `/host/proc/mdstat` for each `md` device:
    - State: parses `[UU_]` pattern to determine degraded vs healthy
    - Resync/recovery/check/reshape progress %, speed (MB/s), and ETA
    - Emits `QueueMetric` + `QueueLog` for degraded or in-progress arrays
  - **Every 5m:** calls `GetSnapshotReplicationTasks()` via DSM API (tries `SYNO.Core.Share.Snapshot.ReplicaTask v1`, falls back to `SYNO.SynologyDrive.SnapshotReplication v1`)
    - Queues each task as `SnapshotReplicaPayload` → `smon_snapshot_replicas`

### Container I/O Collector (`collector/container_io.go`)
- Gets container ID→Name map from `GetDockerContainers()` each tick
- `readCgroupIO()` tries cgroup v1 first (`/sys/fs/cgroup/blkio/docker/<id>/blkio.throttle.io_service_bytes` + `io_serviced`), then cgroup v2 (`/sys/fs/cgroup/system.slice/docker-<id>.scope/io.stat`)
- Delta-computes ReadBPS/WriteBPS/ReadOPS/WriteOPS from cumulative counters
- Skips containers where neither cgroup path exists (e.g., paused containers)
- Uses `sync.Mutex` protecting a `prev map[string]*containerIOPrev` for the delta state
- Queues `ContainerIOPayload` → `smon_container_io`
- Interval: 30s

### Sender (`sender/sender.go`)
- SQLite WAL buffer at `/app/data/wal.db` — survives Supabase outages
- Batches rows (up to `BATCH_SIZE=100`) and flushes every `FLUSH_TIMEOUT=30s`
- WAL is truncated after successful flush; max size `MAX_WAL_SIZE_MB=100`
- Queue methods: `QueueMetric`, `QueueLog`, `QueueStorageSnapshot`, `QueueContainerStatus`, `QueueServiceHealth`, `QueueCustomMetricData`, `QueueScheduledTask`, `QueueBackupTask`, `QueueSnapshotReplica`, `QueueContainerIO`

**Critical Supabase constraint:** PostgREST (Supabase's REST layer) returns HTTP 400 if you POST a column that doesn't exist in the table schema. This means you can NEVER add new fields to an existing payload struct without first creating the column in Supabase. New data categories MUST use new table names (new payload struct + new Supabase table). This is why new collectors always get their own table rather than extending an existing one.

## DSM API Integrations (`dsm/client.go`)

| API | Method | Purpose |
|-----|--------|---------|
| `SYNO.Core.Share` | `GetShares()` | All shared folders, encryption, recycle bin, quota info |
| `SYNO.Core.Package` | `GetInstalledPackages()` | Package name, version, status (running/stopped) |
| `SYNO.Core.SyslogClient.Log` | `GetRecentSystemLogs(limit)` | Structured DSM Log Center events not in text files |
| `SYNO.Core.TaskScheduler` | `GetAllScheduledTasks()` | All scheduled tasks with last_result (exit code) |
| `SYNO.Backup.Task` / `SYNO.Core.Backup.Task` | `GetHyperBackupTasks()` | Hyper Backup task state (dual-API fallback) |
| `SYNO.Core.Share.Snapshot.ReplicaTask` | `GetSnapshotReplicationTasks()` | Snapshot replication task state |
| `SYNO.SynologyDrive.ShareSync` | (extended) | Extended with RemoteHost, Direction, LocalShareName, RemoteShareName, TaskUUID |

## NAS Copilot — Issue Agent (`issue-agent.ts`)

The Copilot uses a conversation-loop agent, not a state machine. Each agent cycle reads the full issue state (conversation history, evidence, past actions) and decides what to do next.

### AI Personality: "THE DRIVER"

The system prompt establishes:

> **YOU ARE THE DRIVER, NOT A PASSENGER.**
> You own this issue end to end. Maintain one coherent hypothesis, update it when new evidence arrives, and either:
> 1. run the one best next read-only diagnostic,
> 2. propose one exact remediation action for approval, or
> 3. ask the user one focused question when automation is blocked.

### Three-Model Architecture (via OpenRouter)

| Role | Model | Purpose |
|------|-------|---------|
| Diagnosis | `google/gemini-2.5-flash` | Initial diagnosis (no completed diagnostic actions yet) |
| Remediation / analysis | `openai/gpt-5.4` | Primary analysis once diagnostics have run |

Model selection is automatic: if any `diagnostic` action is `completed` in the issue's action history, the remediation model is used; otherwise the diagnosis model is used. This is implemented in `callDecisionModel()`.

Both models are configurable in Settings > AI Models. Model IDs stored in `smon_ai_settings` table.

### Agent Loop (`MAX_AGENT_CYCLES = 2`)

Each "tick" runs up to 2 cycles. A cycle:
1. Calls `gatherTelemetryContext()` — 10 parallel Supabase queries
2. Calls `callDecisionModel()` — returns an `AgentDecision`
3. Persists: updates issue fields, saves evidence, saves agent message
4. If `diagnostic_action` is set and auto-approvable: runs it, saves result, loops (up to cycle limit)
5. If `remediation_action` is set: creates an action with `waiting_for_approval` status, stops

The agent stops itself when status is `waiting_on_user`, `waiting_for_approval`, `resolved`, or `stuck`.

### `AgentDecision` Fields

```typescript
type AgentDecision = {
  response: string;              // What the agent says to the user
  summary: string;               // One-line issue summary
  current_hypothesis: string;    // Current best explanation of the problem
  hypothesis_confidence: IssueConfidence;  // low | medium | high
  severity: IssueSeverity;       // info | warning | error | critical
  affected_nas: string[];        // Which NAS units are affected
  conversation_summary: string;  // Running summary of conversation so far
  next_step: string;             // What the agent plans to do next
  status: "running" | "waiting_on_user" | "waiting_for_approval" | "resolved" | "stuck";
  constraints_to_add: string[];  // New constraints to remember (e.g. "user says do not restart Samba")
  blocked_tools: CopilotToolName[];  // Tools the agent has decided not to use
  evidence_notes: Array<{ title: string; detail: string }>;  // New findings
  diagnostic_action: ToolActionPlan | null;    // Next diagnostic to run
  remediation_action: ToolActionPlan | null;   // Fix to propose for approval
};
```

### Telemetry Context (`gatherTelemetryContext`)

10 parallel Supabase queries per agent cycle:

| Query | Table | Window | Notes |
|-------|-------|--------|-------|
| Active alerts | `smon_alerts` | all active | limit 12 |
| Error/warning logs | `smon_logs` | 6h | critical/error/warning only, limit 80 |
| Top processes | `smon_process_snapshots` | 6h | limit 20 |
| Disk I/O | `smon_disk_io_stats` | 6h | limit 20 |
| Failed scheduled tasks | `smon_scheduled_tasks` | 48h | `last_result != 0 OR status = 'error'`, limit 20 |
| Backup tasks | `smon_backup_tasks` | 6h | deduped per task_id, limit 30 |
| Snapshot replicas | `smon_snapshot_replicas` | 6h | deduped per task_id, limit 20 |
| Container I/O (top writers) | `smon_container_io` | 30m | ordered by write_bps desc, limit 15 |
| ShareSync tasks | `smon_sync_task_snapshots` | 6h | deduped per task_id, limit 15 |
| I/O pressure metrics | `smon_metrics` | 30m | types: cpu_iowait_pct, nfs_read_bps/write_bps/calls_ps, vm_pgpgout_ps, vm_swap_out/in_ps |

**Telemetry field guide (thresholds the agent uses):**
- `disk_io`: `await_ms > 100ms` or `util_pct > 80%` = disk saturated
- `scheduled_tasks_with_issues`: any row with `last_result != 0` = script failure (silent, no alert elsewhere)
- `backup_tasks`: `last_result = 'error'|'failed'|'warning'` = broken backup
- `container_io_top`: a container writing >10 MB/s is likely the primary I/O contributor
- `sharesync_tasks`: `backlog_count > 100` = backed up queue; `retry_count > 5` = persistent failure
- `io_pressure_metrics`: `cpu_iowait_pct > 20%` = disk is bottleneck; `vm_pgpgout_ps > 10000` = memory pressure

### Diagnostic Tools (`tools.ts`)

| Tool | Purpose |
|------|---------|
| `check_drive_logs` | Drive sync logs, ShareSync status, error patterns |
| `check_system_resources` | CPU, memory, disk I/O stats |
| `check_network_connections` | Active TCP connection analysis |
| `check_security_events` | Security event history |
| `run_nas_diagnostic` | SSH-based deep diagnostics (ps, iostat, df) |
| `check_io_stalls` | D-state processes, I/O wait %, queue depths, hung_task warnings, iotop |
| `check_share_database` | `synoshare --enum ALL`, per-share `synoshare --get <name>` |
| `check_drive_package_health` | Package status, version, DB files, log file locations |
| `check_kernel_io_errors` | dmesg for I/O error, SCSI, ATA, ext4/btrfs errors, OOM |
| `search_webapi_log` | Greps `synowebapi.log`, `synostorage.log`, `synoshare.log` |
| `check_drive_database` | SQLite `PRAGMA integrity_check` on all Drive `.db` files |
| `search_all_logs` | Iterates ALL log files, reports match counts and samples |
| `check_filesystem_health` | mount, df -i, tune2fs/btrfs check, smartctl, /proc/mdstat |
| `check_scheduled_tasks` | Queries scheduler SQLite DB + searches scheduler log for errors |
| `check_backup_status` | HyperBackup package status + backup log inspection |
| `check_container_io` | Reads cgroup blkio + `docker stats --no-stream` for per-container I/O |
| `check_sharesync_status` | Live ShareSync status (SSH) |
| `tail_sharesync_log` | Last N lines of ShareSync log |
| `tail_drive_server_log` | Last N lines of Drive server log |
| `search_drive_server_log` | Pattern search in Drive server log |
| `get_resource_snapshot` | Point-in-time snapshot of processes, disk, connections |
| `find_problematic_files` | Find files with problematic names (long, special chars, etc.) |

**For Drive/ShareSync issues,** the system prompt mandates plans ALWAYS include: `check_share_database`, `check_drive_package_health`, `search_webapi_log`, `check_kernel_io_errors`.

### Known Synology Error Patterns (in AI prompts)

| Error | Tool to use |
|-------|------------|
| `"Failed to SYNOShareGet"` / `"share_db_get.c"` | `check_share_database` + `search_webapi_log` |
| `"WebAPI SYNO.SynologyDrive.* is not valid"` | `check_drive_package_health` |
| `"error when reading st :stoi"` / `"service-ctrl.cpp"` | `search_all_logs` with filter "stoi" |
| Processes in 'D' state | `check_io_stalls` + `check_kernel_io_errors` |
| SSH returns banner with no output | Symptom (log it), try alternative tool |

### HMAC-Signed Approval Tokens

All write/destructive operations require signed approval tokens:
- HMAC-SHA256 signed with `COPILOT_ACTION_SIGNING_KEY`
- 15-minute expiry
- Verified server-side before execution

### Admin Version Banner (`components/dashboard/version-banner.tsx`)

- Fixed top-right position on every dashboard page
- Only visible to users with `role === "admin"` (checked via `/api/copilot/session`)
- Shows: `build <sha> · <date>` baked in at Next.js build time via `next.config.ts`
- Build env vars: `NEXT_PUBLIC_GIT_SHA` and `NEXT_PUBLIC_BUILD_DATE`

## Database Schema Details

### `smon_process_snapshots`

Top processes by CPU / memory / disk I/O, collected every 15 s.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `nas_id` | UUID | FK to smon_nas_units |
| `snapshot_grp` | UUID | Groups all rows from a single collection pass. Use this to query a coherent point-in-time view. |
| `captured_at` | TIMESTAMPTZ | When collected |
| `pid` | INTEGER | Linux PID |
| `name` | TEXT | Process name from `/proc/PID/stat` (comm field) |
| `cmdline` | TEXT | Full command line, truncated at 256 chars |
| `username` | TEXT | Resolved from UID via `/host/etc/passwd`; falls back to numeric UID string |
| `state` | CHAR(1) | Linux process state: R=running, S=sleeping, D=uninterruptible wait, Z=zombie, T=stopped |
| `cpu_pct` | FLOAT | CPU % since last sample |
| `mem_rss_kb` | BIGINT | Resident set size in KB |
| `mem_pct` | FLOAT | `mem_rss_kb / MemTotal × 100` |
| `read_bps` | BIGINT | Bytes/sec read from storage |
| `write_bps` | BIGINT | Bytes/sec written to storage |
| `parent_service` | TEXT | Human-readable Synology service name (e.g. "Samba (SMB)") |
| `cgroup` | TEXT | Always NULL — not implemented (reserved column) |

### `smon_disk_io_stats`

Per-disk IOPS, throughput, latency, and utilisation, collected every 15 s.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `nas_id` | UUID | FK |
| `captured_at` | TIMESTAMPTZ | |
| `device` | TEXT | Linux device name, e.g. `sda`, `md0`, `nvme0n1` |
| `volume_path` | TEXT | `md0`→`/volume1`, `md1`→`/volume2`, etc. NULL for physical disks. |
| `reads_ps` | FLOAT | Read operations per second |
| `writes_ps` | FLOAT | Write operations per second |
| `read_bps` | BIGINT | Read bytes/sec |
| `write_bps` | BIGINT | Write bytes/sec |
| `await_ms` | FLOAT | Average I/O latency in milliseconds |
| `util_pct` | FLOAT | % of wall time the device was doing I/O, capped at 100 |
| `queue_depth` | FLOAT | Average request queue depth (avgqu-sz) |

### `smon_service_health`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `nas_id` | UUID | FK |
| `service_name` | TEXT | e.g. `SynologyDrive`, `smbd` |
| `status` | TEXT | `running`, `stopped`, `unknown` |
| `captured_at` | TIMESTAMPTZ | |

### `smon_scheduled_tasks`

All DSM scheduled tasks, including those that last ran with errors.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `nas_id` | UUID | FK |
| `task_id` | TEXT | DSM task ID |
| `task_name` | TEXT | Task name |
| `task_type` | TEXT | e.g. `script`, `backup`, `beep` |
| `owner` | TEXT | Owner user |
| `enabled` | BOOLEAN | |
| `status` | TEXT | Current run status |
| `last_run_time` | TIMESTAMPTZ | |
| `next_run_time` | TIMESTAMPTZ | |
| `last_result` | INTEGER | Exit code — 0 = success, nonzero = failure |
| `captured_at` | TIMESTAMPTZ | |

### `smon_backup_tasks`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `nas_id` | UUID | FK |
| `task_id` | TEXT | |
| `task_name` | TEXT | |
| `enabled` | BOOLEAN | |
| `status` | TEXT | e.g. `running`, `idle`, `error` |
| `last_result` | TEXT | e.g. `success`, `error`, `warning` |
| `last_run_time` | TIMESTAMPTZ | |
| `next_run_time` | TIMESTAMPTZ | |
| `dest_type` | TEXT | Destination type (local, remote, cloud) |
| `dest_name` | TEXT | Destination name |
| `total_bytes` | BIGINT | Total size |
| `transferred_bytes` | BIGINT | Transferred in last run |
| `speed_bps` | BIGINT | Current transfer speed |
| `captured_at` | TIMESTAMPTZ | |

### `smon_snapshot_replicas`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `nas_id` | UUID | FK |
| `task_id` | TEXT | |
| `task_name` | TEXT | |
| `status` | TEXT | |
| `src_share` | TEXT | Source share name |
| `dst_share` | TEXT | Destination share name |
| `dst_host` | TEXT | Destination NAS hostname |
| `last_result` | TEXT | |
| `last_run_time` | TIMESTAMPTZ | |
| `next_run_time` | TIMESTAMPTZ | |
| `captured_at` | TIMESTAMPTZ | |

### `smon_container_io`

Per-container block I/O rates, collected every 30 s.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `nas_id` | UUID | FK |
| `captured_at` | TIMESTAMPTZ | |
| `container_id` | TEXT | Docker container ID (short) |
| `container_name` | TEXT | Docker container name |
| `read_bps` | BIGINT | Bytes/sec read from block devices |
| `write_bps` | BIGINT | Bytes/sec written to block devices |
| `read_ops` | BIGINT | Read operations/sec |
| `write_ops` | BIGINT | Write operations/sec |

### `smon_custom_metric_schedules`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `nas_id` | TEXT | NAS name string (e.g. `edgesynology1`), not UUID |
| `metric_name` | TEXT | Human-readable name |
| `description` | TEXT | Why this is collected |
| `collection_command` | TEXT | Shell command run inside the agent container |
| `interval_minutes` | INTEGER | How often to run |
| `next_run_at` | TIMESTAMPTZ | When to run next (optimistic lock used during collection) |
| `referenced_count` | INTEGER | How many times data was used in AI analysis |
| `created_by_resolution_id` | UUID | Which resolution requested this |
| `created_at` | TIMESTAMPTZ | |

### `smon_custom_metric_data`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `schedule_id` | UUID | FK to smon_custom_metric_schedules |
| `nas_id` | TEXT | NAS name string |
| `raw_output` | TEXT | Command stdout/stderr |
| `error` | TEXT | Error message if command failed |
| `captured_at` | TIMESTAMPTZ | |

### `smon_sync_task_snapshots`
ShareSync and Drive task state. **May be empty** because the DSM ShareSync API returns error code 102 on both NAS units. The drive collector falls back to log parsing in this case.

### `smon_net_connections`

Active TCP connections grouped by remote IP and local service port, collected every 30 s. Top 30 remote peers by connection count. `username` is always NULL.

### Log Sources (`smon_logs.source`)

| Source | Description |
|--------|-------------|
| `drive` | Drive package logs (`@synologydrive/log/*.log`) |
| `drive_server` | Drive server syslog (`/var/log/synologydrive.log`) |
| `drive_sharesync` | ShareSync activity log (`syncfolder.log`) |
| `smb` | SMB file operations |
| `security` | Security/firewall events |
| `system` | DSM system logs |
| `connection` | Connection logs |
| `webapi` | `synowebapi.log` — "Failed to SYNOShareGet" lives here |
| `storage` | `synostorage.log` — share/volume management |
| `share` | `synoshare.log` — share database operations |
| `kernel` | `kern.log` — I/O stalls, SCSI errors, ATA errors |
| `system_info` | `synoinfo.log` — DSM config changes |
| `service` | `synoservice.log` — service start/stop/crash |
| `kernel_health` | OOM kills and segfaults from dmesg (via servicehealth collector) |
| `share_config` | Share enumeration results (via sharehealth collector) |
| `share_health` | Share DB failure events (via sharehealth collector) |
| `package_health` | Package status events (via sharehealth collector) |
| `dsm_system_log` | Structured DSM Log Center entries (via sharehealth collector) |
| `scheduled_task_failure` | Failed scheduled tasks with non-zero exit code (via schedtasks collector) |
| `btrfs_error` | Btrfs filesystem error counters (via sysextras collector) |
| `service_restart` | Service state transitions — running→stopped and back (via servicehealth collector) |
| `sharesync_detail` | Per-task ShareSync companion log with remote_host/direction/shares info |

## Code Gotchas and Idiosyncrasies

### 1. First collection pass is baseline-only
Both `ProcessCollector` and `DiskStatsCollector` need two samples to calculate rates. On startup, `collect(false)` is called once to build the baseline. No data is written to Supabase from this pass. The first rows appear after the second tick (~15s after startup). This is intentional.

### 2. Container I/O collector first sample is also baseline-only
Same pattern as process/diskstats: the first tick in `ContainerIOCollector` stores cumulative cgroup counters as `prev` but emits no rows. The second tick computes the delta and writes rows. This means you'll see no container I/O data for the first ~30 seconds after startup.

### 3. AGENT_IMAGE_TAG pins Docker to a specific image
The NAS `.env` file contains `AGENT_IMAGE_TAG=latest`. If it ever gets changed to a SHA tag (e.g. `sha-373b526`), `docker compose up -d` will silently use the old image even if you already ran `docker pull ghcr.io/.../agent:latest`. Docker Compose resolves image references at container creation time, not pull time. To recover: `docker stop synology-monitor-agent && docker rm synology-monitor-agent && docker compose up -d`.

### 4. `/proc/net/tcp` IPs are little-endian hex
The IP addresses in `/proc/net/tcp` are stored in little-endian hex — not dotted-decimal, not network byte order. For IPv4, each 4-byte address has its bytes reversed. For IPv6, each 32-bit word has its bytes reversed independently. See `parseIP()` in `connections.go`.

### 5. CPU% formula uses USER_HZ=100
Linux reports CPU time in "jiffies" (USER_HZ ticks). On all modern Linux systems USER_HZ=100, meaning 100 ticks/second. The formula is: `cpu_pct = (delta_utime + delta_stime) / (wall_seconds × 100) × 100`. This is hardcoded as `clockTicksPerS = 100`. If you ever see CPU% over 100% it means the process is multi-threaded; the collector doesn't cap it. Same formula applies to `collectIOWait()` in sysextras.

### 6. `/proc/PID/io` counts actual storage bytes, not virtual I/O
`read_bytes` and `write_bytes` in `/proc/PID/io` account for page cache — they count bytes that actually hit storage, not all read/write syscall bytes.

### 7. `snapshot_grp` UUID groups a collection pass
All process rows from a single `collect()` call share the same `snapshot_grp` UUID. To query "what was running at time X", filter by `snapshot_grp` rather than `captured_at`. Example: `SELECT * FROM smon_process_snapshots WHERE snapshot_grp = '<uuid>'`.

### 8. ShareSync API returns error code 102 on these NAS units
DSM API error code 102 means "the requested API is not available" (not installed or wrong version). The Drive collector tries three API variants for ShareSync, and all return 102 on edgesynology1 and edgesynology2. This is not a bug — the fallback to log parsing runs. `smon_sync_task_snapshots` will be empty until either the API becomes available or the log parsing finds matching patterns.

### 9. Synology Container Manager rejects `/volume1` as a top-level bind
The compose file uses explicit share mounts (`/volume1/files:/host/shares/files:ro` etc.) instead of mounting `/volume1` directly. This is because Synology's Container Manager UI rejects top-level volume binds during compose/UI recreates with the error `Fail to parse share name from [/volume1]`. The Docker CLI can still use `/volume1` directly, but the UI path cannot.

### 10. `NAS_ID` must be a valid UUID; `NAS_NAME` is the human-readable string
`config.Load()` calls `looksLikeUUID()` and returns an error if `NAS_ID` is not in `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` format. The `CustomCollector` uses `NAS_NAME` (e.g. `edgesynology1`) as the `nas_id` in `smon_custom_metric_schedules`, not the UUID.

### 11. Second opinion model requires dedicated JSON enforcement
The `anthropic/claude-sonnet-4` model (via OpenRouter) ignores `response_format: { type: "json_object" }` and will return prose if not explicitly forced. `callSecondOpinion<T>()` uses: (1) a system message forcing JSON-only output, (2) an explicit JSON instruction appended to the prompt, and (3) a regex fallback `{[\s\S]*}` to extract JSON from prose if the parse fails.

### 12. Custom collector uses NAS_NAME, not NAS_ID
When polling `smon_custom_metric_schedules`, the `CustomCollector` filters `WHERE nas_id = NAS_NAME` (the human-readable name, e.g. `edgesynology1`). This allows the web app's issue agent to target schedules by the name it knows, without needing to manage UUIDs.

### 13. Agent binary is stripped
The binary is built with `-ldflags="-s -w"`, removing DWARF debug info and the symbol table. `strings` output will show string constants but `nm` and backtrace symbol names will not work. This keeps the image small (~16 MB).

### 14. `cgroup` column in process_snapshots is always NULL
The `smon_process_snapshots.cgroup` column was defined in the migration but the collector never populates it. It's a placeholder for future cgroup attribution.

### 15. `username` in `smon_net_connections` is always NULL
The connections collector counts TCP sessions by remote IP but does not attribute them to a system user.

### 16. Cgroup v1 vs v2 fallback for container I/O
Synology DSM may run either cgroup v1 or v2 depending on the DSM version. `readCgroupIO()` tries v1 first (`/sys/fs/cgroup/blkio/docker/<id>/blkio.throttle.io_service_bytes`). If that path doesn't exist, it tries v2 (`/sys/fs/cgroup/system.slice/docker-<id>.scope/io.stat` with `rbytes`/`wbytes` format). If neither exists, the container is silently skipped. No mixed-version handling is needed — all containers on the same host use the same cgroup version.

### 17. PostgREST rejects unknown columns (HTTP 400)
Supabase uses PostgREST. If you POST a JSON body with a field that doesn't exist in the table, PostgREST returns HTTP 400 `"Could not find the field <x> in the schema cache"`. This means: **never add a new field to an existing payload struct** without first creating the column in Supabase via a migration. New data categories get new tables — that's why the codebase has separate tables for container_io, scheduled_tasks, backup_tasks, and snapshot_replicas rather than adding columns to existing tables.

### 18. `dedupeLatestByField` prevents context flooding
In `issue-agent.ts`, backup tasks and sync tasks are deduped before being sent to the AI model. Since the agent collects these every 5 minutes, there may be many rows per task in the 6-hour window. `dedupeLatestByField(items, "task_id")` keeps only the most recent row per task, preventing the AI context from being flooded with identical state snapshots. The array must be pre-sorted by `captured_at desc` (which the Supabase queries do) for this to return the latest row.

### 19. Scheduled tasks use 48h window (not 6h)
Failed scheduled tasks (`last_result != 0`) are queried with a 48-hour lookback window rather than the 6h window used by other tables. This is because scheduled tasks may only run once per day or less — a 6h window would miss most failures. The 48h window catches tasks that failed in their last run even if that was yesterday.

### 20. `logWatermark` prevents DSM log re-ingestion
`sharehealth.go` keeps a `logWatermark time.Time` in memory. After each DSM Log Center poll, the watermark is advanced to the newest entry timestamp. On the next poll, entries at or before the watermark are skipped. This prevents the same structured log entries from being written to `smon_logs` multiple times. The watermark resets on container restart (not persisted to disk), so the first poll after startup will ingest the last N entries fresh.

### 21. `bootstrapRotated` only reads rotated files when current file is fresh
When the logwatcher starts up, `bootstrapRotated(path, source, lines)` checks if the current log file is smaller than 8 KB. If it is, the file was recently rotated (old content moved to `.1`) and the `.1` file is read to backfill. If the current file is larger than 8 KB, the `.1` file is skipped — the current file has enough content and reading `.1` would double-ingest old entries.

### 22. `StoragePoolCollector` uses dual internal tickers, not a single interval
Most collectors take a single interval argument passed from `main.go`. `StoragePoolCollector` is different: it creates two `time.NewTicker` calls internally — one at 60s for mdstat parsing, one at 5m for snapshot replication tasks. This is because the two data sources have different natural cadences. The `main.go` instantiation has no interval argument: `storagepool.NewStoragePoolCollector(cfg, sender, dsmClient)`.
