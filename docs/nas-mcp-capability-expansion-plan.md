# NAS MCP Capability Expansion Plan

## Goal

Expand `apps/nas-mcp` from a useful read-mostly diagnostic bridge into a complete Synology operations surface that can:

- find
- diagnose
- analyze
- remediate
- audit
- recover

the broad set of failures that matter on two production Synology NASes.

This plan is intentionally stricter than the current implementation. The target is not "some more tools". The target is:

1. near-complete read visibility across DSM, package, filesystem, network, backup, sync, and security domains
2. controlled write capability for common remediations
3. enough forensic visibility to investigate user permission and file-history incidents
4. a safety model that prevents turning the MCP plane into an unsafe root shell

## Current State

Current NAS MCP implementation:

- server entrypoint: [apps/nas-mcp/src/index.ts](/worksp/monitor/app/apps/nas-mcp/src/index.ts)
- tool definitions: [apps/nas-mcp/src/tool-definitions.ts](/worksp/monitor/app/apps/nas-mcp/src/tool-definitions.ts)
- NAS API transport client: [apps/nas-mcp/src/nas-client.ts](/worksp/monitor/app/apps/nas-mcp/src/nas-client.ts)
- enabled tools: [apps/nas-mcp/tools-config.json](/worksp/monitor/app/apps/nas-mcp/tools-config.json)

Current strengths:

- strong first-pass live diagnostics
- good Drive / ShareSync triage coverage
- broad host/system checks
- read-only ad hoc shell via `run_command`
- tiered approval support already exists in the NAS API model

Current hard limits:

- `enabled_write_tools` is empty, so remediation is disabled by config
- log coverage is incomplete and path-specific
- filesystem and permission forensics are shallow
- package / daemon internals are incomplete
- multi-volume and encrypted-volume awareness is weak
- no long-running task orchestration
- no support bundle / evidence export path
- no path-scoped permission repair or restoration workflows

## Target Capability Model

The expanded MCP should cover these domains.

### 1. System Health

- DSM version, build, kernel, uptime
- CPU, memory, swap, pressure, slab, dirty/writeback state
- process inventory with CPU, RSS, I/O, wait state
- package status, daemon health, crash indicators
- boot history and last abnormal shutdown causes

### 2. Storage Health

- volume usage and inode pressure
- storage pool / RAID state
- SMART quick and full detail
- scrub history and active scrub status
- filesystem error counters
- Btrfs snapshot and quota state
- per-disk temperature and error trend

### 3. Network Health

- interface state, errors, drops, flaps
- route table, DNS, MTU, duplex/speed
- bond/LACP state if configured
- active listeners and top connection peers
- service-specific connection views for SMB/NFS/Drive/SSH/DSM

### 4. Package and Service Internals

- Synology Drive / ShareSync logs and state
- Hyper Backup / snapshot replication logs and metadata
- `synologand`, `invoked`, scheduler, WebAPI, package-stop-hook visibility
- package runtime dirs, lock files, PID state, temp files
- package config and database integrity checks

### 5. File and Permission Forensics

- POSIX owner/group/mode
- Synology ACLs and inherited ACLs
- effective permissions for a given user on a path
- share-level privileges and service access mappings
- recent file changes by path, mtime, ctime, rename/delete patterns
- SMB/NFS/Drive-related actor evidence where logs exist
- versioning, snapshots, recycle-bin, and restore candidates
- file integrity signals: hashes, sparse/corrupt indicators, checksum-related warnings

### 6. Security and Audit

- failed logins, admin actions, SSH usage, blocked access, suspicious activity
- recent account / group changes
- package exposure surface and risky enabled services
- retention-aware evidence collection for incidents

### 7. Remediation

- package/service restart with approval
- config changes for known safe remediations
- sysctl changes
- ACL and ownership repair
- file quarantine / rename / move
- Drive / ShareSync repair actions
- backup / scrub / SMART / snapshot tasks
- evidence capture and support bundle generation

## Required NAS-Side Access And Permissions

The MCP layer cannot reach the target state without these NAS API permissions and mounts.

### Host execution level

- root-equivalent read access on the NAS host
- controlled root-equivalent write access for approved actions

### Required host mounts

At minimum, mount these into the NAS API container:

