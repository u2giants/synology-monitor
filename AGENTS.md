# Synology Monitor — Architecture Reference

Primary operating guide for AI sessions and new engineers. Full system docs in [docs/architecture.md](docs/architecture.md), [docs/development.md](docs/development.md), [docs/configuration.md](docs/configuration.md), [docs/deployment.md](docs/deployment.md).

There is no universal ignore-file standard across AI coding tools.

`.claudeignore` works for Claude Code.

When using any other AI tool, paste this file as your first message and follow the instructions in the "What to ignore" section.

## 1. Project summary

AI-assisted monitoring + remediation for two production Synology NAS boxes. The agent on each NAS collects telemetry into Supabase; the Next.js dashboard fingerprints alerts into issues and runs an LLM-driven issue agent that proposes fixes through an operator approval gate. A separate MCP server exposes diagnostic + remediation tools to AI chat clients (claude.ai, Claude Desktop).

The product focus is Synology Drive / ShareSync reliability, file operation visibility, sync/replication failures, storage and I/O attribution, and silent task/backup failures.

## 2. Quick orientation

Five components:

| Component | Language | Where it runs | Purpose |
|---|---|---|---|
| `apps/agent` | Go | Each NAS (Docker) | Collects telemetry, pushes to Supabase |
| `apps/nas-api` | Go | Each NAS (Docker) | Executes approved shell commands for the issue agent + MCP |
| `apps/nas-mcp` | Node.js | VPS (Docker) | MCP server — exposes NAS tools to AI chat clients over Streamable HTTP/SSE |
| `apps/web` | Next.js | VPS (Docker via Coolify) | Dashboard, issue agent loop, operator UI |
| `apps/relay` | Node.js | VPS (Docker) | Relay for external clients |

**One branch: `main`.** Push to `main` → GitHub Actions builds images → Coolify deploys web/nas-mcp automatically → agent/nas-api images are picked up by Watchtower on each NAS within 5 minutes and containers are automatically recreated.

**Supabase** (`smon_*` tables) is the shared data layer between agent and web. NAS API does not touch Supabase.

## 3. Prime directive — custom-code boundary

Project-owned code lives here:

- `apps/agent/` — Go collectors + sender (we own)
- `apps/nas-api/` — Go validator + executor (we own)
- `apps/nas-mcp/` — Node.js MCP server + tool registry (we own)
- `apps/web/src/` — Next.js app code (we own)
- `apps/relay/` — Node.js relay (we own)
- `deploy/synology/` — NAS-side compose + env templates
- `supabase/migrations/` — DB schema
- `docs/`, top-level `*.md`, `.github/workflows/`

Everything else (`node_modules/`, `.next/`, `dist/`, `apps/web/node_modules/@synology-monitor/`, the Next.js framework surface) requires explicit justification before touching.

## 4. Key files

### Agent
- Entry: `apps/agent/cmd/agent/main.go`
- Collectors: `apps/agent/internal/collector/*.go` (full inventory in `docs/architecture.md`)
- WAL + sender: `apps/agent/internal/sender/`
- DSM API client: `apps/agent/internal/dsm/client.go`
- Config: `apps/agent/internal/config/config.go`

### NAS API
- Validator (allowlist + hard-blocks): `apps/nas-api/internal/validator/validator.go`
- Executor (process-group kill, timeout): `apps/nas-api/internal/executor/executor.go`
- Auth (HMAC, bearer): `apps/nas-api/internal/auth/auth.go`

### NAS MCP
- Server entry + always-on tools: `apps/nas-mcp/src/index.ts`
- Tool registry (108 defs): `apps/nas-mcp/src/tool-definitions.ts`
- Group taxonomy + search helpers: `TOOL_GROUPS`, `KEYWORD_TO_GROUPS`, `searchTools`, `formatToolForSearch`, `findToolByName` (same file)
- NAS HTTP client: `apps/nas-mcp/src/nas-client.ts`
- Enablement gates: `apps/nas-mcp/tools-config.json`

### Web
- Issue agent loop: `apps/web/src/lib/server/issue-agent.ts`
- Issue detector: `apps/web/src/lib/server/issue-detector.ts`
- NAS tools: `apps/web/src/lib/server/tools.ts`
- NAS API client: `apps/web/src/lib/server/nas-api-client.ts`
- Job workflow: `apps/web/src/lib/server/issue-workflow.ts`
- Facts: `apps/web/src/lib/server/fact-store.ts`
- Forensics: `apps/web/src/lib/server/forensics-drive.ts`, `forensics-hyperbackup.ts`

