# Ingestion Backlog

Last verified: 2026-04-08 UTC

This is the operational tracker for telemetry that we still do not ingest fully, or only ingest partially. It is intentionally separate from the architecture docs so the main docs stay focused on current system behavior.

Status labels:
- `done` = currently ingesting and verified live
- `partial` = some data is ingested, but the source is incomplete or not yet reliable
- `blocked` = the current NAS/DSM combination does not support the current request shape
- `not_started` = known gap, not yet implemented

## Priority 1

| Domain | Missing or incomplete source | Why it matters | Collection strategy | Target table | Fallback path | Status | Notes |
|---|---|---|---|---|---|---|---|
| Scheduled tasks | Full DSM scheduled-task snapshots | Silent task failures often explain backup and maintenance problems | Reverse-engineer the exact `SYNO.Core.TaskScheduler` request shape that the current DSM accepts; persist task name, owner, enabled state, next run, last run, and last result | `smon_scheduled_tasks` | Emit `scheduled_task` warning logs when the API is unsupported; parse task output logs if available | blocked | Current NAS returns `API error code: 103` with the current request shape |
| Hyper Backup | Structured task state and progress | Backup health is a high-value silent failure path | Confirm the supported DSM API/version for task listing and status; persist progress, destination, last result, transfer bytes, and speed | `smon_backup_tasks` | Parse Hyper Backup logs and package state; emit warning logs when the API is unavailable | partial | Rows are not yet verified live |
| Snapshot replication | Structured task state and progress | Snapshot failures can look like file drift or storage issues if not captured | Determine whether Snapshot Replication is installed and which API name/version the current DSM exposes; persist source share, destination, status, and last result | `smon_snapshot_replicas` | Parse package logs and storage events; emit warning logs when the API is unsupported | blocked | Current attempted APIs return unsupported/unavailable responses |
| DSM structured logs | Log Center events with stable cursoring | These logs contain share DB, service, and package errors that do not always appear in flat files | Make the structured log API accept the live response shape and keep a watermark/cursor so events are not re-ingested | `smon_logs` | Keep file-log tailing as the fallback source | partial | Parser is fixed, but live row ingestion is not yet verified on the current NASes |

## Priority 2

| Domain | Missing or incomplete source | Why it matters | Collection strategy | Target table | Fallback path | Status | Notes |
|---|---|---|---|---|---|---|---|
| Drive / ShareSync identity | Exact sync task identity, peer NAS, direction, and task config | Without this, the agent knows a ShareSync problem exists but not which relationship to fix | Normalize the ShareSync companion log + task snapshot into a stable task identity record | `smon_sync_task_snapshots` | Parse `syncfolder.log` and companion Drive logs; keep raw log lines | partial | Existing table exists, but the detail is still not complete enough for confident remediation |
| Drive conflict detail | Conflict lists, invalid filename records, and per-folder failure objects | Needed for specific rename/cleanup or targeted repair recommendations | Extract exact file paths and conflict causes from Drive logs and any sync-task metadata | `smon_logs` plus a dedicated conflict table if the detail volume proves useful | Keep raw logs until a normalized table is justified | not_started | This is one of the biggest reasons remediation stays vague |
| Share quota history | Per-share quota trend and threshold crossings | Helps explain storage pressure and sync backlog behavior | Persist quota snapshots over time instead of only threshold warnings | `smon_metrics` or a dedicated quota table | Threshold logs if history is unavailable | partial | We already have threshold logging; history is still thin |
| SMART history | Longitudinal SMART tests, failures, and reallocated sectors | Needed to tell software faults from storage degradation | Ingest periodic SMART status and scheduled self-test outcomes | `smon_storage_snapshots` or a dedicated SMART table | Current disk health checks and kernel logs | partial | Storage health is present, but test history is not yet first-class |
| Service restart history | Restart frequency, crash loops, and start/stop transitions over time | Helps identify unstable services before they become hard failures | Persist every transition with timestamps and reasons | `smon_service_health` or a dedicated restart table | Current point-in-time service snapshots | done | Restart transitions are already logged; the remaining work is trend visibility |

## Priority 3

| Domain | Missing or incomplete source | Why it matters | Collection strategy | Target table | Fallback path | Status | Notes |
|---|---|---|---|---|---|---|---|
| File-operation attribution | SMB/NFS user identity, remote client attribution, share context | Needed to answer “who did what?” for bursts of rename/move/delete activity | Enrich network and process data with user/share identity where DSM or log sources expose it | `smon_net_connections`, `smon_process_snapshots`, plus issue evidence | Use raw logs and security watcher output | partial | Remote IP alone is not enough for real attribution |
| Container I/O | Read/write BPS and IOPS by container | Useful for explaining NAS load and I/O contention | Keep cgroup + `/proc/<pid>/io` fallback | `smon_container_io` | None needed beyond the current fallback | done | Verified live |
| DSM API capability detection | Explicit installed/available package state | Prevents repeated probes against unsupported APIs | Detect package install state before querying package-specific APIs | warning logs plus the relevant domain table | Package logs | not_started | This reduces noise and makes unsupported APIs explicit |
| Ingestion pipeline health | Collector lag, flush failures, WAL growth, row drop events | Necessary so we can tell telemetry loss from real silence | Emit agent self-health metrics and alerts | `smon_metrics` plus dedicated health table if needed | Agent logs | not_started | This is operationally important and currently under-modeled |

## What is already done

- `smon_container_io` is live and receiving rows.
- `scheduled_task` warning logs are live and visible.
- snapshot-replication warning logs are live and visible.
- the DSM system-log parser no longer crashes on string log levels.
- the docs now separate verified live state from historical notes.

## What should happen next

1. Reverse-engineer the scheduled-task request shape that the current DSM accepts.
2. Determine whether Hyper Backup task listing requires a different version or a different package state on these NAS units.
3. Determine whether Snapshot Replication is installed and, if it is, what API path it actually exposes.
4. Finish the structured DSM log path so it produces live rows or an explicit unsupported warning on every poll.
5. Normalize Drive / ShareSync task identity and conflict detail so remediation can name the exact target.
6. Add pipeline-health telemetry so we can tell “collector broken” from “subsystem quiet.”

## How to use this file

- Treat this as the backlog for telemetry ingestion work.
- When a row changes state, update the `Status` and the `Notes`.
- If a gap is proven impossible on the current DSM/NAS combination, leave it in the backlog but mark it `blocked` and capture the reason.
- If a gap is fully implemented and verified, move it to `done` and keep the verification note short.
