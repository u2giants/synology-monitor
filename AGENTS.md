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
│  │  Collectors (goroutines started in main.go):            │    │
│  │  - system        → smon_metrics (30s)                   │    │
│  │  - storage       → smon_storage_snapshots (60s)         │    │
│  │  - docker        → smon_container_status (30s)          │    │
│  │  - drive         → smon_drive_team_folders, etc. (30s)  │    │
│  │  - process       → smon_process_snapshots (15s)         │    │
│  │  - diskstats     → smon_disk_io_stats (15s)             │    │
│  │  - connections   → smon_net_connections (30s)           │    │
│  │  - logwatcher    → smon_logs (10s)                      │    │
│  │  - sharehealth   → smon_logs (2m)                       │    │
│  │  - servicehealth → smon_service_health (60s)            │    │
│  │  - sysextras     → smon_metrics (30s)                   │    │
│  │  - custom        → smon_custom_metric_data (60s poll)   │    │
│  │  - security      → smon_security_events (event-driven)  │    │
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
│  NAS Copilot: THREE-model AI via OpenRouter                      │
│  - google/gemini-2.5-flash  (diagnosis / bulk log analysis)      │
│  - openai/gpt-5.4           (remediation / chat / fix proposal)  │
│  - anthropic/claude-sonnet-4 (second opinion / confidence check) │
│                                                                  │
│  Resolution Agent: autonomous state machine with tick-based      │
│  polling, HMAC-signed approval tokens, timing awareness          │
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
│   │               ├── resolution-agent.ts  # Autonomous resolution state machine
│   │               ├── tools.ts             # All Copilot diagnostic tool definitions
│   │               ├── metric-collector.ts  # Custom metric context injection
│   │               └── nas.ts               # SSH diagnostics (runNasScript)
│   └── agent/                  # Go monitoring agent
│       ├── cmd/agent/
│       │   └── main.go         # Entry point — starts all collector goroutines
│       └── internal/
│           ├── collector/      # All data collectors
│           │   ├── system.go        # CPU, mem, network metrics + Docker stats
│           │   ├── storage.go       # Volume and disk health
│           │   ├── drive.go         # Drive Admin API + ShareSync task parsing
│           │   ├── process.go       # Per-process CPU/mem/disk I/O (reads /proc)
│           │   ├── diskstats.go     # Per-disk IOPS/throughput/await (reads /proc/diskstats)
│           │   ├── connections.go   # Active TCP connections (reads /proc/net/tcp)
│           │   ├── sharehealth.go   # Share DB health, package status, DSM system logs
│           │   ├── services.go      # DSM service status + OOM/segfault kernel events
│           │   ├── sysextras.go     # Memory pressure, inode usage, CPU temperature
│           │   └── custom.go        # AI-requested custom metric collection
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
| `smon_metrics` | CPU, memory, network, inode, temperature | `system` + `sysextras` collectors |
| `smon_storage_snapshots` | Volume and disk state | `storage` collector (60s) |
| `smon_container_status` | Docker container state (180-day retention) | `system` collector (30s) |
| `smon_logs` | Ingested log events from NAS | `logwatcher` + `sharehealth` collectors |
| `smon_security_events` | Ransomware/entropy alerts | `security` watcher (event-driven) |
| `smon_alerts` | Active system alerts | SQL cron pipeline |
| `smon_service_health` | DSM service status snapshots | `servicehealth` collector (60s) |

### Resource Attribution Tables

| Table | Purpose | Populated by |
|-------|---------|-------------|
| `smon_process_snapshots` | Per-process CPU/mem/disk I/O | `process` collector (15s) |
| `smon_disk_io_stats` | Per-disk IOPS/throughput/await | `diskstats` collector (15s) |
| `smon_net_connections` | Active TCP connections by remote IP | `connections` collector (30s) |
| `smon_sync_task_snapshots` | ShareSync/Drive task state | `drive` collector (30s) — currently empty (API error 102) |

### AI Analysis Tables