## 5. Task-to-file navigation

| Task | Files to touch | Files not to touch |
|---|---|---|
| Add a NAS MCP tool | `apps/nas-mcp/src/tool-definitions.ts` (def), `apps/nas-mcp/tools-config.json` (enable), `apps/nas-mcp/src/tool-definitions.ts` `TOOL_GROUPS` (tag) | `apps/nas-mcp/src/index.ts` (no registration needed — registry-driven) |
| Add an agent collector | `apps/agent/internal/collector/<name>.go`, wire in `apps/agent/cmd/agent/main.go` with `wg.Add(1)` pattern | existing collectors |
| Allow a new NAS command | `apps/nas-api/internal/validator/validator.go` + `validator_test.go` | `executor.go` |
| Add a Supabase column | `supabase/migrations/<new>.sql`, matching `sender/types.go` payload field | applied migration files |
| Change issue agent prompt | `apps/web/src/lib/server/issue-agent.ts` | `issue-detector.ts` fingerprinting |
| Update MCP tool grouping | `TOOL_GROUPS` map in `apps/nas-mcp/src/tool-definitions.ts` | tool defs themselves |

## 6. Container and service inventory

| Container / service | Purpose | Managed by | Image / source |
|---|---|---|---|
| `synology-monitor-web` | Dashboard + issue agent | Coolify | `ghcr.io/u2giants/synology-monitor-web:latest` |
| `synology-monitor-nas-mcp` | MCP server for AI chat clients (Coolify app `efl17f5iocnz94840pexre9d`) | Coolify | `ghcr.io/u2giants/synology-monitor-nas-mcp:latest` |
| `synology-monitor-relay` | External-client relay | Coolify | `ghcr.io/u2giants/synology-monitor-relay:latest` |
| `synology-monitor-agent` | Telemetry collector — runs on each NAS | Watchtower on NAS | `ghcr.io/u2giants/synology-monitor-agent:latest` |
| `nas-api` | Approved-command executor — runs on each NAS, port 7734 | Watchtower on NAS | `ghcr.io/u2giants/synology-monitor-nas-api:latest` |
| Supabase project `qnjimovrsaacneqkggsn` | `smon_*` tables — shared data layer | Supabase | managed Postgres |

## 7. What to ignore

Not relevant to active development; AI sessions should not read or index:

- `node_modules/`, `apps/*/node_modules/`
- `.next/`, `dist/`, `apps/*/dist/`
- `.turbo/`, `.cache/`
- `*.bak` files (e.g. `apps/nas-mcp/src/index.ts.20260422-130635.bak`)
- `pnpm-lock.yaml`, `package-lock.json`
- `ersahazan2Desktopsynology-monitor` (vestigial scratch file at repo root — leave untouched)
- `evals/` unless explicitly working on agent evaluation

## 8. Intentional quirks — do not "fix" these

### NAS MCP is fully stateless (per-request McpServer)

Looks like: a bug — every HTTP request creates a new `McpServer`, registers tools, handles the request, discards. No session map.

Actually: deliberate. Coolify restarts wipe in-memory sessions; statelessness eliminates "stale session 404" failures after every redeploy.

Why: `apps/nas-mcp/src/index.ts` comment at the `/mcp` handler captures the trade-off. Set `sessionIdGenerator: undefined`, `enableJsonResponse: true`.

Do not change because: making it stateful brings back session-resume bugs across deploys and forces the dynamic-tool-registration path that Claude clients do not honor anyway (they cache the initial `tools/list` and ignore `tools/list_changed` notifications).

### NAS MCP exposes only 5 tools but has a 108-tool registry

Looks like: most tools are unregistered / broken. `tools/list` only returns `tool_search`, `invoke_tool`, `run_command`, `check_disk_space`, `restart_nas_api`.

Actually: deliberate lazy-load surface. The full registry lives in `ALL_TOOL_DEFS`. Clients discover by calling `tool_search`, then execute by calling `invoke_tool({ name, target, args })`.

Why: pre-loading 108 schemas into Claude's context window degraded sessions after ~10–15 tool calls. The lazy-load cuts the always-loaded surface from ~50k tokens to ~3k.

Do not change because: undoing it brings session degradation back. If you need a new always-on tool, add it to `EAGER_TOOLS` in `index.ts` and accept the context cost.

