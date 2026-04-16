# Roo Code MCP Server Guide
## How AI Modes Access the Live Server, Databases, and Logs

This document is written for any new developer or Claude coding session working on Albert's POP Creations / Dflow infrastructure. Read this before touching anything on the server or in the databases.

---

## The Big Picture

All production apps (except popdam) run on a single Coolify-managed VPS at **178.156.180.212**. Coolify wraps everything in Docker containers — you never interact with Docker directly through Coolify's UI. Instead, all live server access goes through SSH.

Six MCP servers give Roo Code modes direct access to the live environment:

| MCP Name | What It Does | Use It For |
|---|---|---|
| `coolify-server` | SSH shell into the VPS, run any docker command | Logs, env vars, file inspection — ALL VPS apps |
| `twenty-crm-postgres` | Direct SQL access to Twenty CRM's Postgres DB | Twenty CRM database queries |
| `supabase` | Full Supabase API access | Synology Monitor DB, popdam DB |
| `cloudflare` | Cloudflare account — Workers, D1, R2 | plane-integrations worker, ClickUp events DB, Seafile storage |
| `github` | GitHub API access | Repo browsing, issues, PRs, commits across all u2giants repos |
| `nas-mcp` | Direct NAS diagnostic tools over MCP/SSE | Disk, I/O, Drive logs, kernel errors, backup status on edgesynology1 + 2 |

---

## Prerequisites Before Starting Any Session

### The SSH Tunnel (required for Twenty CRM database only)
The Twenty CRM Postgres database lives inside Docker's private network. To reach it, a tunnel must be running on your Windows machine.

**Start it by double-clicking:**
```
C:\Users\ahazan2\.roo-mcp\start_tunnels.bat
```
Or run manually:
```
node C:\Users\ahazan2\.roo-mcp\tunnel_twenty_pg.js
```
This opens `localhost:15432` as a pass-through to the Twenty Postgres container. Leave it running in the background. You do NOT need this for any other app.

### SSH Config
The SSH alias `coolify` is already configured in `C:\Users\ahazan2\.ssh\config`. It points to `root@178.156.180.212` using the `id_ed25519` key. No password needed. Every `ssh coolify "..."` command in this guide uses that alias.

---

## Application-by-Application Reference

---

### 1. OpenClaw (`claw.designflow.app`)

**What it is:** An AI agent gateway. No traditional database — state is stored in flat files inside a Docker volume at `/data/.openclaw/` inside the container.

**Container name:**
```
openclaw-yxz0hmaien0bgn0sv64g8q3p-044544225829
```

**MCP to use:** `coolify-server`

**How to read logs:**
```bash
ssh coolify "docker logs openclaw-yxz0hmaien0bgn0sv64g8q3p-044544225829 --tail 100"
ssh coolify "docker exec openclaw-yxz0hmaien0bgn0sv64g8q3p-044544225829 cat /data/.openclaw/gateway.log"
```

**How to inspect environment (API keys, config):**
```bash
ssh coolify "docker exec openclaw-yxz0hmaien0bgn0sv64g8q3p-044544225829 env"
```

**Key env vars:**
- `OPENCLAW_PRIMARY_MODEL` — which AI model is active
- `OPENROUTER_API_KEY` — OpenRouter key
- `ANTHROPIC_API_KEY` — Anthropic key
- `OPENCLAW_GATEWAY_TOKEN` — auth token for gateway access (`Albert2026Token`)
- `PAPERCLIP_API_URL` — how OpenClaw talks to Mission Control
- `BROWSER_CDP_URL` — connected browser instance

**How to inspect state files:**
```bash
ssh coolify "docker exec openclaw-yxz0hmaien0bgn0sv64g8q3p-044544225829 cat /data/.openclaw/openclaw.json"
ssh coolify "docker exec openclaw-yxz0hmaien0bgn0sv64g8q3p-044544225829 ls /data/.openclaw/agents/main/sessions/"
ssh coolify "docker exec openclaw-yxz0hmaien0bgn0sv64g8q3p-044544225829 cat /data/.openclaw/devices/paired.json"
```

**How to inspect the workspace (markdown config files inside OpenClaw):**
```bash
ssh coolify "docker exec openclaw-yxz0hmaien0bgn0sv64g8q3p-044544225829 cat /data/workspace/AGENTS.md"
ssh coolify "docker exec openclaw-yxz0hmaien0bgn0sv64g8q3p-044544225829 ls /data/workspace/"
```

