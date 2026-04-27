# AI Infrastructure Guide

Live environment reference for the Synology Monitor system. Use this when accessing running services, checking logs, or configuring credentials.

For rules about what AI tools may and may not do, see [AI_OPERATING_RULES.md](AI_OPERATING_RULES.md).

---

## Live services

| Service | URL | Where it runs |
|---------|-----|---------------|
| Web dashboard | `https://mon.designflow.app` | Coolify VPS (Docker) |
| NAS MCP server | `https://nas-mcp.designflow.app/sse` | Coolify VPS (Docker) |
| NAS API (edgesynology1) | `http://100.107.131.35:7734` | NAS 1 (Tailscale only) |
| NAS API (edgesynology2) | `http://100.107.131.36:7734` | NAS 2 (Tailscale only) |
| Relay | `https://mon.designflow.app/relay` | Coolify VPS (Docker, port 8787) |
| Supabase | `https://qnjimovrsaacneqkggsn.supabase.co` | Supabase cloud |

The NAS APIs are reachable only over Tailscale. The web app and NAS MCP talk to them directly. The relay provides a public HTTPS bridge for older integrations.

---

## Coolify

Coolify manages all VPS-hosted containers. It is the source of truth for runtime environment variables.

- **URL:** `https://coolify.designflow.app`
- **VPS IP:** `178.156.180.212`

### App UUIDs (for API/webhook use)

| App | Coolify UUID |
|-----|-------------|
| NAS MCP | `efl17f5iocnz94840pexre9d` |
| Web app | (check Coolify UI) |
| Relay | (check Coolify UI) |

### Coolify API usage

```bash
# Trigger a redeploy
curl -X GET "http://178.156.180.212:8000/api/v1/deploy?uuid=<APP_UUID>&force=false" \
  -H "Authorization: Bearer $COOLIFY_TOKEN"

# Check app health check config
curl "http://178.156.180.212:8000/api/v1/applications/<APP_UUID>" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  | jq '{health_check_path,health_check_port,health_check_return_code}'
```

---

## Supabase (SynoMon project)

- **Project ID:** `qnjimovrsaacneqkggsn`
- **URL:** `https://qnjimovrsaacneqkggsn.supabase.co`

Key tables: see [AGENTS.md](AGENTS.md) for the full schema reference.

Using the Supabase MCP (if configured in your session):
```
execute_sql(project_id="qnjimovrsaacneqkggsn", query="SELECT ...")
list_tables(project_id="qnjimovrsaacneqkggsn")
list_migrations(project_id="qnjimovrsaacneqkggsn")
```

---

## NAS MCP

- **Endpoint:** `https://nas-mcp.designflow.app/sse`
- **Auth:** `Authorization: Bearer <MCP_BEARER_TOKEN>` (stored in Coolify env vars)

Connecting from Claude Desktop (`claude_desktop_config.json`):
```json
{
  "nas-mcp": {
    "command": "npx",
    "args": [
      "-y", "mcp-remote@latest",
      "https://nas-mcp.designflow.app/sse",
      "--header", "Authorization: Bearer <MCP_BEARER_TOKEN>"
    ]
  }
}
```

---

## Web app environment variables (set in Coolify)

```
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://qnjimovrsaacneqkggsn.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role key — required for /api/analysis/cron>

# AI
OPENROUTER_API_KEY=<primary LLM provider>
OPENAI_API_KEY=<fallback if OPENROUTER_API_KEY is absent>
OPENAI_CHAT_MODEL=gpt-4o
MINIMAX_MODEL=minimax/minimax-m2.7   # default detection/extraction/clustering model
COPILOT_ACTION_SIGNING_KEY=<HMAC key for tier-2/3 approval tokens>
COPILOT_ADMIN_EMAILS=<comma-separated>

# NAS API access (Tailscale)
NAS_EDGE1_API_URL=http://100.107.131.35:7734
NAS_EDGE1_API_SECRET=<must match NAS_API_SECRET in NAS 1 .env>
NAS_EDGE1_API_SIGNING_KEY=<must match NAS_API_APPROVAL_SIGNING_KEY in NAS 1 .env>
NAS_EDGE2_API_URL=http://100.107.131.36:7734
NAS_EDGE2_API_SECRET=<must match NAS_API_SECRET in NAS 2 .env>
NAS_EDGE2_API_SIGNING_KEY=<must match NAS_API_APPROVAL_SIGNING_KEY in NAS 2 .env>

# Issue worker
ISSUE_WORKER_MODE=background        # inline | background
RUN_ISSUE_WORKER=true               # starts issue-worker.mjs alongside Next.js
ISSUE_WORKER_TOKEN=<bearer token for /api/internal/issue-worker/drain>
ISSUE_WORKER_INTERVAL_MS=3000
ISSUE_WORKER_BATCH_LIMIT=10

# Scheduled analysis cron
CRON_SECRET=<must match the secret in the Coolify scheduled task command>
```

