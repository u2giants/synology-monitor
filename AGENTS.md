# Synology Monitor — Architecture Guide

This is the canonical technical reference for this repository. Read it before adding features, debugging, or running any diagnostic session.

## System purpose

Monitor two Synology NAS devices and give the operator:
- live telemetry (CPU, I/O, disk, network, sync state)
- grouped issues with persistent memory
- AI-assisted diagnosis that stops at approval boundaries
- controlled write access for common remediations

The product priority is: Synology Drive / ShareSync reliability, file operation visibility, sync and replication failures, storage and I/O attribution, and silent backup failures. It is **not** a generic server monitoring platform.

---

## Components

### Agent (`apps/agent/`)

Go binary that runs on each NAS inside a Docker container.

- Polls DSM APIs, reads `/proc`, `/sys`, and log files
- Watches shared folders for security-style events
- Writes telemetry to a local SQLite WAL, then flushes to Supabase in 30-second batches
- Each collector runs on an independent goroutine with a configurable interval

Entry point: `apps/agent/cmd/agent/main.go`

### NAS API (`apps/nas-api/`)

Go HTTP service that runs on each NAS, exposing a three-tier shell execution API.

- `POST /preview` — classifies a command's tier and returns a human-readable summary, without executing
- `POST /exec` — executes a command after validating tier rules and (for tier 2/3) verifying an HMAC approval token
- `GET /health` — returns build SHA and timestamp

Access is via Tailscale only. The web app and NAS MCP talk to it directly over the private VPN network.

Entry point: `apps/nas-api/cmd/server/main.go`

### NAS MCP (`apps/nas-mcp/`)

TypeScript MCP server deployed on Coolify. Exposes ~109 named NAS diagnostic and remediation tools to AI agents over the Model Context Protocol.

- Talks to the NAS API on behalf of the AI agent
- Handles tier-2/3 preview-and-confirm workflow (first call returns preview; pass `confirmed: true` to execute)
- All tools defined in `tool-definitions.ts`; enabled/disabled by `tools-config.json` (baked into image at build)

Endpoint: `https://nas-mcp.designflow.app/sse`

### Web App (`apps/web/`)

Next.js app deployed on Coolify at `https://mon.designflow.app`.

- Reads telemetry from Supabase
- Groups telemetry into issues with persistent memory
- Runs the AI issue agent loop (diagnosis → evidence → hypothesis → next step)
- Exposes operator-visible surfaces: issue threads, `/metrics`, `/docker` controls

### Relay (`apps/relay/`)

TypeScript HTTP service running on the VPS. Sits between older Lovable-hosted frontend clients and the private NAS APIs.

- Translates named action requests into NAS API calls
- The web app itself talks to NAS APIs directly (not via the relay)
- The relay is deployed separately from the main CI/CD pipeline — see [apps/relay/README.md](apps/relay/README.md)

---

## Data flow

```
[NAS]                       [Supabase]               [Coolify VPS]
agent → SQLite WAL ─────────► telemetry tables ◄────── web app reads
                                                        groups into issues
                                                        runs AI loop
                                                             │
                                                        calls NAS API
                                                        (via Tailscale)
                                                             │
[NAS]                                                        ▼
nas-api ◄─────────────────────────────────────────── preview / exec
    └─ validates tier, verifies HMAC token
    └─ executes shell command
    └─ returns stdout/stderr/exit code
```

AI agents (Claude Desktop / Claude Code) connect to the NAS MCP, which talks to the same NAS API.

---

## NAS API tier system

Every command is classified into one of three tiers:

| Tier | Name | Approval | Examples |
|------|------|----------|---------|
| 1 | Read-only | Auto-executes | `smartctl -a`, `cat /var/log/...`, `btrfs filesystem df` |
| 2 | Service op | HMAC token required | `docker compose restart`, `synopkg restart SynologyDrive` |
| 3 | File op | HMAC token required | `mv /volume1/...`, `chown`, `btrfs snapshot` |
| -1 | Hard-blocked | Never | `mkfs`, `fdisk`, `dd of=/dev/sda`, `shutdown`, `useradd` |

**HMAC token flow:** The web app (or NAS MCP) calls `/preview`, gets the tier, builds an HMAC-signed approval token (15-minute expiry, signed with `NAS_API_APPROVAL_SIGNING_KEY`), and includes it in the `/exec` call. The NAS API verifies the token — command, tier, and expiry must all match the signature.

**`dd` note:** `dd if=<device> of=/dev/null iflag=direct` is tier 1 (read-only latency test). Only `dd` writing **to** a block device is hard-blocked. The pattern `\bdd\b.*\bof=/dev/(sd|nvme|...)` catches writes; reads to `/dev/null` are not blocked.

