# Synology Monitor: Project Guide

## Read This First

This repository monitors two Synology DS1621xs+ NAS devices. The core business priority is:

- Synology Drive reliability and ShareSync behavior
- Filesystem changes and user-attributed file operations
- Sync failures, conflicts, rename/move/delete activity
- I/O spike attribution — identifying which processes, disks, and remote clients are causing heavy load
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
│  │  Collectors (all goroutines in main.go):                │    │
│  │  - system      → smon_metrics (30s)                     │    │
│  │  - storage     → smon_storage_snapshots (60s)           │    │
│  │  - docker      → smon_container_status (30s)            │    │
│  │  - drive       → smon_drive_team_folders, etc. (30s)    │    │
│  │  - process     → smon_process_snapshots (15s)           │    │
│  │  - diskstats   → smon_disk_io_stats (15s)               │    │
│  │  - connections → smon_net_connections (30s)             │    │
│  │  - logwatcher  → smon_logs (10s)                        │    │
│  │  - security    → smon_security_events (event-driven)    │    │
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
│  NAS Copilot: two-model AI (OpenRouter)                          │
│  - google/gemini-2.5-flash  (diagnosis / bulk log analysis)      │
│  - openai/gpt-5.4           (remediation / chat)                 │
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
5. To deploy: SSH in and run `docker compose -f compose.yaml pull && docker compose -f compose.yaml up -d`

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
│   │       └── lib/
│   │           └── server/
│   │               ├── copilot.ts         # AI integration (context, tools, SSH)
│   │               └── nas.ts             # SSH diagnostics
│   └── agent/                  # Go monitoring agent
│       ├── cmd/agent/
│       │   └── main.go         # Entry point — starts all collector goroutines
│       └── internal/
│           ├── collector/      # All data collectors
│           │   ├── system.go   # CPU, mem, network metrics + Docker stats
│           │   ├── drive.go    # Drive Admin API + ShareSync task parsing
│           │   ├── process.go  # Per-process CPU/mem/disk I/O (reads /proc)
│           │   ├── diskstats.go# Per-disk IOPS/throughput/await (reads /proc/diskstats)
│           │   └── connections.go # Active TCP connections (reads /proc/net/tcp)
│           ├── config/         # Config loading from env vars
│           ├── dsm/            # DSM API client (SYNO.* API calls)
│           ├── logwatcher/     # Log file tailing & parsing
│           ├── security/       # Ransomware/entropy detection, fsnotify
│           └── sender/
│               ├── sender.go   # SQLite WAL buffer + Supabase flush
│               └── types.go    # Payload structs for all Supabase tables
├── supabase/
│   └── migrations/             # Database schema history
├── resource-snapshot-migration.sql  # Migration for I/O attribution tables (already applied)
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
| `smon_metrics` | CPU, memory, network metrics | `system` collector (30s) |
| `smon_storage_snapshots` | Volume and disk state | `storage` collector (60s) |
| `smon_container_status` | Docker container state (180-day retention) | `system` collector (30s) |
| `smon_logs` | Ingested log events from NAS | `logwatcher` collector (10s) |
| `smon_security_events` | Ransomware/entropy alerts | `security` watcher (event-driven) |
| `smon_alerts` | Active system alerts | SQL cron pipeline |

### AI Analysis Tables

| Table | Purpose |
|-------|---------|
| `smon_ai_analyses` | Legacy scheduled SQL-pipeline AI analyses |
| `smon_analysis_runs` | On-demand grouped analysis runs (google/gemini-2.5-flash) |
| `smon_analyzed_problems` | Root cause problems from grouped analysis |

### Copilot Tables

| Table | Purpose |
|-------|---------|
| `smon_copilot_sessions` | Chat session metadata |
| `smon_copilot_messages` | Individual chat messages |
| `smon_copilot_actions` | Approved/rejected NAS actions |

### Resource Attribution Tables