| Table | Purpose |
|-------|---------|
| `smon_ai_analyses` | Legacy scheduled SQL-pipeline AI analyses |
| `smon_analysis_runs` | On-demand grouped analysis runs (google/gemini-2.5-flash) |
| `smon_analyzed_problems` | Root cause problems from grouped analysis |

### Copilot / Resolution Tables

| Table | Purpose |
|-------|---------|
| `smon_copilot_sessions` | Chat session metadata |
| `smon_copilot_messages` | Individual chat messages |
| `smon_copilot_actions` | Approved/rejected NAS actions |
| `smon_issue_resolutions` | Resolution agent state per issue |

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

## Agent Collectors

The Go agent runs thirteen parallel goroutines.

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
- On startup, bootstraps last 200 lines of Drive logs (backfill)
- Interval: 10s (`LOG_INTERVAL`)

Default log files watched (13 sources):

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
- **`GetRecentSystemLogs(50)`** — fetches structured DSM Log Center events (not in text log files) → `smon_logs` source `dsm_system_log`
- Also emits: `share_config`, `share_health` sources

### Service Health Collector (`collector/services.go`)
- Polls 12 key DSM services every 60 seconds:
  `SynologyDrive`, `SynologyDriveShareSync`, `smbd`, `nmbd`, `nginx`, `sshd`, `nfsd`, `pgsql`, `synoscgi`, `synoindexd`, `synologydrive-server`, `syslog-ng`
- Status check chain: `synoservicectl --status` → `synopkg status` → `pgrep -f` fallback
- Writes running/stopped/unknown status to `smon_service_health`
- Also scans `dmesg` for OOM kills and segfaults → `smon_logs` source `kernel_health`

### SysExtras Collector (`collector/sysextras.go`)
- Runs every 30 seconds
- **Memory pressure** from `/proc/meminfo`: MemAvailable%, SwapUsed%, Dirty+Writeback KB → `smon_metrics`
- **Inode usage** from `df -i /volume1` → `smon_metrics` (filesystem/total/used metadata)
- **CPU temperature** from `/sys/class/thermal/thermal_zone*/temp` → `smon_metrics`

### Custom Metric Collector (`collector/custom.go`)
The AI's mechanism for permanently expanding what the agent collects without a code change.

- Polls `smon_custom_metric_schedules` in Supabase every 60 seconds
- Filters schedules where `nas_id` matches `NAS_NAME` (the human-readable name like `edgesynology1`, NOT the UUID) and `next_run_at <= now()`
- Optimistic lock: PATCHes `next_run_at` atomically — only proceeds if the row was actually updated (prevents concurrent collection from multiple agents)
- Runs `sh -c <command>` natively inside the container (30-second timeout)
- Queues results via `sender.QueueCustomMetricData()` → `smon_custom_metric_data`

**How a schedule gets created:** The AI resolution agent's `processMissingDataSuggestions()` function writes a schedule row when the analysis concludes data is missing. Schedules with `collection_command` get created automatically. Those requiring manual action (e.g., "enable DSM audit log") are logged as instructions instead.

**Promotion tracking:** Each time a custom metric's data is used in an AI analysis context, `referenced_count` increments atomically via the `increment_metric_references` Supabase RPC function. When `referenced_count >= 3`, the metric is consistently useful and should be promoted to a built-in Go collector (requires a code change + rebuild).

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
- New queue methods: `QueueServiceHealth()`, `QueueCustomMetricData()`

## DSM API Integrations (`dsm/client.go`)

The DSM API client has three new integrations added alongside the existing ones:

| API | Method | Purpose |
|-----|--------|---------|
| `SYNO.Core.Share` | `GetShares()` | All shared folders, encryption, recycle bin, additional fields |
| `SYNO.Core.Package` | `GetInstalledPackages()` | Package name, version, status (running/stopped) |
| `SYNO.Core.SyslogClient.Log` | `GetRecentSystemLogs(limit)` | Structured DSM Log Center events not in text files |