**There is NO database. There is NO Supabase project for OpenClaw.** All persistent data is files in the Docker volume.

---

### 2. Mission Control / Paperclip (`mc.designflow.app`)

**What it is:** An internal dashboard/control panel (Paperclip). No database of its own — communicates with OpenClaw via WebSocket and uses Google OAuth for auth.

**Container name:**
```
paperclip-jihoc2f68xmgi2gfomhhr9g3-052451089218
```

**MCP to use:** `coolify-server`

**How to read logs:**
```bash
ssh coolify "docker logs paperclip-jihoc2f68xmgi2gfomhhr9g3-052451089218 --tail 100"
```

**How to inspect environment:**
```bash
ssh coolify "docker exec paperclip-jihoc2f68xmgi2gfomhhr9g3-052451089218 env"
```

**Key env vars:**
- `PAPERCLIP_PUBLIC_URL` — public URL (`https://mc.designflow.app`)
- `OPENCLAW_GATEWAY_URL` — WebSocket connection to OpenClaw (`wss://claw.designflow.app`)
- `OPENCLAW_GATEWAY_TOKEN` — shared auth token
- `BETTER_AUTH_SECRET` — session auth secret
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — Google OAuth credentials
- `COOLIFY_TOKEN` — Coolify API token (for deployment automation)
- `GITHUB_TOKEN` — GitHub personal access token

**There is NO database for this app.**

---

### 3. Twenty CRM / POP Creations CRM

**What it is:** A self-hosted Twenty CRM instance. Has its own Postgres database and Redis cache running in Docker.

**Container names:**
```
pkhhmt4r7n0xt25jmmlkkfi8-125130450026   (Twenty app worker 1)
rd261bt0wy7ifjrkoe1tkl92-125130345971   (Twenty app worker 2)
g5j115bwrn8125ev6ap1tjrv               (Postgres 16 database)
jht51gt0biykivnama17crlt               (Redis 7 cache)
```

**MCP to use:** `coolify-server` for logs/env + `twenty-crm-postgres` for database queries

**How to read logs:**
```bash
ssh coolify "docker logs pkhhmt4r7n0xt25jmmlkkfi8-125130450026 --tail 100"
ssh coolify "docker logs rd261bt0wy7ifjrkoe1tkl92-125130345971 --tail 100"
```

**How to inspect environment:**
```bash
ssh coolify "docker exec pkhhmt4r7n0xt25jmmlkkfi8-125130450026 env"
```

**Key env var:** `PG_DATABASE_URL` = `postgres://twenty:TwentyDB2026!SecurePass@g5j115bwrn8125ev6ap1tjrv:5432/twenty`

**How to query the database via `twenty-crm-postgres` MCP:**

⚠️ **Start `start_tunnels.bat` first.** The MCP connects to `localhost:15432` which the tunnel forwards to the container.

```sql
-- List all tables
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;

-- Inspect a table's columns
SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'person' ORDER BY ordinal_position;

-- Count records
SELECT count(*) FROM "person";
```

**How to query via SSH directly (alternative, no tunnel needed):**
```bash
ssh coolify "docker exec g5j115bwrn8125ev6ap1tjrv psql -U twenty -d twenty -c '\dt'"
ssh coolify "docker exec g5j115bwrn8125ev6ap1tjrv psql -U twenty -d twenty -c 'SELECT count(*) FROM person;'"
```

---

### 4. Synology Monitor (`mon.designflow.app`)

**What it is:** An AI-powered NAS monitoring dashboard. App runs in Docker on the VPS but stores all its data in external Supabase.

**Container name:**
```
lrddgp8im0276gllujfu7wm3-010449503799
```

**Supabase project:** `SynoMon` — ID: `qnjimovrsaacneqkggsn`

**MCP to use:** `coolify-server` for logs/env + `supabase` for database

**How to read logs:**
```bash
ssh coolify "docker logs lrddgp8im0276gllujfu7wm3-010449503799 --tail 100"
```

**How to inspect environment:**
```bash
ssh coolify "docker exec lrddgp8im0276gllujfu7wm3-010449503799 env"
```

