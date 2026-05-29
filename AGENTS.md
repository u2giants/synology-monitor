# Synology Monitor — Agent & Developer Operating Guide

Canonical guide for AI sessions and new engineers. Read this first. Deeper
references: [docs/architecture.md](docs/architecture.md),
[docs/development.md](docs/development.md),
[docs/configuration.md](docs/configuration.md),
[docs/deployment.md](docs/deployment.md). The planned issue-agent rewrite is in
[PLAN.md](PLAN.md) (design only — not yet built).

There is no universal ignore-file standard across AI coding tools.

`.claudeignore` works for Claude Code.

When using any other AI tool, paste this file as your first message and follow the instructions in the "What to ignore" section.

## 1. Project summary

AI-assisted monitoring + remediation for two production Synology NAS boxes
(`edgesynology1`, `edgesynology2`). A Go agent on each NAS collects telemetry into
Supabase; a Next.js dashboard (live at **mon.designflow.app**) fingerprints alerts
and logs into "issues" and runs an LLM issue-agent that diagnoses problems and
proposes fixes behind an operator approval gate. A separate MCP server exposes
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
| `apps/nas-mcp` | Node/TS | VPS (Coolify) | MCP server — exposes NAS tools to AI chat clients over Streamable HTTP/SSE |
| `apps/web` | Next.js | VPS (Coolify) | Dashboard, issue detector, issue-agent loop, operator UI |
| `apps/relay` | Node (.mjs) | VPS | Narrow named-action HTTP proxy for an external (Lovable) frontend |

`packages/shared` holds shared TypeScript types (built with Turbo). **One branch:
`main`.** Push to `main` → GitHub Actions builds per-app images → web/nas-mcp
auto-redeploy via Coolify webhook; agent/nas-api are picked up by Watchtower on
each NAS within ~5 min. **Supabase** (project `qnjimovrsaacneqkggsn`) is the shared
data layer between agent (writes) and web (reads). NAS API does not touch Supabase.

## 3. Repository structure

