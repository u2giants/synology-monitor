# Synology Monitor — Architecture Guide

Last verified: 2026-04-09 UTC

Scope:
- Canonical architecture overview.
- Use this to understand subsystem boundaries, key files, and non-negotiable rules.

This file is the canonical technical overview for this repository.

## System purpose

This system monitors two Synology NAS devices and gives the operator:
- live telemetry
- grouped issues
- a persistent issue conversation
- a controlled approval path for fixes

The product priority is not generic server monitoring. It is:
- Synology Drive / ShareSync reliability
- file operation visibility
- sync and replication failures
- storage and I/O attribution
- silent task and backup failures
- operator-guided resolution per issue

## High-level architecture

### Agent side

Each NAS runs the Go agent container. The agent:
- polls DSM APIs
- reads `/proc`, `/sys`, and log files
- watches shared folders for security-style events
- writes telemetry into a local SQLite WAL
- flushes batched payloads to Supabase

### Web side

The Next.js app:
- reads telemetry from Supabase
- groups telemetry into issues
- stores durable issue threads, evidence, actions, and messages
- runs the issue agent loop against one issue at a time
- exposes restricted monitor-stack controls and current iowait visibility to operators

### Persistence

Supabase is the shared source of truth for:
- telemetry
- detected issues
- issue memory
- action history

## Deployment architecture

### Web

The web app deploys through GitHub Actions and Coolify:
1. push to `master`
2. [web-image.yml](.github/workflows/web-image.yml) builds and pushes the web image
3. workflow triggers Coolify redeploy

### Agent

The agent deploys through GitHub Actions plus NAS-side container recreation:
1. push to `master`
2. [agent-image.yml](.github/workflows/agent-image.yml) builds and pushes the agent image
3. each NAS pulls and recreates `synology-monitor-agent`

Canonical compose file:
- [docker-compose.agent.yml](deploy/synology/docker-compose.agent.yml)

## Web architecture

### Primary issue flow

Core files:
- [issue-agent.ts](apps/web/src/lib/server/issue-agent.ts)
- [issue-store.ts](apps/web/src/lib/server/issue-store.ts)
- [issue-workflow.ts](apps/web/src/lib/server/issue-workflow.ts)
- [workflow-store.ts](apps/web/src/lib/server/workflow-store.ts)
- [fact-store.ts](apps/web/src/lib/server/fact-store.ts)
- [capability-store.ts](apps/web/src/lib/server/capability-store.ts)
- [issue-view.ts](apps/web/src/lib/server/issue-view.ts)
- [copilot-issues.ts](apps/web/src/lib/server/copilot-issues.ts)
- [issue-detector.ts](apps/web/src/lib/server/issue-detector.ts)
- [tools.ts](apps/web/src/lib/server/tools.ts)
- [nas-api-client.ts](apps/web/src/lib/server/nas-api-client.ts)
- [route.ts](apps/web/src/app/api/docker/actions/route.ts)

The current system is issue-centric:
- one issue record per problem
- one thread of messages per issue
- evidence and actions attached to that issue
- normalized facts attached to the issue
- capability state tracked per NAS
- issue jobs and transitions tracked explicitly
- monitor-stack operations are routed through explicit action templates, not generic shell access

The old phase-machine model is not the authoritative architecture anymore.

### Workflow ownership

The workflow is now backend-owned:
- request handlers enqueue jobs into `smon_issue_jobs`
- the issue worker drains jobs
- transitions are recorded in `smon_issue_state_transitions`

Worker runtime:
- `inline` mode: request path drains jobs immediately
- `background` mode: the dedicated worker endpoint drains jobs using service-role Supabase access

Relevant files:
- [issue-workflow.ts](apps/web/src/lib/server/issue-workflow.ts)
- [workflow-store.ts](apps/web/src/lib/server/workflow-store.ts)
- [admin.ts](apps/web/src/lib/supabase/admin.ts)
- [drain/route.ts](apps/web/src/app/api/internal/issue-worker/drain/route.ts)
- [issue-worker.mjs](apps/web/scripts/issue-worker.mjs)
- [docker-entrypoint.sh](apps/web/docker-entrypoint.sh)

### Tooling and operator control

The web app now exposes two important operational surfaces:
- direct `cpu_iowait_pct` visibility in `/metrics`
- restricted monitor-stack Docker actions in `/docker`

