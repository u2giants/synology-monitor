# Synology Monitor — Agent & Developer Operating Guide

Canonical guide for AI sessions and new engineers. Read this first. Deeper
references: [docs/architecture.md](docs/architecture.md),
[docs/development.md](docs/development.md),
[docs/configuration.md](docs/configuration.md),
[docs/deployment.md](docs/deployment.md). The 3-stage issue-agent rebuild is
complete (2026-05-30); current behavior and durable rationale live in
[docs/architecture.md](docs/architecture.md). [PLAN.md](PLAN.md) is historical.

There is no universal ignore-file standard across AI coding tools.

`.claudeignore` works for Claude Code.

When using any other AI tool, paste this file as your first message and follow the instructions in the "What to ignore" section.

## 1. Project summary

AI-assisted monitoring + remediation for two production Synology NAS boxes
(`edgesynology1`, `edgesynology2`). A Go agent on each NAS collects telemetry into
Supabase; a Next.js dashboard (live at **mon.designflow.app**) fingerprints alerts
and logs into "issues" and runs a 3-stage LLM issue-agent that diagnoses problems
and proposes fixes behind an operator approval gate. A separate MCP server exposes
NAS diagnostic/remediation tools to AI chat clients (claude.ai, Claude Desktop).
Product focus: Synology Drive / ShareSync reliability, file-operation visibility,
sync/replication failures, storage and I/O attribution, and silent task/backup
failures. The owner is a non-developer; favor changes that keep `main` the single
source of truth and are easy to audit.

## 2. Quick orientation — five components

| Component | Language | Where it runs | Purpose |
|---|---|---|---|
| `apps/agent` | Go | each NAS (Docker) | Collects telemetry, buffers in SQLite WAL, flushes to Supabase |
| `apps/nas-api` | Go | each NAS (Docker, :7734) | Three-tier approved-shell-command executor for the issue agent + MCP |
| `apps/nas-mcp` | Node/TS | VPS (Coolify) | FastMCP server — exposes a 119-definition NAS tool registry to AI chat clients over Streamable HTTP |
| `apps/web` | Next.js | VPS (Coolify) | Dashboard, issue detector, 3-stage issue-agent loop, operator UI |
| `apps/relay` | Node (.mjs) | VPS | Narrow named-action HTTP proxy for an external (Lovable) frontend |

`packages/shared` holds shared TypeScript types and the NAS tool definitions
(built with Turbo). `ALL_TOOL_DEFS` currently contains 119 registry definitions,
including `restart_nas_api`; `apps/nas-mcp/src/index.ts` eagerly registers that
tool alongside `check_disk_space`. **One branch: `main`.** Push to `main` → GitHub Actions builds
per-app images → web/nas-mcp auto-redeploy via Coolify webhook; agent/nas-api are
picked up by Watchtower on each NAS within ~5 min. **Supabase** (project
`qnjimovrsaacneqkggsn`) is the shared data layer between agent (writes) and web
(reads). NAS API does not touch Supabase.

## 3. Repository structure

```
apps/
  agent/        Go — collectors + DSM client + SQLite WAL sender   (we own)
  nas-api/      Go — validator (allowlist/hard-blocks) + executor  (we own)
  nas-mcp/      Node/TS — MCP server + 119-definition tool registry           (we own; dist/ generated)
  web/          Next.js — dashboard + issue agent                  (we own src/; .next/ generated)
  relay/        Node .mjs — named-action proxy                     (we own)
packages/shared/ shared TS types + NAS tool definitions            (we own src/; dist/ generated)
supabase/migrations/  DB schema (00001..00041) — applied history   (we own; do not rewrite applied files)
supabase/functions/send-push/  Deno edge function                  (we own)
deploy/synology/      NAS compose + per-NAS env examples           (we own)
.github/workflows/    4 image-build workflows                      (we own)
docs/                 architecture / development / configuration / deployment / mcp-incident
scripts/              backfill-synobackup.mjs, check-dashboard-data.mjs
PLAN.md               historical design doc for the completed 3-stage issue-agent rebuild
```

Generated / not-source: `apps/web/.next/`, `apps/*/dist/`, `apps/nas-mcp/dist/`,
`packages/shared/dist/`, `.turbo/`, `node_modules/`. Vendored/framework: the
Next.js runtime surface under `apps/web/.next/`. Build artifacts: image layers (in
GHCR, not the repo).