- `/etc`
- `/run`
- `/var/log`
- `/var/packages`
- `/usr/syno`
- `/proc`
- `/sys`
- `/dev`
- `/volume1`
- `/volume2` and any other active volumes
- encrypted mount targets if present
- Docker socket if container diagnostics and control remain in scope

### Required utilities on the NAS API image

- `sqlite3`
- `smartctl`
- `mdadm`
- `btrfs`
- `findmnt`
- `getfacl`
- `setfacl`
- `lsof`
- `ss`
- `iotop`
- `stat`
- `sha256sum`
- `tar`
- `journalctl` only if available in the environment

### Required Synology CLI access

- `synopkg`
- `synoshare`
- storage and RAID Synology CLIs already used in the repo
- snapshot/versioning-related CLIs where available
- ACL and privilege CLIs where available on DSM 7

### Logging prerequisites

If the operator wants to answer "who changed or broke this file?", the NASes must have enough logging enabled before the incident happens.

Enable and retain:

- DSM admin audit logs
- relevant file access audit logs
- SMB logs with username and client IP where possible
- NFS access logs where possible
- Synology Drive version/history retention
- Btrfs snapshots / retention
- package-specific logs under `/var/packages`

Without those, forensic attribution after the fact will often be probabilistic, not definitive.

## Safety Model

The current tier model is the right starting point. Expand it instead of bypassing it.

### Tier 1: Read-only

- no state changes
- no file mutation
- no package or daemon control
- no shell redirections that write

### Tier 2: Reversible service operations

- restart package/daemon
- reload config
- start scrub/test/background maintenance
- create snapshot before repair

### Tier 3: Path-scoped or config mutations

- rename/move/quarantine file
- repair ACL/ownership on a path
- edit sysctl or safe package config
- clear lock files
- trigger targeted package repair flow

### Tier 4: Destructive or high-risk

- delete file
- restore over existing path
- reinstall package
- rebuild DB
- rollback configuration

Tier 4 should require:

- explicit approval
- exact preview
- path or package scope
- immutable action log
- optional snapshot-before-change policy

## Implementation Plan

## Phase 1: Complete Read Coverage

### A. Add shared path and volume discovery

Add foundational read tools:

- `list_volumes`
- `list_shared_folders`
- `inspect_mounts`
- `inspect_encryption_state`

Why:

- removes `/volume1` assumptions
- lets all other tools resolve actual active storage roots

Implementation notes:

- centralize volume/share discovery in helper functions instead of embedding `/volume1` in many commands
- update existing Drive and backup tools to use discovered roots

### B. Add package and daemon internals

Add tools:

- `check_package_runtime`
- `tail_package_logs`
- `search_package_logs`
- `check_daemon_processes`
- `inspect_package_lockfiles`
- `inspect_crash_signals`

Coverage:

- `synologand`
- `invoked`
- `syncd`
- `cloud-control`
- Drive / ShareSync
- Hyper Backup
- scheduler

Purpose:

- diagnose the exact classes of failures already seen in production

### C. Add storage deep health

Add tools:

- `check_smart_detail`
- `check_scrub_status`
- `check_storage_pool_detail`
- `check_btrfs_detail`
- `check_disk_error_trends`
- `check_volume_quota_and_inode_pressure`

Purpose:

- distinguish app/package failure from lower-level disk, RAID, or filesystem instability

### D. Add richer network diagnostics

Add tools:

- `check_interface_flaps`
- `check_bond_health`
- `check_dns_and_gateway_health`
- `check_service_ports`
- `check_synology_drive_network`

Purpose:

- diagnose intermittent DSM API, ShareSync, and remote access failures

### E. Add file and permission forensics read tools

Add tools:

- `inspect_path_metadata`
- `inspect_path_acl`
- `inspect_effective_permissions`
- `find_recent_path_changes`
- `find_path_versions_and_snapshots`
- `search_file_access_audit`
- `search_smb_path_activity`
- `search_drive_path_activity`
- `hash_file`
- `compare_file_versions`

Inputs these tools should support:

- exact path
- share name
- username
- lookback window

### F. Add evidence collection tools

Add tools:

- `collect_incident_bundle`
- `fetch_log_file`
- `fetch_package_db`
- `fetch_support_artifacts`

Purpose:

- allow deeper offline analysis without raw shell scraping every time