These four tables were added for I/O spike diagnosis. They are queried automatically by the Copilot when you ask about I/O or process activity. Migration: `resource-snapshot-migration.sql` (already applied to production).

#### `smon_process_snapshots`
Top processes by CPU / memory / disk I/O, collected every 15 s.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `nas_id` | UUID | FK to smon_nas_units |
| `snapshot_grp` | UUID | Groups all rows from a single collection pass (same timestamp). Use this to query a coherent point-in-time view. |
| `captured_at` | TIMESTAMPTZ | When collected |
| `pid` | INTEGER | Linux PID |
| `name` | TEXT | Process name from `/proc/PID/stat` (comm field) |
| `cmdline` | TEXT | Full command line (NUL-separated args joined with spaces), truncated at 256 chars |
| `username` | TEXT | Resolved from UID via `/host/etc/passwd`; falls back to numeric UID string |
| `state` | CHAR(1) | Linux process state: R=running, S=sleeping, D=uninterruptible wait, Z=zombie, T=stopped |
| `cpu_pct` | FLOAT | CPU percentage since last sample. Formula: `(delta_utime + delta_stime) / (wall_seconds × 100) × 100` |
| `mem_rss_kb` | BIGINT | Resident set size in KB from `/proc/PID/status` VmRSS |
| `mem_pct` | FLOAT | `mem_rss_kb / MemTotal × 100` |
| `read_bps` | BIGINT | Bytes/sec read from storage (delta `read_bytes` from `/proc/PID/io`) |
| `write_bps` | BIGINT | Bytes/sec written to storage (delta `write_bytes` from `/proc/PID/io`) |
| `parent_service` | TEXT | Human-readable Synology service name (e.g. "Samba (SMB)"), or empty if unknown |
| `cgroup` | TEXT | Always NULL — cgroup reading not implemented |

The first collection pass is a baseline-only pass (no rows emitted). Data starts appearing after the second interval tick (30 s after startup).

#### `smon_disk_io_stats`
Per-disk IOPS, throughput, latency, and utilisation, collected every 15 s.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `nas_id` | UUID | FK |
| `captured_at` | TIMESTAMPTZ | |
| `device` | TEXT | Linux device name, e.g. `sda`, `md0`, `nvme0n1` |
| `volume_path` | TEXT | Mapped Synology volume: `md0`→`/volume1`, `md1`→`/volume2`, `md2`→`/volume3`, `md3`→`/volume4`. NULL for physical disks. |
| `reads_ps` | FLOAT | Read operations per second |
| `writes_ps` | FLOAT | Write operations per second |
| `read_bps` | BIGINT | Read bytes/sec (delta sectors × 512) |
| `write_bps` | BIGINT | Write bytes/sec (delta sectors × 512) |
| `await_ms` | FLOAT | Average I/O latency in milliseconds: `(delta_ms_reading + delta_ms_writing) / (delta_reads + delta_writes)` |
| `util_pct` | FLOAT | % of wall time the device was doing I/O: `delta_ms_doing_io / wall_ms × 100`, capped at 100 |
| `queue_depth` | FLOAT | Average request queue depth (avgqu-sz): `delta_ms_weighted_io / wall_ms` |

Partitions (sda1, sda2…) are excluded. Only `sd*`, `hd*`, `nvme*`, `md*`, `xvd*`, `vd*` prefixes are collected. Synology RAID arrays appear as both `md*` (aggregate) and `sda`/`sdb` etc. (individual disks). The MD device gives the application-level view; individual disks give the hardware view.