**Docker allowlist:** Docker commands are not blanket-allowed at tier 2. Only a fixed allowlist of monitor-stack compose commands is permitted (see `validator.go:allowedServiceCommands`). `docker run`, `docker exec`, `docker cp`, and all other Docker subcommands are hard-blocked regardless of tier.

---

## NAS container stack

All three containers live at `/volume1/docker/synology-monitor-agent/` on each NAS. The compose file there should match `deploy/synology/docker-compose.agent.yml` in this repo.

| Container | Image | Purpose |
|-----------|-------|---------|
| `synology-monitor-agent` | `ghcr.io/u2giants/synology-monitor-agent:latest` | Passive telemetry collector |
| `synology-monitor-nas-api` | `ghcr.io/u2giants/synology-monitor-nas-api:latest` | Shell execution API |
| `synology-monitor-watchtower` | `containrrr/watchtower` | Auto-pulls new images every 5 minutes |

**`nas-api` container requirements:**
- `privileged: true` — required for raw block device access (`dd iflag=direct`, `smartctl`)
- `pid: host` — required for `pkill`/`ps` to reach DSM processes
- `/dev:/dev` — exposes block device files inside the container
- `cap_add: SYS_ADMIN` — required for `btrfs subvolume list`, `btrfs scrub`, and snapshot operations
- `security_opt: apparmor=unconfined` — Synology DSM rejects the default apparmor profile on container init

**Synology binary execution:** The nas-api image is Debian-based (not Alpine) because Synology's glibc binaries (`synopkg`, `synoacltool`, `synoshare`) link against glibc symbols absent in musl. The `entrypoint.sh` creates symlinks so those binaries find expected DSM paths (`/usr/syno`, `/var/packages`, `/etc/synoinfo.conf`). It also emulates `get_key_value`, which DSM package scripts call but which isn't a standalone binary.

**Watchtower vs. compose config changes:** Watchtower pulls a new image and restarts the container from its original creation parameters. It does **not** re-read `docker-compose.agent.yml`. If compose config changes (volumes, `privileged`, etc.), the container must be recreated with `docker compose up -d` for the changes to take effect. The `restart_nas_api` write tool now runs `docker compose up -d nas-api` precisely for this reason.

---

## Agent collector inventory

| Collector | File | Main outputs | Interval |
|-----------|------|-------------|----------|
| system | `system.go` | `smon_metrics`, `smon_container_status` | 30s |
| storage | `system.go` | `smon_storage_snapshots` | 60s |
| drive | `drive.go` | Drive tables, sync task data, log entries | 30s |
| process | `process.go` | `smon_process_snapshots` | 15s |
| diskstats | `diskstats.go` | `smon_disk_io_stats` | 15s |
| connections | `connections.go` | `smon_net_connections` | 30s |
| logwatcher | `watcher.go` | `smon_logs` | 10s |
| sharehealth | `sharehealth.go` | `smon_logs`, `smon_metrics` | 2m |
| services | `services.go` | `smon_service_health`, logs, metrics | 60s |
| sysextras | `sysextras.go` | `smon_metrics` (`cpu_iowait_pct`) | 30s |
| infra | `infra.go` | network link state, share metrics, HyperBackup fallback | 2m |
| custom | `custom.go` | `smon_custom_metric_data` | 60s |
| security | `security/watcher.go` | `smon_security_events` | event-driven |
| schedtasks | `schedtasks.go` | `smon_scheduled_tasks`, warning logs | 5m |
| hyperbackup | `hyperbackup.go` | `smon_backup_tasks`, warning logs | 5m |
| storagepool | `storagepool.go` | `smon_snapshot_replicas`, logs, metrics | 60s / 5m |
| container_io | `container_io.go` | `smon_container_io` | 30s |

**DSM API reliability notes:**

- `schedtasks`: `SYNO.Core.TaskScheduler` v4 returns error 103 on current NAS builds. The DSM client falls back through v3/v2/v1. Warning logs are emitted when all versions fail.
- `hyperbackup`: DSM API task rows may be absent on some builds. The collector falls back to reading task state from `/volume1/@appdata/HyperBackup/config/task_state.conf` and adjacent logs.
- `storagepool`: Snapshot replication uses the `SYNO.DR.Plan` API family (not older guessed APIs). `edgesynology2` has the package installed; `edgesynology1` does not expose the same API surface. No DR plans are currently configured.
- `sharehealth`: DSM structured Log Center event ingestion is implemented but not yet verified live on current NAS builds.

An empty table does not mean a subsystem is healthy. Collectors emit explicit warning logs to `smon_logs` when APIs are unavailable. Check `smon_logs.source` values like `scheduled_task`, `hyperbackup`, `dsm_system_log`, and messages beginning with `Snapshot replication API unavailable:`.

---

## Supabase schema (key tables)