See `apps/web/.env.example` for placeholder values and descriptions.

---

## Coolify scheduled tasks

| Task | Frequency | Command | Container |
|------|-----------|---------|-----------|
| `smon-analysis-cron` | `*/15 * * * *` | `node -e "fetch('http://localhost:3000/api/analysis/cron?secret=<CRON_SECRET>').then(...)"` | `synology-monitor-web` |

The task runs `docker exec synology-monitor-web node -e "..."` so it hits port 3000 inside the container, not the host. `node` is always available in the web image; no external tools needed.

To edit: Coolify UI → Synology Monitor project → web app → Scheduled Tasks. If the task fails, check Coolify's `failed_jobs` table:
```bash
docker exec coolify php artisan tinker --execute="print_r(DB::table('failed_jobs')->orderBy('failed_at','desc')->limit(5)->get()->toArray());"
```

---

## NAS-side environment variables (per-NAS `.env` file)

Each NAS has a `.env` at `/volume1/docker/synology-monitor-agent/.env`. See `deploy/synology/nas-1.env.example` and `nas-2.env.example` for the full variable list.

Key vars:

```
NAS_API_SECRET=<bearer token — must match web app NAS_EDGE*_API_SECRET>
NAS_API_APPROVAL_SIGNING_KEY=<HMAC key — must match web app NAS_EDGE*_API_SIGNING_KEY>
NAS_API_PORT=7734
AGENT_IMAGE_TAG=latest
SUPABASE_URL=https://qnjimovrsaacneqkggsn.supabase.co
SUPABASE_KEY=<anon or service role key>
```

If `AGENT_IMAGE_TAG` is pinned to a SHA, Watchtower will not switch to `latest` on the next pull. Set it to `latest` for normal operation.

---

## NAS MCP environment variables (set in Coolify)

```
MCP_PORT=3001
MCP_BEARER_TOKEN=<token for MCP clients>
NAS_EDGE1_NAME=edgesynology1
NAS_EDGE1_API_URL=http://100.107.131.35:7734
NAS_EDGE1_API_SECRET=<same as web app NAS_EDGE1_API_SECRET>
NAS_EDGE1_API_SIGNING_KEY=<same as web app NAS_EDGE1_API_SIGNING_KEY>
NAS_EDGE2_NAME=edgesynology2
NAS_EDGE2_API_URL=http://100.107.131.36:7734
NAS_EDGE2_API_SECRET=<same as web app NAS_EDGE2_API_SECRET>
NAS_EDGE2_API_SIGNING_KEY=<same as web app NAS_EDGE2_API_SIGNING_KEY>
```

---

## GitHub Actions secrets

| Secret | Used by |
|--------|---------|
| `GITHUB_TOKEN` | All workflows — GHCR push (auto-provided by Actions) |
| `COOLIFY_TOKEN` | `nas-mcp-image.yml` — triggers Coolify redeploy webhook |

---

## DevOps MCP (VPS shell access)

A separate `devops-mcp` service provides shell access to the VPS for AI agents. It is not part of this repo.

- **Endpoint:** `https://mcp.designflow.app/mcp`
- **Auth:** `Authorization: Bearer <TOKEN_ROOCODE>` (or relevant agent token)
- **Transport:** Streamable HTTP (`--transport http` flag required)

Available tools: `run_command`, `read_file`, `write_file`, `list_directory`, `docker_ps`, `docker_logs`, `docker_action`, `view_audit_log`.

This MCP is read-only by convention for diagnostics; write access exists but should be used with care.

---

## Relay environment variables

```
PORT=8787
RELAY_BEARER_TOKEN=<public bearer token>
RELAY_ADMIN_SECRET=<write-action secret>
RELAY_ALLOWED_ORIGINS=<comma-separated allowed origins>
NAS_EDGE1_API_URL=http://100.107.131.35:7734
NAS_EDGE1_API_SECRET=<same as above>
NAS_EDGE1_API_SIGNING_KEY=<same as above>
NAS_EDGE2_API_URL=http://100.107.131.36:7734
NAS_EDGE2_API_SECRET=<same as above>
NAS_EDGE2_API_SIGNING_KEY=<same as above>
```