Files:
- [page.tsx](apps/web/src/app/(dashboard)/metrics/page.tsx)
- [page.tsx](apps/web/src/app/(dashboard)/docker/page.tsx)
- [tools.ts](apps/web/src/lib/server/tools.ts)
- [route.ts](apps/web/src/app/api/docker/actions/route.ts)

Important tool additions:
- `check_cpu_iowait`
- `stop_monitor_agent`
- `start_monitor_agent`
- `restart_monitor_agent`
- `pull_monitor_agent`
- `build_monitor_agent`

Scope rule:
- these Docker write actions are limited to `/volume1/docker/synology-monitor-agent`
- they do not grant arbitrary Docker control over unrelated containers

### Issue agent behavior

For one cycle:
1. load issue record
2. load recent issue messages
3. load recent actions and evidence
4. gather telemetry context
5. derive normalized facts from telemetry
6. update per-NAS capability state
7. call the decision model
8. persist updated issue state, reply, evidence, and actions
9. run auto-approved diagnostics if appropriate
10. stop at approval boundaries for remediation

Important design rule:
- query failures and missing telemetry must be represented as degraded visibility, not mistaken for subsystem health

That is now enforced through:
- `telemetry_errors` in [issue-agent.ts](apps/web/src/lib/server/issue-agent.ts)
- persisted normalized facts in [fact-store.ts](apps/web/src/lib/server/fact-store.ts)
- persisted capability registry rows in [capability-store.ts](apps/web/src/lib/server/capability-store.ts)

## Agent architecture

### Entry point

All collectors are started from:
- [main.go](apps/agent/cmd/agent/main.go)

### WAL and sender

The sender:
- buffers writes locally
- flushes every 30 seconds
- writes per-table payload batches

Files:
- [sender.go](apps/agent/internal/sender/sender.go)
- [types.go](apps/agent/internal/sender/types.go)

### DSM client

All DSM API access goes through:
- [client.go](apps/agent/internal/dsm/client.go)

Recent important fixes here:
- system log levels can be parsed from int or string
- scheduled-task / backup / snapshot collectors no longer silently return nil on API failure

## Collector inventory

### Always-on collectors

| Collector | File | Primary outputs | Interval |
|---|---|---|---|
| system | [system.go](apps/agent/internal/collector/system.go) | `smon_metrics`, `smon_container_status` | 30s |
| storage | [system.go](apps/agent/internal/collector/system.go) | `smon_storage_snapshots` | 60s |
| drive | [drive.go](apps/agent/internal/collector/drive.go) | Drive tables, sync task data, log entries | 30s |
| process | [process.go](apps/agent/internal/collector/process.go) | `smon_process_snapshots` | 15s |
| diskstats | [diskstats.go](apps/agent/internal/collector/diskstats.go) | `smon_disk_io_stats` | 15s |
| connections | [connections.go](apps/agent/internal/collector/connections.go) | `smon_net_connections` | 30s |
| logwatcher | [watcher.go](apps/agent/internal/logwatcher/watcher.go) | `smon_logs` | 10s |
| sharehealth | [sharehealth.go](apps/agent/internal/collector/sharehealth.go) | `smon_logs`, `smon_metrics` | 2m |
| services | [services.go](apps/agent/internal/collector/services.go) | `smon_service_health`, logs, metrics | 60s |
| sysextras | [sysextras.go](apps/agent/internal/collector/sysextras.go) | `smon_metrics`, `smon_logs` | 30s |
| custom | [custom.go](apps/agent/internal/collector/custom.go) | `smon_custom_metric_data` | 60s poll |
| security | [watcher.go](apps/agent/internal/security/watcher.go) | `smon_security_events` | event-driven |
| schedtasks | [schedtasks.go](apps/agent/internal/collector/schedtasks.go) | `smon_scheduled_tasks`, warning logs | 5m |
| hyperbackup | [hyperbackup.go](apps/agent/internal/collector/hyperbackup.go) | `smon_backup_tasks`, warning logs | 5m |
| storagepool | [storagepool.go](apps/agent/internal/collector/storagepool.go) | `smon_snapshot_replicas`, storage logs, metrics | 60s / 5m |
| container_io | [container_io.go](apps/agent/internal/collector/container_io.go) | `smon_container_io` | 30s |

### Important collector behavior notes

#### `container_io`