**Telemetry:**
- `smon_metrics` — time-series metrics (cpu, iowait, disk, network, share usage)
- `smon_logs` — log events from all collectors and log watchers
- `smon_storage_snapshots` — volume/disk SMART and RAID snapshots
- `smon_disk_io_stats` — per-disk read/write throughput and IOPS
- `smon_process_snapshots` — top processes by CPU/mem
- `smon_net_connections` — active TCP connections
- `smon_container_status` — Docker container running state
- `smon_service_health` — Synology package health
- `smon_sync_task_snapshots` — Drive/ShareSync task state
- `smon_scheduled_tasks` — DSM scheduled task history
- `smon_backup_tasks` — Hyper Backup task history
- `smon_snapshot_replicas` — DR/snapshot replication state
- `smon_container_io` — per-container disk I/O
- `smon_security_events` — auth failures and security events

**Issue memory:**
- `smon_issues` — one row per detected problem
- `smon_issue_messages` — AI and operator messages per issue
- `smon_issue_evidence` — evidence items attached to issues
- `smon_issue_actions` — actions taken per issue
- `smon_issue_jobs` — work queue for the issue worker
- `smon_issue_state_transitions` — audit trail of issue state changes

Migrations live in `supabase/migrations/`.

---

## Issue agent workflow

The issue agent (`apps/web/src/lib/server/issue-agent.ts`) runs per-issue:

1. Load issue record, recent messages, actions, evidence
2. Load recent telemetry context from Supabase
3. Derive normalized facts (`fact-store.ts`) and update capability state (`capability-store.ts`)
4. Call the decision model
5. Persist reply, updated facts, evidence, and actions
6. Auto-execute tier-1 diagnostics if appropriate
7. Stop at tier-2/3 boundaries for operator approval

**Critical rule:** query failures and missing telemetry are represented as degraded visibility, not as health. An absent table row never implies a healthy subsystem.

Worker modes:
- `inline` — the request handler drains the job queue synchronously
- `background` — a dedicated worker endpoint drains jobs; runs from `docker-entrypoint.sh`

---

## NAS MCP session behavior

- Transport: Streamable HTTP (not SSE, despite the `/sse` URL being preserved for client backwards compatibility)
- Session IDs are pre-generated before `handleRequest` is called, then registered in the session map. This prevents a race condition where `mcp-remote` sends `notifications/initialized` before the session is stored.
- Write tools show a command preview on the first call. Pass `confirmed: true` on the second call to execute. If the operator waits more than 15 minutes, the HMAC approval token expires and the flow must restart.

---

## Intentional behaviors that look surprising

**`/sse` URL uses Streamable HTTP, not SSE.** The URL was the original SSE endpoint. The server now implements Streamable HTTP (the current MCP transport standard) but keeps the `/sse` path so existing client configs don't break. New clients can also use `/mcp`.

**nas-mcp `tools-config.json` is in the image, not on disk.** The enabled tool list is compiled into the Docker image at build time. You cannot change which tools are active by editing a file on the server — you must push to `main` and let CI rebuild the image.

**`restart_nas_api` uses `docker compose up -d`, not `docker compose restart`.** `restart` keeps the original creation parameters. `up -d` re-reads the compose file and recreates the container if config has changed. This is intentional so that compose config changes (like adding `privileged: true`) take effect without manual intervention.

**Synology binaries run with `LD_LIBRARY_PATH`.** Synology's tools (`synoinfo`, `synoacltool`, etc.) are glibc binaries that need host library paths. The nas-api container mounts `/lib`, `/usr/lib`, `/usr/syno/lib` from the host, and tool commands prefix them with `LD_LIBRARY_PATH=/host/lib:/host/usr/lib:/host/usr/syno/lib`. This is not a security hole — those are read-only mounts.

**`btrfs/volume1` mount instead of `/volume1`.** The nas-api mounts the full Btrfs volume at `/btrfs/volume1` instead of `/volume1` to avoid conflicting with the container's own `/volume1` path (which Synology Container Manager uses). The entrypoint symlinks `/volume1/@appstore → /btrfs/volume1/@appstore` to satisfy package scripts.

---

## Deployment quick reference

| What changed | What to do |
|-------------|------------|
| `apps/agent/` code | Push to `main` → CI builds image → Watchtower auto-pulls on each NAS |
| `apps/nas-api/` code | Push to `main` → CI builds image → Watchtower auto-pulls on each NAS |
| `apps/nas-mcp/` code or `tools-config.json` | Push to `main` → CI builds image → Coolify auto-redeploys |
| `apps/web/` code | Push to `main` → CI builds image → Coolify deploys |
| Compose config change (volumes, privileged, env) | Push to `main` → wait for Watchtower to pull new image → run `restart_nas_api` (or `restart_monitor_agent`) via MCP to recreate container from updated compose |
| Coolify env var change | Edit in Coolify UI → trigger redeploy |
