# AI Infrastructure & Environment Guide
## For AI agents, new developers, and new coding sessions working on Albert's stack

**READ THIS FIRST before touching any code, database, or server.**
This document tells you exactly how to access every live environment, database, and log across all of Albert's applications. It is the single source of truth.

---

## The Stack at a Glance

| App | URL | Where it runs | Database |
|---|---|---|---|
| OpenClaw | claw.designflow.app | Coolify VPS (Docker) | None — flat files |
| Mission Control | mc.designflow.app | Coolify VPS (Docker) | None |
| Twenty CRM | (internal) | Coolify VPS (Docker) | Internal Postgres |
| Synology Monitor | mon.designflow.app | Coolify VPS (Docker) | Supabase (SynoMon) |
| popdam | (Lovable cloud) | Lovable.dev — NOT on VPS | Supabase (popdam-prod) |
| plane-integrations | (Cloudflare) | Cloudflare Worker | Cloudflare D1 |

---

## MCP Servers Available in Roo Code

Five MCP servers are configured. **DevOps and Architect modes have access to all of them. Builder and Reviewer-Pusher do not.**

| MCP name | What it connects to |
|---|---|
| `coolify-server` | SSH shell on the VPS — logs, env vars, files for ALL Docker apps |
| `twenty-crm-postgres` | Direct SQL into Twenty CRM's Postgres DB (needs tunnel — see below) |
| `supabase` | Supabase API — covers SynoMon and popdam-prod projects |
| `cloudflare` | Cloudflare account — Worker, D1 database, R2 buckets |
| `github` | GitHub API — all repos under u2giants and popcre orgs |

---

## Before You Start: The SSH Tunnel

The Twenty CRM Postgres lives inside Docker's private network and cannot be reached directly. A tunnel must be running on the Windows dev machine before any session that touches the Twenty database.

**Start it:** Double-click `C:\Users\ahazan2\.roo-mcp\start_tunnels.bat`
**Or manually:** `node C:\Users\ahazan2\.roo-mcp\tunnel_twenty_pg.js`
**What it does:** Forwards `localhost:15432` → Twenty's Postgres container on the VPS
**You don't need this for:** OpenClaw, Mission Control, Synology Monitor, popdam, or Cloudflare

The SSH alias `coolify` is configured in `C:\Users\ahazan2\.ssh\config` → `root@178.156.180.212` using `id_ed25519`. No password.

---

## Application Reference

---

### OpenClaw — `claw.designflow.app`

An AI agent gateway. Stores all state in flat files inside a Docker volume. No database whatsoever. No Supabase project.

**MCP:** `coolify-server` only

**Container:** `openclaw-yxz0hmaien0bgn0sv64g8q3p-044544225829`

**Logs:**
```bash
ssh coolify "docker logs openclaw-yxz0hmaien0bgn0sv64g8q3p-044544225829 --tail 100"
ssh coolify "docker exec openclaw-yxz0hmaien0bgn0sv64g8q3p-044544225829 cat /data/.openclaw/gateway.log"
```

**Environment / config:**
```bash
ssh coolify "docker exec openclaw-yxz0hmaien0bgn0sv64g8q3p-044544225829 env"
```

**Key env vars:**
- `OPENCLAW_PRIMARY_MODEL` — active AI model
- `OPENROUTER_API_KEY` — OpenRouter
- `ANTHROPIC_API_KEY` — Anthropic
- `OPENCLAW_GATEWAY_TOKEN` — gateway auth (`Albert2026Token`)
- `PAPERCLIP_API_URL` — connection to Mission Control
- `BROWSER_CDP_URL` — connected browser instance

**State files (the "database"):**
```bash
# Main config
ssh coolify "docker exec openclaw-yxz0hmaien0bgn0sv64g8q3p-044544225829 cat /data/.openclaw/openclaw.json"
# Active device pairings
ssh coolify "docker exec openclaw-yxz0hmaien0bgn0sv64g8q3p-044544225829 cat /data/.openclaw/devices/paired.json"
# Agent sessions
ssh coolify "docker exec openclaw-yxz0hmaien0bgn0sv64g8q3p-044544225829 ls /data/.openclaw/agents/main/sessions/"
# Workspace markdown files (AGENTS.md, SOUL.md, etc.)
ssh coolify "docker exec openclaw-yxz0hmaien0bgn0sv64g8q3p-044544225829 ls /data/workspace/"
ssh coolify "docker exec openclaw-yxz0hmaien0bgn0sv64g8q3p-044544225829 cat /data/workspace/AGENTS.md"
```

