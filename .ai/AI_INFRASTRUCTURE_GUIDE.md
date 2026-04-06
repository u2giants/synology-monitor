# AI Infrastructure & Environment Guide
## For AI agents, new developers, and new coding sessions working on the u2giants stack

**READ THIS FIRST before touching any code, database, or server.**
This is the single source of truth for how to access every live environment, database, and log across all of Albert's applications.

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
| `twenty-crm-postgres` | Direct SQL into Twenty CRM Postgres DB (needs tunnel — see below) |
| `supabase` | Supabase API — covers SynoMon and popdam-prod projects |
| `cloudflare` | Cloudflare account — Worker, D1 database, R2 buckets |
| `github` | GitHub API — all repos under u2giants |

---

## Before You Start: The SSH Tunnel

The Twenty CRM Postgres lives inside Docker's private network and cannot be reached directly. A tunnel must be running on the Windows dev machine before any session that touches the Twenty database.

**Start it:** Double-click `C:\Users\ahazan2\.roo-mcp\start_tunnels.bat`
**Or manually:** `node C:\Users\ahazan2\.roo-mcp\tunnel_twenty_pg.js`
**What it does:** Forwards `localhost:15432` to the Twenty Postgres container on the VPS
**Not needed for:** OpenClaw, Mission Control, Synology Monitor, popdam, or Cloudflare

The SSH alias `coolify` is in `C:\Users\ahazan2\.ssh\config` pointing to `root@178.156.180.212` using `id_ed25519`. No password required.

---

## Application Reference

---

### OpenClaw — claw.designflow.app

AI agent gateway. Stores all state in flat files inside a Docker volume at `/data/.openclaw/`. No database. No Supabase project.

**MCP:** `coolify-server` only
**Container:** `openclaw-yxz0hmaien0bgn0sv64g8q3p-044544225829`

**Logs:**
```bash
ssh coolify "docker logs openclaw-yxz0hmaien0bgn0sv64g8q3p-044544225829 --tail 100"
ssh coolify "docker exec openclaw-yxz0hmaien0bgn0sv64g8q3p-044544225829 cat /data/.openclaw/gateway.log"
```

**Environment:**
```bash
ssh coolify "docker exec openclaw-yxz0hmaien0bgn0sv64g8q3p-044544225829 env"
```