## NAS Copilot — Resolution Agent (`resolution-agent.ts`)

The Copilot uses an autonomous resolution state machine, not a simple chat loop.

### AI Personality: "THE DRIVER"

The `SAFETY_PREAMBLE` injected into all AI prompts establishes:

> **YOU ARE THE DRIVER, NOT A PASSENGER.**
> You own this problem end-to-end. Do NOT say "I don't have access to X" unless you have genuinely exhausted every available tool and data source first.
>
> When data is missing:
> 1. First: use `search_all_logs`
> 2. Second: use a specific diagnostic tool
> 3. Third: add a `collection_command` in `missing_data_suggestions` (permanent collection)
> 4. Only as last resort: ask the operator
>
> When you need to interrupt service access: ASK if now is a good time. Late nights and weekends are generally safe.

### Three-Model Architecture (via OpenRouter)

| Role | Model | Purpose |
|------|-------|---------|
| Diagnosis / planning | `google/gemini-2.5-flash` | Root cause identification, log pattern analysis, tool selection |
| Remediation / analysis / fix | `openai/gpt-5.4` | Detailed repair proposals, fix generation, primary analysis |
| Second opinion | `anthropic/claude-sonnet-4` | Independent confidence check from a different model family |

The second opinion model (`callSecondOpinion<T>()`) is implemented with a dedicated function that:
- Uses `response_format: { type: "json_object" }`
- Injects a system message: "You respond only with valid JSON objects. Never include explanation or prose outside the JSON."
- Appends an explicit JSON instruction to the user prompt
- Has a two-level fallback: direct JSON parse → regex `{[\s\S]*}` extraction from prose

### State Machine

States: `planning` → `diagnosing` → `analyzing` → `proposing_fix` → `awaiting_fix_approval` → `applying_fix` → `verifying` → `resolved` / `stuck`

- **Tick-based polling:** 2.5-second intervals; each tick = one DB-persisted state transition
- **`activeTicks: Set<string>`** prevents concurrent ticks for the same resolution
- **`MAX_DIAGNOSTIC_ROUNDS = 3`**: counted by distinct diagnostic batch IDs (a Set). When the limit is hit OR no genuinely new `tool_name:target` combinations remain, the agent forces a `stuck` state with a full summary
- **Deduplication:** already-run `tool_name:target` pairs are excluded from proposed next steps
- **Null filtering:** `additional_steps` items with null/undefined `title` or `target` are filtered before display (prevents "undefined (undefined): undefined" in the stuck message)
- **`missing_data_suggestions`** field in `AnalysisResponse`: when the AI identifies data the agent isn't collecting, it specifies `metric_name`, `collection_command`, `interval_minutes`, `why_needed`, and optionally `manual_action`. The `processMissingDataSuggestions()` function creates schedule rows automatically.

### System Context Injected Into Every Analysis

`fetchSystemContext()` queries 11+ data sources:

| Source | Table / Query |
|--------|--------------|
| Recent logs | `smon_logs` — 120 rows, multiple sources including: `webapi`, `storage`, `share`, `kernel`, `service`, `share_config`, `share_health`, `package_health`, `dsm_system_log`, `kernel_health` |
| Active alerts | `smon_alerts` |
| System metrics | `smon_metrics` — last 20 rows |
| Process snapshots | `smon_process_snapshots` — last 60 rows |
| Disk I/O stats | `smon_disk_io_stats` — last 40 rows |
| Storage snapshots | `smon_storage_snapshots` — last 10 rows |
| Sync task snapshots | `smon_sync_task_snapshots` — last 30 rows |
| Container status | `smon_container_status` — last 20 rows |
| Service health | `smon_service_health` — last 30 rows |
| Net connections | `smon_net_connections` — last 30 rows |
| Custom metrics | `smon_custom_metric_data` via `getCustomMetricContext()` |

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

**For Drive/ShareSync issues,** the planning prompt mandates that plans ALWAYS include: `check_share_database`, `check_drive_package_health`, `search_webapi_log`, `check_kernel_io_errors`.

