# NAS Monitor — Agent Handoff Prompt

You are continuing work on the NAS Monitor AI issue agent. Below is a complete picture of the product, architecture, current state, and what needs attention.

---

## What the product is

NAS Monitor is a Next.js 15 web app that monitors two Synology NAS devices (edgesynology1, edgesynology2) over SSH. The `/assistant` page hosts an AI agent ("NAS Copilot") that diagnoses and fixes NAS problems through a conversation interface.

**Stack:**
- Next.js 15, Supabase (Postgres), OpenRouter for AI
- AI models: configurable via Settings — currently `google/gemini-2.5-flash` (diagnosis) and `openai/gpt-5.4` (remediation/analysis)
- Go agent runs on each NAS, collecting 17 data streams into Supabase

**Repo:** github.com/u2giants/synology-monitor — push to master only. GitHub Actions builds Go agent Docker image → GHCR → agents pull manually. Next.js web app deploys via Coolify on push to master.

**Deployment SSH:** root@178.156.180.212 with ed25519 key; Coolify panel at http://178.156.180.212:8000

**Supabase:** qnjimovrsaacneqkggsn.supabase.co

---

## What the agent is supposed to do (the vision)

1. One linear conversation per issue — user messages are direct replies to agent messages, agent messages are direct replies to user messages. Like a chat with a knowledgeable engineer who happens to be running commands in the background.
2. The agent is the DRIVER, not a passive passenger. It takes charge, proposes actions, executes diagnostics, reports back, asks follow-up questions.
3. Persistent memory per issue that survives page refreshes — everything tried, every result, every user message, every agent response.
4. When a diagnostic is run, the agent integrates the result into its hypothesis and decides what to do next.
5. When a fix is proposed, the user approves or rejects it. If rejected, the agent proposes a different approach.

---

## Current architecture

### Core files

```
apps/web/src/lib/server/
├── issue-agent.ts      — THE main AI logic (conversation-loop agent)
├── issue-store.ts      — DB CRUD: issues, actions, messages, evidence
├── issue-detector.ts   — Auto-detects new issues from alerts/logs
├── copilot.ts          — Copilot chat handler
├── tools.ts            — SSH diagnostic tool definitions + execution
└── nas.ts              — SSH connection + runNasScript
```

### The agent (`issue-agent.ts`)

**NOT a state machine.** The old `resolution-agent.ts` with planning→diagnosing→analyzing→proposing_fix→awaiting_fix_approval→... phases no longer exists. It was replaced by `issue-agent.ts` which is a conversation-loop agent.

Each "tick" (triggered by the frontend polling):
1. Loads the full issue state from DB: issue record, messages (last 12), actions (last 10), evidence (last 20)
2. Calls `gatherTelemetryContext()` — 10 parallel Supabase queries (see below)
3. Calls `callDecisionModel()` — sends everything to OpenRouter, gets back `AgentDecision`
4. Persists: updates issue fields (hypothesis, confidence, severity), saves evidence notes, saves agent response as a message
5. If `diagnostic_action` is set and auto-approvable: runs it via SSH, saves result, loops (up to `MAX_AGENT_CYCLES = 2`)
6. If `remediation_action` is set: creates a DB action with `waiting_for_approval` status, stops
7. Stops if status = `waiting_on_user`, `waiting_for_approval`, `resolved`, or `stuck`

**Model selection:** If any diagnostic action is `completed`, uses `getRemediationModel()` (gpt-5.4). Otherwise uses `getDiagnosisModel()` (gemini-2.5-flash).

### DB tables (issue-related)

| Table | Purpose |
|-------|---------|
| `smon_issues` | One row per issue: hypothesis, confidence, severity, status, affected_nas, constraints, blocked_tools, conversation_summary |
| `smon_issue_actions` | Tool calls and actions: kind (diagnostic/remediation), tool_name, target, status, result_text |
| `smon_issue_messages` | Conversation: role (user/agent), content, created_at |
| `smon_issue_evidence` | Structured findings: source_kind, title, detail |

### Telemetry context (10 queries per cycle)

`gatherTelemetryContext()` runs these in `Promise.all()`:

| Data | Table | Time window |
|------|-------|-------------|
| Active alerts | `smon_alerts` | all active |
| Error/warning logs | `smon_logs` | 6h |
| Top processes | `smon_process_snapshots` | 6h |
| Disk I/O | `smon_disk_io_stats` | 6h |
| Failed scheduled tasks | `smon_scheduled_tasks` | 48h (tasks may run daily) |
| Backup tasks | `smon_backup_tasks` | 6h, deduped per task_id |
| Snapshot replicas | `smon_snapshot_replicas` | 6h, deduped per task_id |
| Container I/O (top writers) | `smon_container_io` | 30m, sorted by write_bps desc |
| ShareSync tasks | `smon_sync_task_snapshots` | 6h, deduped per task_id |
| I/O pressure metrics | `smon_metrics` | 30m (iowait, NFS, vmstat types) |

### API routes (under `/app/api/`)

- `POST /api/copilot/chat` — handles user messages, triggers agent tick
- `POST /api/copilot/execute` — executes an approved remediation action
- `GET /api/copilot/session` — session info including admin role

