# NAS Relay

Public HTTPS bridge between external clients and the private NAS APIs.

## Purpose

- Keep each NAS API reachable only on the private Tailscale network
- Expose a narrow named-action surface on the VPS
- Let older Lovable-hosted frontend clients call named actions instead of raw shell
- Keep NAS API secrets out of the browser

The **web app and NAS MCP talk to the NAS APIs directly over Tailscale** — they do not go through the relay. The relay exists for external integrations and legacy clients.

## Endpoints

| Method | Path | Auth |
|--------|------|------|
| `GET` | `/health` | None |
| `GET` | `/catalog` | Bearer token |
| `POST` | `/actions/preview` | Bearer token |
| `POST` | `/actions/exec` | Bearer token (+ admin secret for writes) |

Public base URL: `https://mon.designflow.app/relay`

Local container: `http://127.0.0.1:8787`

## Authentication

- All requests: `Authorization: Bearer <RELAY_BEARER_TOKEN>`
- Write actions additionally: `X-Relay-Admin-Secret: <RELAY_ADMIN_SECRET>`

## Supported actions

**Read-only:** `check_disk_space`, `check_agent_container`, `check_cpu_iowait`, `tail_drive_server_log`, `search_drive_server_log`, `tail_sharesync_log`, `get_resource_snapshot`, `check_sharesync_status`, `check_io_stalls`, `check_share_database`, `check_drive_package_health`, `check_kernel_io_errors`, `search_webapi_log`, `check_drive_database`, `search_all_logs`, `find_problematic_files`, `check_filesystem_health`, `check_scheduled_tasks`, `check_backup_status`, `check_container_io`

**Write (requires admin secret):** `restart_monitor_agent`, `stop_monitor_agent`, `start_monitor_agent`, `pull_monitor_agent`, `build_monitor_agent`, `restart_synology_drive_server`, `restart_synology_drive_sharesync`

## Security model

Public callers submit named actions, not raw shell commands. Write actions require a second secret. The NAS API still enforces its own validator and approval-token logic as a second layer.

## Deployment

The relay is **not** built by the standard CI/CD pipeline (no GitHub Actions workflow exists for it). It runs as a Docker container on the VPS, deployed separately. See [OPERATIONS.md](OPERATIONS.md) for the run command and verification steps.

## Environment variables

```
PORT=8787
RELAY_ALLOWED_ORIGINS=<comma-separated allowed origins>
RELAY_BEARER_TOKEN=<public bearer token>
RELAY_ADMIN_SECRET=<write-action secret>
NAS_EDGE1_API_URL=http://100.107.131.35:7734
NAS_EDGE1_API_SECRET=<must match NAS .env NAS_API_SECRET>
NAS_EDGE1_API_SIGNING_KEY=<must match NAS .env NAS_API_APPROVAL_SIGNING_KEY>
NAS_EDGE2_API_URL=http://100.107.131.36:7734
NAS_EDGE2_API_SECRET=<same for NAS 2>
NAS_EDGE2_API_SIGNING_KEY=<same for NAS 2>
```

## Quick test

```bash
# Health
curl http://127.0.0.1:8787/health

# Catalog
curl -H "Authorization: Bearer $RELAY_BEARER_TOKEN" http://127.0.0.1:8787/catalog

# Preview a read action
curl -H "Authorization: Bearer $RELAY_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"target":"edgesynology1","action":"check_backup_status","input":{"lookbackHours":12}}' \
  http://127.0.0.1:8787/actions/preview

# Execute a read action
curl -H "Authorization: Bearer $RELAY_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"target":"edgesynology1","action":"check_disk_space"}' \
  http://127.0.0.1:8787/actions/exec

# Execute a write action
curl -H "Authorization: Bearer $RELAY_BEARER_TOKEN" \
  -H "X-Relay-Admin-Secret: $RELAY_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"target":"edgesynology1","action":"restart_monitor_agent"}' \
  http://127.0.0.1:8787/actions/exec
```