## 4. Prime directive — custom-code boundary

Our custom code lives here:

- `apps/agent/`, `apps/nas-api/`, `apps/nas-mcp/src/`, `apps/web/src/`, `apps/relay/`
- `packages/shared/src/`
- `supabase/migrations/`, `supabase/functions/`
- `deploy/synology/`, `.github/workflows/`, `docs/`, top-level `*.md`, `scripts/`

Everything else (`node_modules/`, `.next/`, `dist/`, `.turbo/`, lockfiles, the
Next.js framework surface) requires explicit justification before touching. Do not
scatter project logic into generated or framework files.

## 5. Core modification inventory

No files outside the project-owned areas (above) have been patched — there is no
forked vendor/framework code in this repo. All code is first-party; third-party
code is consumed only as dependencies (`node_modules`, Go modules) and base Docker
images. If you ever patch a vendored file, record it here.

| File | Change made | Why | Risk during upgrades |
|---|---|---|---|
| — | — | — | — |

## 6. Task-to-file navigation

| Task | Files to touch | Files NOT to touch |
|---|---|---|
| Add a NAS MCP tool | `packages/shared/src/nas-tools.ts` (def + `TOOL_GROUPS`), `apps/nas-mcp/tools-config.json` (enable) | `apps/nas-mcp/src/index.ts` (registry-driven; no registration needed) |
| Add an agent collector | `apps/agent/internal/collector/<name>.go`, wire in `apps/agent/cmd/agent/main.go` with the `wg.Add(1)` pattern | existing collectors |
| Send a new agent field to Supabase | `apps/agent/internal/sender/types.go` + a `Queue*` method, **and** a matching column via a new `supabase/migrations/*.sql` | applied migration files |
| Allow a new NAS command tier | `apps/nas-api/internal/validator/validator.go` (+ `validator_test.go`; Go/RE2 regex only, no lookaround/backrefs) | `executor.go` |
| Change an AI pipeline stage | `apps/web/src/lib/server/ai/stage{1,2,3}-*.ts`, `pipeline-v2.ts` | `issue-detector.ts` fingerprinting |
| Change AI model per stage | Settings UI (live dropdowns) → `ai_settings` table; fallback chain in `apps/web/src/lib/server/ai-settings.ts` | hardcoded defaults |
| Add a selectable model / fix its capabilities | nothing — dropdowns are live from connected providers (`provider-models.ts` → `/api/ai-models`). To **tune** a model's effort/tool-use precisely, add a row to `MODEL_CATALOG` in `packages/shared/src/ai-capabilities.ts` (overrides the heuristic) | the live-fetch list logic unless adding a provider |
| Add a new log source to the agent | `apps/agent/internal/logwatcher/watcher.go` (`defaultLogFiles`) | No source whitelist to update (migration 00035 dropped it) |
| Add an env var | `apps/web/.env.example` and `apps/web/src/app/api/settings/route.ts` if it's an AI setting, `docs/configuration.md` | production env (lives in Coolify or NAS `.env`) |
| Add a DB migration | `supabase/migrations/000NN_description.sql` — next number after current max (00041) | applied migrations |
| Add a dashboard page | `apps/web/src/app/(dashboard)/<page>/page.tsx`, hook in `src/hooks/` | — |
| Add a nightly custom command | Insert into `custom_metric_schedules` DB table with `collection_command`, `interval_minutes`, `nas_id` | — |

## 7. Data model and external identifiers

Do not casually rename or regenerate these.

| Entity / System | Identifier | Where defined | Notes |
|---|---|---|---|
| Supabase project | `qnjimovrsaacneqkggsn` | Supabase | Postgres; 53 tables total |
| NAS 1 (`edgesynology1`) | id `4f1d7e2a-7d5d-4d5f-8b55-0f8efb0d1001`, Tailscale `100.107.131.35` | `deploy/synology/nas-1.env.example` | `nas_units.id` must match agent `NAS_ID` |
| NAS 2 (`edgesynology2`) | id `9dbd4646-5f4e-4fa0-8f44-1d0dbe6f1002`, Tailscale `100.107.131.36` | `deploy/synology/nas-2.env.example` | |
| NAS API port | `7734` | NAS `.env` (`NAS_API_PORT`) | HTTP over Tailscale |
| Coolify nas-mcp app | `efl17f5iocnz94840pexre9d` | **hardcoded** in `.github/workflows/nas-mcp-image.yml` | redeploy webhook target |
| Coolify web app | `${COOLIFY_WEBHOOK_UUID}` | GitHub secret (not in repo) | redeploy webhook target |
| Coolify API host | `http://178.156.180.212:8000` | both deploy workflows | VPS Coolify control plane |
| GHCR images | `ghcr.io/u2giants/synology-monitor-{agent,nas-api,nas-mcp,web}` | workflows | tags: `latest`, `sha-<sha>`, `main` |
| Public endpoints | `mon.designflow.app` (web), `nas-mcp.designflow.app/mcp` | Coolify/Traefik | |