### `Connection: close` on every nas-api request

Looks like: terrible practice; loses HTTP keep-alive.

Actually: required. Requests that time out don't always return their connection to undici's pool cleanly, so after ~10–15 tool calls in a session the pool exhausts and new calls hang. The NAS API is local over Tailscale (sub-ms RTT), so re-handshake cost is negligible.

Do not change because: this was the root cause of the "works early, fails later" session-degradation pattern (commit `a0362da`).

### Node `keepAliveTimeout: 120s` and `headersTimeout: 125s`

Looks like: arbitrarily large numbers.

Actually: set above Traefik's 90s idle timeout. If Node closes first, Traefik tries to reuse a dead socket and the client sees "connection interrupted."

Do not change because: this was the cause of the "Tool result could not be submitted" error fixed in commit `7234d9e`.

### `check_backup_status` enumerates ~7 candidate log paths instead of one

Looks like: redundant — pick the canonical path.

Actually: deliberate. On at least one NAS the canonical `/host/log/synolog/synobackup.log` was stale (2024 entries), while the live log was in a per-task dir under `/host/var/packages/HyperBackup/target/`. The tool now lists every candidate with mtime + size, picks the freshest as the tail source, and shows a staleness banner.

Do not change because: a single-path bet returns false-positive stale data; the multi-path discovery is the bug fix.

### NAS API package restarts call DSM WebAPI, not `synoservice`

Looks like: over-engineered.

Actually: `synoservice` was removed in DSM 7. Package restarts must go through `SYNO.Core.Package` stop+start. Requires `DSM_USERNAME` + `DSM_PASSWORD` in the NAS `.env`.

### Recursive grep on `@synologydrive` is hard-blocked at the validator

Looks like: an arbitrary deny rule.

Actually: a `grep -R` against Synology's internal stores ran for 4 days 11 hours on a production NAS in May 2026 before discovery. Those dirs contain millions of opaque blobs; recursive grep never returns useful results and thrashes disk I/O. Blocked regardless of tier.

### Web app uses `merge-duplicates` upsert only for `smon_package_status`

Looks like: inconsistent table semantics.

Actually: `smon_package_status` is current-state (one row per NAS+package), not time-series. All other `smon_*` tables are append-only inserts.

### Agent collector goroutines must use the WaitGroup pattern

Looks like: ceremony.

Actually: without `wg.Add(1)` + `defer wg.Done()`, graceful shutdown returns before the collector finishes, dropping in-flight WAL writes. The ShareSync collector had this bug until commit `268b9c9` (May 2026).

### `GET /mcp` without `Mcp-Session-Id` uses a stateless transport

Looks like: a special case tucked into the `/mcp` handler that creates a second kind of transport.

Actually: the claude.ai proxy sends a `GET /mcp` without a session ID to open a standalone SSE notification stream before making any tool calls. The server creates a stateless transport (`sessionIdGenerator: undefined`) for exactly this path, which causes the MCP SDK to skip `validateSession`. The POST tool-call path is unchanged.

Why: when the server previously routed this GET into a normal stateful session (which had never received `initialize`), `validateSession` returned `400 Bad Request: Server not initialized`. The claude.ai proxy treated this as a fatal connection failure, never proceeded to call tools, and the client waited the full 4-minute timeout. Fix: commit `336348d` (validator portion), correctly re-implemented May 14 2026 and deployed directly. See `docs/mcp-incident-2026-05.md`.

Do not change because: removing the stateless branch for this path causes the 4-minute hang to return. The stateless path is safe — the server never pushes events through it.

### NAS API executor kills the process group, not just bash

Looks like: unusual `Setpgid` + `syscall.Kill(-pid, SIGKILL)` setup.

Actually: `exec.CommandContext` only kills the direct bash child on context expiry — not the subprocess tree. Without process-group kill, `grep ... | head -50` orphans `grep` when the timeout fires. Combined with the hard-block list this prevents the 4-day runaway.

## 9. Credentials and environment

Full reference in [docs/configuration.md](docs/configuration.md). Quick map:

| Variable | Used by | Stored in |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | agent, web | Coolify env / NAS `.env` |
| `DSM_URL`, `DSM_USERNAME`, `DSM_PASSWORD` | agent, nas-api (for WebAPI restarts) | NAS `.env` |
| `NAS_EDGE{1,2}_API_URL`, `_API_SECRET`, `_API_SIGNING_KEY` | web, nas-mcp | Coolify env |
| `NAS_API_SECRET`, `NAS_API_APPROVAL_SIGNING_KEY` | nas-api | NAS `.env` (must match web/mcp values) |
| `MCP_BEARER_TOKEN` | nas-mcp clients | Coolify env |
| `ISSUE_WORKER_MODE` (`inline` / `background`) | web | Coolify env |
| `COOLIFY_TOKEN` | GH Actions | GitHub repo secrets |

NAS API URLs are Tailscale IPs (`100.107.131.35`, `100.107.131.36`). Tailscale must be connected for local dev.

## 10. Deployment

The one normal path:

1. Edit files. Commit to `main`.
2. GitHub Actions builds and pushes images to GHCR:
   - `apps/agent/**` → `.github/workflows/agent-image.yml` → `synology-monitor-agent:latest`
   - `apps/nas-api/**` → `.github/workflows/nas-api-image.yml` → `synology-monitor-nas-api:latest`
   - `apps/nas-mcp/**` → `.github/workflows/nas-mcp-image.yml` → `synology-monitor-nas-mcp:latest`
   - `apps/web/**` → `.github/workflows/web-image.yml` → `synology-monitor-web:latest`
3. For `apps/web` and `apps/nas-mcp`: workflow calls Coolify webhook → Coolify redeploys.
4. For `apps/agent` and `apps/nas-api`: Watchtower on each NAS detects the new image within ~5 min and recreates the container.

Rollback: re-deploy the previous image tag in Coolify, or `git revert` and push.

Public SSH (port 22) on the VPS is intentionally disabled. There is no routine SSH-based deploy path. Direct manual container rebuilds on the VPS or NAS are not the approved path — they create drift.

## 11. Non-negotiable rules

- Do not commit to any branch other than `main`.
- Do not build Docker images or restart containers manually on the VPS.
- Do not hotfix the live NAS and commit after the fact.
- Do not interpret an empty Supabase table as a healthy subsystem — the collector may be hitting an unsupported DSM API. Check `smon_logs` for API-unavailable warnings.
- Do not add sender payload fields without a matching column in the target Supabase table.
- Do not undo the "intentional quirks" above without reading the linked commit / incident first.

## 12. Critical incidents

### 2026-05 — 4-day runaway `grep -R` on production NAS

What happened: a recursive grep against `@SynologyDriveShareSync` ran for 4 days 11 hours before discovery.

Root cause: missing hard-block in the validator + `exec.CommandContext` only killed the direct bash child, leaving orphaned `grep`.

Fix: hard-block list in `validator.go`; process-group kill in `executor.go` (`Setpgid: true` + `syscall.Kill(-pid, SIGKILL)` on cancel + `WaitDelay: 2s`).

### 2026-05 — Claude MCP sessions hanging / failing

What happened: tool calls hung until Claude's 4-minute client timeout, or returned "Tool result could not be submitted."

Root cause: three independent bugs — `AbortSignal.timeout()` not killing stalled TCP under undici load; undici keep-alive pool exhaustion after ~10–15 calls; Node `keepAliveTimeout: 5s` shorter than Traefik's 90s idle.

Fix: commits `a0362da` (`AbortController` + `setTimeout`, `Connection: close`, 25s exec cap, 45s tool deadline) and `7234d9e` (Node `keepAliveTimeout: 120s`, `headersTimeout: 125s`). Deployed and confirmed in use.

### 2026-05 — `check_backup_status` returning stale 2024 data on edgesynology2

What happened: tool reported 2024 backup events as current.

Root cause: hard-coded read of `/host/log/synolog/synobackup.log`. On that NAS the canonical path was stale; live events were in a per-task target dir.

Fix: tool now enumerates every candidate log location, picks the freshest by mtime, filters tail by date cutoff, prints a staleness banner. See `apps/nas-mcp/src/tool-definitions.ts:check_backup_status`.

### 2026-05 — ShareSync collector dropping in-flight writes on shutdown

What happened: graceful shutdown returned before the ShareSync collector finished, dropping queued WAL writes.

Root cause: the goroutine was started without `wg.Add(1)` registration.

Fix: commit `268b9c9`. The WaitGroup pattern is now an enforced rule for all collectors.

## 13. Pending work

None tracked in-repo. Open issues are tracked outside this file. If you start work that will outlive the current session, create `HANDOFF.md` per the rules in the user's documentation prompt; delete it when complete.
