# NAS MCP Server

Exposes Synology NAS diagnostic + remediation tools to AI chat clients (claude.ai, Claude Desktop) via the Model Context Protocol over Streamable HTTP at `/mcp`. Legacy SSE remains served at `/sse`.

## Connection

| | |
|---|---|
| **URL** | `https://nas-mcp.designflow.app/mcp` |
| **Transport** | Streamable HTTP |
| **Legacy URL** | `https://nas-mcp.designflow.app/sse` |
| **Legacy transport** | SSE (still served, but prefer `/mcp`) |
| **Auth** | `Authorization: Bearer <MCP_BEARER_TOKEN>` |

Claude Desktop / claude.ai client config:

```json
{
  "nas-mcp": {
    "url": "https://nas-mcp.designflow.app/mcp",
    "type": "streamable-http",
    "headers": { "Authorization": "Bearer <MCP_BEARER_TOKEN>" }
  }
}
```

**After any redeploy** (Coolify restarts the container), all in-memory MCP sessions are gone. Existing conversations holding a `mcp-session-id` will see a 404. Start a new conversation to get a fresh session.

## Tool surface — lazy-loaded registry

The server has a registry of 108 tool definitions but exposes only **5 tools** to MCP clients per session. This keeps the always-loaded `tools/list` surface at ~3k tokens (vs ~50k if all 108 were registered upfront).

| Always-on tool | Purpose |
|---|---|
| `tool_search({ query, limit })` | Search the registry by keyword. Returns names, descriptions, and parameter shapes as text. **Call this first** to discover the right tool. |
| `invoke_tool({ name, target, args })` | Execute any registry tool by name. For write tools, include `confirmed: true` inside `args`. |
| `run_command({ target, command })` | Free-form tier-1-only shell. Write commands are blocked by the NAS API validator. |
| `check_disk_space({ target })` | Eager freebie — disk + inode usage across volumes. |
| `restart_nas_api({ target, confirmed })` | Eager freebie — recovery tool, always available. |

### Typical flow

```text
tool_search({ query: "snapshot recovery" })
  → returns: list_snapshot_candidates, create_prechange_snapshot,
             restore_path_from_snapshot, inspect_recycle_bin, ...

invoke_tool({
  name: "list_snapshot_candidates",
  target: "edgesynology1",
  args: { filter: "drive" }
})
```

### Search keywords + groups

`tool_search` matches against:
- **Keyword index** (`KEYWORD_TO_GROUPS` in `src/tool-definitions.ts`): `snapshot`, `backup`, `drive`, `sync`, `sharesync`, `disk`, `smart`, `btrfs`, `scrub`, `network`, `tailscale`, `bond`, `dns`, `memory`, `cpu`, `performance`, `iowait`, `log`, `package`, `restart`, `file`, `permission`, `acl`, `delete`, `recover`, `recycle`, `security`, `session`, `temperature`, `volume`, `space`, `audit`, `task`, `scheduled`
- **Group names**: `system`, `performance`, `network`, `security`, `drive_sync`, `logs`, `storage`, `files`, `recovery`, `packages`, `backup`, `write_restart`, `write_storage`, `write_files`, `write_tasks`, `misc`
- **Name substring** of any tool in the registry
- **Description substring** of any tool

Multi-word queries require a tool to match **all** words (AND, not OR). When a query word is an exact group name (e.g. `files`, `recovery`), only tools in that group are returned — description matches for that word are suppressed. For all other words, tools in KEYWORD_TO_GROUPS-mapped groups plus name/description substring matches qualify. Survivors are scored: name match +3, description match +1 per word; sorted descending then alphabetically. Default `limit: 8`, max 30.

### Why lazy-load, why not dynamic registration

MCP supports `notifications/tools/list_changed`, but Claude clients cache the initial `tools/list` and do not re-fetch on the notification. So `tool_search` cannot register new tools mid-session. Returning schemas as text (which Claude then uses to construct an `invoke_tool` call) is the only mechanism that actually delivers the context savings on real clients.

The server is also fully stateless (no `mcp-session-id`), so any dynamic registration would be discarded at the end of the request anyway.

## NAS targets

Every registry tool accepts a `target`:

| Value | Meaning |
|---|---|
| `edgesynology1` | Run on NAS 1 only |
| `edgesynology2` | Run on NAS 2 only |
| `both` | Run on both NAS boxes in parallel |