## 8. Container and service inventory

| Container / service | Purpose | Managed by | App ID | Image / source |
|---|---|---|---|---|
| `synology-monitor-web` | Dashboard + issue agent | Coolify | `${COOLIFY_WEBHOOK_UUID}` (secret) | `ghcr.io/u2giants/synology-monitor-web:latest` |
| `synology-monitor-nas-mcp` | MCP server for AI chat clients | Coolify | `efl17f5iocnz94840pexre9d` | `ghcr.io/u2giants/synology-monitor-nas-mcp:latest` |
| `synology-monitor-relay` | External-client named-action proxy | Coolify (manual — see below) | — | `ghcr.io/u2giants/synology-monitor-relay` |
| `synology-monitor-agent` | Telemetry collector (per NAS) | Watchtower on NAS | — | `ghcr.io/u2giants/synology-monitor-agent:latest` |
| `synology-monitor-nas-api` | Approved-command executor (per NAS, :7734) | Watchtower on NAS | — | `ghcr.io/u2giants/synology-monitor-nas-api:latest` |
| `synology-monitor-watchtower` | Auto-updates agent + nas-api from GHCR (300s poll) | NAS compose | — | `containrrr/watchtower` |
| Supabase `qnjimovrsaacneqkggsn` | Telemetry + issue tables | Supabase | — | managed Postgres |

**Relay has no CI workflow** — there is no `.github/workflows/relay-*.yml`. The
relay image is not produced by the standard pipeline; it is built/deployed manually
on the VPS. Treat its deploy path as exceptional, not routine.

## 9. What to ignore

Not relevant to active development; do not read or index (already in
`.claudeignore` / `.cursorignore` / `.copilotignore`): `node_modules/`, `apps/*/node_modules/`,
`.next/`, `dist/`, `apps/*/dist/`, `.turbo/`, `.cache/`, `coverage/`,
`*.tsbuildinfo`, `pnpm-lock.yaml`, `package-lock.json`, `**/*.bak`, `evals/` (unless working on
agent evaluation), and the vestigial scratch file `ersahazan2Desktopsynology-monitor`.

## 10. Intentional quirks — do not "fix" these

### NAS MCP is fully stateless (FastMCP HTTP Stream)
Looks like: a bug — the server refuses to rely on persistent MCP session state.
Actually: deliberate. `apps/nas-mcp` uses TypeScript FastMCP with
`transportType: "httpStream"` and `stateless: true`.
Why: Coolify restarts wipe in-memory sessions; statelessness eliminates stale
session problems after redeploys, and avoids the claude.ai proxy's old 4-minute
hang class (see incidents).
Do not change because: stateful mode brings back session-resume bugs and forces
dynamic tool registration that Claude clients ignore.

### NAS MCP exposes 7 small tools but has a 119-definition registry
Looks like: most tools are broken/unregistered.
Actually: deliberate lazy-load. `tools/list` returns only `list_capabilities`,
`get_capability_details`, `tool_search`, `invoke_tool`, `run_command`,
`check_disk_space`, and `restart_nas_api`. Clients browse/search/detail on demand
and execute via `invoke_tool({name,target,args})`.
Why: pre-loading 119 schemas put ~50k tokens into every session and degraded it
after ~10–15 calls; lazy-load keeps the always-on surface compact.
Do not change because: it brings back session degradation. New always-on tools go
in `EAGER_TOOLS` in `index.ts`, accepting the context cost.

`tools-config.json` enables a subset of the 119 shared definitions. Always-on does
not mean separate from the registry: `check_disk_space` and `restart_nas_api` are
shared definitions that `apps/nas-mcp/src/index.ts` registers eagerly.