Implemented in:
- [container_io.go](apps/agent/internal/collector/container_io.go)

Behavior:
- tries cgroup files under `/host/sys`
- falls back to `/sys`
- if Synology’s blkio files are absent, falls back to summing `/proc/<pid>/io` for cgroup task PIDs

Status:
- verified live
- `smon_container_io` now has rows in production

#### `sysextras`

Implemented in:
- [sysextras.go](apps/agent/internal/collector/sysextras.go)

Behavior:
- emits `cpu_iowait_pct` into `smon_metrics`
- that metric is consumed by issue detection, normalized facts, and the metrics UI

Status:
- verified live
- now first-class in the operator UI

#### `schedtasks`

Implemented in:
- [schedtasks.go](apps/agent/internal/collector/schedtasks.go)

Behavior:
- attempts DSM scheduled-task API
- writes rows if supported
- writes a warning log if API is unavailable

Live reality:
- the current NAS advertises `SYNO.Core.TaskScheduler`
- current request shape returns `API error code: 103`
- no task rows verified yet
- warning logs are verified

#### `hyperbackup`

Implemented in:
- [hyperbackup.go](apps/agent/internal/collector/hyperbackup.go)

Behavior:
- tries multiple DSM APIs
- writes task rows if available
- writes warning logs if APIs fail
- treats non-zero numeric `last_result` as failure

Live reality:
- rows not yet verified on the current NASes
- failure surfacing is implemented

#### `storagepool`

Implemented in:
- [storagepool.go](apps/agent/internal/collector/storagepool.go)

Behavior:
- reads `/host/proc/mdstat` for RAID activity and degraded arrays
- attempts snapshot-replication APIs
- writes warning logs when snapshot APIs are unavailable

Live reality:
- degraded RAID-style log entries are present
- snapshot-replication warnings are present
- snapshot task rows are not yet verified

#### `sharehealth`

Implemented in:
- [sharehealth.go](apps/agent/internal/collector/sharehealth.go)

Behavior:
- enumerates shares
- emits share quota metrics and threshold warnings
- reads DSM structured Log Center events
- now handles log levels encoded as strings
- writes warning logs if structured DSM system logs are unavailable

Live reality:
- share-related telemetry is active
- structured `dsm_system_log` rows are not yet verified

## Database model

### Core telemetry

Important tables:
- `smon_metrics`
- `smon_logs`
- `smon_storage_snapshots`
- `smon_service_health`
- `smon_process_snapshots`
- `smon_disk_io_stats`
- `smon_net_connections`
- `smon_container_status`
- `smon_sync_task_snapshots`

### Extended telemetry

Added and now tracked in repo:
- `smon_scheduled_tasks`
- `smon_backup_tasks`
- `smon_snapshot_replicas`
- `smon_container_io`

Migration:
- [00025_create_extended_telemetry_tables_and_log_sources.sql](supabase/migrations/00025_create_extended_telemetry_tables_and_log_sources.sql)

### Issue memory

Issue-centric tables:
- `smon_issues`
- `smon_issue_messages`
- `smon_issue_evidence`
- `smon_issue_actions`

These are the backbone of the new issue architecture.

## Canonical operational rules

### Documentation rule

Do not describe “implemented in code” as “verified live” unless it has been checked against production behavior.

### Schema rule

Do not add sender payload fields unless the target Supabase table already has matching columns.

### Telemetry rule

An empty table must not be interpreted as health if the collector or DSM API may be unsupported.

Preferred behavior:
- write real rows when supported
- write explicit warning logs when unsupported

### Deploy rule

Do not rely on `compose up -d` alone to switch agent images on Synology. Pull, stop, remove, then recreate.

## Current known limitations

- scheduled-task DSM API request shape still needs reverse-engineering
- snapshot-replication DSM API request shape still needs reverse-engineering
- Hyper Backup task listing still needs verification on the live NASes
- structured DSM Log Center event ingestion still needs verification or a revised request shape

These are now visible in runtime logs instead of being silently hidden.

## Files to read first

1. [PLAN.md](PLAN.md)
2. [HANDOFF.md](HANDOFF.md)
3. [issue-agent.ts](apps/web/src/lib/server/issue-agent.ts)
4. [client.go](apps/agent/internal/dsm/client.go)
5. [docker-compose.agent.yml](deploy/synology/docker-compose.agent.yml)