---

### Mission Control / Paperclip — `mc.designflow.app`

Internal dashboard. No database. Talks to OpenClaw via WebSocket. Auth via Google OAuth.

**MCP:** `coolify-server` only

**Container:** `paperclip-jihoc2f68xmgi2gfomhhr9g3-052451089218`

**Logs:**
```bash
ssh coolify "docker logs paperclip-jihoc2f68xmgi2gfomhhr9g3-052451089218 --tail 100"
```

**Environment:**
```bash
ssh coolify "docker exec paperclip-jihoc2f68xmgi2gfomhhr9g3-052451089218 env"
```

**Key env vars:**
- `OPENCLAW_GATEWAY_URL` — `wss://claw.designflow.app`
- `OPENCLAW_GATEWAY_TOKEN` — shared auth token
- `BETTER_AUTH_SECRET` — session secret
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — OAuth
- `COOLIFY_TOKEN` — Coolify API token
- `GITHUB_TOKEN` — GitHub PAT

---

### Twenty CRM — POP Creations CRM

Self-hosted Twenty CRM. Internal Postgres + Redis, both in Docker.

**MCPs:** `coolify-server` (logs/env) + `twenty-crm-postgres` (database)

**Containers:**
```
pkhhmt4r7n0xt25jmmlkkfi8-125130450026   Twenty app worker 1
rd261bt0wy7ifjrkoe1tkl92-125130345971   Twenty app worker 2
g5j115bwrn8125ev6ap1tjrv               Postgres 16
jht51gt0biykivnama17crlt               Redis 7 (cache only)
```

**Logs:**
```bash
ssh coolify "docker logs pkhhmt4r7n0xt25jmmlkkfi8-125130450026 --tail 100"
ssh coolify "docker logs rd261bt0wy7ifjrkoe1tkl92-125130345971 --tail 100"
```

**Environment:**
```bash
ssh coolify "docker exec pkhhmt4r7n0xt25jmmlkkfi8-125130450026 env"
```

**Database via `twenty-crm-postgres` MCP** (start tunnel first):
```sql
-- List all tables
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' ORDER BY table_name;

-- Inspect a table
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'person' ORDER BY ordinal_position;
```

**Database via SSH directly** (no tunnel needed):
```bash
ssh coolify "docker exec g5j115bwrn8125ev6ap1tjrv psql -U twenty -d twenty -c '\dt'"
ssh coolify "docker exec g5j115bwrn8125ev6ap1tjrv psql -U twenty -d twenty -c 'SELECT count(*) FROM person;'"
```

---

### Synology Monitor — `mon.designflow.app`

AI-powered NAS monitoring dashboard. App runs in Docker on the VPS. All data in Supabase.

**MCPs:** `coolify-server` (logs/env) + `supabase` (database)

**Container:** `lrddgp8im0276gllujfu7wm3-010449503799`

**Supabase project:** `SynoMon` — ID: `qnjimovrsaacneqkggsn`

**Logs:**
```bash
ssh coolify "docker logs lrddgp8im0276gllujfu7wm3-010449503799 --tail 100"
```

**Environment:**
```bash
ssh coolify "docker exec lrddgp8im0276gllujfu7wm3-010449503799 env"
```

**Key env vars:**
- `NEXT_PUBLIC_SUPABASE_URL` — `https://qnjimovrsaacneqkggsn.supabase.co`
- `NAS_EDGE1_HOST` / `NAS_EDGE2_HOST` — Tailscale IPs of the two Synology NAS units
- `CRON_SECRET` — cron job auth

**Database via `supabase` MCP:**
```
list_tables(project_id="qnjimovrsaacneqkggsn")
execute_sql(project_id="qnjimovrsaacneqkggsn", query="SELECT * FROM ...")
get_logs(project_id="qnjimovrsaacneqkggsn", service="api")
list_migrations(project_id="qnjimovrsaacneqkggsn")
```

---

### popdam — Lovable.dev cloud

**NOT on the VPS.** Hosted entirely on Lovable's infrastructure. No SSH access, no Docker, no container to inspect. Supabase is the only window into it.

