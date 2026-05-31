# Architecture

## System purpose

Monitors two Synology NAS devices and gives the operator:

- live telemetry (metrics, logs, storage, processes, network, containers)
- grouped issues with persistent conversation threads
- a 3-stage LLM-driven issue agent that diagnoses problems and proposes fixes
- a controlled approval gate for any state-modifying action on the NAS

Focus is Synology Drive / ShareSync reliability, file operation visibility, sync
and replication failures, storage and I/O attribution, and silent task/backup
failures.

## Component map

```
┌─────────────────────────────────────────────────┐
│ NAS (×2: edgesynology1, edgesynology2)          │
│  ┌──────────────────┐  ┌──────────────────────┐ │
│  │  agent (Go)      │  │  nas-api (Go)        │ │
│  │  polls DSM APIs  │  │  3-tier shell exec   │ │
│  │  reads /proc,sys │  │  port 7734           │ │
│  │  watches logs    │  │  tier1: read-only    │ │
│  │  → Supabase WAL  │  │  tier2: service ops  │ │
│  └──────────────────┘  │  tier3: file ops     │ │
└──────────┬─────────────┴──────────┬────────────┘
           │ WAL flush (PostgREST)   │ HTTPS over Tailscale
           ▼                         ▼
┌──────────────────┐    ┌─────────────────────────┐
│ Supabase         │◄───│ web app (Next.js)        │
│ 53 tables        │    │ mon.designflow.app        │
│ partitioned +    │    │  - issue detector         │
│ time-series      │    │  - 3-stage issue-agent    │
└──────────────────┘    │  - operator UI            │
                         └─────────────────────────┘
                                    ▲
                                    │ MCP / Streamable HTTP
                         ┌─────────────────────────┐
                         │ nas-mcp (Node.js)        │
                         │ nas-mcp.designflow.app   │
                         │ 108-tool registry        │
                         │ 5 always-on tools        │
                         └─────────────────────────┘
```

## Agent (apps/agent)

The Go agent runs on each NAS as a Docker container. It collects telemetry on a
rolling schedule and buffers writes in a local SQLite WAL before flushing to
Supabase in batches.

### Collector inventory

| Collector | File | Primary tables | Default interval |
|---|---|---|---|
| system | `collector/system.go` | `metrics`, `container_status`, `storage_snapshots` | 30s / 60s |
| drive | `collector/drive.go` | `sync_task_snapshots`, `drive_team_folders`, `nas_logs` | 30s |
| sharesync | `collector/sharesync.go` | `alerts`, `nas_logs` | 5m (hardcoded) |
| sharehealth | `collector/sharehealth.go` | `nas_logs`, `metrics`, `package_status`, `dsm_errors` | 2m |
| storagepool | `collector/storagepool.go` | `snapshot_replicas`, `metrics`, `nas_logs` | 60s (mdstat) / 5m (replicas) |
| process | `collector/process.go` | `process_snapshots` | 15s |
| diskstats | `collector/diskstats.go` | `disk_io_stats`, `metrics` (`disk_inflight_ios`) | 15s |
| container_io | `collector/container_io.go` | `container_io` | 30s |
| connections | `collector/connections.go` | `net_connections` | 30s |
| sysextras | `collector/sysextras.go` | `metrics` (cpu_iowait_pct, thermal, memory, NFS, VM pressure, btrfs errors) | 30s |
| services | `collector/services.go` | `service_health`, `nas_logs` | 60s |
| hyperbackup | `collector/hyperbackup.go` | `backup_tasks`, `nas_logs` | 5m |
| schedtasks | `collector/schedtasks.go` | `scheduled_tasks`, `nas_logs` | 5m |
| infra | `collector/infra.go` | `metrics`, `nas_logs` | 2m |
| custom | `collector/custom.go` | `custom_metric_data` | polls DB every 60s |
| logwatcher | `logwatcher/watcher.go` | `nas_logs` | 10s tail interval |
| security | `security/watcher.go` | `security_events` | inotify-driven |

### Storagepool collector

Reads `/host/proc/mdstat` directly every 60s for RAID scrub/rebuild/check
progress and emits `raid_scrub_progress` metrics. Also emits `disk_inflight_ios`
(instantaneous in-progress I/O count per device from `/proc/diskstats` field 9).
Alerts once on healthy→degraded state transitions; does not flood on every tick.

### ShareSync health collector

Scans `dscc.log` and `dscc_monitor.log` directly — failure patterns the DSM UI
does not surface:

- **Queue jam** — same path in `RedoEvent`/`PullEvent` ≥5 times without a
  `DoneEvent` → `critical` alert
- **Basis-file corruption** — `PrepareDownloadFile` repeat without `DoneEvent`
- **Transport flap** — ≥3 error-code-26 / daemon-socket / reconnect events

Uses byte-offset watermarks per log file (stored in WAL `checkpoints` table).
Log files are at `/host/shares/@SynologyDriveShareSync/log/` inside the container.

