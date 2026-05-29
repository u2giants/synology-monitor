# Configuration

## Agent (`deploy/synology/nas-1.env.example`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `NAS_ID` | Yes | — | UUID. Must match `nas_units.id` in Supabase. Validated at startup. |
| `NAS_NAME` | No | `Synology NAS 1` | Display name in UI |
| `DSM_URL` | Yes | `https://localhost:5001` | DSM web interface URL |
| `DSM_USERNAME` | Yes | — | DSM account used for API calls |
| `DSM_PASSWORD` | Yes | — | DSM account password |
| `DSM_INSECURE_SKIP_VERIFY` | No | `true` | Set false if DSM has a valid TLS cert |
| `SUPABASE_URL` | Yes | — | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Yes | — | Supabase service role key |
| `AGENT_IMAGE_TAG` | No | `latest` | Pin to a SHA tag to hold a specific version |
| `NAS_API_SECRET` | Yes | — | Shared secret — must match `NAS_EDGE1_API_SECRET` in web app |
| `NAS_API_APPROVAL_SIGNING_KEY` | Yes | — | HMAC key for tier-3 approval tokens — must match `NAS_EDGE1_API_SIGNING_KEY` in web app |
| `NAS_API_PORT` | No | `7734` | Port the nas-api listens on |
| `WATCH_PATHS` | No | `/host/shares/...` | Comma-separated paths for inotify security watcher and log watcher |
| `LOG_DIR` | No | `/host/log` | Root for log watcher |
| `EXTRA_LOG_FILES` | No | — | Additional log files to watch (comma-separated) |
| `MAX_INOTIFY_DIRS` | No | `5000` | inotify directory limit |
| `DATA_DIR` | No | `/app/data` | SQLite WAL and checkpoints storage |
| `TZ` | No | `UTC` | Container timezone |

### Collection intervals

All accept Go duration strings (`30s`, `2m`, `1h`).

| Variable | Default | Collector |
|---|---|---|
| `METRICS_INTERVAL` | `30s` | system metrics |
| `STORAGE_INTERVAL` | `60s` | storage snapshots |
| `LOG_INTERVAL` | `10s` | log watcher |
| `DOCKER_INTERVAL` | `30s` | container status |
| `PROCESS_INTERVAL` | `15s` | per-process snapshots |
| `DISKSTATS_INTERVAL` | `15s` | disk I/O stats |
| `CONNECTIONS_INTERVAL` | `30s` | network connections |
| `INFRA_INTERVAL` | `2m` | share usage, network counters |

The `sharesync` collector interval is hardcoded at 5m and is not configurable via env.

### WAL tuning

| Variable | Default | |
|---|---|---|
| `BATCH_SIZE` | `100` | Rows per Supabase flush request |
| `FLUSH_TIMEOUT` | `30s` | Flush interval |
| `MAX_WAL_SIZE_MB` | `100` | WAL size cap — oldest entries dropped when exceeded |

## Web app (`apps/web/.env.example`)

See `apps/web/.env.example` for the authoritative list (placeholders only — no
real secrets are committed). Key variables:

| Variable | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL (baked into client bundle at build time) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anon key (baked at build time) |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Service role key for server-side writes |
| `OPENROUTER_API_KEY` | Yes* | LLM calls; code reads `OPENROUTER_API_KEY ?? OPENAI_API_KEY` with `baseURL=openrouter.ai`. *At least one of the two is required |
| `OPENAI_API_KEY` | Yes* | Fallback for the above; also default approval-token signing key |
| `OPENAI_CHAT_MODEL` | No | Default chat model id (`gpt-5.4`) when `ai_settings` is empty |
| `COPILOT_ACTION_SIGNING_KEY` | No | HMAC key for legacy-copilot one-off NAS action approval tokens (falls back to `OPENAI_API_KEY`) |
| `COPILOT_ADMIN_EMAILS` | No | Comma-separated admin emails for the copilot |
| `ISSUE_WORKER_MODE` | No | `inline` (default) or `background` |
| `RUN_ISSUE_WORKER` | No | `true` to run the in-process background worker loop |
| `ISSUE_WORKER_TOKEN` | If background | Bearer auth for `/api/internal/issue-worker/drain` |
| `ISSUE_WORKER_INTERVAL_MS` / `ISSUE_WORKER_BATCH_LIMIT` | No | Background worker poll cadence (`3000`) / batch size (`10`) |
| `NAS_EDGE{1,2}_API_URL` | Yes | `http://100.107.131.3{5,6}:7734` (Tailscale IPs) |
| `NAS_EDGE{1,2}_API_SECRET` | Yes | Must match `NAS_API_SECRET` on each NAS |
| `NAS_EDGE{1,2}_API_SIGNING_KEY` | Yes | Must match `NAS_API_APPROVAL_SIGNING_KEY` on each NAS |
| `NAS_EDGE{1,2}_HOST/PORT/USER/PASSWORD/SUDO_PASSWORD` | Legacy | SSH access used by the **legacy copilot chat only**, not the issue agent |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | No | Web-push public key (`npx web-push generate-vapid-keys`) |

**Non-obvious:** `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are build-time variables — they are embedded in the Next.js client bundle during `docker build`. Changing them in Coolify after the image is built has no effect. Changing these requires a new image build.

### LLM model selection

Model assignments are stored in Supabase (`ai_settings`) and read at runtime by the issue agent. The web app Settings UI exposes these. If `ai_settings` is empty, each stage falls back to env vars, then hardcoded defaults. See `apps/web/src/lib/server/ai-settings.ts` for the fallback chain.

**Non-obvious:** `ai_settings` must be read via `createAdminClient()` (service role), not the session client. The issue agent runs as a background worker with no user session; using the session client causes silent RLS failures and every model silently falls back to its hardcoded default.

## NAS API (`apps/nas-api`)

| Variable | Required | Notes |
|---|---|---|
| `NAS_API_SECRET` | Yes | Bearer token for incoming requests |
| `NAS_API_APPROVAL_SIGNING_KEY` | Yes | HMAC key for tier-3 tokens |
| `NAS_API_PORT` | No | Default `7734` |
| `DSM_USERNAME` | Yes | Used for DSM WebAPI package restarts |
| `DSM_PASSWORD` | Yes | Used for DSM WebAPI package restarts |
| `DSM_PORT` | No | Default `5000` |

## NAS MCP server (`apps/nas-mcp`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MCP_BEARER_TOKEN` | Yes | — | Auth token for all MCP client connections |
| `MCP_PORT` | No | `3001` | Port the server listens on |
| `NAS_EDGE1_NAME` | No | `edgesynology1` | Logical name used in tool `target` parameter |
| `NAS_EDGE1_API_URL` | Yes | — | NAS 1 API base URL (`http://100.107.131.35:7734`) |
| `NAS_EDGE1_API_SECRET` | Yes | — | Bearer secret for NAS 1 API |
| `NAS_EDGE1_API_SIGNING_KEY` | Yes | — | HMAC key for tier 2/3 approval tokens; must match `NAS_API_APPROVAL_SIGNING_KEY` on NAS 1 |
| `NAS_EDGE2_NAME` | No | `edgesynology2` | Logical name used in tool `target` parameter |
| `NAS_EDGE2_API_URL` | Yes | — | NAS 2 API base URL (`http://100.107.131.36:7734`) |
| `NAS_EDGE2_API_SECRET` | Yes | — | Bearer secret for NAS 2 API |
| `NAS_EDGE2_API_SIGNING_KEY` | Yes | — | HMAC key for tier 2/3 approval tokens; must match `NAS_API_APPROVAL_SIGNING_KEY` on NAS 2 |

Tool availability is controlled by `apps/nas-mcp/tools-config.json`, not env vars. Changes require a push to `main`.