```
apps/
  agent/        Go — collectors + DSM client + SQLite WAL sender   (we own)
  nas-api/      Go — validator (allowlist/hard-blocks) + executor  (we own)
  nas-mcp/      Node/TS — MCP server + 108-tool registry           (we own; dist/ generated)
  web/          Next.js — dashboard + issue agent                  (we own src/; .next/ generated)
  relay/        Node .mjs — named-action proxy                     (we own)
packages/shared/ shared TS types                                   (we own src/; dist/ generated)
supabase/migrations/  DB schema (00001..00035) — applied history   (we own; do not rewrite applied files)
supabase/functions/send-push/  Deno edge function                  (we own)
deploy/synology/      NAS compose + per-NAS env examples           (we own)
.github/workflows/    4 image-build workflows                      (we own)
docs/                 architecture / development / configuration / deployment / mcp-incident
scripts/              backfill-synobackup.mjs, check-dashboard-data.mjs
PLAN.md               design for the planned issue-agent rewrite
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
| Add a NAS MCP tool | `apps/nas-mcp/src/tool-definitions.ts` (def + `TOOL_GROUPS`), `apps/nas-mcp/tools-config.json` (enable) | `apps/nas-mcp/src/index.ts` (registry-driven; no registration needed) |
| Add an agent collector | `apps/agent/internal/collector/<name>.go`, wire in `apps/agent/cmd/agent/main.go` with the `wg.Add(1)` pattern | existing collectors |
| Send a new agent field to Supabase | `apps/agent/internal/sender/types.go` + a `Queue*` method, **and** a matching column via a new `supabase/migrations/*.sql` | applied migration files |
| Allow a new NAS command | `apps/nas-api/internal/validator/validator.go` (+ `validator_test.go`) | `executor.go` |
| Change issue-agent prompt/stage | `apps/web/src/lib/server/issue-stage-models.ts`, `issue-agent.ts` | `issue-detector.ts` fingerprinting |
| Change AI model per stage | Settings UI / `ai_settings` table; fallback chain in `apps/web/src/lib/server/ai-settings.ts` | hardcoded defaults |
| Add a web setting/env | `apps/web/src/app/api/settings/route.ts` (key whitelist), `docs/configuration.md` | production env directly (lives in Coolify) |
| Add a dashboard page | `apps/web/src/app/(dashboard)/<page>/page.tsx`, a hook in `src/hooks/` | — |

## 7. Data model and external identifiers

Do not casually rename or regenerate these.

| Entity / System | Identifier | Where defined | Notes |
|---|---|---|---|
| Supabase project | `qnjimovrsaacneqkggsn` | Supabase | Postgres data layer; tables are **unprefixed** (see quirk below) |
| NAS 1 (`edgesynology1`) | id `4f1d7e2a-7d5d-4d5f-8b55-0f8efb0d1001`, Tailscale `100.107.131.35`, SSH :22 | `deploy/synology/nas-1.env.example`, web `.env` | `nas_units.id` must match agent `NAS_ID` |
| NAS 2 (`edgesynology2`) | id `9dbd4646-5f4e-4fa0-8f44-1d0dbe6f1002`, Tailscale `100.107.131.36`, SSH :1904 | `deploy/synology/nas-2.env.example` | |
| NAS API port | `7734` | NAS `.env` (`NAS_API_PORT`) | HTTP over Tailscale |
| Coolify nas-mcp app | `efl17f5iocnz94840pexre9d` | **hardcoded** in `.github/workflows/nas-mcp-image.yml` | redeploy webhook target |
| Coolify web app | `${COOLIFY_WEBHOOK_UUID}` | GitHub secret (not in repo) | redeploy webhook target |
| Coolify API host | `http://178.156.180.212:8000` | both deploy workflows | VPS Coolify control plane |
| GHCR images | `ghcr.io/u2giants/synology-monitor-{agent,nas-api,nas-mcp,web}` | workflows | tags: `latest`, `sha-<sha>`, `main` |
| Public endpoints | `mon.designflow.app` (web + `/relay`), `nas-mcp.designflow.app/mcp` (+`/sse`) | Coolify/Traefik | |

## 8. Container and service inventory

| Container / service | Purpose | Managed by | App ID | Image / source |
|---|---|---|---|---|
| `synology-monitor-web` | Dashboard + issue agent | Coolify | `${COOLIFY_WEBHOOK_UUID}` (secret) | `ghcr.io/u2giants/synology-monitor-web:latest` |
| `synology-monitor-nas-mcp` | MCP server for AI chat clients | Coolify | `efl17f5iocnz94840pexre9d` | `ghcr.io/u2giants/synology-monitor-nas-mcp:latest` |
| `synology-monitor-relay` | External-client named-action proxy | Coolify (manual — see below) | — | `ghcr.io/u2giants/synology-monitor-relay` |
| `synology-monitor-agent` | Telemetry collector (per NAS) | Watchtower on NAS | — | `ghcr.io/u2giants/synology-monitor-agent:latest` |
| `synology-monitor-nas-api` | Approved-command executor (per NAS, :7734) | Watchtower on NAS | — | `ghcr.io/u2giants/synology-monitor-nas-api:latest` |
| `synology-monitor-watchtower` | Auto-updates agent + nas-api from GHCR (300s poll) | NAS compose | — | `containrrr/watchtower` |
| Supabase `qnjimovrsaacneqkggsn` | telemetry + issue tables (unprefixed) | Supabase | — | managed Postgres |

**Relay has no CI workflow** — there is no `.github/workflows/relay-*.yml`. The
relay image is not produced by the standard pipeline; it is built/deployed
manually on the VPS (see `apps/relay/OPERATIONS.md`). Treat its deploy path as
exceptional, not routine.

## 9. What to ignore

Not relevant to active development; do not read or index (already in
`.claudeignore` / `.cursorignore`): `node_modules/`, `apps/*/node_modules/`,
`.next/`, `dist/`, `apps/*/dist/`, `.turbo/`, `.cache/`, `coverage/`,
`pnpm-lock.yaml`, `package-lock.json`, `**/*.bak`, `evals/` (unless working on
agent evaluation), and the vestigial scratch file `ersahazan2Desktopsynology-monitor`.

## 10. Intentional quirks — do not "fix" these

### NAS MCP is fully stateless (per-request McpServer)
Looks like: a bug — every HTTP request builds a new `McpServer`, registers tools,
handles the request, discards. No session map.
Actually: deliberate (`sessionIdGenerator: undefined`, `enableJsonResponse: true`).
Why: Coolify restarts wipe in-memory sessions; statelessness eliminates "stale
session 404" after redeploys, and a stateless transport for `GET /mcp` without a
session ID is what stopped the claude.ai proxy's 4-minute hang (see incidents).
Do not change because: stateful mode brings back session-resume bugs and forces
dynamic tool registration that Claude clients ignore.

### NAS MCP exposes 5 tools but has a 108-tool registry
Looks like: most tools are broken/unregistered.
Actually: deliberate lazy-load. `tools/list` returns only `tool_search`,
`invoke_tool`, `run_command`, `check_disk_space`, `restart_nas_api`. Clients
discover via `tool_search`, execute via `invoke_tool({name,target,args})`.
Why: pre-loading 108 schemas put ~50k tokens into every session and degraded it
after ~10–15 calls; lazy-load keeps the always-on surface ~3k tokens.
Do not change because: it brings back session degradation. New always-on tools go
in `EAGER_TOOLS` in `index.ts`, accepting the context cost.

### `Connection: close` on every nas-api request (from nas-mcp/web)
Looks like: throws away HTTP keep-alive.
Actually: required — timed-out requests don't always return their socket to
undici's pool, so after ~10–15 calls the pool exhausts and calls hang. NAS API is
local over Tailscale (sub-ms RTT), so re-handshake cost is negligible.

### Node `keepAliveTimeout: 120s` / `headersTimeout: 125s` on nas-mcp
Set above Traefik's 90s idle timeout so Traefik never reuses a socket Node already
closed (fixed "Tool result could not be submitted").

### Sender isolates one bad row instead of failing the whole batch
Looks like: extra complexity in `apps/agent/internal/sender/sender.go` (`postRows`).
Actually: required. PostgREST inserts a batch as one statement; one bad row rejects
all rows, and after 5 retries the WAL drops them. On a 4xx the sender now re-sends
each row alone so good rows land and only the bad row is dropped.
Why: this exact failure (a constraint rejecting some rows) silently froze log/alert
ingestion for ~19h/23d (see incidents). Do not revert to all-or-nothing batches.

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
Migration 00031 renamed all `smon_*` tables to unprefixed (`smon_logs`→`nas_logs`,
others drop the prefix). Migration 00034 renamed 4 standalone functions. Two
helper functions (`smon_create_alert`, `smon_get_openai_key`) are intentionally
still `smon_`-prefixed because other functions call them by name. Historical
migrations (00002–00030) still contain `smon_` — that is applied history; do not
rewrite them.

## 11. Credentials and environment

Full reference: [docs/configuration.md](docs/configuration.md). No secret values
live in the repo (example files use placeholders; real values live in Coolify and
each NAS `.env`).

| Variable | Purpose | Stored where | Dev | Prod |
|---|---|---|---|---|
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | agent → Supabase | NAS `.env` | yes | yes |
| `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` | web client (build-time) | GitHub secrets (build args) | yes | yes |
| `SUPABASE_SERVICE_ROLE_KEY` | web server-side writes | Coolify | yes | yes |
| `DSM_URL` / `DSM_USERNAME` / `DSM_PASSWORD` | agent + nas-api WebAPI restarts | NAS `.env` | yes | yes |
| `NAS_API_SECRET` / `NAS_API_APPROVAL_SIGNING_KEY` | nas-api auth + HMAC | NAS `.env` | yes | yes |
| `NAS_EDGE{1,2}_API_URL/_SECRET/_SIGNING_KEY` | web + nas-mcp → nas-api (must match NAS `.env`) | Coolify | yes | yes |
| `MCP_BEARER_TOKEN` | nas-mcp client auth | Coolify | yes | yes |
| `OPENROUTER_API_KEY` (fallback `OPENAI_API_KEY`) | issue-agent LLM calls | Coolify | yes | yes |
| `ISSUE_WORKER_MODE` / `RUN_ISSUE_WORKER` / `ISSUE_WORKER_TOKEN` | issue worker mode/auth | Coolify | no | depends |
| `COOLIFY_TOKEN` / `COOLIFY_WEBHOOK_UUID` | CI → Coolify redeploy | GitHub secrets | n/a | n/a |
| `RELAY_BEARER_TOKEN` / `RELAY_ADMIN_SECRET` | relay auth | Coolify (relay) | — | yes |

NAS API URLs are Tailscale IPs; Tailscale must be connected for local dev.

## 12. Deployment

Push to `main` → `.github/workflows/{agent,nas-api,nas-mcp,web}-image.yml` build
and push to GHCR (each has a `paths:` filter; tags `latest`, `sha-<sha>`, `main`):

- **web** and **nas-mcp**: workflow's final step calls the Coolify redeploy webhook
  (`GET http://178.156.180.212:8000/api/v1/deploy?uuid=...` with `COOLIFY_TOKEN`).
  nas-mcp's UUID is hardcoded (`efl17f5iocnz94840pexre9d`); web's is the secret
  `COOLIFY_WEBHOOK_UUID`. Coolify pulls + recreates.