### Log watcher

Tails the following sources by default:

| Path (in container) | Source label |
|---|---|
| `/host/log/messages` | `system` |
| `/host/log/synolog/synobackup.log` | `backup` |
| `/host/log/synologydrive.log` | `drive_server` |
| `/host/log/synolog/synosecurity.log` | `security` |
| `/host/log/synolog/synoconnection.log` | `connection` |
| `/host/log/synolog/synopkg.log` | `package` |
| `/host/log/samba/log.smbd` | `smb` |
| `/host/log/synolog/synowebapi.log` | `webapi` |
| `/host/log/synolog/synostorage.log` | `storage` |
| `/host/log/synolog/synoshare.log` | `share` |
| `/host/log/kern.log` | `kernel` |
| `/host/log/synolog/synoinfo.log` | `system_info` |
| `/host/log/synolog/synoservice.log` | `service` |
| `/host/shares/@synologydrive/log/*.log` | `drive` |
| `/host/shares/@synologydrive/log/syncfolder.log` | `drive_sharesync` |

Additional paths can be added via `EXTRA_LOG_FILES` env var or by editing
`defaultLogFiles` in `logwatcher/watcher.go`.

### WAL and sender

`sender/sender.go` buffers writes in `/app/data/wal.db` (SQLite), flushes every
30s in per-table batches to Supabase's REST API. A `checkpoints` table in the same
file stores named string values (log file byte offsets, collector cursors).

**Poison-row isolation:** on a PostgREST `4xx`, the sender re-sends each row
individually so good rows land and only the bad row accumulates retries. This was
added after a single bad row silently froze ingestion (see incidents).

**`package_status` is the only merge-duplicates upsert** — all other tables are
append-only inserts.

## NAS API (apps/nas-api)

Runs on each NAS as a Docker container on port 7734. Accepts bearer-authenticated
POST requests from the web app and nas-mcp to execute shell commands.

### Three-tier execution model

| Tier | Label | Auto-executes | Examples |
|---|---|---|---|
| 1 | read-only | Yes | `cat /proc/mdstat`, `df -h`, `smartctl -a`, `tail -n 100 /var/log/kern.log` |
| 2 | service ops | Requires HMAC approval token | `synopkg restart SynologyDrive`, `docker compose restart` |
| 3 | file ops (touches /volume*) | Requires HMAC approval token | `mv /volume1/file.old /volume1/file`, `btrfs scrub start` |

The validator (`internal/validator/validator.go`) classifies commands before
execution. Hard-blocked commands (regardless of tier): disk destruction (`mkfs`,
`fdisk`, `dd if=`), firmware writes, user account changes, shutdown/reboot, package
install/remove, recursive grep on `@synologydrive`/`@SynologyDriveShareSync`.

HMAC approval tokens are minted fresh at execution time — never persisted. The
15-minute expiry bounds only the exec→exec window, not the operator's think time.

## NAS MCP (apps/nas-mcp)

Node.js MCP server at `nas-mcp.designflow.app/mcp`. AI chat clients (claude.ai,
Claude Desktop) connect over Streamable HTTP/SSE.

**Always-on tools (5):** `tool_search`, `invoke_tool`, `run_command`,
`check_disk_space`, `restart_nas_api`.

**Tool registry:** 108 predefined tools in `packages/shared/src/nas-tools.ts`,
enabled/disabled via `apps/nas-mcp/tools-config.json`. Clients discover tools via
`tool_search`, execute via `invoke_tool`. The full registry is never loaded into a
session (lazy-load design — see AGENTS.md §10).

## Web app (apps/web)

Next.js 14 app at `mon.designflow.app`. Supabase for auth + data. Key subsystems:

- **Issue detector** (`issue-detector.ts`): fingerprints alerts + logs into issues
  by family (sharesync-metadata-corruption, drive-not-ready, sync-failure, I/O
  pressure, backup-failure, etc.)
- **3-stage issue-agent** (`ai/pipeline-v2.ts`): one job per turn, resumable from
  DB state
- **Copilot** (`copilot.ts`): legacy NAS assistant chat (uses OpenRouter/MiniMax)
- **Resolution UI** (`/api/resolution/*`): operator interface over the issue-agent

## 3-stage AI pipeline

The only active issue-agent pipeline as of 2026-05-30. Legacy 7-stage pipeline and
OpenRouter inference path removed.

### Stage 1 — Lossless Structurer (deterministic, no model call)

Ingests raw telemetry for the issue window (alerts, logs, metrics, tasks, etc.),
deduplicates byte-identical lines, classifies each row as in-scope/anomalous,
persists the full deduped set to `issue_evidence_items`, and builds a bounded
prioritized evidence slice for Stage 2's prompt.

Budget: 12,000 tokens (48,000 chars). 70% for in-scope/anomalous events in full;
30% for noise summaries. Always includes the evidence index.

### Stage 2 — Reasoning Core (strong model, agentic loop, resumable)

