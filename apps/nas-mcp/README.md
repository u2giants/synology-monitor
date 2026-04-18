# NAS MCP Server

Exposes Synology NAS diagnostic tools to AI agents via the Model Context Protocol (MCP) over SSE.

## Connection

| | |
|---|---|
| **URL** | `https://nas-mcp.designflow.app/sse` |
| **Transport** | SSE (Server-Sent Events) |
| **Auth** | `Authorization: Bearer <token>` |

Bearer token is stored as `MCP_BEARER_TOKEN` in Coolify's runtime environment for this service.

**MCP client config:**
```json
{
  "nas-mcp": {
    "url": "https://nas-mcp.designflow.app/sse",
    "type": "sse",
    "headers": {
      "Authorization": "Bearer <MCP_BEARER_TOKEN>"
    }
  }
}
```

## NAS targets

Every tool accepts a `target` parameter:

| Value | Meaning |
|---|---|
| `edgesynology1` | Run on NAS 1 only |
| `edgesynology2` | Run on NAS 2 only |
| `both` | Run on both NAS boxes in parallel (default) |

When `both` is used, results are returned labeled `[edgesynology1]` and `[edgesynology2]`.

## Tool tiers and approval

The NAS API enforces a three-tier command classification:

| Tier | Type | Approval |
|---|---|---|
| 1 | Read-only diagnostic | Runs automatically |
| 2 | State-modifying (reversible) | Requires explicit `confirmed: true` |
| 3 | Destructive / irreversible | Requires explicit `confirmed: true` + HMAC-signed token |

Write tools always show a preview of the exact command before executing. Set `confirmed: true` only after reviewing the preview.

## Enabling/disabling tools

`tools-config.json` controls which tools are active. Changes take effect after a push to `master` (GitHub Actions rebuilds the image, Coolify redeploys).

```json
{
  "enabled_read_tools": ["check_disk_space", "..."],
  "enabled_write_tools": []
}
```

To enable a write tool: add its name to `enabled_write_tools` and push.

## Available read tools

### Storage and volume discovery

| Tool | What it does |
|---|---|
| `list_volumes` | Discover active data volumes and their filesystem usage |
| `list_shared_folders` | Map DSM share names to real filesystem paths |
| `inspect_mounts` | Show the live mount graph for data, package, and bind mounts |
| `inspect_encryption_state` | Check whether volumes and share paths appear mounted and visible |
| `check_disk_space` | Disk and inode usage for all active data volumes |
| `check_filesystem_health` | Mount status, inode usage, RAID status, SMART health across all volumes |
| `check_volume_health` | DSM-layer RAID/volume health (synovolumestatus, synoarraystatus), mdstat, SMART |

### System health

| Tool | What it does |
|---|---|
| `check_system_info` | DSM version, NAS model, uptime, CPU, memory — baseline context |
| `check_cpu_iowait` | CPU I/O wait percentage |
| `check_io_stalls` | Processes stuck on disk, queue depth, hung task warnings |
| `check_memory_detail` | Full meminfo, swap activity, dirty/writeback pages, OOM kills |
| `check_hardware_temps` | CPU/chassis temperatures, fan speeds, SMART disk temperatures |
| `get_resource_snapshot` | Full live picture: top processes, disk I/O, connections, memory, recent errors |
| `check_kernel_io_errors` | Kernel log for disk errors, SCSI faults, filesystem corruption |

### Package and daemon internals

| Tool | What it does |
|---|---|
| `check_packages` | All installed DSM packages, running status, recent package events |
| `check_package_runtime` | Named package runtime state: status, PID files, lock files, matching processes |
| `check_daemon_processes` | Key daemon state: synologand, invoked, syncd, cloud-control, syno_drive_server |
| `inspect_package_lockfiles` | Stale lock files across all packages and runtime dirs |
| `inspect_crash_signals` | Crash evidence: segfaults, OOM kills, core dumps, DSM error log |
| `tail_package_logs` | Recent logs for a named package from all known log locations |
| `search_package_logs` | Search all log files for a named package and a filter term |
| `check_scheduled_tasks` | All DSM scheduled tasks and last run result |

### Synology Drive and ShareSync