#### `smon_sync_task_snapshots`
ShareSync and Drive task state, collected every 30 s. **Currently always empty** because the DSM ShareSync API returns error code 102 on both NAS units (API endpoint not available at the installed DSM version). The log-parsing fallback runs but finds no tasks. This is expected — the table will populate if the API becomes available or if log patterns match.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `nas_id` | UUID | |
| `captured_at` | TIMESTAMPTZ | |
| `task_id` | TEXT | Task identifier from DSM API or log file path |
| `task_name` | TEXT | |
| `task_type` | TEXT | `sharesync`, `drive`, or `backup` |
| `status` | TEXT | `running`, `idle`, `error`, or `stopped` |
| `backlog_count` | INTEGER | Files waiting to sync |
| `backlog_bytes` | BIGINT | |
| `current_file` | TEXT | File currently being transferred |
| `current_folder` | TEXT | Folder currently being processed |
| `retry_count` | INTEGER | |
| `last_error` | TEXT | |
| `transferred_files` | INTEGER | |
| `transferred_bytes` | BIGINT | |
| `speed_bps` | BIGINT | Transfer speed bytes/sec |
| `indexing_queue` | INTEGER | Pending indexing items |

#### `smon_net_connections`
Active TCP connections grouped by remote IP and local service port, collected every 30 s.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `nas_id` | UUID | |
| `captured_at` | TIMESTAMPTZ | |
| `remote_ip` | TEXT | Client IP address |
| `local_port` | INTEGER | Service port (445=SMB, 6690=Drive, 2049=NFS, 22=SSH, etc.) |
| `protocol` | TEXT | Service label derived from port: `smb`, `drive`, `nfs`, `ssh`, `dsm-https`, etc. |
| `conn_count` | INTEGER | Number of ESTABLISHED connections from this remote IP to this port |
| `username` | TEXT | Always NULL — username-to-connection mapping is not implemented |

Top 30 remote peers by connection count are stored. Loopback connections are excluded.

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

### Extra Tables (live, not in tracked migrations)

These tables exist in production but were not created by migrations in this repo:

| Table | Status |
|-------|--------|
| `smon_drive_activities` | Live — Drive user activity (individual file operations) |
| `smon_drive_team_folders` | Live — Drive team folder quota and usage snapshots |
| `smon_sync_remediations` | Live — remediation action records |

The SQL that created them is in `apply-migrations.ps1` (migrations 00008 and 00009). They should be added to the tracked migrations directory.

## Agent Capabilities

The Go agent running on each NAS collects data via seven parallel goroutines:

### System Collector (`collector/system.go`)
- DSM API: CPU%, memory usage, network RX/TX
- Docker stats via DSM API (container CPU, memory, status)
- Writes to `smon_metrics` and `smon_container_status`
- Interval: 30s (`METRICS_INTERVAL` / `DOCKER_INTERVAL`)

### Storage Collector (`collector/system.go`)
- DSM API: volume usage, disk health, SMART status
- Writes to `smon_storage_snapshots`
- Interval: 60s (`STORAGE_INTERVAL`)

### Drive Collector (`collector/drive.go`)
- DSM API: team folders, user activity, Drive stats
- Tries DSM API for ShareSync tasks; falls back to log parsing
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
- Parses `synologydrive.log` → `drive_server`
- Parses `@synologydrive/log/*.log` → `drive` / `drive_sharesync`
- On startup, bootstraps last 200 lines of Drive logs (backfill)
- Interval: 10s (`LOG_INTERVAL`)

### Security Watcher (`security/watcher.go`)
- `fsnotify` on `WATCH_PATHS`
- Entropy-based ransomware detection on new/modified files
- Mass-rename detection
- Checksum-based integrity scanning on `CHECKSUM_PATHS`
- Event-driven; interval: 15m for background scans (`SECURITY_INTERVAL`)

### Sender (`sender/sender.go`)
- SQLite WAL buffer at `/app/data/wal.db` — survives Supabase outages
- Batches rows (up to `BATCH_SIZE=100`) and flushes every `FLUSH_TIMEOUT=30s`
- WAL is truncated after successful flush; max size `MAX_WAL_SIZE_MB=100`

## Code Gotchas and Idiosyncrasies

These are things that will surprise a new developer:

### 1. First collection pass is baseline-only
Both `ProcessCollector` and `DiskStatsCollector` need two samples to calculate rates. On startup, `collect(false)` is called once to build the baseline. No data is written to Supabase from this pass. The first rows appear after the second tick (~15s after startup). This is intentional.