One agentic turn per job invocation. Rebuilds its full context from the DB on every
turn — resumable from any worker after any approval gate.

**Prompt order (stable → dynamic for cache correctness):**
1. System prompt (stable)
2. Output schema (stable)
3. NAS taxonomy / DSM blind spots (stable)
4. Whole-system snapshot — NAS reachability probe (3s), active alerts, open issues (semi-stable)
5. Issue summary (semi-stable)
6. Evidence slice from `issue_evidence_items` (dynamic)
7. Per-turn instruction (dynamic)

**Tool catalog (all tier-1, auto-execute):**
- `fetch_evidence` — reads `issue_evidence_items` for this issue; works offline
- `run_command` — free-form read-only shell command; validated by nas-api; useful
  for raw log files, `/proc/mdstat`, `/sys/block/*/inflight`, etc.
- 100+ predefined NAS tools (SMART, BTRFS, ShareSync, Docker, process/network/storage)

Every tool result is persisted to `issue_evidence_items` so later turns can page it.

**Terminals per turn:** `continue` (enqueue next turn) | `propose_remediation`
(persist intent, wait for approval) | `ask_user` | `blocked_on_issue` |
`resolved` | `stuck`.

**Re-chew guard:** hashes the evidence slice text each turn. After ≥2 turns on
unchanged evidence with `decision=continue`, forces `decision=ask_user`.

### Stage 3 — Explainer / Memory (cheap model, single-shot)

Runs after Stage 2 reaches `resolved` or `stuck`. Produces:
- Operator-facing message (2–5 sentences) posted to `issue_messages`
- Up to 5 durable `agent_memory` entries (specific, non-obvious, durable facts)

Best-effort: Stage 3 failure never fails the issue resolution.

Reads from `issue_evidence_items` (in_scope=true, limit 30) and `issue_actions`
(limit 20).

## Custom metric schedules

`custom_metric_schedules` is a DB table the AI or operator can insert rows into.
Each row specifies a shell command, interval, and NAS target. The Go agent's
`custom` collector polls the table every 60s, claims due rows with an optimistic
lock, and executes the command in the container. Output is stored in
`custom_metric_data`.

Use cases: ad-hoc deep diagnostics, nightly disk health snapshots, anything the AI
wants to observe over time without a code change.

Current permanent schedule: `nightly_disk_health` (migration 00040) — runs at 2am
UTC on weekdays on both NASes; collects `/proc/diskstats`, `/proc/mdstat`, and
per-device inflight IOs.

## Database

Supabase project `qnjimovrsaacneqkggsn`. 53 tables total (migrations 00001–00041).

**Partitioned tables** (pg_partman, monthly, auto-retention): `metrics`,
`nas_logs`, `storage_snapshots`, `container_status`, `drive_activities`.

**Lossless evidence store:** `issue_evidence_items` — written by Stage 1 and Stage
2 tool calls; read by Stage 2 `fetch_evidence` and Stage 3. Not the same as
`issue_evidence` (curated notes from copilot/resolution).

**Key table groups:**
- Telemetry: `metrics`, `nas_logs`, `disk_io_stats`, `process_snapshots`, `net_connections`, `container_io`, `backup_tasks`, `scheduled_tasks`, `snapshot_replicas`, `service_health`, `dsm_errors`, `package_status`, `security_events`, `drive_activities`, `sync_task_snapshots`, `drive_team_folders`
- Issue pipeline: `issues`, `issue_messages`, `issue_evidence`, `issue_evidence_items`, `issue_actions`, `issue_jobs`, `issue_stage_runs`, `issue_state_transitions`, `agent_memory`
- AI config: `ai_settings`, `ai_model_calls`
- Copilot/resolution: `copilot_sessions`, `copilot_messages`, `copilot_actions`, `sync_remediations`
- Custom collection: `custom_metric_schedules`, `custom_metric_data`

## Known constraints and blind spots

- `container_status` CPU/mem always reads 0 — use `container_io` instead
- `scheduled_tasks` returns DSM error 103 on edgesynology1 (unsupported API version)
- Some snapshot-replication APIs are unsupported on some DSM versions
- Log-derived fields are regex-parsed — categorizations imperfect, raw text faithful
- `NEXT_PUBLIC_SUPABASE_*` are baked at build time; changing them in Coolify after
  build has no effect

## Incomplete features

| Feature | State | Location |
|---|---|---|
| `analyzeRecentLogs` | Orphaned writer — tables preserved for future AI clustering layer | `lib/server/log-analyzer.ts` |
| Second-opinion model | Planned: second AI cross-check of Stage 2 diagnosis; not wired | `getSecondOpinionModel()` in `ai-settings.ts` |
| `drive_team_folders` reader | Agent writes; no web query | `collector/drive.go` |
| `drive_team_folders_partitioned` | Schema exists; no child partitions; no writes | Migration 00008 |
| `issue_resolutions` + related | Superseded by `issues` pipeline; not yet dropped | Migrations 00016, 00021 |