**Key env vars:**
- `NEXT_PUBLIC_SUPABASE_URL` — `https://qnjimovrsaacneqkggsn.supabase.co`
- `NAS_EDGE1_HOST` / `NAS_EDGE2_HOST` — Tailscale IPs of the two Synology NAS devices
- `OPENAI_API_KEY` — for AI features
- `CRON_SECRET` — cron job auth token

**How to query the database via `supabase` MCP:**
```
list_tables(project_id="qnjimovrsaacneqkggsn")
execute_sql(project_id="qnjimovrsaacneqkggsn", query="SELECT * FROM ...")
get_logs(project_id="qnjimovrsaacneqkggsn", service="api")
list_migrations(project_id="qnjimovrsaacneqkggsn")
```

---

### 5. popdam (hosted on Lovable.dev — NOT on the VPS)

**What it is:** A separate app hosted entirely on Lovable's cloud. Does NOT run on the Coolify VPS. No Docker container, no SSH access possible.

**Supabase project:** `popdam-prod` — ID: `ryltkzzernhwnojzouyb`

**MCP to use:** `supabase` only — no shell/log access exists since it runs on Lovable's infrastructure.

**How to query the database via `supabase` MCP:**
```
list_tables(project_id="ryltkzzernhwnojzouyb")
execute_sql(project_id="ryltkzzernhwnojzouyb", query="SELECT * FROM ...")
get_logs(project_id="ryltkzzernhwnojzouyb", service="api")
```

---

### 6. Cloudflare — plane-integrations Worker + ClickUp Events

**What it is:** A Cloudflare Worker (`plane-integrations`) that listens for ClickUp webhooks, verifies HMAC signatures, and stores every task event (status changes, assignee changes, field updates, etc.) into a Cloudflare D1 database (`clickup-events`). This is how ClickUp activity gets captured for reporting or automation.

**Cloudflare account ID:** `8303d11002766bf1cc36bf2f07ba6f20`

**Resources:**
- **Worker:** `plane-integrations` — endpoint at `/clickup/webhook` (POST), health check at `/health` (GET)
- **D1 database:** `clickup-events` (ID: `c37aeb36-e16e-416b-b699-c910f6f8dc10`) — table `events` with columns: `event_type`, `task_id`, `list_id`, `workspace_id`, `payload`, `user_id`, `user_name`, `field_changed`, `from_value`, `to_value`, `space_id`
- **R2 buckets:** `pop-seafile-blocks`, `pop-seafile-commits`, `pop-seafile-fs` — these are object storage for a Seafile file sync server (not related to app code)

**MCP to use:** `cloudflare`

**How to query ClickUp events via `cloudflare` MCP:**
```
d1_database_query(
  database_id="c37aeb36-e16e-416b-b699-c910f6f8dc10",
  query="SELECT * FROM events ORDER BY rowid DESC LIMIT 20"
)

-- Filter by task
d1_database_query(
  database_id="c37aeb36-e16e-416b-b699-c910f6f8dc10",
  query="SELECT * FROM events WHERE task_id = '...' ORDER BY rowid DESC"
)

-- See recent status changes
d1_database_query(
  database_id="c37aeb36-e16e-416b-b699-c910f6f8dc10",
  query="SELECT task_id, user_name, from_value, to_value FROM events WHERE field_changed = 'status' ORDER BY rowid DESC LIMIT 50"
)
```

**How to view Worker code:**
```
workers_get_worker_code(scriptName="plane-integrations")
```

**How to check Worker logs:**
```
workers_get_worker(scriptName="plane-integrations")
```

---

### 7. GitHub (`github` MCP)

**What it is:** Access to all repos under the `u2giants` GitHub org.

**MCP to use:** `github`

**Useful operations:**
```
search_repositories(query="org:u2giants")
get_file_contents(owner="u2giants", repo="<repo>", path="<file>")
list_commits(owner="u2giants", repo="<repo>", sha="main")
list_issues(owner="u2giants", repo="<repo>", state="open")
list_pull_requests(owner="u2giants", repo="<repo>", state="open")
```

---

## Quick Reference: Which MCP for What Problem