### `Connection: close` on every nas-api request (from nas-mcp/web)
Looks like: throws away HTTP keep-alive.
Actually: required — timed-out requests don't return their socket to undici's pool,
so after ~10–15 calls the pool exhausts and calls hang. NAS API is local over
Tailscale (sub-ms RTT), so re-handshake cost is negligible.

### Sender isolates one bad row instead of failing the whole batch
Looks like: extra complexity in `apps/agent/internal/sender/sender.go` (`postRows`).
Actually: required. PostgREST inserts a batch as one statement; one bad row rejects
all rows, and after 5 retries the WAL drops them. On a 4xx the sender re-sends each
row individually so good rows land and only the bad row is dropped.
Why: this exact failure silently froze log/alert ingestion for ~19h/23d (see
incidents). Do not revert to all-or-nothing batches.

### No source whitelist on `nas_logs` / `alerts`
Looks like: missing validation.
Actually: the `*_source_check` CHECK constraints were dropped (migration 00035).
They had to be hand-expanded every time a collector added a source and caused the
ingestion outage. The agent governs what it writes; the sender isolates bad rows.
Do not re-add a source whitelist.

### `check_backup_status` enumerates ~7 candidate log paths
Deliberate. On one NAS the canonical `synobackup.log` was stale (2024) while the
live log was in a per-task target dir. The tool lists every candidate with
mtime+size, tails the freshest, shows a staleness banner. A single-path bet returns
false-positive stale data.

### NAS API package restarts use the DSM WebAPI, not `synoservice`
`synoservice` was removed in DSM 7; restarts go through `SYNO.Core.Package`
stop+start, requiring `DSM_USERNAME`/`DSM_PASSWORD` in the NAS `.env`.

### Recursive grep on `@synologydrive` / `@SynologyDriveShareSync` is hard-blocked
A `grep -R` against Synology's internal stores ran 4d11h on production before
discovery. Blocked at the validator regardless of tier (see incidents).

### Executor kills the process group, not just bash
`Setpgid: true` + `syscall.Kill(-pid, SIGKILL)` + `WaitDelay: 2s`.
`exec.CommandContext` only kills the direct bash child, so `grep ... | head`
orphans `grep` on timeout. Combined with the hard-block, prevents the runaway.

### Collector goroutines must use the WaitGroup pattern
`wg.Add(1)` + `defer wg.Done()`. Without it, graceful shutdown returns before the
collector finishes, dropping in-flight WAL writes (the ShareSync collector had this
bug, commit `268b9c9`).

### `package_status` is the only merge-duplicates upsert
It's current-state (one row per NAS+package). All other telemetry tables are
append-only inserts.

### DB tables are unprefixed; two functions still carry `smon_`
Migration 00031 renamed all `smon_*` tables. Migration 00034 renamed 4 standalone
functions. Two helper functions (`smon_create_alert`, `smon_get_openai_key`) are
intentionally still `smon_`-prefixed because other functions call them by name.
Historical migrations (00002–00030) still contain `smon_` — do not rewrite them.

### HMAC approval tokens are never persisted
Stage 2 persists the action intent (command, tier, target, summary) but **never
the HMAC token**. The token is minted fresh at execution time in
`pipeline-v2.ts::executeApprovedAction`. Persisting tokens would cause 403s after
the 15-min expiry — the operator's approval window is often hours.

### NAS API requires `apparmor=unconfined` + `SYS_ADMIN`
Looks like: insecure container config.
Actually: required by DSM. Synology's container runtime rejects the default
AppArmor profile during init; `SYS_ADMIN` is required for `btrfs subvolume list`,
scrub, and snapshot operations. DSM constraint, not a choice.

### NAS API has `SYS_PTRACE` but `gdb` and `lldb` are hard-blocked
Looks like: contradictory — why grant ptrace and then block it?
Actually: `strace` and `/proc/PID/stack` (already readable with `SYS_ADMIN`) are the
safe ptrace operations. `gdb`/`lldb` are blocked because they can call arbitrary
functions in a traced process via `call system(...)` — a code-injection vector.
`strace_process` uses `-c` count mode only (syscall summary, no argument printing)
so no sensitive data is printed.
Do not change because: removing the `gdb`/`lldb` hard-blocks would allow an
AI-generated command to inject arbitrary code into live DSM processes.

