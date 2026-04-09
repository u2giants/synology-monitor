# NAS Monitor — Status Plan

Last verified: 2026-04-09 UTC

Scope:
- Reality-based status file.
- Use this to distinguish implemented, deployed, verified, and still incomplete.

This document is a reality-based status file, not a wish list. It separates:
- implemented in code
- deployed live
- still unsupported or incomplete

## Current outcome

The system now has:
- an issue-centric web app with persistent issue memory
- a 17-collector Synology agent
- live extended telemetry tables for tasks, backups, snapshot replication, and container I/O
- live rebuild-foundation tables for capabilities, facts, jobs, and state transitions
- a unified issue backend for both the assistant UI and `/api/copilot/*`
- explicit warning logs when a DSM API is unsupported, instead of silent empty data
- first-class `cpu_iowait_pct` visibility in the metrics UI
- restricted monitor-stack Docker controls in the web UI and tool catalog

The system does not yet have:
- working scheduled-task snapshots from DSM on these NAS units
- working snapshot-replication snapshots from DSM on these NAS units
- confirmed working Hyper Backup task snapshots on these NAS units
- confirmed structured DSM Log Center event ingestion on these NAS units

Those remaining gaps are now surfaced as runtime warnings rather than being mistaken for healthy subsystems.

## Implemented in code

### Web app

- Issue-centric architecture implemented in:
  - [issue-agent.ts](/worksp/monitor/app/apps/web/src/lib/server/issue-agent.ts)
  - [issue-store.ts](/worksp/monitor/app/apps/web/src/lib/server/issue-store.ts)
  - [issue-detector.ts](/worksp/monitor/app/apps/web/src/lib/server/issue-detector.ts)
- The agent reads persistent issue state, recent messages, actions, evidence, and telemetry context on each cycle.
- Telemetry query failures are now preserved in `telemetry_errors` so the agent can treat missing data as degraded visibility instead of “no problems found”.
- Telemetry is normalized into facts and capability-state rows before issue reasoning.
- The issue workflow is now queue-backed through `smon_issue_jobs`.
- `/api/copilot/*` now routes through the issue backend instead of a separate reasoning/persistence stack.
- `/metrics` now surfaces `cpu_iowait_pct` directly.
- `/docker` now exposes monitor-stack-only actions through:
  - [route.ts](/worksp/monitor/app/apps/web/src/app/api/docker/actions/route.ts)
  - [page.tsx](/worksp/monitor/app/apps/web/src/app/(dashboard)/docker/page.tsx)
- The tool catalog now includes:
  - `check_cpu_iowait`
  - `stop_monitor_agent`
  - `start_monitor_agent`
  - `restart_monitor_agent`
  - `pull_monitor_agent`
  - `build_monitor_agent`

### Agent

- 17 collectors are wired in [main.go](/worksp/monitor/app/apps/agent/cmd/agent/main.go).
- Extended telemetry schema is defined in:
  - [00025_create_extended_telemetry_tables_and_log_sources.sql](/worksp/monitor/app/supabase/migrations/00025_create_extended_telemetry_tables_and_log_sources.sql)
- Container I/O collector now supports:
  - host-mounted `/host/sys`
  - Synology cgroup layouts that lack throttle files
  - fallback to `/proc/<pid>/io`
  - implementation in [container_io.go](/worksp/monitor/app/apps/agent/internal/collector/container_io.go)
- DSM system log levels now parse as either integers or strings in [client.go](/worksp/monitor/app/apps/agent/internal/dsm/client.go).
- Scheduled-task / backup / snapshot DSM API failures no longer collapse into silent nil results in [client.go](/worksp/monitor/app/apps/agent/internal/dsm/client.go).
- Unsupported telemetry APIs are now surfaced into `smon_logs` from:
  - [schedtasks.go](/worksp/monitor/app/apps/agent/internal/collector/schedtasks.go)
  - [hyperbackup.go](/worksp/monitor/app/apps/agent/internal/collector/hyperbackup.go)
  - [storagepool.go](/worksp/monitor/app/apps/agent/internal/collector/storagepool.go)
  - [sharehealth.go](/worksp/monitor/app/apps/agent/internal/collector/sharehealth.go)
- `cpu_iowait_pct` continues to be emitted by [sysextras.go](/worksp/monitor/app/apps/agent/internal/collector/sysextras.go) and is now directly exposed to operators.