- **agent** and **nas-api**: no webhook. Watchtower on each NAS polls GHCR every
  300s and recreates the container. (`web` build args bake `NEXT_PUBLIC_SUPABASE_*`
  at image build — changing them in Coolify after build has no effect.)
- **relay**: no workflow; built/deployed manually on the VPS (exceptional path).

Runtime env lives in **Coolify** (VPS services) and each NAS `.env` (agent/nas-api).
Rollback: redeploy a previous image tag in Coolify, or pin `AGENT_IMAGE_TAG` to a
SHA on the NAS, or `git revert` + push. Public SSH on the VPS is disabled by
design — **SSH is not a routine deploy path**; manual container rebuilds create
drift and are not approved.

## 13. Critical incidents

### 2026-05-29 — Log/alert ingestion silently frozen + pg_partman broken
What happened: `nas_logs` stopped ingesting ~19h, `alerts` ~23 days, while metrics
stayed fresh. Separately, partitioning had been dead ~6 weeks (12.85M rows piled
into the default partition; no retention).
Impact: the issue agent reasoned on stale logs/alerts; unbounded default-partition
growth.
Root cause: brittle `smon_logs/alerts_source_check` whitelists rejected ~13 newer
log sources + ShareSync alert sources; one rejected row failed the whole PostgREST
batch → dropped after 5 retries. partman's `part_config` still pointed at the
pre-00031 `smon_*` parent names.
Recovery: dropped the whitelists (00035); agent stops emitting `"filter"` severity;
sender isolates bad rows (`postRows`); corrected partman config, drained the
backlog, restored retention/premake, reclaimed 3.34 GB.
Rule added: no source whitelists; the sender must isolate bad rows, never
all-or-nothing batches; treat empty/sparse tables as possible bugs, not health.