### `/dev/sd*` and `/dev/md*` are individually named mounts, not the full `/dev` tree
Looks like: there should just be `- /dev:/dev:ro`.
Actually: individual named mounts (`/dev/sda:/dev/sda:ro`, ..., `/dev/md3:/dev/md3:ro`).
Why: Docker bind-mounts the source device at container start. If a source device
doesn't exist (empty drive bay), the compose `up` fails for the whole service.
Individual mounts let you comment out non-existent bays.
Do not change because: mounting the full `/dev` tree read-only would still expose
`/dev/mem`, `/dev/kmem`, and other sensitive kernel interfaces.

### Watchtower updates images but NOT compose configuration
Looks like: after pushing `docker-compose.agent.yml` changes to `main`, the NAS
containers will pick them up like code changes.
Actually: Watchtower pulls the new image and restarts with the **existing compose
state** — it reads the current in-memory config, not the file on disk. New
capabilities (`cap_add`), volume mounts, env keys, etc. do not take effect until
`docker compose up -d` is run manually on the NAS with the updated compose file.
Do not assume because: this is how Docker Compose restart semantics work — container
recreation from a new image uses the last-applied compose spec, not the repo copy.

### AI-stage model dropdowns are live; `MODEL_CATALOG` is an override, not the menu
Looks like: `MODEL_CATALOG` in `packages/shared/src/ai-capabilities.ts` is the list
of selectable models, so a model missing from it (e.g. a new DeepSeek release)
can't be picked.
Actually: since 2026-06-02 the dropdowns are populated **live** from every connected
provider's list-models endpoint (`apps/web/src/lib/server/ai/provider-models.ts`,
served by `/api/ai-models`). `MODEL_CATALOG` is now a precise-metadata override +
offline/no-keys fallback. Catalog-miss ids get a *derived* descriptor (provider by
id prefix, cache style by provider, effort/tool-use by conservative id heuristics);
`callModel` resolves `catalog → derived → live-map` and only fails when no connected
provider offers the id.
Why: the curated list silently excluded any model not hand-added; the operator asked
for every connected provider's models to be selectable.
Do not change because: deleting `MODEL_CATALOG` or re-gating the dropdown to it
breaks precise effort/cache/tool-use metadata for the curated models and the
offline fallback. A selected model whose capabilities are derived is flagged with an
amber "inferred model" warning in the UI; to tune it exactly, add a catalog row.

### `issue_evidence` and `issue_evidence_items` are different tables
Looks like: `issue_evidence_items` is just the renamed `issue_evidence`.
Actually: entirely different purposes.
- `issue_evidence` (created 00022): curated human-readable notes (title/detail)
  written by the copilot, resolution API, and `seedIssueFromOrigin`.
- `issue_evidence_items` (created 00038): the lossless telemetry store for the
  3-stage pipeline. Written by Stage 1 and Stage 2 tool calls.
Do not query the wrong one for a given context.

### Drive client logs are at `/host/shares/@synologydrive/log/`
Looks like: the logwatcher's `WATCH_PATHS` default (`/host/volume1`) should cover
Drive logs.
Actually: the agent compose mounts `@synologydrive` at `/host/shares/@synologydrive`
(not under `/host/volume1`). `inferDriveLogFiles` prepends `/host/shares` first so
the glob resolves. The old watch-path attempt is kept as a harmless fallback.

### `drive_team_folders_partitioned` has no child partitions and receives no writes
Looks like: dead schema artifact.
Actually: forward infrastructure for pg_partman partition management when
`drive_team_folders` grows large enough. No child partitions created yet.
Do not drop it.

### `analyzeRecentLogs` (log-analyzer.ts) has no callers
Looks like: dead function.
Actually: orphaned when `/api/analysis` was rewritten to use `runIssueDetection`.
The `analysis_runs` and `analyzed_problems` tables remain for a potential future
AI clustering layer. The three former readers were migrated to `issues` (2026-05-31).

### `getSecondOpinionModel` and `getClusterModel` are exported but have no callers
Looks like: dead exports.
Actually: planned features. `getSecondOpinionModel` is for a second AI model
cross-checking Stage 2 diagnoses; it is explicitly deferred.
`getClusterModel` is the intended abstraction for `log-analyzer.ts`. Keep both.

