# NAS Relay

This app is the public HTTPS relay that sits between a Lovable-hosted frontend and the private NAS APIs.

## Purpose

- Keep each NAS API reachable only on the private Tailscale network.
- Expose a much narrower public surface on the VPS.
- Let the frontend call named actions instead of arbitrary shell.
- Keep NAS secrets out of the browser.

## Current design

Flow:

1. The Lovable app calls the relay on the VPS.
2. The relay authenticates the request with a bearer token.
3. For write actions, the relay also requires a separate admin secret.
4. The relay converts the named action into a shell command.
5. The relay calls the private NAS API over Tailscale.
6. The NAS API still enforces its own validator and approval-token logic.

## Endpoints

- `GET /health`
- `GET /catalog`
- `POST /actions/preview`
- `POST /actions/exec`

Current public base URL on this VPS:

- `https://mon.designflow.app/relay`

## Authentication

- All requests require `Authorization: Bearer <RELAY_BEARER_TOKEN>`.
- Write actions also require `X-Relay-Admin-Secret: <RELAY_ADMIN_SECRET>`.

## Supported actions

Read-only:

- `check_disk_space`
- `check_agent_container`
- `check_cpu_iowait`
- `tail_drive_server_log`
- `search_drive_server_log`
- `tail_sharesync_log`
- `get_resource_snapshot`
- `check_sharesync_status`
- `check_io_stalls`
- `check_share_database`
- `check_drive_package_health`
- `check_kernel_io_errors`
- `search_webapi_log`
- `check_drive_database`
- `search_all_logs`
- `find_problematic_files`
- `check_filesystem_health`
- `check_scheduled_tasks`
- `check_backup_status`
- `check_container_io`

Write:

- `restart_monitor_agent`
- `stop_monitor_agent`
- `start_monitor_agent`
- `pull_monitor_agent`
- `build_monitor_agent`
- `restart_synology_drive_server`
- `restart_synology_drive_sharesync`

## Security model

The relay is intentionally narrower than the NAS API:

- public callers do not submit raw shell commands
- public callers can only choose from a named action catalog
- write actions require a second secret
- CORS can be restricted with `RELAY_ALLOWED_ORIGINS`

This does **not** remove the risk of the Docker socket on the NAS API side. It only reduces what the public relay can ask the NAS API to do.

## Files

- [src/server.mjs](/worksp/monitor/app/apps/relay/src/server.mjs:1)
- [Dockerfile](/worksp/monitor/app/apps/relay/Dockerfile:1)
- [.env.example](/worksp/monitor/app/apps/relay/.env.example:1)
