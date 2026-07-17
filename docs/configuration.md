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
| `NAS_API_NAME` | Logical API identity used in approval tokens and archive jobs (`edgesynology1` / `edgesynology2`) | Container hostname if unset; set explicitly in production |
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
| `ANTHROPIC_API_KEY` | Anthropic / Claude provider for the 3-stage pipeline; presence lists its models in the live AI-stage dropdowns | Runtime |
| `OPENAI_API_KEY` | OpenAI provider (3-stage pipeline + live dropdowns); also fallback signing key for copilot actions | Runtime |
| `OPENROUTER_API_KEY` | Copilot chat + the **copilot** model-picker dropdown (`/api/models`, Settings page). Not used by the 3-stage AI-stage dropdowns | Runtime |

### Optional AI providers

A provider counts as "connected" when its key is present; its models are then
fetched live into the AI-stage dropdowns (see *Model capability and effort
controls* below). Any provider can be selected for any stage subject to capability
gating.

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Google Gemini provider (default for Stage 1 & 3); `GOOGLE_API_KEY` is accepted as a fallback name |
| `DEEPSEEK_API_KEY` | DeepSeek provider; `DEEPSEEK_BASE_URL` overrides the default `https://api.deepseek.com` |
| `DASHSCOPE_API_KEY` | Qwen/DashScope provider; `DASHSCOPE_BASE_URL` overrides the default compatible-mode endpoint |
| `OPENAI_CHAT_MODEL` | Env fallback for the copilot `remediation_model` when `ai_settings.remediation_model` is unset (→ `openai/gpt-5.4`). Does not affect the 3 pipeline stages |
| `MINIMAX_MODEL` | Env fallback for the copilot `diagnosis_model` / `cluster_model` (→ `minimax/minimax-m2.7`) |

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

### Dashboard copilot authorization

| Variable | Purpose |
|---|---|
| `COPILOT_ACTION_SIGNING_KEY` | Signs privileged copilot actions; OpenAI key fallback exists for compatibility but production should set a dedicated value |
| `COPILOT_ADMIN_EMAILS` | Comma-separated accounts allowed to execute copilot actions |

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
| `NAS_API_NAME` | Production | Container hostname | Stable logical NAS name used by approval signing and job results |
| `NAS_API_JOBS_PATH` | Compose only | `/volume1/docker/synology-monitor-agent/nas-api-jobs` | Host path bound to `/app/data/jobs`; not read directly by Go code |

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

## Relay (`apps/relay`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PORT` | No | `8787` | Relay HTTP listen port |
| `RELAY_ALLOWED_ORIGINS` | Yes | — | Comma-separated browser origins permitted by CORS |
| `RELAY_BEARER_TOKEN` | Yes | — | Authenticates relay clients |
| `RELAY_ADMIN_SECRET` | Yes for writes | — | Additional authorization for state-changing actions |
| `NAS_EDGE1_API_URL`, `NAS_EDGE1_API_SECRET`, `NAS_EDGE1_API_SIGNING_KEY` | Yes | — | NAS 1 upstream and approval credentials |
| `NAS_EDGE2_API_URL`, `NAS_EDGE2_API_SECRET`, `NAS_EDGE2_API_SIGNING_KEY` | Yes | — | NAS 2 upstream and approval credentials |

## Operational scripts and build metadata

| Variable | Consumer | Default / notes |
|---|---|---|
| `RETENTION_BATCH_LIMIT` | `scripts/run-telemetry-retention-cleanup.mjs` | Rows per cleanup call; use the runbook's staged values |
| `RETENTION_MAX_BATCHES` | Same | Maximum calls in one run |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Retention/dashboard scripts | Must be explicit; the retention runner rejects the retired Ohio ref |
| `ISSUE_WORKER_URL` | `apps/web/scripts/issue-worker.mjs` | Drain endpoint for the standalone worker |
| `BUILD_SHA`, `NEXT_PUBLIC_BUILD_SHA`, `NEXT_PUBLIC_BUILD_DATE` | Docker/workflow and web build metadata | Set by build/deploy tooling; not operator secrets |
| `UPDATE_GOLDEN` | Shared NAS-tool golden test | Set `1` only to intentionally regenerate the cross-language fixture |

---

## AI model settings

Model assignments are stored in the `ai_settings` Supabase table and read at
runtime. The Settings UI exposes them. For the **3 pipeline stages**, an empty
value falls back directly to the hardcoded `STAGE_DESCRIPTORS` default in
`packages/shared/src/ai-capabilities.ts` (no env-var layer); these defaults match
the migration 00036 seed. The **copilot** models (`diagnosis_model`,
`remediation_model`, `cluster_model`) fall back through env vars then a hardcoded
default.

**Non-obvious:** `ai_settings` must be read via `createAdminClient()` (service
role), not the session client. The issue agent runs as a background worker with no
user session; the session client returns `{}` under RLS, silently falling back to
hardcoded defaults.

| Key | Stage / feature | Fallback |
|---|---|---|
| `stage_structurer_model` / `stage_structurer_effort` | Stage 1 | `gemini-3.1-flash-lite-preview` / `minimal` |
| `stage_reasoning_model` / `stage_reasoning_effort` | Stage 2 | `claude-sonnet-4-6` / `high` |
| `stage_explainer_model` / `stage_explainer_effort` | Stage 3 | `gemini-3.1-flash-lite-preview` / `low` |
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

**Model dropdowns are live, not curated.** As of 2026-06-02 the AI-stage model
dropdowns are populated from every connected provider's list-models endpoint
(`apps/web/src/lib/server/ai/provider-models.ts`, served by `/api/ai-models`,
cached ~10 min). So any model a connected provider exposes — including ones newer
than this repo — is selectable. A provider is "connected" when its key env is set.

`packages/shared/src/ai-capabilities.ts` remains the source of truth for the
provider capability matrix, stage requirements, fallback models, and stage spec
text — but its `MODEL_CATALOG` is now a precise-metadata **override and offline
fallback**, not the menu:

- A model id in `MODEL_CATALOG` uses its hand-verified metadata (effort control,
  effort levels, cache style, tool use).
- A catalog-miss id gets a **derived** descriptor: provider from the id prefix
  (`inferProvider`), cache style from the provider, and effort/tool-use from
  conservative id-pattern heuristics. Derivation is intentionally cautious about
  enabling an effort knob, because sending an unsupported reasoning param 400s the
  call while omitting one merely forgoes thinking.
- The runtime resolves ids `catalog → derived → live-map` (`resolveModelDescriptor`
  then `resolveLiveDescriptor`); it only fails when no connected provider offers
  the id.

The Settings UI still gates the live list per stage (Stage 2 needs tool use; all
stages need structured output), shows an amber **"inferred model"** warning when a
selected model's capabilities are derived rather than catalog-backed, and builds
the copy-spec clipboard payload for asking another model which provider-native
model best fits a stage. **To tune a specific model precisely** (its effort knob or
tool-use), add a row to `MODEL_CATALOG` — the catalog always overrides the
heuristic. The `OPENROUTER_API_KEY`-backed `/api/models` route is a *separate*
dropdown for the copilot, not the 3-stage pipeline.

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

Tool definitions live in `packages/shared/src/nas-tools.ts`. A registry tool must
appear in both the definitions file and `tools-config.json` to be callable through
`invoke_tool`. `check_disk_space` and `restart_nas_api` are also registered
eagerly by `apps/nas-mcp/src/index.ts`, so they are directly callable even though
they remain normal shared registry definitions.

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