## Phase 2: Controlled Remediation

Enable current write tools after review:

- `restart_monitor_agent`
- `stop_monitor_agent`
- `start_monitor_agent`
- `pull_monitor_agent`
- `build_monitor_agent`
- `restart_nas_api`
- `restart_synology_drive_server`
- `restart_synology_drive_sharesync`
- `restart_hyper_backup`
- `rename_file_to_old`
- `remove_invalid_chars`
- `trigger_sharesync_resync`

Then add new write tools:

- `set_vm_overcommit_memory`
- `persist_vm_overcommit_memory`
- `restart_synologand`
- `restart_invoked_related_services`
- `restart_scheduler_services`
- `clear_package_lockfiles`
- `repair_drive_db_permissions`
- `quarantine_path`
- `repair_path_ownership`
- `repair_path_acl`
- `create_prechange_snapshot`
- `start_btrfs_scrub`
- `start_smart_test`
- `restart_network_service_safe`

Notes:

- package/daemon restart tools should prefer package-aware control commands over blunt PID kills
- any path mutation must require an exact path, not a fuzzy filter

## Phase 3: Recovery And Restoration

Add tools:

- `list_snapshot_candidates`
- `restore_path_from_snapshot`
- `list_drive_version_history`
- `restore_file_version`
- `inspect_recycle_bin`
- `restore_from_recycle_bin`
- `generate_support_bundle`

Purpose:

- move from "diagnose and suggest" to "recover safely"

## Phase 4: Long-Running Task Orchestration

Add task-aware operations for:

- SMART extended tests
- RAID scrub
- Btrfs scrub
- package reindex / rebuild
- large ACL repair passes
- backup verification tasks

Implementation requirement:

- asynchronous task start + polling + final status fetch
- do not rely on a single 90-second shell response

## Exact Tool Additions

The following tool names are the recommended implementation inventory.

### New read tools

- `list_volumes`
- `list_shared_folders`
- `inspect_mounts`
- `inspect_encryption_state`
- `check_package_runtime`
- `tail_package_logs`
- `search_package_logs`
- `check_daemon_processes`
- `inspect_package_lockfiles`
- `inspect_crash_signals`
- `check_smart_detail`
- `check_scrub_status`
- `check_storage_pool_detail`
- `check_btrfs_detail`
- `check_disk_error_trends`
- `check_volume_quota_and_inode_pressure`
- `check_interface_flaps`
- `check_bond_health`
- `check_dns_and_gateway_health`
- `check_service_ports`
- `check_synology_drive_network`
- `inspect_path_metadata`
- `inspect_path_acl`
- `inspect_effective_permissions`
- `find_recent_path_changes`
- `find_path_versions_and_snapshots`
- `search_file_access_audit`
- `search_smb_path_activity`
- `search_drive_path_activity`
- `hash_file`
- `compare_file_versions`
- `collect_incident_bundle`
- `fetch_log_file`
- `fetch_package_db`
- `fetch_support_artifacts`

### New write tools

- `set_vm_overcommit_memory`
- `persist_vm_overcommit_memory`
- `restart_synologand`
- `restart_invoked_related_services`
- `restart_scheduler_services`
- `clear_package_lockfiles`
- `repair_drive_db_permissions`
- `quarantine_path`
- `repair_path_ownership`
- `repair_path_acl`
- `create_prechange_snapshot`
- `start_btrfs_scrub`
- `start_smart_test`
- `restart_network_service_safe`
- `list_snapshot_candidates`
- `restore_path_from_snapshot`
- `list_drive_version_history`
- `restore_file_version`
- `inspect_recycle_bin`
- `restore_from_recycle_bin`
- `generate_support_bundle`

## Repo Changes Required

### `apps/nas-mcp`

Update:

- [apps/nas-mcp/src/tool-definitions.ts](/worksp/monitor/app/apps/nas-mcp/src/tool-definitions.ts)
- [apps/nas-mcp/src/index.ts](/worksp/monitor/app/apps/nas-mcp/src/index.ts)
- [apps/nas-mcp/src/nas-client.ts](/worksp/monitor/app/apps/nas-mcp/src/nas-client.ts)
- [apps/nas-mcp/tools-config.json](/worksp/monitor/app/apps/nas-mcp/tools-config.json)
- [apps/nas-mcp/README.md](/worksp/monitor/app/apps/nas-mcp/README.md)

