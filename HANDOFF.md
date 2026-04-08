# NAS Monitor — Handoff

Last verified: 2026-04-08 UTC

This file is the shortest accurate handoff for the current system.

## What this product is

NAS Monitor watches two Synology NAS units and gives the operator a persistent issue-centric interface in the web app. The intended behavior is:
- one durable issue thread per problem
- one linear conversation per issue
- persistent memory across refreshes and restarts
- diagnostics and approvals tied to that issue record

The old “phase machine” approach is gone from the primary architecture. The current system centers on issue state and issue conversation.

## Core architecture

### Web

Key files:
- [issue-agent.ts](/worksp/monitor/app/apps/web/src/lib/server/issue-agent.ts)
- [issue-store.ts](/worksp/monitor/app/apps/web/src/lib/server/issue-store.ts)
- [issue-workflow.ts](/worksp/monitor/app/apps/web/src/lib/server/issue-workflow.ts)
- [workflow-store.ts](/worksp/monitor/app/apps/web/src/lib/server/workflow-store.ts)
- [fact-store.ts](/worksp/monitor/app/apps/web/src/lib/server/fact-store.ts)
- [capability-store.ts](/worksp/monitor/app/apps/web/src/lib/server/capability-store.ts)
- [issue-view.ts](/worksp/monitor/app/apps/web/src/lib/server/issue-view.ts)
- [copilot-issues.ts](/worksp/monitor/app/apps/web/src/lib/server/copilot-issues.ts)
- [issue-detector.ts](/worksp/monitor/app/apps/web/src/lib/server/issue-detector.ts)
- [tools.ts](/worksp/monitor/app/apps/web/src/lib/server/tools.ts)
- [nas.ts](/worksp/monitor/app/apps/web/src/lib/server/nas.ts)

The web app:
- stores issues, messages, evidence, and actions in Supabase
- stores normalized facts, capability state, issue jobs, and state transitions
- queries telemetry on each issue-agent cycle
- treats missing telemetry as degraded visibility when query errors occur
- can run in `inline` or `background` issue-worker mode

### Agent

Key files:
- [main.go](/worksp/monitor/app/apps/agent/cmd/agent/main.go)
- [sender.go](/worksp/monitor/app/apps/agent/internal/sender/sender.go)
- [client.go](/worksp/monitor/app/apps/agent/internal/dsm/client.go)
- [container_io.go](/worksp/monitor/app/apps/agent/internal/collector/container_io.go)
- [sharehealth.go](/worksp/monitor/app/apps/agent/internal/collector/sharehealth.go)
- [schedtasks.go](/worksp/monitor/app/apps/agent/internal/collector/schedtasks.go)
- [hyperbackup.go](/worksp/monitor/app/apps/agent/internal/collector/hyperbackup.go)
- [storagepool.go](/worksp/monitor/app/apps/agent/internal/collector/storagepool.go)

The Go agent:
- runs 17 collectors
- buffers writes through a local SQLite WAL
- flushes to Supabase every 30 seconds

## Deployment truth

### Web deployment

Web deployment is not “direct Coolify on git push”.

Actual flow:
1. push to `master`
2. GitHub Actions workflow builds and pushes `ghcr.io/u2giants/synology-monitor-web:latest`
3. the workflow triggers Coolify redeploy

Relevant file:
- [.github/workflows/web-image.yml](/worksp/monitor/app/.github/workflows/web-image.yml)

### Agent deployment

Agent deployment flow:
1. push to `master`
2. GitHub Actions builds and pushes `ghcr.io/u2giants/synology-monitor-agent:latest`
3. each NAS must `pull`, remove old container, and recreate

Relevant files:
- [.github/workflows/agent-image.yml](/worksp/monitor/app/.github/workflows/agent-image.yml)
- [docker-compose.agent.yml](/worksp/monitor/app/deploy/synology/docker-compose.agent.yml)

Canonical NAS path:
- `/volume1/docker/synology-monitor-agent`

Docker binary on Synology:
- `/var/packages/ContainerManager/target/usr/bin/docker`

## Database truth

Extended telemetry is now tracked in-repo and live:
- `smon_scheduled_tasks`
- `smon_backup_tasks`
- `smon_snapshot_replicas`
- `smon_container_io`

Rebuild foundation tables are also live:
- `smon_capability_state`
- `smon_ingestion_health`
- `smon_ingestion_events`
- `smon_facts`
- `smon_fact_sources`
- `smon_issue_facts`
- `smon_issue_jobs`
- `smon_issue_state_transitions`

Migration:
- [00025_create_extended_telemetry_tables_and_log_sources.sql](/worksp/monitor/app/supabase/migrations/00025_create_extended_telemetry_tables_and_log_sources.sql)
- [00026_rebuild_foundation_schema.sql](/worksp/monitor/app/supabase/migrations/00026_rebuild_foundation_schema.sql)

Important rule:
- do not add fields to an existing sender payload unless the Supabase table already has those columns
- when in doubt, add a migration first

## What was fixed in the latest pass

### Schema contract