### 2. AGENT_IMAGE_TAG pins Docker to a specific image
The NAS `.env` file contains `AGENT_IMAGE_TAG=latest`. If it ever gets changed to a SHA tag (e.g. `sha-373b526`), `docker compose up -d` will silently use the old image even if you already ran `docker pull ghcr.io/.../agent:latest`. Docker Compose resolves image references at container creation time, not pull time. To recover: `docker stop synology-monitor-agent && docker rm synology-monitor-agent && docker compose up -d`.

### 3. `/proc/net/tcp` IPs are little-endian hex
The IP addresses in `/proc/net/tcp` are stored in little-endian hex — not dotted-decimal, not network byte order. For IPv4, each 4-byte address has its bytes reversed. For IPv6, each 32-bit word has its bytes reversed independently. See `parseIP()` in `connections.go`.

### 4. CPU% formula uses USER_HZ=100
Linux reports CPU time in "jiffies" (USER_HZ ticks). On all modern Linux systems USER_HZ=100, meaning 100 ticks/second. The formula is: `cpu_pct = (delta_utime + delta_stime) / (wall_seconds × 100) × 100`. This is hardcoded as `clockTicksPerS = 100`. If you ever see CPU% over 100% it means the process is multi-threaded; the collector doesn't cap it.

### 5. `/proc/PID/io` counts actual storage bytes, not virtual I/O
`read_bytes` and `write_bytes` in `/proc/PID/io` account for page cache — they count bytes that actually hit storage, not all read/write syscall bytes. This makes them a better proxy for disk pressure than syscall counters.

### 6. `snapshot_grp` UUID groups a collection pass
All process rows from a single `collect()` call share the same `snapshot_grp` UUID. To query "what was running at time X", filter by `snapshot_grp` rather than `captured_at` (which may vary slightly between rows). Example: `SELECT * FROM smon_process_snapshots WHERE snapshot_grp = '<uuid>'`.

### 7. ShareSync API returns error code 102 on these NAS units
DSM API error code 102 means "the requested API is not available" (not installed or wrong version). The Drive collector tries three API variants for ShareSync, and all return 102 on edgesynology1 and edgesynology2. This is not a bug — the fallback to log parsing runs. `smon_sync_task_snapshots` will be empty until either the API becomes available or the log parsing finds matching patterns.

### 8. Synology Container Manager rejects `/volume1` as a top-level bind
The compose file uses explicit share mounts (`/volume1/files:/host/shares/files:ro` etc.) instead of mounting `/volume1` directly. This is because Synology's Container Manager UI rejects top-level volume binds during compose/UI recreates with the error `Fail to parse share name from [/volume1]`. The Docker CLI can still use `/volume1` directly, but the UI path cannot. See `HANDOFF_PROMPT.md` for the full history.

### 9. `NAS_ID` must be a valid UUID
`config.Load()` calls `looksLikeUUID()` and returns an error if `NAS_ID` is not in `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` format. The agent will refuse to start with a non-UUID `NAS_ID`. This matches the `smon_nas_units.id` column type.

### 10. Agent binary is stripped
The binary is built with `-ldflags="-s -w"`, removing DWARF debug info and the symbol table. `strings` output will show string constants (log messages, etc.) but `nm` and backtrace symbol names will not work. This keeps the image small (~16 MB).

### 11. `cgroup` column is always NULL
The `smon_process_snapshots.cgroup` column was defined in the migration but the collector never populates it. It's a placeholder for future cgroup attribution.

### 12. `username` in `smon_net_connections` is always NULL
The connections collector counts TCP sessions by remote IP but does not attribute them to a system user. The `username` column is defined in the schema but never set.

## NAS Copilot (`/assistant`)

AI-powered assistant using a two-model architecture, both via OpenRouter.