### Known Synology Error Patterns (in AI prompts)

The AI is pre-primed with these patterns in both `planningPrompt` and `analysisPrompt`:

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

### Timing Awareness

The AI knows it can ask the operator if now is a good time before interrupting service access. Late nights and weekends are generally safe for service restarts. This is prompted explicitly in the `SAFETY_PREAMBLE`.

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
| `cgroup` | TEXT | Always NULL — not implemented |

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
ShareSync and Drive task state. **Currently always empty** because the DSM ShareSync API returns error code 102 on both NAS units. This is expected.

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

## Code Gotchas and Idiosyncrasies

### 1. First collection pass is baseline-only
Both `ProcessCollector` and `DiskStatsCollector` need two samples to calculate rates. On startup, `collect(false)` is called once to build the baseline. No data is written to Supabase from this pass. The first rows appear after the second tick (~15s after startup). This is intentional.

### 2. AGENT_IMAGE_TAG pins Docker to a specific image
The NAS `.env` file contains `AGENT_IMAGE_TAG=latest`. If it ever gets changed to a SHA tag (e.g. `sha-373b526`), `docker compose up -d` will silently use the old image even if you already ran `docker pull ghcr.io/.../agent:latest`. Docker Compose resolves image references at container creation time, not pull time. To recover: `docker stop synology-monitor-agent && docker rm synology-monitor-agent && docker compose up -d`.

### 3. `/proc/net/tcp` IPs are little-endian hex
The IP addresses in `/proc/net/tcp` are stored in little-endian hex — not dotted-decimal, not network byte order. For IPv4, each 4-byte address has its bytes reversed. For IPv6, each 32-bit word has its bytes reversed independently. See `parseIP()` in `connections.go`.

### 4. CPU% formula uses USER_HZ=100
Linux reports CPU time in "jiffies" (USER_HZ ticks). On all modern Linux systems USER_HZ=100, meaning 100 ticks/second. The formula is: `cpu_pct = (delta_utime + delta_stime) / (wall_seconds × 100) × 100`. This is hardcoded as `clockTicksPerS = 100`. If you ever see CPU% over 100% it means the process is multi-threaded; the collector doesn't cap it.

### 5. `/proc/PID/io` counts actual storage bytes, not virtual I/O
`read_bytes` and `write_bytes` in `/proc/PID/io` account for page cache — they count bytes that actually hit storage, not all read/write syscall bytes.

### 6. `snapshot_grp` UUID groups a collection pass
All process rows from a single `collect()` call share the same `snapshot_grp` UUID. To query "what was running at time X", filter by `snapshot_grp` rather than `captured_at`. Example: `SELECT * FROM smon_process_snapshots WHERE snapshot_grp = '<uuid>'`.

### 7. ShareSync API returns error code 102 on these NAS units
DSM API error code 102 means "the requested API is not available" (not installed or wrong version). The Drive collector tries three API variants for ShareSync, and all return 102 on edgesynology1 and edgesynology2. This is not a bug — the fallback to log parsing runs. `smon_sync_task_snapshots` will be empty until either the API becomes available or the log parsing finds matching patterns.

### 8. Synology Container Manager rejects `/volume1` as a top-level bind
The compose file uses explicit share mounts (`/volume1/files:/host/shares/files:ro` etc.) instead of mounting `/volume1` directly. This is because Synology's Container Manager UI rejects top-level volume binds during compose/UI recreates with the error `Fail to parse share name from [/volume1]`. The Docker CLI can still use `/volume1` directly, but the UI path cannot. See `HANDOFF_PROMPT.md` for the full history.

### 9. `NAS_ID` must be a valid UUID; `NAS_NAME` is the human-readable string
`config.Load()` calls `looksLikeUUID()` and returns an error if `NAS_ID` is not in `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` format. The `CustomCollector` uses `NAS_NAME` (e.g. `edgesynology1`) as the `nas_id` in `smon_custom_metric_schedules`, not the UUID.