When `both` is used, results are labeled `[edgesynology1]` / `[edgesynology2]`. On a loaded NAS, prefer targeting a single NAS to avoid the 45s tool deadline being reached while waiting for the slow side.

## Tool tiers and approval

Enforced by the NAS API:

| Tier | Type | Approval |
|---|---|---|
| 1 | Read-only diagnostic | Automatic |
| 2 | State-modifying (reversible) | `confirmed: true` inside `args` |
| 3 | Destructive / irreversible | `confirmed: true` + HMAC-signed token (issued by the MCP server) |

Calling `invoke_tool` on a write tool without `confirmed: true` returns a preview of the exact shell command that would run, prefixed with the NAS name. Re-call with `confirmed: true` to execute.

## Timeout architecture

Three layers protect against NAS-side hangs:

| Layer | Timeout | What it does |
|---|---|---|
| `/preview` HTTP abort | 8s | Aborts the tier-classification call |
| `/exec` HTTP abort | 25s command + 5s buffer = 30s | Aborts the execution call; sends `timeout_ms: 25000` to nas-api so it kills the subprocess first |
| Tool deadline | 45s | If both NASes stall, the MCP tool returns a clear error at 45s rather than holding the connection until Claude's 4-minute client timeout |

HTTP client uses `AbortController` + `setTimeout` (not `AbortSignal.timeout()`) and sets `Connection: close` to prevent undici keep-alive pool exhaustion.

The Node HTTP server has `keepAliveTimeout: 120s` / `headersTimeout: 125s` — above Traefik's 90s idle — so Traefik never reuses a connection Node has already closed.

## Enabling / disabling tools

`tools-config.json` controls which registry tools are invokable:

```json
{
  "enabled_read_tools":  [ "check_disk_space", "check_btrfs_detail", ... ],
  "enabled_write_tools": [ "restart_monitor_agent", "start_btrfs_scrub", ... ]
}
```

Tools in the registry but not listed are compiled into the image but invisible to `tool_search` and rejected by `invoke_tool` with a "disabled in tools-config.json" message. This lets you ship a tool dark and enable it without a code deploy — edit the JSON and push.

Changes take effect on the next image build (push to `main` → GitHub Actions → Coolify redeploy).

## Registry catalog (108 tools)

The lists below describe what's in `ALL_TOOL_DEFS` for discovery purposes. All are invoked via `invoke_tool({ name, target, args })`, except `check_disk_space` / `restart_nas_api` / `run_command` which are also directly callable as always-on tools.

### Group `system` (11)

| Tool | What it does |
|---|---|
| `check_system_info` | DSM version, NAS model, uptime, CPU, memory — baseline context |
| `check_disk_space` | Disk + inode usage for all active volumes (also always-on) |
| `check_hardware_temps` | CPU/chassis temperatures, fan speeds, SMART disk temperatures |
| `check_volume_health` | DSM RAID/volume health, mdstat, SMART |
| `check_packages` | All installed DSM packages, running status, recent events |
| `check_scheduled_tasks` | All DSM scheduled tasks and last run result |
| `list_volumes` | Active data volumes + filesystem usage |
| `list_shared_folders` | Share names → real filesystem paths |
| `inspect_mounts` | Live mount graph for data, package, and bind mounts |
| `inspect_encryption_state` | Whether volumes/share paths are mounted + visible |
| `check_agent_container` | Whether the monitor agent container is running |

### Group `performance` (5)

| Tool | What it does |
|---|---|
| `check_cpu_iowait` | CPU I/O wait % |
| `get_resource_snapshot` | Full live picture: top processes, disk I/O, connections, memory, recent errors |
| `check_io_stalls` | Processes stuck on disk, queue depth, hung-task warnings |
| `check_memory_detail` | Full meminfo, swap activity, dirty/writeback, OOM kills |
| `check_container_io` | Docker containers doing the most disk I/O |

### Group `network` (8)

| Tool | What it does |
|---|---|
| `check_network_health` | Interface errors/drops, routing, DNS, listening ports |
| `check_tailscale` | Tailscale interface state, IP, daemon reachability |
| `check_network_connections` | Active TCP per process, state counts, top peers |
| `check_interface_flaps` | Carrier change counts, error counters |
| `check_bond_health` | Bond/LACP state, slaves, mode |
| `check_dns_and_gateway_health` | DNS tests, gateway ping, nameserver config |
| `check_service_ports` | Listener state + connection count for key Synology ports |
| `check_synology_drive_network` | Drive port 6690 listener, connections by client, recent net errors |

