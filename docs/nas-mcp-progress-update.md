# NAS MCP Progress Update

## Session Summary

This session focused on:

1. assessing whether the current NAS MCP server exposes enough data and control to fully diagnose and remediate Synology issues
2. writing an implementation-ready expansion plan
3. starting Phase 1 foundation work in `apps/nas-mcp`

## Conclusions Reached

### NAS MCP server

The current NAS MCP server is useful for first-pass diagnosis, but it does **not** expose all data, logs, permissions, or remediation actions needed to fully handle:

- DSM package/runtime failures
- Synology Drive / ShareSync failures
- system daemon issues such as `synologand` / `invoked`
- permission and ACL investigations
- file actor attribution
- snapshot / version / recycle-bin recovery
- safe remediation across all major Synology fault domains

### Main `synology-monitor` platform

The broader platform is stronger than the MCP server on telemetry and issue grouping, but it also does **not** yet provide the full target capability set.

It already has strong collection for:

- metrics
- storage
- process snapshots
- disk I/O
- network connections
- service health
- Drive / ShareSync telemetry
- security events
- issue grouping and AI analysis

It still lacks full end-to-end coverage for:

- ACL and permission forensics
- definitive file actor attribution
- complete snapshot/version/recovery workflows
- fully verified scheduled-task and snapshot-replication collection
- full DSM package/daemon remediation coverage

## Documents Added / Updated

### Added

- [docs/nas-mcp-capability-expansion-plan.md](/worksp/monitor/app/docs/nas-mcp-capability-expansion-plan.md)

This document contains:

- target capability model
- required mounts, permissions, utilities, and logging prerequisites
- safety model
- exact new read/write tool inventory
- repo changes required
- recommended delivery order
- execution backlog

### Added

- [docs/nas-mcp-progress-update.md](/worksp/monitor/app/docs/nas-mcp-progress-update.md)

This file is the handoff for the next session.

## Code Changes Completed

### `apps/nas-mcp/src/tool-definitions.ts`

Added these new read tools:

- `list_volumes`
- `list_shared_folders`
- `inspect_mounts`
- `inspect_encryption_state`

Purpose:

- remove blind `/volume1` assumptions
- discover actual live storage layout before path-sensitive diagnosis
- map DSM share names to real filesystem paths
- show mount topology and surface missing/unmounted share paths

### `apps/nas-mcp/tools-config.json`

Enabled the new read tools so they are part of the active MCP surface.

### `apps/nas-mcp/README.md`

Updated the documented read tool list and added a recommended starting sequence for path-sensitive incidents:

1. `list_volumes`
2. `list_shared_folders`
3. `inspect_mounts`
4. the specific package/log/file tool needed after discovery

## Verification Completed

Completed:

- confirmed `tools-config.json` still parses as valid JSON
- confirmed new tool names appear in:
  - `tool-definitions.ts`
  - `tools-config.json`
  - `README.md`
  - `nas-mcp-capability-expansion-plan.md`

Not completed:

- no live execution of the new MCP tools on the actual NASes yet
- no redeploy of the NAS MCP service yet
- no refactor of existing `/volume1`-specific tools yet

## Current Execution State

The implementation backlog has been written into:

- [docs/nas-mcp-capability-expansion-plan.md](/worksp/monitor/app/docs/nas-mcp-capability-expansion-plan.md)

The backlog sections currently include:

- in progress work
- next block
- later remediation work
- verification backlog

## Recommended Next Step

Continue with the next Phase 1 block:

1. refactor existing path-sensitive tools to prefer discovered volumes and share paths
2. add package-runtime and package-log tools:
   - `tail_package_logs`
   - `search_package_logs`
   - `check_package_runtime`
3. add permission/ACL forensic read tools:
   - `inspect_path_metadata`
   - `inspect_path_acl`
   - `inspect_effective_permissions`

## Specific Files To Continue Editing

- [apps/nas-mcp/src/tool-definitions.ts](/worksp/monitor/app/apps/nas-mcp/src/tool-definitions.ts)
- [apps/nas-mcp/tools-config.json](/worksp/monitor/app/apps/nas-mcp/tools-config.json)
- [apps/nas-mcp/README.md](/worksp/monitor/app/apps/nas-mcp/README.md)
- [docs/nas-mcp-capability-expansion-plan.md](/worksp/monitor/app/docs/nas-mcp-capability-expansion-plan.md)

## Important Repo Context

There is already unrelated work in the repo. At the time of this session, `git status` showed existing modified and untracked files outside `apps/nas-mcp`. Those were not touched except for the new MCP plan/progress docs and the MCP files changed above.

## Files Changed This Session

- [apps/nas-mcp/src/tool-definitions.ts](/worksp/monitor/app/apps/nas-mcp/src/tool-definitions.ts)
- [apps/nas-mcp/tools-config.json](/worksp/monitor/app/apps/nas-mcp/tools-config.json)
- [apps/nas-mcp/README.md](/worksp/monitor/app/apps/nas-mcp/README.md)
- [docs/nas-mcp-capability-expansion-plan.md](/worksp/monitor/app/docs/nas-mcp-capability-expansion-plan.md)
- [docs/nas-mcp-progress-update.md](/worksp/monitor/app/docs/nas-mcp-progress-update.md)