| Problem | MCP | Example |
|---|---|---|
| App is throwing errors — see logs | `coolify-server` | `ssh coolify "docker logs <container> --tail 200"` |
| What config/API keys is an app using? | `coolify-server` | `ssh coolify "docker exec <container> env"` |
| Is a container running or crashed? | `coolify-server` | `ssh coolify "docker ps"` |
| Restart a crashed container | `coolify-server` | `ssh coolify "docker restart <container>"` |
| Query Twenty CRM database | `twenty-crm-postgres` | SQL query (start tunnel first) |
| Query Synology Monitor database | `supabase` | `execute_sql(project_id="qnjimovrsaacneqkggsn", ...)` |
| Query popdam database | `supabase` | `execute_sql(project_id="ryltkzzernhwnojzouyb", ...)` |
| See recent ClickUp task events | `cloudflare` | `d1_database_query(database_id="c37aeb36...", ...)` |
| Debug the plane-integrations worker | `cloudflare` | `workers_get_worker_code(scriptName="plane-integrations")` |
| Browse source code / PRs / issues | `github` | `list_commits(owner="u2giants", repo="...")` |
| DNS or domain routing issue | `cloudflare` | search zones, check tunnel config |
| OpenClaw state files / config | `coolify-server` | `ssh coolify "docker exec openclaw-... cat /data/.openclaw/openclaw.json"` |

---

## Which Roo Modes Can Use Which MCPs

| Mode | Can use MCPs? | Notes |
|---|---|---|
| 🧠 Orchestrator | No | Plans and delegates only |
| 🛠️ Builder | No | Code files only — no live environment access by design |
| ⚙️ DevOps | **Yes** | Full access to all MCPs |
| 📐 Architect | **Yes** | Full access to all MCPs (read/inspect only by convention) |
| 🔍 Reviewer-Pusher | No | Reviews diffs only |

---

## NAS MCP Server

**URL:** `https://nas-mcp.designflow.app/sse`  
**Transport:** SSE (Server-Sent Events)  
**Auth:** Bearer token in `Authorization` header  
**Bearer token:** `14cde11e584136b15306c03d160ce9536da4f87f82d74c6d728a6c8cb6dd2122`

**MCP client config (for Claude Code / Roo Code):**
```json
{
  "nas-mcp": {
    "url": "https://nas-mcp.designflow.app/sse",
    "type": "sse",
    "headers": {
      "Authorization": "Bearer 14cde11e584136b15306c03d160ce9536da4f87f82d74c6d728a6c8cb6dd2122"
    }
  }
}
```

**Available read tools (run automatically, no approval needed):**
`check_disk_space`, `check_cpu_iowait`, `check_agent_container`, `get_resource_snapshot`, `check_io_stalls`, `tail_drive_server_log`, `search_drive_server_log`, `tail_sharesync_log`, `check_sharesync_status`, `check_kernel_io_errors`, `check_share_database`, `check_drive_package_health`, `check_drive_database`, `search_webapi_log`, `search_all_logs`, `find_problematic_files`, `check_filesystem_health`, `check_scheduled_tasks`, `check_backup_status`, `check_container_io`, `run_command`

**Write tools (approval required before execution):**
None enabled by default. To enable: add tool names to `enabled_write_tools` in `apps/nas-mcp/tools-config.json` and push to GitHub.

**Available write tools (disabled by default):**
`restart_monitor_agent`, `stop_monitor_agent`, `start_monitor_agent`, `pull_monitor_agent`, `build_monitor_agent`, `restart_synology_drive_server`, `restart_synology_drive_sharesync`, `rename_file_to_old`, `remove_invalid_chars`, `trigger_sharesync_resync`

**Coolify management:**
- Image: `ghcr.io/u2giants/synology-monitor-nas-mcp:latest`
- Coolify app UUID: `efl17f5iocnz94840pexre9d`
- Project: Synology Monitor → production
- Auto-deploys when `apps/nas-mcp/**` changes are pushed to `master`

---

## Important Notes

- **Start `start_tunnels.bat`** before any session that touches the Twenty CRM database.
- The `coolify-server` MCP runs shell commands on your **Windows machine** and reaches the VPS via the `coolify` SSH alias in `C:\Users\ahazan2\.ssh\config`.
- Secrets visible in `docker exec ... env` are real production secrets. Never log, commit, or expose them publicly.
- **popdam** is on Lovable's cloud — there is no SSH, no Docker, no container to inspect. Supabase is the only window into it.
- **OpenClaw has no database** — its entire persistent state is flat files in a Docker volume at `/data/.openclaw/`.