**MCP:** `supabase` only

**Supabase project:** `popdam-prod` — ID: `ryltkzzernhwnojzouyb`

**Database via `supabase` MCP:**
```
list_tables(project_id="ryltkzzernhwnojzouyb")
execute_sql(project_id="ryltkzzernhwnojzouyb", query="SELECT * FROM ...")
get_logs(project_id="ryltkzzernhwnojzouyb", service="api")
```

---

### Cloudflare — plane-integrations Worker + ClickUp Events

A Cloudflare Worker that listens for ClickUp webhooks, verifies HMAC signatures, and stores every task event into a D1 database.

**MCP:** `cloudflare`

**Cloudflare account ID:** `8303d11002766bf1cc36bf2f07ba6f20`

**Resources:**
- **Worker:** `plane-integrations` — `POST /clickup/webhook`, `GET /health`
- **D1 database:** `clickup-events` (ID: `c37aeb36-e16e-416b-b699-c910f6f8dc10`)
  - Table `events` columns: `event_type`, `task_id`, `list_id`, `workspace_id`, `payload`, `user_id`, `user_name`, `field_changed`, `from_value`, `to_value`, `space_id`
- **R2 buckets:** `pop-seafile-blocks`, `pop-seafile-commits`, `pop-seafile-fs` — Seafile file server object storage, not app data

**Query ClickUp events via `cloudflare` MCP:**
```
d1_database_query(
  database_id="c37aeb36-e16e-416b-b699-c910f6f8dc10",
  query="SELECT * FROM events ORDER BY rowid DESC LIMIT 20"
)

-- Filter by task
d1_database_query(
  database_id="c37aeb36-e16e-416b-b699-c910f6f8dc10",
  query="SELECT task_id, user_name, field_changed, from_value, to_value FROM events WHERE task_id = '...' ORDER BY rowid DESC"
)

-- Recent status changes only
d1_database_query(
  database_id="c37aeb36-e16e-416b-b699-c910f6f8dc10",
  query="SELECT task_id, user_name, from_value, to_value FROM events WHERE field_changed = 'status' ORDER BY rowid DESC LIMIT 50"
)
```

**View Worker source code:**
```
workers_get_worker_code(scriptName="plane-integrations")
```

---

### GitHub — `github` MCP

Access to all repos across both orgs.

**Orgs:** `u2giants` (public + private repos), `popcre` (all private)

**Useful operations:**
```
search_repositories(query="org:u2giants")
search_repositories(query="org:popcre")
get_file_contents(owner="u2giants", repo="openclaw", path="README.md")
list_commits(owner="u2giants", repo="openclaw", sha="main")
list_issues(owner="u2giants", repo="openclaw", state="open")
list_pull_requests(owner="popcre", repo="designflow-backend", state="open")
```

---

## Quick Reference

| Problem you're solving | MCP to reach for | Command/call pattern |
|---|---|---|
| App throwing errors right now | `coolify-server` | `ssh coolify "docker logs <container> --tail 200"` |
| What config is the app using? | `coolify-server` | `ssh coolify "docker exec <container> env"` |
| Is a container running or dead? | `coolify-server` | `ssh coolify "docker ps"` |
| Restart a crashed container | `coolify-server` | `ssh coolify "docker restart <container>"` |
| Twenty CRM database schema/data | `twenty-crm-postgres` | SQL query (start tunnel first) |
| Synology Monitor database | `supabase` | `execute_sql(project_id="qnjimovrsaacneqkggsn", ...)` |
| popdam database | `supabase` | `execute_sql(project_id="ryltkzzernhwnojzouyb", ...)` |
| ClickUp task event history | `cloudflare` | `d1_database_query(database_id="c37aeb36...", ...)` |
| Debug Cloudflare Worker | `cloudflare` | `workers_get_worker_code(scriptName="plane-integrations")` |
| Browse source code or PRs | `github` | `list_commits(...)` / `list_pull_requests(...)` |
| OpenClaw state / config files | `coolify-server` | `ssh coolify "docker exec openclaw-... cat /data/.openclaw/openclaw.json"` |

---

## Roo Mode Permissions