### Group `security` (2)

| Tool | What it does |
|---|---|
| `check_security_log` | Failed logins, security events, admin audit, SSH |
| `check_active_sessions` | Current SMB, NFS, SSH, DSM web, Drive sessions |

### Group `drive_sync` (9)

| Tool | What it does |
|---|---|
| `tail_drive_server_log` | Recent Synology Drive server log entries |
| `search_drive_server_log` | Search Drive logs for a keyword or share name |
| `tail_sharesync_log` | Recent ShareSync log entries across all volumes |
| `check_sharesync_status` | Stuck, conflicted, or erroring ShareSync tasks |
| `check_drive_package_health` | Drive package installation integrity across volumes |
| `check_drive_database` | Drive internal DB corruption check across volumes |
| `check_share_database` | Shared folder list from DSM DB — failures = corruption |
| `search_webapi_log` | DSM WebAPI logs for share access + auth errors |
| `search_drive_path_activity` | Drive + ShareSync logs for activity on a path/user |

### Group `logs` (7)

| Tool | What it does |
|---|---|
| `tail_system_log` | Recent `/var/log/messages` |
| `tail_package_logs` | Recent logs for a named package from all known locations |
| `search_package_logs` | Search all log files for a named package + filter term |
| `search_all_logs` | Search every log file on the NAS for a phrase |
| `fetch_log_file` | Content of a specific log file; lists available logs if no path |
| `fetch_support_artifacts` | DSM support bundles, large log files, package log dirs, core dumps |
| `check_kernel_io_errors` | Kernel log for disk errors, SCSI faults, filesystem corruption |

### Group `storage` (8)

| Tool | What it does |
|---|---|
| `check_scrub_status` | Btrfs scrub status + RAID sync from mdstat |
| `check_storage_pool_detail` | Detailed RAID array state, degraded arrays, rebuild progress |
| `check_btrfs_detail` | Btrfs filesystem usage, device error counters, balance status, subvolumes |
| `check_disk_error_trends` | Compact SMART error table |
| `check_volume_quota_and_inode_pressure` | Inode + Btrfs qgroup quota state |
| `check_smart_detail` | Full SMART attributes, error log, self-test history per disk |
| `check_filesystem_health` | Mount status, inode usage, RAID, SMART across all volumes |
| `check_smart_test_progress` | In-progress SMART self-test % + ETA |

### Group `files` (11)

| Tool | What it does |
|---|---|
| `inspect_path_metadata` | POSIX metadata: owner, group, mode, size, inode, timestamps |
| `inspect_path_acl` | POSIX + Synology ACL entries (`getfacl` + `synoacltool`) |
| `inspect_effective_permissions` | Effective access on a path with per-user + share-level check |
| `find_recent_path_changes` | Files modified within lookback hours under a path, sorted by mtime |
| `find_path_versions_and_snapshots` | Btrfs snapshots, recycle bin, Drive version hints for a path |
| `search_file_access_audit` | DSM file-access audit log (grep-based, raw log files) |
| `search_file_access_log` | DSM Log Center file-access log via authenticated WebAPI (`SYNO.Core.Log.Center`) — filters by path / date / action / limit |
| `search_smb_path_activity` | Samba/SMB logs for activity on a path / share / user |
| `search_drive_path_activity` | Drive + ShareSync logs for activity on a path / user |
| `hash_file` | SHA-256 + MD5 hashes + timestamps |
| `compare_file_versions` | Compare two file paths by metadata, hashes, optional text diff |
| `find_problematic_files` | Files with sync-breaking names (special chars, conflicts, long names) |

### Group `recovery` (5)

| Tool | What it does |
|---|---|
| `list_snapshot_candidates` | Btrfs snapshots with path, creation time, size |
| `list_drive_version_history` | Drive-managed version history for a file path |
| `inspect_recycle_bin` | Recent files in share recycle bins across volumes |
| `fetch_package_db` | Query a package SQLite DB — list tables or run a SQL query |
| `collect_incident_bundle` | Targeted diagnostic snapshot: drive, storage, network, permission, crash |

### Group `packages` (4)