Key env vars: `OPENCLAW_PRIMARY_MODEL`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENCLAW_GATEWAY_TOKEN` (Albert2026Token), `PAPERCLIP_API_URL`, `BROWSER_CDP_URL`

**State files (the "database"):**
```bash
ssh coolify "docker exec openclaw-yxz0hmaien0bgn0sv64g8q3p-044544225829 cat /data/.openclaw/openclaw.json"
ssh coolify "docker exec openclaw-yxz0hmaien0bgn0sv64g8q3p-044544225829 cat /data/.openclaw/devices/paired.json"
ssh coolify "docker exec openclaw-yxz0hmaien0bgn0sv64g8q3p-044544225829 ls /data/.openclaw/agents/main/sessions/"
ssh coolify "docker exec openclaw-yxz0hmaien0bgn0sv64g8q3p-044544225829 cat /data/workspace/AGENTS.md"
```

---

### Mission Control / Paperclip — mc.designflow.app

Internal dashboard. No database. WebSocket connection to OpenClaw. Google OAuth for auth.

**MCP:** `coolify-server` only
**Container:** `paperclip-jihoc2f68xmgi2gfomhhr9g3-052451089218`

```bash
ssh coolify "docker logs paperclip-jihoc2f68xmgi2gfomhhr9g3-052451089218 --tail 100"
ssh coolify "docker exec paperclip-jihoc2f68xmgi2gfomhhr9g3-052451089218 env"
```

Key env vars: `OPENCLAW_GATEWAY_URL` (wss://claw.designflow.app), `OPENCLAW_GATEWAY_TOKEN`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `COOLIFY_TOKEN`, `GITHUB_TOKEN`

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

```bash
ssh coolify "docker logs pkhhmt4r7n0xt25jmmlkkfi8-125130450026 --tail 100"
ssh coolify "docker exec pkhhmt4r7n0xt25jmmlkkfi8-125130450026 env"
```

**Database via `twenty-crm-postgres` MCP** (start tunnel first):
```sql
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;
SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'person' ORDER BY ordinal_position;
```

**Database via SSH directly** (no tunnel needed):
```bash
ssh coolify "docker exec g5j115bwrn8125ev6ap1tjrv psql -U twenty -d twenty -c '\dt'"
ssh coolify "docker exec g5j115bwrn8125ev6ap1tjrv psql -U twenty -d twenty -c 'SELECT count(*) FROM person;'"
```

---

### Synology Monitor — mon.designflow.app

AI-powered NAS monitoring dashboard. App runs in Docker on the VPS. All data in Supabase.

**MCPs:** `coolify-server` (logs/env) + `supabase` (database)
**Container:** `lrddgp8im0276gllujfu7wm3-010449503799`
**Supabase project:** SynoMon — ID: `qnjimovrsaacneqkggsn`

```bash
ssh coolify "docker logs lrddgp8im0276gllujfu7wm3-010449503799 --tail 100"
ssh coolify "docker exec lrddgp8im0276gllujfu7wm3-010449503799 env"
```

Key env vars: `NEXT_PUBLIC_SUPABASE_URL` (https://qnjimovrsaacneqkggsn.supabase.co), `NAS_EDGE1_HOST`, `NAS_EDGE2_HOST`, `CRON_SECRET`

**Database via `supabase` MCP:**
```
list_tables(project_id="qnjimovrsaacneqkggsn")
execute_sql(project_id="qnjimovrsaacneqkggsn", query="SELECT * FROM ...")
get_logs(project_id="qnjimovrsaacneqkggsn", service="api")
```

---

### popdam — Lovable.dev cloud

NOT on the VPS. Hosted entirely on Lovable's infrastructure. No SSH, no Docker. Supabase is the only access point.

**MCP:** `supabase` only
**Supabase project:** popdam-prod — ID: `ryltkzzernhwnojzouyb`

```
list_tables(project_id="ryltkzzernhwnojzouyb")
execute_sql(project_id="ryltkzzernhwnojzouyb", query="SELECT * FROM ...")
get_logs(project_id="ryltkzzernhwnojzouyb", service="api")
```

---

### Cloudflare — plane-integrations Worker + ClickUp Events

A Cloudflare Worker that receives ClickUp webhooks, verifies HMAC signatures, and writes every task event into a D1 database.

**MCP:** `cloudflare`
**Account ID:** `8303d11002766bf1cc36bf2f07ba6f20`

Resources:
- **Worker:** `plane-integrations` — `POST /clickup/webhook`, `GET /health`
- **D1 database:** `clickup-events` (ID: `c37aeb36-e16e-416b-b699-c910f6f8dc10`)
  - Table `events` columns: `event_type`, `task_id`, `list_id`, `workspace_id`, `payload`, `user_id`, `user_name`, `field_changed`, `from_value`, `to_value`, `space_id`
- **R2 buckets:** `pop-seafile-blocks`, `pop-seafile-commits`, `pop-seafile-fs` — Seafile object storage, not app data

```
d1_database_query(database_id="c37aeb36-e16e-416b-b699-c910f6f8dc10", query="SELECT * FROM events ORDER BY rowid DESC LIMIT 20")
d1_database_query(database_id="c37aeb36-e16e-416b-b699-c910f6f8dc10", query="SELECT task_id, user_name, field_changed, from_value, to_value FROM events WHERE field_changed = 'status' ORDER BY rowid DESC LIMIT 50")
workers_get_worker_code(scriptName="plane-integrations")
```

---

### GitHub — `github` MCP

**Org:** `u2giants`

```
search_repositories(query="org:u2giants")
list_commits(owner="u2giants", repo="openclaw", sha="main")
list_pull_requests(owner="u2giants", repo="mission-control", state="open")
```

---

## Quick Reference

| Problem | MCP | Pattern |
|---|---|---|
| App errors / crashes | `coolify-server` | `ssh coolify "docker logs <container> --tail 200"` |
| App config / API keys | `coolify-server` | `ssh coolify "docker exec <container> env"` |
| Is container running? | `coolify-server` | `ssh coolify "docker ps"` |
| Restart container | `coolify-server` | `ssh coolify "docker restart <container>"` |
| Twenty CRM data | `twenty-crm-postgres` | SQL query (start tunnel first) |
| Synology Monitor data | `supabase` | `execute_sql(project_id="qnjimovrsaacneqkggsn", ...)` |
| popdam data | `supabase` | `execute_sql(project_id="ryltkzzernhwnojzouyb", ...)` |
| ClickUp event history | `cloudflare` | `d1_database_query(database_id="c37aeb36...", ...)` |
| Worker code / debug | `cloudflare` | `workers_get_worker_code(scriptName="plane-integrations")` |
| Source code / PRs | `github` | `list_commits(...)` / `list_pull_requests(...)` |
| OpenClaw state files | `coolify-server` | `ssh coolify "docker exec openclaw-... cat /data/.openclaw/openclaw.json"` |

---

## Roo Mode Permissions

| Mode | MCP access | Reason |
|---|---|---|
| 🧠 Orchestrator | No | Plans and delegates only |
| 🛠️ Builder | No | Code files only — no live environment access by design |
| ⚙️ DevOps | **Yes — all MCPs** | Deploy, debug, query |
| 📐 Architect | **Yes — all MCPs** | Inspect live environment before designing |
| 🔍 Reviewer-Pusher | No | Reviews diffs only |

---

## Critical Rules

- **Start `start_tunnels.bat`** before any session touching the Twenty CRM database.
- **OpenClaw has no database** — state is flat files in `/data/.openclaw/` inside Docker.
- **popdam is not on the VPS** — Supabase is the only access point, no SSH possible.
- **Secrets from `docker exec ... env` are real production secrets.** Never log, commit, or expose them.
- If SSH fails: check `C:\Users\ahazan2\.ssh\config` and that `id_ed25519` key exists.