### `/host/*` paths in agent container
Looks like: wrong paths.
Actually: the agent runs in Docker. The NAS host `/proc`, `/sys`, `/var/log` are
mounted read-only at `/host/proc`, `/host/sys`, `/host/log`. Shared folders are
at `/host/shares/<name>`. The `/host/` prefix keeps host and container namespaces
distinct. See `deploy/synology/docker-compose.agent.yml`.

### NAS API mount layout is not the same as the agent mount layout
Looks like: a read-only diagnostic should find DSM package files at
`/host/var/packages` or snapshots under `/volume1`.

Actually: the NAS API compose mounts host `/var/packages` at `/host/packages`, not
`/host/var/packages`. Full Btrfs data volumes are mounted at `/btrfs/volumeN` for
subvolume/snapshot commands; individual shared folders are mounted separately
under `/volume1/<share>` and may not expose system snapshot directories.

Why: Synology Container Manager rejects some top-level volume binds during
compose/UI recreates. The compose file uses narrower named mounts for shares,
package state, host libraries, and Btrfs volumes.

Do not change because: tools that only check `/volume1` or `/host/var/packages`
will miss Snapshot Replication state and scheduler/package artifacts on one NAS.
Read-only tools should check `/host/packages` and `/btrfs/volumeN`, and may use
DSM WebAPI read methods as a fallback when SQLite/config paths are not mounted.

## 11. Credentials and environment

Full reference: [docs/configuration.md](docs/configuration.md). No secret values
live in the repo (example files use placeholders; real values live in Coolify and
each NAS `.env`).

| Variable | Purpose | Stored where | Dev | Prod |
|---|---|---|---|---|
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Agent → Supabase | NAS `.env` | yes | yes |
| `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` | Web client (build-time bake) | GitHub secrets (build args) | yes | yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Web server-side writes | Coolify | yes | yes |
| `DSM_URL` / `DSM_USERNAME` / `DSM_PASSWORD` | Agent DSM API + nas-api WebAPI restarts | NAS `.env` | yes | yes |
| `NAS_API_SECRET` / `NAS_API_APPROVAL_SIGNING_KEY` | Nas-api auth + HMAC | NAS `.env` | yes | yes |
| `NAS_EDGE{1,2}_API_URL/_SECRET/_SIGNING_KEY` | Web + nas-mcp → nas-api | Coolify | yes | yes |
| `MCP_BEARER_TOKEN` | Nas-mcp client auth | Coolify | yes | yes |
| `ANTHROPIC_API_KEY` | Stage 2 reasoning (Anthropic/Claude) | Coolify | yes | yes |
| `OPENAI_API_KEY` | Stage 1/3 + copilot fallback | Coolify | yes | yes |
| `GEMINI_API_KEY` | Gemini provider — **seeded default for Stage 1 & 3**; selectable for any stage; key also lists Gemini models in the live dropdowns (`GOOGLE_API_KEY` accepted) | Coolify | yes (for seeded defaults) | yes (for seeded defaults) |
| `DEEPSEEK_API_KEY` | DeepSeek provider — selectable for any stage; key lists DeepSeek models in the live dropdowns | Coolify | optional | optional |
| `DASHSCOPE_API_KEY` | Qwen/DashScope provider — selectable for any stage; key lists Qwen (and DashScope-hosted) models in the live dropdowns | Coolify | optional | optional |
| `OPENROUTER_API_KEY` | Copilot chat + the copilot model-picker (`/api/models`). NOT the 3-stage AI-stage dropdowns, which fetch each connected provider directly | Coolify | yes | yes |
| `ISSUE_WORKER_MODE` / `RUN_ISSUE_WORKER` / `ISSUE_WORKER_TOKEN` | Issue worker mode/auth | Coolify | no | depends |
| `COOLIFY_TOKEN` / `COOLIFY_WEBHOOK_UUID` | CI → Coolify redeploy | GitHub secrets | n/a | n/a |

NAS API URLs are Tailscale IPs; Tailscale must be connected for live NAS calls.

## 12. Deployment

Push to `main` → `.github/workflows/{agent,nas-api,nas-mcp,web}-image.yml` build
and push to GHCR (each has a `paths:` filter; tags `latest`, `sha-<sha>`, `main`):