| Tool | What it does |
|---|---|
| `check_package_runtime` | Named package runtime: status, PID files, locks, matching processes |
| `check_daemon_processes` | Key daemons: `synologand`, `invoked`, `syncd`, Drive server, … |
| `inspect_package_lockfiles` | Stale lock files across packages |
| `inspect_crash_signals` | Crash evidence: segfaults, OOM kills, core dumps, DSM error log |

### Group `backup` (1)

| Tool | What it does |
|---|---|
| `check_backup_status` | Hyper Backup package state, task list, and recent log entries. Discovery-driven: enumerates every candidate log path (DSM 6, DSM 7, package-scoped, per-task target dirs), picks the freshest by mtime, filters tail by date cutoff, prints a staleness banner. Tolerates the case where the canonical log path is stale or empty. |

### Group `write_restart` (14)

`restart_monitor_agent`, `stop_monitor_agent`, `start_monitor_agent`, `pull_monitor_agent`, `build_monitor_agent`, `restart_nas_api` (also always-on), `restart_synology_drive_server`, `restart_synology_drive_sharesync`, `restart_hyper_backup`, `restart_synologand`, `restart_invoked_related_services`, `restart_scheduler_services`, `restart_network_service_safe`, `trigger_sharesync_resync`

### Group `write_storage` (7)

`start_btrfs_scrub`, `cancel_btrfs_scrub`, `start_smart_test`, `cancel_smart_test`, `create_prechange_snapshot`, `set_vm_overcommit_memory`, `persist_vm_overcommit_memory`

### Group `write_files` (9)

`rename_file_to_old`, `remove_invalid_chars`, `clear_package_lockfiles`, `repair_drive_db_permissions`, `quarantine_path`, `repair_path_ownership`, `repair_path_acl`, `restore_path_from_snapshot`, `restore_from_recycle_bin`

### Group `write_tasks` (5)

`generate_support_bundle`, `trigger_backup_task`, `run_scheduled_task`, `enable_scheduled_task`, `disable_scheduled_task`

### Group `misc` (2 — untagged, still searchable)

`kill_process`, `run_privileged_command`. These have intentionally narrow scope and fall through to "misc" via the substring + name fallback in `searchTools`.

## Deployment

Standard CI/CD path (see [AI_OPERATING_RULES.md](../../AI_OPERATING_RULES.md)):

- Push to `main` with changes under `apps/nas-mcp/**`
- `.github/workflows/nas-mcp-image.yml` builds and pushes `ghcr.io/u2giants/synology-monitor-nas-mcp:latest`
- Coolify auto-deploys (app UUID `efl17f5iocnz94840pexre9d`, project Synology Monitor → production)

## Environment variables (set in Coolify)

| Variable | Purpose |
|---|---|
| `MCP_PORT` | Port the server listens on (default `3001`) |
| `MCP_BEARER_TOKEN` | Auth token required by all MCP clients |
| `NAS_EDGE1_NAME` | Logical name for NAS 1 (default `edgesynology1`) |
| `NAS_EDGE1_API_URL` | HTTP URL of NAS 1 API (`http://100.107.131.35:7734`) |
| `NAS_EDGE1_API_SECRET` | Bearer secret for NAS 1 API |
| `NAS_EDGE1_API_SIGNING_KEY` | HMAC key for tier 2/3 approval tokens on NAS 1 |
| `NAS_EDGE2_NAME` | Logical name for NAS 2 (default `edgesynology2`) |
| `NAS_EDGE2_API_URL` | HTTP URL of NAS 2 API (`http://100.107.131.36:7734`) |
| `NAS_EDGE2_API_SECRET` | Bearer secret for NAS 2 API |
| `NAS_EDGE2_API_SIGNING_KEY` | HMAC key for tier 2/3 approval tokens on NAS 2 |

## Adding a tool

1. Add a new `McpToolDef` entry to `ALL_TOOL_DEFS` in `src/tool-definitions.ts`.
2. Tag it: add `<tool_name>: "<group>"` to `TOOL_GROUPS` in the same file. (Skipping this is allowed — it falls into `"misc"` and startup logs a warning.)
3. Enable it: add the name to `enabled_read_tools` or `enabled_write_tools` in `tools-config.json`.
4. `pnpm build` to type-check locally.
5. Push to `main`. No changes to `index.ts` needed unless the tool should be eagerly registered (in which case add it to `EAGER_TOOLS`).
