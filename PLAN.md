# NAS Monitor — Plan

## Current State (April 2026)

The system is production-ready and actively monitoring two Synology NAS units. Both the Go agent and the Next.js web app are deployed and running.

---

## What is complete

### Go agent (17 collectors)

All collectors are implemented and running on both NAS units:

- [x] System: CPU, memory, network, Docker container status (30s)
- [x] Storage: Volume and disk health via DSM API (60s)
- [x] Drive: Drive team folders, user activity, ShareSync task parsing (30s)
- [x] Process: Per-process CPU/mem/disk I/O from /proc (15s)
- [x] Diskstats: Per-disk IOPS/throughput/await/utilisation from /proc/diskstats (15s)
- [x] Connections: Active TCP connections grouped by remote IP (30s)
- [x] Logwatcher: Multi-source log tailing with bootstrap and rotated-file support (10s)
- [x] Share health: DSM API share enumeration, package health, structured DSM logs, share quotas (2m)
- [x] Service health: 12 DSM services with restart detection and uptime metrics (60s)
- [x] SysExtras: Memory pressure, inode, CPU temp, iowait%, NFS stats, VM pressure, Btrfs errors (30s)
- [x] Custom: AI-requested dynamic collection via smon_custom_metric_schedules (60s poll)
- [x] Security: Entropy-based ransomware detection, mass-rename, integrity scanning (event-driven)
- [x] Scheduled tasks: ALL DSM scheduled tasks with exit codes via DSM API (5m) → smon_scheduled_tasks
- [x] Hyper Backup: Task state and progress via DSM API with dual-API fallback (5m) → smon_backup_tasks
- [x] Storage pool: RAID scrub/rebuild from /proc/mdstat (60s) + snapshot replication (5m) → smon_snapshot_replicas
- [x] Container I/O: Per-container block I/O via cgroup v1/v2 with delta computation (30s) → smon_container_io

### Web app (Next.js)

- [x] Dashboard: Live metrics, alerts, service health overview
- [x] /assistant: NAS Copilot chat with issue agent
- [x] /sync-triage: Sync error triage UI
- [x] /ai-insights: Grouped AI analysis runs
- [x] /settings: AI model configuration
- [x] Issue agent (issue-agent.ts): conversation-loop agent with MAX_AGENT_CYCLES=2
- [x] Telemetry context: 10 parallel queries including all new tables
- [x] Diagnostic tools: 16 tools including check_scheduled_tasks, check_backup_status, check_container_io
- [x] HMAC-signed approval tokens for remediation actions
- [x] Admin version banner with build SHA
- [x] dedupeLatestByField: prevents context flooding from repeated task snapshots
- [x] Telemetry field guide in agent prompt: thresholds for iowait, backup failures, container I/O

### Supabase tables (live)

- [x] smon_nas_units, smon_metrics, smon_logs, smon_alerts
- [x] smon_storage_snapshots, smon_container_status, smon_service_health
- [x] smon_process_snapshots, smon_disk_io_stats, smon_net_connections
- [x] smon_sync_task_snapshots, smon_drive_activities, smon_drive_team_folders
- [x] smon_security_events, smon_copilot_sessions, smon_copilot_messages, smon_copilot_actions
- [x] smon_custom_metric_schedules, smon_custom_metric_data
- [x] smon_issues, smon_issue_actions, smon_issue_messages, smon_issue_evidence
- [x] smon_ai_analyses, smon_analysis_runs, smon_analyzed_problems
- [x] smon_scheduled_tasks (new April 2026)
- [x] smon_backup_tasks (new April 2026)
- [x] smon_snapshot_replicas (new April 2026)
- [x] smon_container_io (new April 2026)

---

## What could be improved (not blocking anything)

### Agent quality
- [ ] **Context window management**: the 10 parallel queries can return a lot of data. Add token estimation and trim lower-priority context if approaching model limits.
- [ ] **Issue auto-detection**: `issue-detector.ts` triggers on alerts, but not all problems generate alerts. Could trigger on log patterns (e.g., repeated `last_result != 0` on a scheduled task).
- [ ] **Conversation summary pruning**: `conversation_summary` field is updated on each cycle but can grow long. Consider a summarization step every N cycles.

### Data collection
- [ ] **`smon_sync_task_snapshots` is empty**: DSM API error 102 on both NAS units. The ShareSync task API isn't available. Investigation needed: is it a package version issue? A DSM version issue? Can the log-parsing fallback produce structured output that populates this table?
- [ ] **SMART data freshness**: currently collected by the storage collector but SMART self-tests aren't triggered. Could add a `check_smart` scheduled task.
- [ ] **Snapshot replication reliability**: `GetSnapshotReplicationTasks()` has a dual-API fallback but may still fail if the package isn't installed. Monitor `smon_snapshot_replicas` for data.

### Operations
- [ ] **Agent auto-update**: currently requires SSH to each NAS to `docker compose pull && restart`. Could automate with a watchtower container or a deploy webhook.
- [ ] **WAL persistence**: the SQLite WAL in the agent container at `/app/data/wal.db` is lost when the container is recreated. Should be a named volume or bind mount. Currently the 30s flush interval makes this low-risk.

---

## Decision log

### April 2026: New collectors added (schedtasks, hyperbackup, storagepool, container_io)

**Why:** The AI agent had significant blind spots. Silent scheduled task failures, Hyper Backup state, RAID scrub/rebuild progress, and container-level I/O were all completely invisible. These are common root causes for NAS performance and reliability problems.

**Key design decision — new tables, not new columns:** PostgREST (Supabase's REST layer) returns HTTP 400 if you POST a field that doesn't exist in the table schema. This means you can never add a field to an existing payload struct without first adding it to Supabase via a migration. We chose to create new tables (`smon_scheduled_tasks`, `smon_backup_tasks`, `smon_snapshot_replicas`, `smon_container_io`) rather than trying to extend existing structs with optional fields.

### April 2026: sysextras extended with I/O metrics

**Why:** CPU iowait%, NFS server traffic, VM page writeback, and Btrfs errors were not collected. These are critical for distinguishing disk saturation from CPU saturation and identifying memory pressure as a root cause.

**Key design decision — existing table, new metric types:** Unlike the structured task data, these are scalar metrics that fit naturally into `smon_metrics` as new `type` values. No schema change needed — the `smon_metrics` table already has `type`, `value`, `unit`, and `metadata` fields.

### April 2026: Logwatcher bootstrap extended

**Why:** Log evidence was being lost on agent restart. Drive logs were bootstrapped (last 200 lines) but other sources (backup, webapi, kernel, service, package) were not. Also, rotated log files (`.1`) were never read, losing up to a day of context if a log rotated recently.

**Key design decision — conditional rotation read:** `bootstrapRotated()` only reads the `.1` file if the current file is < 8 KB. This heuristic detects "freshly rotated" vs "has content" without having to parse timestamps. The threshold is generous — a legitimate fresh log file would be 0 bytes; 8 KB gives headroom for startup messages.

### April 2026: Issue agent replaces resolution-agent state machine

**Why:** The old `resolution-agent.ts` was a complex state machine with 8 phases, a tick-based polling loop, and multiple AI calls per tick. It had persistent bugs: re-proposing rejected fixes, ignoring user messages, re-running the same diagnostics after replanning. These were architectural, not implementation bugs — the state machine model is inherently fragile for a conversational interface.

**The new approach:** `issue-agent.ts` is a conversation-loop agent. Each cycle gives the AI the full conversation history, all evidence, all past actions, and fresh telemetry — and asks for one decision. The AI's response IS the state. There's no state machine to get stuck in.
