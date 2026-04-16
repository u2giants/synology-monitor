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

| Tool | What it does |
|---|---|
| `check_disk_space` | Disk usage on /volume1 |
| `check_cpu_iowait` | CPU I/O wait percentage |
| `check_agent_container` | Whether the monitor agent container is running |
| `get_resource_snapshot` | Full live picture: top processes, disk I/O, connections, memory, recent errors |
| `check_io_stalls` | Processes stuck on disk, queue depth, hung task warnings |
| `tail_drive_server_log` | Recent Synology Drive server log entries |
| `search_drive_server_log` | Search Drive logs for a keyword or share name |
| `tail_sharesync_log` | Recent ShareSync log entries |
| `check_sharesync_status` | Stuck, conflicted, or erroring ShareSync tasks |
| `check_kernel_io_errors` | Kernel log for disk errors, SCSI faults, filesystem corruption |
| `check_share_database` | Shared folder list from DSM database |
| `check_drive_package_health` | Synology Drive package installation integrity |
| `check_drive_database` | Synology Drive internal database corruption check |
| `search_webapi_log` | DSM WebAPI logs for share access and auth errors |
| `search_all_logs` | Search every log file on the NAS for a phrase |
| `find_problematic_files` | Files with names that break ShareSync (special chars, conflicts, long names) |
| `check_filesystem_health` | Mount status, inode usage, RAID status, SMART health |
| `check_scheduled_tasks` | All DSM scheduled tasks and last run result |
| `check_backup_status` | Hyper Backup status and recent log entries |
| `check_container_io` | Docker containers doing the most disk I/O |
| `run_command` | Any read-only shell command (write commands are blocked by the NAS API) |

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