## Deployed live

### Web

- Live site: `https://mon.designflow.app`
- Deployment model:
  1. push to `master`
  2. GitHub Actions builds `ghcr.io/u2giants/synology-monitor-web:latest`
  3. workflow triggers Coolify redeploy
- This is defined in:
  - [.github/workflows/web-image.yml](/worksp/monitor/app/.github/workflows/web-image.yml)

### Agent

- Both NAS units are deployed from:
  - [docker-compose.agent.yml](/worksp/monitor/app/deploy/synology/docker-compose.agent.yml)
- Canonical live directory on each NAS:
  - `/volume1/docker/synology-monitor-agent`
- `/sys` is now part of the canonical compose spec and must be mounted as `/host/sys:ro`.

### Database

- Live extended tables now exist:
  - `smon_scheduled_tasks`
  - `smon_backup_tasks`
  - `smon_snapshot_replicas`
  - `smon_container_io`
- Live rebuild tables now exist:
  - `smon_capability_state`
  - `smon_ingestion_health`
  - `smon_ingestion_events`
  - `smon_facts`
  - `smon_fact_sources`
  - `smon_issue_facts`
  - `smon_issue_jobs`
  - `smon_issue_state_transitions`
- Live `smon_logs.source` constraint now includes:
  - `scheduled_task`
  - `hyperbackup`
  - `service_restart`
  - `btrfs_error`
  - `sharesync_detail`
  - `share_quota`

## Verified live behavior

- `smon_container_io` is receiving live rows.
- `scheduled_task` warning logs are reaching `smon_logs`.
- `storage` warning logs for snapshot API unavailability are reaching `smon_logs`.
- Both NASes are on the current deployed agent revision as of this verification pass.

Implemented in code and awaiting live verification from the newest web deploy:
- `/metrics` current `cpu_iowait_pct` card
- `/docker` stop/start/restart/pull/build controls for the monitor stack
- issue-agent use of `check_cpu_iowait`

## Remaining unsupported or incomplete areas

### Scheduled tasks

- DSM advertises `SYNO.Core.TaskScheduler`.
- On the current NAS units, the request shape used by the collector returns `API error code: 103`.
- Result:
  - no `smon_scheduled_tasks` rows yet
  - explicit warning log now emitted instead of silent emptiness

### Snapshot replication

- Current collector attempts:
  - `SYNO.Core.Share.Snapshot.ReplicaTask`
  - `SYNO.SynologyDrive.SnapshotReplication`
- On the current NAS units, those calls return unsupported or unavailable responses.
- Result:
  - no `smon_snapshot_replicas` rows yet
  - explicit warning log now emitted

### Hyper Backup

- Current collector tries `SYNO.Backup.Task` first, then fallback APIs.
- Live NAS capability and request behavior still need one more pass to determine the exact supported request shape or whether no tasks are configured.
- Result:
  - no `smon_backup_tasks` rows verified yet
  - API failures are now surfaced if present

### DSM structured system logs

- Parsing bug was fixed.
- On the current NAS units, the collector is no longer crashing, but recent `dsm_system_log` rows have still not been observed in production.
- This may be:
  - a DSM response shape mismatch
  - no recent items in the queried stream
  - a different method or parameter requirement

## Why these changes were necessary

The previous state had two bad failure modes:
- collectors wrote to tables that did not exist
- unsupported DSM APIs returned empty behavior that looked like “healthy, no data”

That made the system lie by omission. The new standard is:
- if telemetry is supported and working, store it
- if telemetry is unsupported or broken, log that fact explicitly
- never let an empty table imply subsystem health without evidence

## Next recommended work

1. Deploy the web app with `ISSUE_WORKER_MODE=background`, `RUN_ISSUE_WORKER=true`, `SUPABASE_SERVICE_ROLE_KEY`, and `ISSUE_WORKER_TOKEN`.
2. Remove or archive the old copilot persistence code so it cannot drift back into use.
3. Reverse-engineer the exact DSM request shape for `SYNO.Core.TaskScheduler` on these NASes.
4. Do the same for Hyper Backup task listing.
5. Confirm whether Snapshot Replication is actually installed and expose that state explicitly.
6. Finish DSM structured Log Center ingestion so `dsm_system_log` produces rows or explicit unsupported diagnostics every cycle.
