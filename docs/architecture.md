# Architecture

## System purpose

Monitors two Synology NAS devices and gives the operator:

- live telemetry (metrics, logs, storage, processes, network, containers)
- grouped issues with persistent conversation threads
- an LLM-driven issue agent that diagnoses problems and proposes fixes
- a controlled approval gate for any state-modifying action

Focus is Synology Drive / ShareSync reliability, file operation visibility, sync and replication failures, storage and I/O attribution, and silent task and backup failures.

## Component map

```
┌─────────────────────────────────────────────────┐
│ NAS (×2)                                        │
│  ┌──────────────────┐  ┌──────────────────────┐ │
│  │  agent (Go)      │  │  nas-api (Go)        │ │
│  │  polls DSM APIs  │  │  executes approved   │ │
│  │  reads /proc,sys │  │  shell commands      │ │
│  │  watches logs    │  │  port 7734           │ │
│  │  → Supabase WAL  │  │  ← web app (HTTPS)   │ │
│  └──────────────────┘  └──────────────────────┘ │
└─────────────────────────────────────────────────┘
         │ WAL flush (REST)               │ HTTPS over Tailscale
         ▼                                ▼
┌──────────────────┐           ┌──────────────────────┐
│ Supabase         │ ◄──reads──│ web app (Next.js)     │
│ smon_* tables    │           │ mon.designflow.app    │
└──────────────────┘           │  - issue detector     │
                                │  - issue agent loop   │
                                │  - operator UI        │
                                └──────────────────────┘
                                          ▲
                                          │ MCP over Streamable HTTP
                               ┌──────────────────────┐
                               │ nas-mcp (Node.js)    │
                               │ nas-mcp.designflow   │
                               │ .app/mcp             │
                               └──────────────────────┘
```

## Agent

The Go agent runs on each NAS as a Docker container. It collects telemetry on a rolling schedule and buffers writes in a local SQLite WAL before flushing to Supabase in batches.

### Collector inventory

| Collector | File | Primary tables | Default interval |
|---|---|---|---|
| system | `collector/system.go` | `smon_metrics`, `smon_container_status`, `smon_storage_snapshots` | 30s / 60s |
| drive | `collector/drive.go` | `smon_sync_task_snapshots`, `smon_logs` | 30s |
| sharesync | `collector/sharesync.go` | `smon_alerts`, `smon_logs` | 5m |
| sharehealth | `collector/sharehealth.go` | `smon_logs`, `smon_metrics`, `smon_package_status`, `smon_dsm_errors` | 2m |
| storagepool | `collector/storagepool.go` | `smon_snapshot_replicas`, `smon_metrics`, `smon_logs` | 60s / 5m |
| process | `collector/process.go` | `smon_process_snapshots` | 15s |
| diskstats | `collector/diskstats.go` | `smon_disk_io_stats` | 15s |
| container_io | `collector/container_io.go` | `smon_container_io` | 30s |
| connections | `collector/connections.go` | `smon_net_connections` | 30s |
| sysextras | `collector/sysextras.go` | `smon_metrics` (`cpu_iowait_pct`, thermal, memory pressure) | 30s |
| services | `collector/services.go` | `smon_service_health`, `smon_logs` | 60s |
| hyperbackup | `collector/hyperbackup.go` | `smon_backup_tasks`, `smon_logs` | 5m |
| schedtasks | `collector/schedtasks.go` | `smon_scheduled_tasks`, `smon_logs` | 5m |
| infra | `collector/infra.go` | `smon_metrics`, `smon_logs` | 2m |
| custom | `collector/custom.go` | `smon_custom_metric_data` | 60s poll |
| logwatcher | `logwatcher/watcher.go` | `smon_logs` | 10s |
| security | `security/watcher.go` | `smon_security_events` | inotify-driven |

### ShareSync health collector (sharesync.go)

Scans `dscc.log` and `dscc_monitor.log` directly — failure patterns the DSM UI does not surface:

- **Queue jam** — same path in `RedoEvent`/`PullEvent` ≥5 times without a `DoneEvent` → `critical` alert with exact path and repeat count
- **Basis-file corruption** — `PrepareDownloadFile` repeat without `DoneEvent` → `critical` if `file_hash = 31d6cfe0d16ae931b73c59d7e0c089c0` (MD5 of empty file), `warning` otherwise
- **Transport flap** — ≥3 error-code-26 / daemon-socket / reconnect events in a scan window → `warning` alert

Each detector emits `QueueAlert` (picked up by the issue detector) and `QueueLog` (structured evidence with a `recommended_action` field).

The collector uses byte-offset watermarks per log file (stored in the WAL's `checkpoints` SQLite table) so it only reads new content each cycle and survives agent restarts without re-processing. Log rotation is handled by resetting to offset 0 when the file is smaller than the saved offset.

Log files are at `/host/shares/@SynologyDriveShareSync/log/` inside the container.

### WAL and sender

`sender/sender.go` — buffers writes in a local SQLite WAL (`/app/data/wal.db`), flushes every 30 seconds in per-table batches to Supabase's REST API. A separate `checkpoints` table in the same SQLite file stores durable per-collector cursors (e.g. log file byte offsets).

**Non-obvious:** the `package_status` table uses Supabase's `resolution=merge-duplicates` upsert because it holds one current-state row per package, not a time-series. All other tables are append-only inserts.

### container_io collector

Container Manager on Synology does not always expose cgroup blkio files. The collector tries cgroup files under `/host/sys`, falls back to `/sys`, and if Synology's blkio files are absent, sums `/proc/<pid>/io` for all container task PIDs. The `/sys` mount in the agent compose file is required for the primary path.

**Non-obvious:** Synology's kernel reports identical I/O stats for every thread in `/proc/{pid}/tasks/`. The collector resolves each task PID to its TGID via `/proc/{pid}/status` and reads I/O only once per unique TGID to avoid summing inflated per-thread numbers.

### storagepool collector

Reads `/host/proc/mdstat` for RAID activity. Emits log+alert only on state transitions (healthy→degraded or degraded→healthy), not every tick — prevents flooding `smon_logs` with redundant RAID status messages.

## Web app

Next.js app at `mon.designflow.app`. All data comes from Supabase; NAS actions go through the NAS API over Tailscale.

### Issue pipeline

```
smon_alerts + smon_logs
       │
       ▼ issue-detector.ts (fingerprinting, grouping)
       │
       ▼ smon_issues
       │
       ▼ issue-workflow.ts (job queue in smon_issue_jobs)
       │
       ▼ issue-agent.ts (per-cycle loop, max 3 cycles)
         ├── gatherTelemetryContext() → raw telemetry
         ├── compressLogsToFacts() → extractor model → normalized facts
         ├── rankIssueHypothesis() → hypothesis model
         ├── planIssueNextStep() → planner model
         ├── planIssueRemediation() → remediation_planner model (if action needed)
         └── explainIssueState() → explainer model → operator message
```

### Telemetry flow into facts

`gatherTelemetryContext()` fetches from Supabase across 6–48h windows depending on source. The expensive LLM stages (hypothesis, planner, explainer, verifier) receive `normalized_facts` — compressed by the cheap extractor model — not raw log rows. Raw `logs` and `audit_logs` are stripped before those calls.

`audit_logs` uses all severities for sources that carry important events at info level (SSH logins, DSM API auth, scheduled task completions). `logs` uses warning+ to suppress high-volume polling noise.

### Worker modes

Controlled by `ISSUE_WORKER_MODE` env var:
- `inline` (default) — request path drains jobs immediately
- `background` — enqueue only; `/api/internal/issue-worker/drain` drains with service-role Supabase access

### Issue agent sustained I/O pressure detection

`issue-detector.ts` detects sustained I/O pressure from `smon_metrics`: `cpu_iowait_pct` avg ≥ 20% over ≥ 3 samples → "Sustained disk I/O pressure" issue; critical at ≥ 40%.

## NAS API

Three-tier command executor running on each NAS at port 7734. Commands are classified statically in `validator.go`:

| Tier | Approval | Examples |
|---|---|---|
| 1 — read-only | Automatic | `df -h`, `smartctl -a`, `ls /proc/mdstat` |
| 2 — reversible writes | `confirmed: true` | Package stop/start, ShareSync restart, `docker compose up -d` |
| 3 — destructive | `confirmed: true` + HMAC token | Anything irreversible |

**Non-obvious:** Package restarts use the DSM WebAPI (`SYNO.Core.Package` stop+start) rather than `pkill` because `synoservice` was removed in DSM 7. Requires `DSM_USERNAME` and `DSM_PASSWORD` in the NAS `.env`.

**Non-obvious:** The nas-api container needs `pid: host` for commands that reference running process PIDs. Without it, `pkill`-based restarts fail silently.

### Hard-block list

`validator.go` maintains a `hardBlocked` list of regex patterns that are rejected at any tier, before any approval flow. These protect against commands that could brick the NAS, destroy data, or lock out admins: disk erasure (`mkfs`, `dd if=`, `wipefs`), root filesystem deletion, DSM binary modification, firmware/kernel manipulation, user account changes, shutdown/reboot, global package manager invocations, and Docker socket misuse.

**Critical entry — recursive grep on Synology internal stores is hard-blocked:**

```
grep -r/-R on @synologydrive, @SynologyDriveShareSync, /var/packages/SynologyDrive
```

These directories contain millions of opaque file objects. A recursive grep never returns diagnostically useful results and will thrash disk I/O for days without completing. This pattern is blocked regardless of tier or confirmation. Use targeted `find -maxdepth`, timestamp-bounded log reads, or Supabase telemetry instead.

### Executor process-group kill guarantee

`executor.go` places every bash subprocess in its own process group (`Setpgid: true`) and overrides the default context-cancel behavior to send `SIGKILL` to the entire process group:

```go
cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
cmd.Cancel = func() error {
    return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}
cmd.WaitDelay = 2 * time.Second
```

This is required because `exec.CommandContext` only kills the direct bash child — it does not kill the process tree. Without process-group kill, a command like `grep ... | head -50` will orphan the `grep` when the timeout fires (head exits, bash exits, but grep keeps running). In May 2026 this caused a runaway `grep -R` to run for 4 days 11 hours on a production NAS. The process-group kill + hard-block together prevent recurrence.

## NAS MCP server

Node.js MCP server at `nas-mcp.designflow.app/mcp` (StreamableHTTP). Also serves the legacy SSE transport at `/sse`.

### Surface model: lazy-loaded tool registry

The server compiles a registry of 108 tool definitions (`ALL_TOOL_DEFS` in `apps/nas-mcp/src/tool-definitions.ts`) but exposes only **5 tools** to MCP clients per session:

| Tool | Purpose |
|---|---|
| `tool_search({ query, limit })` | Keyword + group + name/description search across the registry. Returns formatted tool names, descriptions, and parameter shapes as text. |
| `invoke_tool({ name, target, args })` | Execute any tool in the registry by name. Enforces `tools-config.json` gating. Write tools require `confirmed: true` inside `args`. |
| `run_command` | Free-form tier-1-only shell. |
| `check_disk_space` | Eager freebie — common enough that paying the `tool_search` round-trip isn't worth it. |
| `restart_nas_api` | Eager freebie — recovery tool, should never require discovery. |

**Why:** registering all 108 schemas in `tools/list` pre-loaded ~50k tokens of tool definitions into every Claude session. After ~10–15 tool calls the context filled and sessions degraded. The two-step `tool_search` → `invoke_tool` flow keeps the always-loaded surface at ~3k tokens.

**Why not dynamic registration:** MCP supports `notifications/tools/list_changed`, but Claude clients cache the initial `tools/list` and do not re-fetch on the notification. So `tool_search` cannot register new tools mid-session; it returns schemas as text and Claude calls them by name via `invoke_tool`.

`tools-config.json` still gates which tools are *invokable* (`enabled_read_tools` / `enabled_write_tools`); disabled tools are invisible to `tool_search` and rejected by `invoke_tool` with a clear message.

### Group taxonomy + search

- `TOOL_GROUPS: Record<string, string>` — tool name → group (`system`, `performance`, `network`, `security`, `drive_sync`, `logs`, `storage`, `files`, `recovery`, `packages`, `backup`, `write_restart`, `write_storage`, `write_files`, `write_tasks`). Untagged tools fall through to `"misc"` and remain searchable + invokable; startup logs the untagged set as a warning so they can be tagged later.
- `KEYWORD_TO_GROUPS: Record<string, string[]>` — keywords (`snapshot`, `tailscale`, `audit`, …) → groups.
- `searchTools(query, enabled)` — splits query into words. For each word: if it is an exact group name, builds a match set containing only tools in that group (no name/description fallback); otherwise builds a match set from KEYWORD_TO_GROUPS-mapped groups plus tools whose name or description contains the word. Applies AND semantics across all per-word sets — a tool must appear in every word's match set to be included. Scores survivors: +3 per query word found in tool name, +1 per query word found in description; sorted descending, then alphabetically by name.
- `formatToolForSearch(tool)` renders one tool as a text block (name, group, type, description, params with type / optional / default annotations, plus the `confirmed` row for write tools). This is what `tool_search` returns.

### Statelessness

Every HTTP request creates a new `McpServer` (`sessionIdGenerator: undefined`, `enableJsonResponse: true`). No session map. The trade-off: dynamic in-session registration is impossible (which the surface model already accounts for), but Coolify redeploys no longer leave clients holding stale `mcp-session-id` values.

### Timeout architecture

Three layers prevent NAS-side slowness from hanging claude.ai tool calls indefinitely:

1. **`/preview` HTTP abort** — 8 seconds. Classifies command tier; if the NAS doesn't respond, fail fast.
2. **`/exec` HTTP abort** — 30 seconds (25s command timeout sent in request body + 5s abort buffer). Uses `AbortController` + `setTimeout` rather than `AbortSignal.timeout()` because undici's implementation of the latter fails to cancel stalled TCP connections under load.
3. **Tool deadline** — 45 seconds. A `Promise.race` in the MCP tool handler fires a user-visible error message if both NAS calls somehow stall past the HTTP abort layer.

`Connection: close` is set on all outbound requests to nas-api to prevent keep-alive pool exhaustion across a long session (the root cause of the "works early, fails later" session-degradation pattern).

The Node.js HTTP server runs with `keepAliveTimeout: 120s` and `headersTimeout: 125s` — above Traefik's 90s idle timeout — so Traefik never tries to reuse a connection that Node has already closed.

See [apps/nas-mcp/README.md](../apps/nas-mcp/README.md) for the full tool catalog.

## Database

Supabase project `qnjimovrsaacneqkggsn`. All tables are prefixed `smon_`.

### Telemetry tables (append-only)

`smon_metrics`, `smon_logs`, `smon_alerts`, `smon_storage_snapshots`, `smon_process_snapshots`, `smon_disk_io_stats`, `smon_net_connections`, `smon_container_status`, `smon_container_io`, `smon_sync_task_snapshots`, `smon_scheduled_tasks`, `smon_backup_tasks`, `smon_snapshot_replicas`, `smon_security_events`, `smon_dsm_errors`

### Current-state tables (upserted)

`smon_package_status` — one row per NAS + package, upserted every 2m.

### Issue tables

`smon_issues`, `smon_issue_messages`, `smon_issue_evidence`, `smon_issue_actions`, `smon_issue_jobs`, `smon_issue_state_transitions`, `smon_facts`, `smon_fact_sources`, `smon_issue_facts`, `smon_capability_state`, `smon_ingestion_health`, `smon_ingestion_events`, `smon_ai_settings`

### Known DSM blind spots

- `smon_scheduled_tasks` — DSM returns error 103 for `SYNO.Core.TaskScheduler` on edgesynology1
- `smon_snapshot_replicas` — Snapshot Replication APIs return error 102 on edgesynology1
- `smon_container_status` CPU/memory — DSM API always returns 0; use `smon_container_io` for real I/O data

Empty tables do not imply healthy subsystems. Check `smon_logs` for explicit API-unavailable warnings from the affected collectors.
