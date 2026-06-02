# Configuration

## Overview

- **Production:** Runtime env lives in **Coolify** (VPS apps) and each NAS `.env`
  file (agent + nas-api). Do not commit real values or edit production env from the
  repo side.
- **Development:** Copy the `*.env.example` files and fill in your values locally.
- **AI model settings:** Stored in the `ai_settings` Supabase table; editable via
  the Settings UI. See [AI model settings](#ai-model-settings) below.

---

## Agent (`deploy/synology/nas-1.env.example`)

### Required

| Variable | Purpose | Default |
|---|---|---|
| `NAS_ID` | UUID. Must match `nas_units.id` in Supabase. Validated on startup. | — |
| `NAS_NAME` | Display name in the UI | `Synology NAS 1` |
| `DSM_URL` | DSM web interface URL | `https://localhost:5001` |
| `DSM_USERNAME` | DSM account for API calls (also used by nas-api for WebAPI package restarts) | — |
| `DSM_PASSWORD` | DSM account password | — |
| `SUPABASE_URL` | Supabase project URL | — |
| `SUPABASE_SERVICE_KEY` | Supabase service role key | — |
| `NAS_API_SECRET` | Shared secret — must match `NAS_EDGE{1,2}_API_SECRET` in the web app | — |
| `NAS_API_APPROVAL_SIGNING_KEY` | HMAC key for tier-2/3 approval tokens — must match `NAS_EDGE{1,2}_API_SIGNING_KEY` in the web app | — |

### Optional

| Variable | Purpose | Default |
|---|---|---|
| `DSM_INSECURE_SKIP_VERIFY` | Set `false` if DSM has a valid TLS cert | `true` |
| `NAS_API_PORT` | Port the nas-api listens on | `7734` |
| `AGENT_IMAGE_TAG` | Pin to a SHA tag to hold a specific image version | `latest` |
| `WATCH_PATHS` | Comma-separated paths for inotify security watcher | `/host/shares/...` |
| `LOG_DIR` | Root directory for log watcher | `/host/log` |
| `EXTRA_LOG_FILES` | Additional log files: `path|source,path|source,...` | — |
| `MAX_INOTIFY_DIRS` | inotify directory limit | `5000` |
| `DATA_DIR` | SQLite WAL and checkpoints storage | `/app/data` |
| `TZ` | Container timezone | `UTC` |

### Collection intervals (Go duration strings: `30s`, `2m`, `1h`)

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

| Variable | Default | Purpose |
|---|---|---|
| `BATCH_SIZE` | `100` | Rows per Supabase flush request |
| `FLUSH_TIMEOUT` | `30s` | Flush interval |
| `MAX_WAL_SIZE_MB` | `100` | WAL size cap — oldest entries dropped when exceeded |

---

## Web app (`apps/web/.env.example`)

**Non-obvious:** `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are
baked into the Next.js client bundle at `docker build` time. Changing them in
Coolify after the image is built has no effect — a new image build is required.

### Required

| Variable | Purpose | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | Build-time bake |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key | Build-time bake |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side writes (issue agent, admin queries) | Runtime |
| `NAS_EDGE1_API_URL` | NAS 1 API base URL (e.g. `http://100.107.131.35:7734`) | Runtime |
| `NAS_EDGE1_API_SECRET` | Must match `NAS_API_SECRET` on NAS 1 | Runtime |
| `NAS_EDGE1_API_SIGNING_KEY` | Must match `NAS_API_APPROVAL_SIGNING_KEY` on NAS 1 | Runtime |
| `NAS_EDGE2_API_URL` | NAS 2 API base URL | Runtime |
| `NAS_EDGE2_API_SECRET` | Must match `NAS_API_SECRET` on NAS 2 | Runtime |
| `NAS_EDGE2_API_SIGNING_KEY` | Must match `NAS_API_APPROVAL_SIGNING_KEY` on NAS 2 | Runtime |
| `ANTHROPIC_API_KEY` | Anthropic / Claude provider for Stage 2 reasoning | Runtime |
| `OPENAI_API_KEY` | OpenAI provider; also fallback signing key for copilot actions | Runtime |
| `OPENROUTER_API_KEY` | Copilot chat + model catalog dropdown | Runtime |

### Optional AI providers

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Google Gemini provider for Stage 2 (if selected in AI settings) |
| `DEEPSEEK_API_KEY` | DeepSeek provider for Stage 2 |
| `DASHSCOPE_API_KEY` | Qwen/DashScope provider for Stage 2 |
| `OPENAI_CHAT_MODEL` | Default model ID when `ai_settings` is empty |
| `MINIMAX_MODEL` | Default MiniMax model ID for copilot/clustering |

### Issue worker

| Variable | Default | Purpose |
|---|---|---|
| `ISSUE_WORKER_MODE` | `inline` | `inline` = drain on API requests; `background` = separate worker loop |
| `RUN_ISSUE_WORKER` | — | Set `true` to run the in-process background worker |
| `ISSUE_WORKER_TOKEN` | — | Bearer auth for `/api/internal/issue-worker/drain` (background mode) |
| `ISSUE_WORKER_INTERVAL_MS` | `3000` | Background worker poll cadence |
| `ISSUE_WORKER_BATCH_LIMIT` | `10` | Background worker batch size |

### Push notifications

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Web-push public key (`npx web-push generate-vapid-keys`) |
| `VAPID_PRIVATE_KEY` | Web-push private key |
| `VAPID_SUBJECT` | Web-push contact (e.g. `mailto:you@example.com`) |

---

## NAS API (`apps/nas-api`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `NAS_API_SECRET` | Yes | — | Bearer token for all incoming requests |
| `NAS_API_APPROVAL_SIGNING_KEY` | Yes | — | HMAC key for tier-2/3 tokens |
| `NAS_API_PORT` | No | `7734` | Port to listen on |
| `DSM_USERNAME` | Yes | — | Used for DSM WebAPI package restarts |
| `DSM_PASSWORD` | Yes | — | Used for DSM WebAPI package restarts |
| `DSM_PORT` | No | `5000` | DSM HTTP port |

---

## NAS MCP server (`apps/nas-mcp`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MCP_BEARER_TOKEN` | Yes | — | Auth token for all MCP client connections |
| `MCP_PORT` | No | `3001` | Port the server listens on |
| `NAS_EDGE1_NAME` | No | `edgesynology1` | Logical name for `target` parameter in tool calls |
| `NAS_EDGE1_API_URL` | Yes | — | NAS 1 API base URL |
| `NAS_EDGE1_API_SECRET` | Yes | — | Bearer secret for NAS 1 API |
| `NAS_EDGE1_API_SIGNING_KEY` | Yes | — | HMAC key; must match `NAS_API_APPROVAL_SIGNING_KEY` on NAS 1 |
| `NAS_EDGE2_NAME` | No | `edgesynology2` | |
| `NAS_EDGE2_API_URL` | Yes | — | |
| `NAS_EDGE2_API_SECRET` | Yes | — | |
| `NAS_EDGE2_API_SIGNING_KEY` | Yes | — | |

---

## AI model settings

Model assignments are stored in the `ai_settings` Supabase table and read at
runtime. The Settings UI exposes them. If `ai_settings` is empty, each stage falls
back through env vars then hardcoded defaults.

**Non-obvious:** `ai_settings` must be read via `createAdminClient()` (service
role), not the session client. The issue agent runs as a background worker with no
user session; the session client returns `{}` under RLS, silently falling back to
hardcoded defaults.

| Key | Stage / feature | Fallback |
|---|---|---|
| `stage_structurer_model` / `stage_structurer_effort` | Stage 1 | `claude-haiku-4-5-20251001` / `low` |
| `stage_reasoning_model` / `stage_reasoning_effort` | Stage 2 | `claude-sonnet-4-6` / `medium` |
| `stage_explainer_model` / `stage_explainer_effort` | Stage 3 | `claude-haiku-4-5-20251001` / `low` |
| `diagnosis_model` | Copilot (MiniMax) | `MINIMAX_MODEL` env → `minimax/minimax-m2.7` |
| `remediation_model` | Copilot (OpenAI) | `OPENAI_CHAT_MODEL` env → `openai/gpt-5.4` |
| `second_opinion_model` | Planned cross-check feature (not yet wired) | `anthropic/claude-sonnet-4` |
| `cluster_model` | Log clustering (writer has no callers) | `diagnosis_model` → `minimax/minimax-m2.7` |

### Model capability and effort controls

The Settings UI stores a model and an effort/reasoning value per active stage, but
"effort" is provider-specific. The provider client should map the abstract setting
only when the selected model supports it and omit unsupported parameters rather
than sending a no-op or invalid field.

| Provider | Effort shape | Notes |
|---|---|---|
| Anthropic | extended thinking budget | Best fit for Stage 2 when tool use and reasoning are needed; cache usage has Anthropic-specific read/write fields. |
| OpenAI | `reasoning_effort` on reasoning models | Prefix caching is automatic; non-reasoning models may not accept the effort parameter. |
| Gemini | thinking config where supported | Explicit cached content needs lifecycle tracking if enabled. |
| DeepSeek | usually model choice, not a generic knob | Cache usage fields differ from OpenAI-compatible defaults. |
| Qwen/DashScope | model-specific; often OpenAI-style | Multi-turn cache behavior may require preserving provider response/session ids. |

Stage 2 should be limited to models with reliable tool use, structured JSON output,
long-context coherence, and strong multi-step reasoning. Stage 3 can use a cheaper
model optimized for concise writing and memory extraction. If a model lacks an
effort knob, keep the selected model and treat effort as disabled for that provider.

`packages/shared/src/ai-capabilities.ts` is the source of truth for the curated
model catalog, provider capability matrix, stage requirements, fallback models,
and stage spec text. The Settings UI imports that shared data to filter model
dropdowns and to build the copy-spec clipboard payload for asking another model
which provider-native model best fits a stage.

---

## tools-config.json

`apps/nas-mcp/tools-config.json` controls which NAS tools are enabled/disabled in
the MCP server. Changes require a push to `main`.

```json
{
  "enabled_read_tools": ["check_disk_space", "get_smart_info", ...],
  "enabled_write_tools": ["restart_nas_api", "restart_synology_drive", ...]
}
```

Tool definitions live in `packages/shared/src/nas-tools.ts`. A normal registry
tool must appear in both the definitions file and `tools-config.json` to be
callable. `restart_nas_api` is the exception: it is an always-on MCP tool
implemented in `apps/nas-mcp/src/index.ts`, so it appears in `tools-config.json`
but not in `ALL_TOOL_DEFS`.

---

## Custom metric schedules

Insert rows into `custom_metric_schedules` to schedule recurring shell commands
on the agent (no code change or deploy required):

| Column | Type | Notes |
|---|---|---|
| `name` | text | Descriptive name |
| `description` | text | What it collects and why |
| `nas_id` | text | `edgesynology1` or `edgesynology2` |
| `collection_command` | text | Shell command run via `sh -c` in the agent container |
| `interval_minutes` | int | How often to run (minimum 1) |
| `is_active` | bool | Set false to pause without deleting |
| `next_run_at` | timestamptz | When to next run (default: `now()`) |

The agent polls every 60s and claims due rows with an optimistic lock.
Output is stored in `custom_metric_data.raw_output`.

Available paths in the agent container:
- `/host/proc/*` — host kernel virtual files
- `/host/sys/*` — host sysfs
- `/host/log/*` — host `/var/log`
- `/host/shares/@synologydrive/*` — Drive appdata
- Standard shell utilities: `cat`, `grep`, `awk`, `head`, `tail`, `find`

---

## Volume mount paths (agent container)

The agent compose file mounts host paths under `/host/` to avoid shadowing the
container's own `/proc` and `/sys`. Access host data at:

| Host path | Container path |
|---|---|
| `/proc` | `/host/proc` |
| `/sys` | `/host/sys` |
| `/var/log` | `/host/log` |
| `/volume1/@synologydrive` | `/host/shares/@synologydrive` |
| `/volume1/@SynologyDriveShareSync` | `/host/shares/@SynologyDriveShareSync` |
| `/volume1/files` | `/host/shares/files` |
| (other shares) | `/host/shares/<name>` |

## Volume mount paths (NAS API container)

Predefined MCP/NAS API diagnostic tools run in the `synology-monitor-nas-api`
container. Its mount layout is different from the telemetry agent:

| Host path | Container path | Notes |
|---|---|---|
| `/proc` | `/host/proc` | Host procfs without shadowing container `/proc` |
| `/sys` | `/host/sys` | Host sysfs |
| `/usr/syno` | `/host/usr/syno` | DSM binaries and config |
| `/lib`, `/usr/lib` | `/host/lib`, `/host/usr/lib` | Host libraries for DSM binaries |
| `/var/log` | `/host/log` | DSM logs |
| `/var/packages` | `/host/packages` | DSM package state; tools should not assume `/host/var/packages` |
| `/volume1` | `/btrfs/volume1` | Full Btrfs volume for subvolume/snapshot operations |
| selected shared folders | `/volume1/<share>` | Narrow share mounts for file inspection |
| selected block devices | `/dev/sd*`, `/dev/md*` | Individually mounted read-only; empty bays may be commented out |

For DSM 7 scheduler and Snapshot Replication inspection, prefer `/host/packages`,
`/host/usr/syno`, and `/btrfs/volumeN`, and fall back to DSM WebAPI read methods
when package SQLite/config paths are not visible.