Recommended code changes:

- introduce helper builders for shared command fragments
- stop hardcoding `/volume1` where discovery is required
- add structured parameter schemas for path, username, share, package, and task identifiers
- add explicit "exact path required" validation for any mutating file tool
- add task start / poll abstraction for long-running actions

### NAS API side

This repo references a NAS API but does not include its server implementation. The following changes are required on the NAS API side as well:

- broaden validator allowlists for the new safe command set
- support path-scoped Tier 3 and Tier 4 approvals
- add asynchronous job execution for long tasks
- add artifact download support for fetched logs and support bundles
- add immutable audit logging for every approved write action

## Delivery Order

Recommended implementation sequence:

1. volume/share discovery and path abstraction
2. package/daemon internals
3. file/ACL forensic read tools
4. storage deep health
5. evidence export
6. enable current write tools after review
7. add sysctl / ACL / snapshot-safe repair tools
8. add long-running task orchestration
9. add restore/recovery tools

## Execution Backlog

### In Progress

- add foundational discovery tools to `apps/nas-mcp`
- enable those tools in `tools-config.json`
- document the new tool surface in the MCP README

### Next

- refactor existing path-sensitive tools to prefer discovered volumes and share paths
- add `tail_package_logs`, `search_package_logs`, and `check_package_runtime`
- add `inspect_path_metadata`, `inspect_path_acl`, and `inspect_effective_permissions`

### After That

- enable reviewed write tools one by one instead of bulk-enabling them
- add `set_vm_overcommit_memory` and `persist_vm_overcommit_memory`
- add snapshot-safe remediation primitives before file or ACL repair tools

### Verification Backlog

- verify discovery tools on both NASes against the real mounted volume layout
- verify share enumeration returns correct `path` values for every production share
- verify package log paths for Synology Drive, ShareSync, Hyper Backup, and logging services
- verify which ACL utilities and snapshot/versioning CLIs are actually available on DSM 7.3.2

## What The Main `synology-monitor` Stack Already Covers

The broader `synology-monitor` software already has meaningful telemetry and analysis coverage, but not the full capability target described here.

Implemented strengths:

- metrics, storage, process, disk I/O, network connection, service health, container status
- Drive / ShareSync telemetry
- security events
- backup and snapshot-related telemetry attempts
- issue grouping and AI analysis
- some NAS API-driven forensics in the web layer

Primary references:

- [AGENTS.md](/worksp/monitor/app/AGENTS.md)
- [apps/agent/internal/collector](/worksp/monitor/app/apps/agent/internal/collector)
- [apps/web/src/lib/server/log-analyzer.ts](/worksp/monitor/app/apps/web/src/lib/server/log-analyzer.ts)
- [apps/web/src/lib/server/forensics-drive.ts](/worksp/monitor/app/apps/web/src/lib/server/forensics-drive.ts)
- [apps/web/src/lib/server/forensics-hyperbackup.ts](/worksp/monitor/app/apps/web/src/lib/server/forensics-hyperbackup.ts)

Known gaps in the main stack relative to the full target:

- incomplete DSM API support for scheduled tasks and snapshot replication
- some collectors are implemented but not fully verified live
- file-level permission forensics are not complete
- actor attribution for "who changed this file" is limited by available logs
- no complete snapshot / version / recycle-bin recovery plane
- no full ACL repair and permission remediation workflows
- no complete package-daemon remediation surface across DSM internals
- no universal multi-volume forensic model

Conclusion:

The main `synology-monitor` platform is already stronger on telemetry and issue correlation than the current MCP server, but it does not yet have all capabilities required to diagnose and remediate every relevant Synology problem end to end.

## Acceptance Criteria

This expansion should be considered complete only when:

- all required read tools are implemented and documented
- all required mounts and utilities are present on both NASes
- current write tools are reviewed and enabled intentionally
- new remediation tools exist for the known production issue classes
- at least one end-to-end test exists for:
  - Drive / ShareSync fault
  - permission denial on a file path
  - storage degradation warning
  - backup cleanup failure
  - user-attribution forensic request
- operator-visible docs clearly distinguish:
  - implemented in code
  - verified live on the NASes
  - blocked by DSM limitations