| Mode | MCP access | Reason |
|---|---|---|
| 🧠 Orchestrator | No | Plans and delegates only |
| 🛠️ Builder | No | Code files only — no live environment access by design |
| ⚙️ DevOps | **Yes — all MCPs** | Needs full access to deploy, debug, query |
| 📐 Architect | **Yes — all MCPs** | Needs to inspect live environment before designing |
| 🔍 Reviewer-Pusher | No | Reviews diffs only |

---

## Critical Rules

- **Always start `start_tunnels.bat`** before any session touching the Twenty CRM database.
- **OpenClaw has no database** — its entire persistent state is flat files in `/data/.openclaw/` inside the container.
- **popdam is not on the VPS** — there is no SSH or Docker access to it, ever.
- **Secrets in `docker exec ... env` are real production secrets.** Never log, commit, or share them publicly.
- The `coolify-server` MCP runs commands on your local Windows machine via the `coolify` SSH alias. If SSH isn't working, check `C:\Users\ahazan2\.ssh\config` and that `id_ed25519` key is present.

---

## devops-mcp — VPS Access for Claude Desktop (Cowork)

This section covers how Claude desktop (Cowork mode) connects to the VPS. It replaces the old `coolify-server` SSH pattern for AI-driven devops tasks.

### What changed

The stack now includes a dedicated MCP server (`devops-mcp`) running as a Docker container on the VPS, accessible over HTTPS via Cloudflare Tunnel. Claude desktop connects to it using the `mcp-remote` npm package — no SSH, no local tunnel, no `.bat` files required.

| Old approach | New approach |
|---|---|
| `coolify-server` MCP → SSH → VPS | `devops-mcp` MCP → HTTPS → Cloudflare Tunnel → VPS container |
| Required SSH key on dev machine | Bearer token only |
| Roo Code / Windsurf only | Claude desktop (Cowork) + Roo Code + Windsurf |

### devops-mcp endpoints

| URL | Auth | What it does |
|---|---|---|
| `https://mcp.designflow.app/` | None | HTML status page — registered agents, audit activity, tool list |
| `https://mcp.designflow.app/mcp` | Bearer token | MCP Streamable HTTP endpoint — all AI clients POST JSON-RPC here |

### How Claude desktop connects on Windows

Two entries in `%APPDATA%\Claude\claude_desktop_config.json`:

```json
"devops-mcp": {
  "command": "C:\\PROGRA~1\\nodejs\\npx.cmd",
  "args": [
    "-y", "mcp-remote@latest",
    "https://mcp.designflow.app/mcp",
    "--transport", "http",
    "--header", "Authorization: Bearer <TOKEN_ROOCODE value from Coolify>"
  ]
},
"synology-monitor": {
  "command": "C:\\PROGRA~1\\nodejs\\npx.cmd",
  "args": [
    "-y", "mcp-remote@latest",
    "https://nas-mcp.designflow.app/sse",
    "--header", "Authorization: Bearer <NAS bearer token>"
  ]
}
```

The `--transport http` flag is required for devops-mcp (Streamable HTTP). The synology-monitor uses SSE and does not need that flag.

**Replicating on a new Windows PC:** There is a PowerShell script that safely merges these entries into an existing config without overwriting anything. See [devops-mcp docs/claude-desktop-setup.md](https://github.com/u2giants/devops-mcp/blob/main/docs/claude-desktop-setup.md).

### devops-mcp tools available in Claude

| Tool | What it does |
|---|---|
| `run_command` | Run any shell command on the VPS host |
| `read_file` / `write_file` | Read or write any file on the VPS |
| `list_directory` | Browse the VPS filesystem |
| `docker_ps` / `docker_logs` / `docker_action` | Manage containers |
| `service_status` / `service_action` | Manage systemd services |
| `view_audit_log` | See a log of every tool call made by every agent |
| `health` | Server info and registered agent list |

### Authentication

Each AI agent has its own bearer token set in Coolify as `TOKEN_<NAME>`. The Claude desktop token is `TOKEN_ROOCODE`. To add a new agent: add `TOKEN_<NAME>=<secret>` in Coolify → Environment Variables → Save → Restart.

### Audit log

Every tool call is logged to a persistent Docker volume. Each line is JSON:

```json
{"ts": "2026-04-22T06:00:00Z", "agent": "roocode", "tool": "run_command", "args": {"command": "docker ps"}, "ok": true, "duration_ms": 111}
```

Ask Claude: *"show me the last 50 audit log entries"* to see recent activity.