| Tool | What it does |
|---|---|
| `check_drive_package_health` | Synology Drive package installation integrity across all volumes |
| `check_drive_database` | Synology Drive internal database corruption check across all volumes |
| `tail_drive_server_log` | Recent Synology Drive server log entries |
| `search_drive_server_log` | Search Drive logs for a keyword or share name |
| `tail_sharesync_log` | Recent ShareSync log entries across all volumes |
| `check_sharesync_status` | Stuck, conflicted, or erroring ShareSync tasks |
| `find_problematic_files` | Files with names that break ShareSync (special chars, conflicts, long names) |

### File and permission forensics

| Tool | What it does |
|---|---|
| `inspect_path_metadata` | POSIX metadata for an exact path: owner, group, mode, size, inode, timestamps |
| `inspect_path_acl` | POSIX and Synology ACL entries for an exact path (getfacl + synoacltool) |
| `inspect_effective_permissions` | Effective access on a path with optional per-user group and share-level check |

### Network

| Tool | What it does |
|---|---|
| `check_network_health` | Interface errors/drops, routing table, DNS resolution, listening ports |
| `check_network_connections` | Active TCP connections per process, state counts, top peers |
| `check_tailscale` | Tailscale VPN status — interface state, IP, daemon reachability |
| `check_active_sessions` | Currently active SMB, NFS, SSH, DSM web, and Drive sessions |

### Logs and search

| Tool | What it does |
|---|---|
| `tail_system_log` | Recent /var/log/messages — general kernel and service events |
| `check_security_log` | Failed logins, security events, admin audit entries, SSH connections |
| `search_webapi_log` | DSM WebAPI logs for share access and auth errors |
| `search_all_logs` | Search every log file on the NAS for a phrase |
| `check_share_database` | Shared folder list from DSM database — failures indicate corruption |

### Backup and containers

| Tool | What it does |
|---|---|
| `check_backup_status` | Hyper Backup status and recent log entries across all volumes |
| `check_container_io` | Docker containers doing the most disk I/O |
| `check_agent_container` | Whether the monitor agent container is running |
| `run_command` | Any read-only shell command (write commands are blocked by the NAS API) |

Recommended starting sequence for path-sensitive incidents:

1. `list_volumes`
2. `list_shared_folders`
3. `inspect_mounts`
4. the specific package, log, or file diagnostic tool you actually need

## Available write tools (disabled by default)

| Tool | What it does |
|---|---|
| `restart_monitor_agent` | Restart the Synology Monitor agent container |
| `stop_monitor_agent` | Stop the agent |
| `start_monitor_agent` | Start the agent |
| `pull_monitor_agent` | Pull latest agent image |
| `build_monitor_agent` | Rebuild agent container |
| `restart_synology_drive_server` | Restart the Synology Drive package |
| `restart_synology_drive_sharesync` | Restart ShareSync |
| `rename_file_to_old` | Rename a problem file by appending `.old` |
| `remove_invalid_chars` | Remove sync-breaking characters from a filename |
| `trigger_sharesync_resync` | Force a ShareSync re-sync |

## Deployment

Follows the standard CI/CD path (see [docs/ai-operating-rules.md](../../docs/ai-operating-rules.md)):

- Push to `master` with changes under `apps/nas-mcp/**`
- GitHub Actions builds and pushes `ghcr.io/u2giants/synology-monitor-nas-mcp:latest`
- Coolify auto-deploys (app UUID: `efl17f5iocnz94840pexre9d`, project: Synology Monitor → production)

## Environment variables (set in Coolify)

| Variable | Purpose |
|---|---|
| `MCP_PORT` | Port the server listens on (3001) |
| `MCP_BEARER_TOKEN` | Auth token required by all MCP clients |
| `NAS_EDGE1_NAME` | Logical name for NAS 1 (`edgesynology1`) |
| `NAS_EDGE1_API_URL` | HTTP URL of the NAS 1 API |
| `NAS_EDGE1_API_SECRET` | Bearer secret for NAS 1 API |
| `NAS_EDGE1_API_SIGNING_KEY` | HMAC key for tier 2/3 approval tokens on NAS 1 |
| `NAS_EDGE2_NAME` | Logical name for NAS 2 (`edgesynology2`) |
| `NAS_EDGE2_API_URL` | HTTP URL of the NAS 2 API |
| `NAS_EDGE2_API_SECRET` | Bearer secret for NAS 2 API |
| `NAS_EDGE2_API_SIGNING_KEY` | HMAC key for tier 2/3 approval tokens on NAS 2 |