The extended collector work originally targeted tables that were not present in tracked schema. That is fixed now via:
- [00025_create_extended_telemetry_tables_and_log_sources.sql](/worksp/monitor/app/supabase/migrations/00025_create_extended_telemetry_tables_and_log_sources.sql)

### Log source contract

New collector sources were being rejected by the `smon_logs` check constraint. That is fixed in the same migration and now includes:
- `scheduled_task`
- `hyperbackup`
- `service_restart`
- `btrfs_error`
- `sharesync_detail`
- `share_quota`

### Runtime mount mismatch

New collectors assumed `/sys` was available, but the canonical compose file did not mount it. That is fixed in:
- [docker-compose.agent.yml](/worksp/monitor/app/deploy/synology/docker-compose.agent.yml)

### Container I/O collection

Synology’s cgroup layout does not always expose blkio throttle files. The collector now:
- tries `/host/sys`
- falls back to `/sys`
- falls back again to `/proc/<pid>/io` for tasks in the container cgroup

File:
- [container_io.go](/worksp/monitor/app/apps/agent/internal/collector/container_io.go)

This is verified live: `smon_container_io` now has rows.

### Silent API failure behavior

The DSM client used to swallow several failures and return nil data. It now returns real errors for:
- scheduled tasks
- Hyper Backup tasks
- snapshot replication

File:
- [client.go](/worksp/monitor/app/apps/agent/internal/dsm/client.go)

### Silent blind spots in production

Collectors now write warning logs when an advertised DSM API is unsupported or not working on the current NAS:
- scheduled tasks
- Hyper Backup
- snapshot replication
- DSM structured system logs

Files:
- [schedtasks.go](/worksp/monitor/app/apps/agent/internal/collector/schedtasks.go)
- [hyperbackup.go](/worksp/monitor/app/apps/agent/internal/collector/hyperbackup.go)
- [storagepool.go](/worksp/monitor/app/apps/agent/internal/collector/storagepool.go)
- [sharehealth.go](/worksp/monitor/app/apps/agent/internal/collector/sharehealth.go)

## Verified live status

Verified:
- both NASes deployed from the current compose shape with `/host/sys`
- `smon_container_io` is receiving live rows
- `scheduled_task` warnings reach `smon_logs`
- snapshot-replication API warnings reach `smon_logs`

Not yet verified as working data streams:
- `smon_scheduled_tasks`
- `smon_backup_tasks`
- `smon_snapshot_replicas`
- `dsm_system_log` rows

That does not mean those subsystems are healthy. It means the NAS DSM APIs for those collectors still need additional reverse-engineering or package-state detection.

## Known live blind spots

### Scheduled tasks

Observed behavior:
- `SYNO.Core.TaskScheduler` is advertised by DSM
- current request shape returns `API error code: 103`

Current system behavior:
- no task rows
- explicit warning log instead of silent success

### Snapshot replication

Observed behavior:
- current attempted APIs return unsupported/unavailable responses

Current system behavior:
- no snapshot rows
- explicit warning log instead of silent success

### Hyper Backup

Observed behavior:
- task rows are not yet verified
- API surfacing now exists if it fails

### DSM Log Center structured logs

Observed behavior:
- parser no longer crashes on string log levels
- rows still not observed yet on the current NASes

## How the system is supposed to behave

### Issue agent

For one issue:
1. load issue record, recent messages, actions, evidence
2. load telemetry context
3. derive normalized facts from that telemetry
4. update capability state for the affected NAS units
5. decide on one next step
6. persist the reply and any evidence
7. execute auto-approvable diagnostics
8. stop at approval boundaries for remediation

### Issue workflow ownership

Current architecture:
- routes enqueue issue jobs into `smon_issue_jobs`
- the backend worker drains those jobs
- issue transitions are recorded in `smon_issue_state_transitions`

Worker modes:
- `ISSUE_WORKER_MODE=inline`
  - request paths enqueue and immediately drain jobs
  - this is the compatibility mode
- `ISSUE_WORKER_MODE=background`
  - request paths enqueue only
  - `/api/internal/issue-worker/drain` drains jobs with service-role access
  - `RUN_ISSUE_WORKER=true` starts the loop in the web container via `docker-entrypoint.sh`

Required env for background mode:
- `SUPABASE_SERVICE_ROLE_KEY`
- `ISSUE_WORKER_TOKEN`

The system should never treat missing telemetry as proof of health. That principle is now partially enforced in both the web prompt context and the agent collector warning logs.

### Telemetry interpretation

Healthy telemetry means:
- data rows exist for the collector’s target table
- or the collector explicitly records that the subsystem currently has no items

Unhealthy telemetry path means:
- warnings appear in `smon_logs`
- the target table remains empty
- the app should treat that subsystem as degraded or unsupported

## What a new developer should read first

1. [AGENTS.md](/worksp/monitor/app/AGENTS.md)
2. [PLAN.md](/worksp/monitor/app/PLAN.md)
3. [issue-agent.ts](/worksp/monitor/app/apps/web/src/lib/server/issue-agent.ts)
4. [client.go](/worksp/monitor/app/apps/agent/internal/dsm/client.go)
5. [docker-compose.agent.yml](/worksp/monitor/app/deploy/synology/docker-compose.agent.yml)