### 2026-05-29 — Live secrets found committed in example/recovery files
What happened: real NAS API secrets/signing keys, relay tokens, the Supabase
service-role key, and a NAS SSH password were committed in
`apps/relay/RECOVERY_PROMPT.md`, `apps/relay/.env.runtime`,
`scripts/backfill-synobackup.mjs`, `apps/web/.env.example`, and
`deploy/synology/nas-{1,2}.env.example`.
Impact: full NAS + Supabase access exposed in public git history.
Recovery: all values redacted to placeholders; `.env.runtime` untracked +
gitignored; hardcoded key removed from the backfill script.
Rule added: never commit real secrets to example files; **the leaked values remain
in git history and MUST be rotated** (still pending — see §14).

### 2026-05 — 4-day runaway `grep -R` on production NAS
A recursive grep against `@SynologyDriveShareSync` ran 4d11h before discovery.
Fix: validator hard-block list + process-group kill in `executor.go`.

### 2026-05 — Claude MCP sessions hanging / failing
Tool calls hung to the 4-minute client timeout or returned "Tool result could not
be submitted." Causes: claude.ai proxy's pre-init `GET /mcp` failing
`validateSession`; undici keep-alive pool exhaustion; Node keepAlive < Traefik
idle. Fix: stateless transport for GET-without-session; `Connection: close`; 25s
exec cap / 45s tool deadline; `keepAliveTimeout 120s`. Full writeup:
[docs/mcp-incident-2026-05.md](docs/mcp-incident-2026-05.md).

### 2026-05 — `check_backup_status` returning stale 2024 data
Hard-coded read of a stale `synobackup.log`. Fix: multi-path freshest-by-mtime
discovery + staleness banner.

## 14. Pending work

| Status | Item | Owner / next action |
|---|---|---|
| open | **Rotate leaked credentials** (NAS API secrets/keys, relay tokens, Supabase service-role key, NAS SSH pw) | Owner — values are in git history; regenerate in NAS `.env` + Coolify + Supabase |
| open | **Issue-agent 3-stage rewrite** (lossless structurer → cached reasoning core → explainer/memory) | Fresh coding session — build from [PLAN.md](PLAN.md) |
| open | Relay has no CI build workflow | Decide: add `.github/workflows/relay-image.yml` or document the manual path as canonical |
| low | 2 DB functions still `smon_`-prefixed (`smon_create_alert`, `smon_get_openai_key`) | Rename only with caller-body updates; low value |
| auto | 3 oldest metric partitions still `smon_`-named | Retention auto-drops them ~2026-06-27 |
| done | Ingestion fix + partman repair + smon table/function cleanup + secret redaction | Committed `b9f1c0c`, `f15822d`, `e15cbc3`, `248a3ab`; migrations 00034/00035 |

## 15. Non-negotiable rules

- Commit only to `main`; never create feature branches.
- Do not build Docker images or restart containers manually on the VPS/NAS.
- Do not hotfix the live NAS/VPS and commit after the fact.
- Do not modify Coolify runtime env from the repo side (Coolify is the source of
  truth for runtime env — see `AI_OPERATING_RULES.md`).
- Do not add a sender payload field without a matching Supabase column/migration.
- Do not interpret an empty Supabase table as a healthy subsystem — a collector may
  be hitting an unsupported DSM API. Check `nas_logs` for API-unavailable warnings.
- Do not commit real secrets, even to `*.env.example`.
- Do not undo the §10 intentional quirks without reading the linked incident first.