- **web** and **nas-mcp**: workflow's final step calls the Coolify redeploy webhook
  (`GET http://178.156.180.212:8000/api/v1/deploy?uuid=...` with `COOLIFY_TOKEN`).
  nas-mcp UUID is hardcoded (`efl17f5iocnz94840pexre9d`); web's is `$COOLIFY_WEBHOOK_UUID`.
- **agent** and **nas-api**: no webhook. Watchtower polls GHCR every 300s and
  recreates. `NEXT_PUBLIC_SUPABASE_*` is baked at image build — changing it in
  Coolify after build has no effect; requires a new push to `main`.
- **relay**: no workflow; built/deployed manually on the VPS (exceptional).

Runtime env lives in **Coolify** (VPS) and each NAS `.env` (agent/nas-api).
Rollback: redeploy a previous tag in Coolify, or pin `AGENT_IMAGE_TAG` to a SHA
on the NAS, or `git revert` + push. **SSH is not a routine deploy path** — public
SSH on the VPS is disabled by design; manual container rebuilds create drift.

## 13. Critical incidents

### 2026-05-29 — Log/alert ingestion silently frozen + pg_partman broken
What happened: `nas_logs` stopped ingesting ~19h, `alerts` ~23 days.
Root cause: source-check whitelists rejected newer log sources; one bad row failed
the whole PostgREST batch → dropped after 5 retries. partman config pointed at
pre-rename `smon_*` parent names.
Recovery: dropped whitelists (migration 00035); sender now isolates bad rows;
corrected partman, reclaimed 3.34 GB.
Rule: no source whitelists; sender must isolate bad rows; empty tables are bugs.

### 2026-05-29 — Live secrets found committed in example/recovery files
What happened: real NAS API secrets, relay tokens, Supabase service-role key,
NAS SSH password committed in example and recovery files.
Recovery: values redacted; `.env.runtime` gitignored.
Rule: never commit real secrets. **Leaked values remain in git history and MUST
still be rotated by the owner.**

### 2026-05 — 4-day runaway `grep -R` on production NAS
Fix: validator hard-block list + process-group kill in `executor.go`.

### 2026-05 — Claude MCP sessions hanging / failing
Fix: stateless transport; `Connection: close`; bounded NAS API calls; 45s MCP tool deadline.
Full writeup: [docs/mcp-incident-2026-05.md](docs/mcp-incident-2026-05.md).

### 2026-06 — NAS API crash-loop from invalid Go regexp
Cause: validator used PCRE-style negative lookahead `(?!...)` inside
`regexp.MustCompile`; Go RE2 does not support lookaround, so `nas-api` panicked
at startup after Watchtower pulled the image. Symptom: MCP calls returned
`ECONNREFUSED` to both NAS `:7734` endpoints. Fix: use RE2-safe positive regexes
or Go helper code, add validator tests for both match and exception cases, then
verify `/health` on both NASes after `nas-api-image.yml` publishes.

### 2026-06 — Read-only MCP probes missed DSM 7/NAS API paths
What happened: `check_scheduled_tasks`, `list_snapshot_candidates`, and
`inspect_snapshot_replication` were safe to run but reported missing data because
they only checked legacy or agent-style paths.
Impact: AI sessions could not confirm DSM scheduled tasks or Snapshot Replication
schedule/retention rules even though the package/runtime existed.
Root cause: NAS API mount layout differs from the telemetry agent: package state is
under `/host/packages`, and the full Btrfs volume is under `/btrfs/volumeN`.
Recovery: widened read-only path discovery, opened SQLite with `-readonly`, added
DSM WebAPI read fallbacks for task and Snapshot/Replication API discovery, and
kept writes/start/cancel operations separate.
Rule added to prevent recurrence: read-only NAS tools must be narrow and
allowlisted, but they must cover the actual compose mounts before assuming DSM data
is absent.

### 2026-06 — Snapshot Replication probe exceeded NAS API command limit
What happened: `inspect_snapshot_replication` was read-only, but it bundled too
much DSM WebAPI/config/SQLite discovery into one generated shell probe. The NAS
API rejects commands over 4096 bytes, so the MCP tool failed before reaching
either NAS.
Recovery: keep `inspect_snapshot_replication` as a compact first-pass probe and
push deeper follow-up into separate read-only tools such as
`summarize_snapshots_by_share`, `check_scheduled_tasks`, and `fetch_package_db`.
Rule added to prevent recurrence: every generated NAS MCP command must stay under
the NAS API `maxCommandLength`; split broad diagnostics into smaller named tools
instead of raising the limit or packing everything into one shell command.