---

## Go agent data collection

The Go agent on each NAS runs 17 collectors. See AGENTS.md for full documentation. The key ones for the AI agent:

### New collectors (added April 2026)

| Collector | Table | Interval | Key data |
|-----------|-------|----------|----------|
| `schedtasks` | `smon_scheduled_tasks` | 5m | ALL scheduled tasks with last_result (exit code). Non-zero = silent failure. |
| `hyperbackup` | `smon_backup_tasks` | 5m | Hyper Backup task state, progress, last_result |
| `storagepool` | `smon_snapshot_replicas` | 5m | Snapshot replication state; also RAID scrub/rebuild via /proc/mdstat every 60s |
| `container_io` | `smon_container_io` | 30s | Per-container block I/O via cgroup v1/v2 delta computation |

### Extended sysextras (same table, new metric types)

New `smon_metrics` types added to the `sysextras` collector:
- `cpu_iowait_pct` — % of CPU time spent waiting on disk (from /proc/stat jiffies delta)
- `nfs_read_bps`, `nfs_write_bps`, `nfs_calls_ps` — NFS server throughput (from /proc/net/rpc/nfsd)
- `vm_pgpgout_ps`, `vm_swap_out_ps`, `vm_swap_in_ps` — memory pressure (from /proc/vmstat)
- Btrfs filesystem errors logged to `smon_logs` source `btrfs_error` when nonzero

### Extended sharehealth

- `logWatermark` — prevents re-ingesting DSM Log Center entries on each 2-minute poll
- `collectShareQuotas()` — share quota usage logged at 85%/90%/95% thresholds
- DSM log fetch limit raised from 50 → 200

### Extended services

- Restart detection: `prevStatus` tracks running→stopped and stopped→running transitions → `service_restart` log entries
- Service uptime via pgrep + ps etimes → `service_uptime` metric

### Extended logwatcher

- Bootstrap expanded from drive-only to multiple sources: drive=200 lines, backup=150, webapi/share/service=100, storage/kernel=75, package=50
- `bootstrapRotated()` — reads `.1` rotated log file if current file < 8KB (freshly rotated)

---

## What is working well

- Issue agent conversation loop is functional
- 17 data collectors running on both NAS units
- Telemetry context covers: process I/O, disk I/O, container I/O, backup state, scheduled task failures, RAID status, NFS load, memory pressure
- HMAC-signed approval tokens for destructive operations
- 3 new SSH diagnostic tools: `check_scheduled_tasks`, `check_backup_status`, `check_container_io`

---

## Known limitations / things to watch

1. **`smon_sync_task_snapshots` may be empty** — DSM API error code 102 on both NAS units. The drive collector falls back to log parsing, but the structured table may have no data.

2. **Container I/O requires correct volume mounts** — `/sys/fs/cgroup` must be bind-mounted into the container (read-only) for cgroup-based I/O accounting. Check the compose file if container_io data is missing.

3. **Hyper Backup API fallback** — tries `SYNO.Backup.Task v1`, then `SYNO.Core.Backup.Task v1`. If the package isn't installed, both fail and `smon_backup_tasks` will be empty. This is non-fatal and logged at debug level.

4. **NFS stats absent when NFS not running** — `/proc/net/rpc/nfsd` doesn't exist if NFS server isn't running. `collectNFSStats()` silently skips when the file is absent.

5. **First tick after agent restart produces no container I/O rows** — delta computation needs two samples. Data starts appearing on the second tick (~30s after startup).

---

## Key conventions

- **Always commit and push after every implementation.** Run `git add [files] && git commit -m "..." && git push origin master` from `/worksp/monitor/app` (or the repo root — check with `git rev-parse --show-toplevel`).
- Push to `master` branch only.
- Coolify is in dockerimage mode (not dockerfile). GitHub Actions builds on push to master and pushes to GHCR. Coolify polls GHCR and deploys.
- **Never add fields to existing payload structs** in `sender/types.go` without first adding the column to Supabase. PostgREST returns HTTP 400 for unknown columns. New data → new table.
- `safeAppendLog` (Go) wraps log writes and never panics. Use it for informational entries.
- `dedupeLatestByField` (TypeScript) — always pre-sort by `captured_at desc` before calling; it keeps the first (most recent) occurrence per field value.
- Synology tool paths: `/usr/syno/bin/synopkg`, `/usr/syno/sbin/synoshare` — NOT on default PATH in SSH sessions.

---

## Quick orientation checklist for a new developer

1. Read `AGENTS.md` — full architecture, all 17 collectors, all Supabase tables, all gotchas
2. Read `apps/web/src/lib/server/issue-agent.ts` — the AI agent brain
3. Read `apps/web/src/lib/server/issue-store.ts` — how issues/actions/messages are persisted
4. Read `apps/web/src/lib/server/tools.ts` — what SSH commands the agent can run
5. Read `apps/agent/cmd/agent/main.go` — how all collectors are started
6. Check `apps/agent/internal/sender/types.go` — all Supabase payload structs (one per table)