### 10. Second opinion model requires dedicated JSON enforcement
The `anthropic/claude-sonnet-4` model (via OpenRouter) ignores `response_format: { type: "json_object" }` and will return prose if not explicitly forced. `callSecondOpinion<T>()` uses: (1) a system message forcing JSON-only output, (2) an explicit JSON instruction appended to the prompt, and (3) a regex fallback `{[\s\S]*}` to extract JSON from prose if the parse fails.

### 11. Resolution agent MAX_DIAGNOSTIC_ROUNDS = 3
The agent will not cycle through `diagnosing → analyzing → medium confidence → more steps → repeat` more than 3 times. It counts distinct diagnostic batch IDs in a Set. When the limit is hit, it forces a `stuck` state with a comprehensive summary of everything attempted.

### 12. Custom collector uses NAS_NAME, not NAS_ID
When polling `smon_custom_metric_schedules`, the `CustomCollector` filters `WHERE nas_id = NAS_NAME` (the human-readable name, e.g. `edgesynology1`). This allows the web app's resolution agent to target schedules by the name it knows, without needing to manage UUIDs.

### 13. Agent binary is stripped
The binary is built with `-ldflags="-s -w"`, removing DWARF debug info and the symbol table. `strings` output will show string constants but `nm` and backtrace symbol names will not work. This keeps the image small (~16 MB).

### 14. `cgroup` column is always NULL
The `smon_process_snapshots.cgroup` column was defined in the migration but the collector never populates it. It's a placeholder for future cgroup attribution.

### 15. `username` in `smon_net_connections` is always NULL
The connections collector counts TCP sessions by remote IP but does not attribute them to a system user.

## NAS Copilot (`/assistant`)

AI-powered assistant using a three-model architecture, all via OpenRouter.

### Models
1. **google/gemini-2.5-flash** — diagnosis model: bulk log analysis, pattern detection, root cause grouping, initial planning
2. **openai/gpt-5.4** — remediation model: detailed repair proposals, action token generation, primary analysis
3. **anthropic/claude-sonnet-4** — second opinion model: independent confidence check from a different model family

All are configurable in Settings > AI Models. Model IDs stored in `smon_ai_settings` table.

### Context Provided to Copilot
Every Copilot message automatically includes (from the last 15-30 minutes):
- Recent `smon_logs` (120 rows, all sources including webapi/kernel/share_health/dsm_system_log)
- Active `smon_alerts`
- Recent `smon_metrics` (including memory pressure, inode usage, temperature)
- Top processes by write I/O (`smon_process_snapshots`)
- Disk I/O stats (`smon_disk_io_stats`)
- Sync task state (`smon_sync_task_snapshots`)
- Active connections (`smon_net_connections`)
- Storage snapshots (`smon_storage_snapshots`)
- Container status (`smon_container_status`)
- Service health (`smon_service_health`)
- Custom metric data (`smon_custom_metric_data` via `getCustomMetricContext()`)

### Dynamic Metric Collection Lifecycle
1. AI identifies missing data → specifies `missing_data_suggestions` in analysis response
2. `processMissingDataSuggestions()` creates schedule rows in `smon_custom_metric_schedules`
3. Agent's `CustomCollector` picks them up within 60s, runs commands natively inside container
4. Results stored in `smon_custom_metric_data`
5. Next analysis injects this data via `getCustomMetricContext()`
6. `referenced_count` increments each time data is used
7. At `referenced_count >= 3`: metric should be promoted to a built-in Go collector

**Important distinction:** Shell commands in custom schedules run WITHOUT a code rebuild. Promotions to built-in collectors DO require a code change, rebuild, and image push.

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

### Agent code changes (new collectors, DSM API integrations)
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