### Models
1. **google/gemini-2.5-flash** — diagnosis model: bulk log analysis, pattern detection, root cause grouping
2. **openai/gpt-5.4** — remediation model: detailed repair proposals, action token generation

Both are configurable in Settings > AI Models. Model IDs stored in `smon_ai_settings` table.

### Context Provided to Copilot
Every Copilot message automatically includes (from the last 15 minutes):
- Recent `smon_logs` (last 200 rows, filtered to Drive/SMB/security)
- Active `smon_alerts`
- Recent `smon_metrics`
- Top processes by write I/O (`smon_process_snapshots`, last 60 rows)
- Disk I/O stats (`smon_disk_io_stats`, last 40 rows)
- Sync task state (`smon_sync_task_snapshots`, last 30 rows)
- Active connections (`smon_net_connections`, last 30 rows, ordered by conn_count)

### Tools Available to Copilot
- `get_resource_snapshot` — triggers SSH-based deep diagnostic (ps, iostat, df, etc.)
- `execute_nas_command` — runs pre-approved safe commands on NAS via SSH
- Other structured tools defined in `copilot.ts`

### Safety Model
- Destructive commands are blocked in `nas.ts`
- Actions require server-signed approval tokens
- Short expiration window for approved actions

### Required Environment Variables
```
OPENROUTER_API_KEY=sk-or-v1-...
NAS_EDGE1_HOST=100.107.131.35
NAS_EDGE1_PORT=22
NAS_EDGE1_USER=popdam
NAS_EDGE1_PASSWORD=...
NAS_EDGE1_SUDO_PASSWORD=...
NAS_EDGE2_HOST=100.107.131.36
NAS_EDGE2_PORT=1904
NAS_EDGE2_USER=popdam
NAS_EDGE2_PASSWORD=...
NAS_EDGE2_SUDO_PASSWORD=...
COPILOT_ACTION_SIGNING_KEY=<random secret>
COPILOT_ADMIN_EMAILS=admin@example.com
```

## AI Analysis Pipeline

Automatic root cause analysis via `POST /api/analysis`. Uses google/gemini-2.5-flash.

### Tables
- `smon_analysis_runs` — each analysis run (status, timing, raw model output)
- `smon_analyzed_problems` — grouped root cause problems with affected files/users/shares

### Separate Scheduled Pipeline
A SQL-based cron pipeline (defined in migration 00009) runs separately and writes to `smon_ai_analyses` and `smon_alerts`. This is the source of the generic "28 sync errors detected" alert messages. It is independent of the application-level analysis pipeline. Both pipelines are active in production.

## How to Deploy Changes

### Database schema changes
1. Write a migration SQL file in `supabase/migrations/`
2. Apply it via Supabase MCP tool or SQL Editor at `https://supabase.com` → project `qnjimovrsaacneqkggsn` → SQL Editor
3. Commit the migration file to the repo

### Agent code changes
1. Commit and push to `master`
2. GitHub Actions builds and publishes the new image (3–5 min)
3. SSH into each NAS and run:
   ```sh
   DOCKER=/var/packages/ContainerManager/target/usr/bin/docker
   cd /volume1/docker/synology-monitor-agent
   $DOCKER pull ghcr.io/u2giants/synology-monitor-agent:latest
   $DOCKER stop synology-monitor-agent
   $DOCKER rm synology-monitor-agent
   $DOCKER compose -f compose.yaml up -d
   $DOCKER logs synology-monitor-agent 2>&1 | head -20
   ```
4. Confirm the new collectors appear in the logs

**Why stop+rm before up -d?** If the container was previously running an old image, `compose up -d` without removing it may reuse the old container rather than creating a new one from the updated image. Always stop+rm to force recreation.

### Web app changes
Just push to `master`. Coolify handles the rest automatically.

### Verifying a new agent image is running
```sh
DOCKER=/var/packages/ContainerManager/target/usr/bin/docker
$DOCKER inspect synology-monitor-agent --format "{{.Image}}"
```
Compare the image SHA against `$DOCKER images ghcr.io/u2giants/synology-monitor-agent`.