### 2026-05 — `check_backup_status` returning stale 2024 data
Fix: multi-path freshest-by-mtime discovery + staleness banner.

## 14. Pending work

| Status | Item | Owner / next action |
|---|---|---|
| **open** | **Rotate leaked credentials** (NAS API secrets, relay tokens, Supabase service-role key, NAS SSH password) | Owner — values remain in git history |
| open | `analyzeRecentLogs` caller: decide whether to keep AI log clustering as a background job | Owner decision — readers already migrated to `issues` (2026-05-31) |
| open | `second_opinion_model`: wire a second AI model cross-check into Stage 2 | Future session — see `getSecondOpinionModel()` in `ai-settings.ts` |
| open | `drive_team_folders` reader: web app never queries team folder data | Future session |
| open | `issue_resolutions` / `resolution_steps` / `resolution_log` / `resolution_messages`: confirmed superseded, not yet dropped | Owner confirm → migration 00042 |
| open | Relay has no CI build workflow | Decide: add workflow or document manual path as canonical |
| low | 2 DB functions still `smon_`-prefixed (`smon_create_alert`, `smon_get_openai_key`) | Low value; rename with caller updates |
| **open** | **Manual `docker compose up -d` on each NAS** — `SYS_PTRACE` + `/dev/sd*` mounts in `docker-compose.agent.yml` require a manual compose recreate; Watchtower will not apply these | Owner — run on each NAS after pulling new compose file |
| done | 3-stage issue-agent rebuild (structurer → reasoning core → explainer/memory) | Completed 2026-05-30 |
| done | `disk_inflight_ios` metric, Drive client log fix, Stage 2 `run_command` tool, nightly disk health schedules | 2026-05-31 |
| done | `backend-findings.ts` + `buildProblemPrompt` + `resolution/create` migrated from `analyzed_problems` to `issues` | 2026-05-31 |
| done | Ingestion fix + partman repair + smon cleanup + secret redaction | Migrations 00034/00035 |
| done | Deep iowait diagnostics: 9 new MCP tools (PSI, I/O scheduler, NFS client, strace, per-process IO detail, hdparm, set_io_scheduler, set_vm_dirty_ratios, set_ionice), Stage 1 evidence body fix, Stage 2 NAS taxonomy expansion, Metrics page Device Saturation + Container I/O + D-state + per-CPU iowait sections, `SYS_PTRACE` + individual `/dev` mounts in NAS API compose | 2026-06-01 |
| done | Safe read-only MCP expansion: unblocked diagnostics, hardened validator regexes, restored NAS API containers, widened DSM 7 scheduler/snapshot discovery, and added Snapshot Replication read-only WebAPI/config discovery | Commits `ff73e58`, `a2ce0bd`, `2ad8f52`, `93b82b2` |
| done | Compact `inspect_snapshot_replication` so the generated NAS API command stays under the 4096-byte `maxCommandLength`; split deeper work into separate read-only tools | Commit `d65047a` |
| done | De-curate AI-stage model dropdowns: live per-provider model lists (`provider-models.ts` → `/api/ai-models`), `MODEL_CATALOG` demoted to metadata override + fallback, runtime resolves `catalog → derived → live-map`, "inferred model" UI warning | Commits `4f8ee0e`, `4ea43f3` (2026-06-02) |

## 15. Non-negotiable rules

- Commit only to `main`; never create feature branches.
- Do not build Docker images manually on the VPS/NAS. Container restarts or
  `docker compose up -d` are exceptional recovery/config-application steps only
  (for example, applying compose mount/capability changes or recovering a crashed
  NAS API) and must be reflected in the repo/docs.
- Do not hotfix the live NAS/VPS and commit after the fact.
- Runtime env changes belong in Coolify — apply them directly through the Coolify API or UI. Do not route them through GitHub Actions shell commands, SSH, or server-side scripts (see `AI_OPERATING_RULES.md`).
- Do not add a sender payload field without a matching Supabase column/migration.
- Do not interpret an empty Supabase table as a healthy subsystem — a collector may
  be hitting an unsupported DSM API. Check `nas_logs` for API-unavailable warnings.
- Do not commit real secrets, even to `*.env.example`.
- Do not undo the §10 intentional quirks without reading the linked incident first.