### Adding AI-requested custom metrics (no rebuild needed)
When the AI creates a schedule in `smon_custom_metric_schedules`, the agent picks it up automatically within 60 seconds. No code change, rebuild, or deployment is needed. The command runs natively inside the container — any CLI tool already available in the container image can be used.

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
| `apps/agent/cmd/agent/main.go` | Agent entry point — starts all 13 goroutines |
| `apps/agent/internal/config/config.go` | Config loading; enforces UUID NAS_ID |
| `apps/agent/internal/collector/process.go` | Per-process CPU/mem/disk I/O |
| `apps/agent/internal/collector/diskstats.go` | Per-disk IOPS/throughput/await |
| `apps/agent/internal/collector/connections.go` | Active TCP connection counts |
| `apps/agent/internal/collector/drive.go` | Drive Admin + ShareSync collector |
| `apps/agent/internal/collector/system.go` | System metrics + Docker stats |
| `apps/agent/internal/collector/sharehealth.go` | Share DB health, packages, DSM system logs |
| `apps/agent/internal/collector/services.go` | DSM service status + kernel OOM/segfaults |
| `apps/agent/internal/collector/sysextras.go` | Memory pressure, inode usage, CPU temp |
| `apps/agent/internal/collector/custom.go` | AI-requested custom metric collection |
| `apps/agent/internal/dsm/client.go` | DSM API client (GetShares, GetInstalledPackages, GetRecentSystemLogs) |
| `apps/agent/internal/logwatcher/watcher.go` | Log tailing — 13 default sources |
| `apps/agent/internal/security/watcher.go` | Ransomware detection |
| `apps/agent/internal/sender/sender.go` | SQLite WAL + Supabase flush |
| `apps/agent/internal/sender/types.go` | Payload structs for all tables |
| `apps/web/src/lib/server/resolution-agent.ts` | Autonomous resolution state machine |
| `apps/web/src/lib/server/tools.ts` | 14 diagnostic tool definitions |
| `apps/web/src/lib/server/metric-collector.ts` | Custom metric context injection |
| `apps/web/src/lib/server/nas.ts` | SSH command execution (runNasScript) |
| `apps/web/src/components/dashboard/version-banner.tsx` | Admin-only build SHA banner |
| `deploy/synology/docker-compose.agent.yml` | Canonical compose spec |
| `supabase/migrations/` | Database schema history (applied to qnjimovrsaacneqkggsn) |

## Operational Notes

- Docker binary path on Synology: `/var/packages/ContainerManager/target/usr/bin/docker` — not on default PATH
- `docker compose up -d` after `docker pull` may still use the old container; always stop+rm first when updating
- Synology Container Manager can leave replaced containers in `Created` state during UI-driven recreates — prefer CLI
- SSH may emit host key / post-quantum algorithm warnings; check exit code, not just stderr
- The healthcheck at `/app/data/wal.db` only checks file existence, not database health
- Both NAS units have only `/volume1`; the extra share mounts (`/volume1/mac`, `/volume1/styleguides`, etc.) are configured in the live `.env` files on each NAS
- The web app and NAS agent share the same Supabase project but use different API keys (anon key for web, service role key for agent)
- The `CustomCollector` uses `NAS_NAME` (human-readable) as its Supabase filter, not `NAS_ID` (UUID)

## Known Gaps

- ShareSync task data (`smon_sync_task_snapshots`) is empty — DSM API returns code 102 for ShareSync endpoints on both NAS units
- `username` in `smon_net_connections` is always NULL — connection-to-user attribution not implemented
- `cgroup` in `smon_process_snapshots` is always NULL
- SMB per-file audit coverage (only connection-level logging)
- Automatic data retention cleanup for high-frequency tables — `smon_process_snapshots`, `smon_disk_io_stats`, and `smon_net_connections` grow indefinitely without a retention job
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
8. **The AI is THE DRIVER** — the resolution agent is designed to own problems end-to-end, not ask the operator for every tool call. If it's asking for too many manual steps, the prompt has drifted from its DRIVER mentality
9. **Custom metrics don't need a rebuild** — `smon_custom_metric_schedules` rows are picked up automatically by the agent within 60s
10. **Check `referenced_count >= 3`** in `smon_custom_metric_schedules` periodically — these are candidates for promotion to built-in collectors