## Key Files

| File | Purpose |
|------|---------|
| `apps/agent/cmd/agent/main.go` | Agent entry point — starts all goroutines |
| `apps/agent/internal/config/config.go` | Config loading; enforces UUID NAS_ID |
| `apps/agent/internal/collector/process.go` | Per-process CPU/mem/disk I/O |
| `apps/agent/internal/collector/diskstats.go` | Per-disk IOPS/throughput/await |
| `apps/agent/internal/collector/connections.go` | Active TCP connection counts |
| `apps/agent/internal/collector/drive.go` | Drive Admin + ShareSync collector |
| `apps/agent/internal/collector/system.go` | System metrics + Docker stats |
| `apps/agent/internal/dsm/client.go` | DSM API client |
| `apps/agent/internal/logwatcher/watcher.go` | Log tailing & parsing |
| `apps/agent/internal/security/watcher.go` | Ransomware detection |
| `apps/agent/internal/sender/sender.go` | SQLite WAL + Supabase flush |
| `apps/agent/internal/sender/types.go` | Payload structs for all tables |
| `apps/web/src/lib/server/copilot.ts` | AI context building + tool definitions |
| `apps/web/src/lib/server/nas.ts` | SSH command execution |
| `apps/web/src/app/api/copilot/chat/route.ts` | Chat API endpoint |
| `apps/web/src/app/api/copilot/execute/route.ts` | Action execution |
| `resource-snapshot-migration.sql` | I/O attribution tables (already applied) |
| `deploy/synology/docker-compose.agent.yml` | Canonical compose spec |

## Operational Notes

- Docker binary path on Synology: `/var/packages/ContainerManager/target/usr/bin/docker` — not on default PATH
- `docker compose up -d` after `docker pull` may still use the old container; always stop+rm first when updating
- Synology Container Manager can leave replaced containers in `Created` state during UI-driven recreates — prefer CLI
- SSH may emit host key / post-quantum algorithm warnings; check exit code, not just stderr
- The healthcheck at `/app/data/wal.db` only checks file existence, not database health
- Both NAS units have only `/volume1`; the extra share mounts (`/volume1/mac`, `/volume1/styleguides`, etc.) are configured in the live `.env` files on each NAS
- The web app and NAS agent share the same Supabase project but use different API keys (anon key for web, service role key for agent)

## Known Gaps

- ShareSync task data (`smon_sync_task_snapshots`) is empty — DSM API returns code 102 for ShareSync endpoints on both NAS units
- `username` in `smon_net_connections` is always NULL — connection-to-user attribution not implemented
- `cgroup` in `smon_process_snapshots` is always NULL
- SMB per-file audit coverage (only connection-level logging)
- Automatic data retention cleanup for high-frequency tables — the migration SQL includes a commented-out `pg_cron` schedule for this; without it, `smon_process_snapshots`, `smon_disk_io_stats`, and `smon_net_connections` grow indefinitely
- `smon_drive_activities` and `smon_drive_team_folders` exist in production but are not in tracked migrations
- Per-session bandwidth accounting (connection counts only, not bytes per session)

## Advice For Future Development

1. **Always verify the running image SHA** before debugging agent behavior — `docker inspect` the container's image ID
2. **Query Supabase before changing parsers** — check what `smon_logs` actually contains for the source you're modifying
3. **The WAL buffer means delayed visibility** — data may appear in Supabase up to 30s after the collector runs
4. **Use `snapshot_grp`** to query a coherent process snapshot, not `captured_at`
5. **Supabase project is dedicated** — `qnjimovrsaacneqkggsn` is synology-monitor only, migrated from shared project April 2026
6. **Web deploys are Coolify**, not GitHub Actions — look at Coolify deployment history, not Actions tab
7. **Both AI pipelines are active** — the SQL cron pipeline (→ `smon_ai_analyses`) and the app pipeline (→ `smon_analysis_runs`) run independently; don't confuse their tables
