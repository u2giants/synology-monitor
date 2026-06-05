# MCP Incident Notes — May 2026

This document is a dedicated handoff for the `nas-mcp` / `nas-api` failures and regressions that occurred in May 2026. It is intended for a fresh session with no prior context.

## Resolution — May 14 2026

The 4-minute tool-call hang was root-caused and fixed.

**Root cause:** The claude.ai MCP proxy sends a `GET /mcp` request *without* a `Mcp-Session-Id` header to open a standalone SSE notification stream before attempting any tool calls. The server was routing this into `getOrCreateSession(undefined)`, which created a new *stateful* transport (with `sessionIdGenerator`). Because that transport had never processed an `initialize` message, `_initialized` was `false`. `validateSession()` in the MCP SDK checks `if (this.sessionIdGenerator !== undefined && !this._initialized)` and returns `400 Bad Request: Server not initialized`. The proxy treated this 400 as a fatal connection failure and never sent the tool call POST.

**Fix:** Added an early branch in the `/mcp` handler for `GET` without a session ID. That branch creates a **stateless** transport (`sessionIdGenerator: undefined`). In stateless mode the SDK skips `validateSession` entirely, so the GET succeeds with `200 OK text/event-stream`. The SSE stream stays open until the client disconnects; the server never pushes events through it since this is a pure request-response proxy. Stateful session management for POST requests is unchanged.

Commit: this fix was applied on May 14 and deployed directly to the running container. It must be pushed to `main` for it to survive the next Coolify redeploy.

**This document has been updated to correct the earlier wrong assessment of the stateless-GET approach.** The previous attempt in `336348d` was reverted because it correlated with a regression, but that implementation may have differed in a way that broke things. The correctly-scoped fix (stateless mode only for GET without session ID) works and is verified.

**Current-state note (2026-06-05):** `apps/nas-mcp` now runs on TypeScript
FastMCP with `transportType: "httpStream"` and `stateless: true`. The historical
Node `keepAliveTimeout` / `headersTimeout` setting described below is not present
in the current FastMCP implementation. Preserve the current invariants instead:
stateless transport, `Connection: close` for NAS API requests, bounded NAS API
HTTP calls, and the 45s MCP tool deadline.

---

It answers five questions:

1. What broke
2. What was changed to reduce NAS resource usage
3. Which changes are safe and should remain
4. Which changes likely regressed MCP behavior
5. What the current correct state is, including deployment nuance

## Environment

- Public MCP endpoint: `https://nas-mcp.designflow.app/mcp`
- Legacy SSE endpoint: `https://nas-mcp.designflow.app/sse`
- VPS service: `nas-mcp` in Coolify
- NAS-side service: `nas-api` on each NAS over Tailscale
- NAS 1 API: `http://100.107.131.35:7734`
- NAS 2 API: `http://100.107.131.36:7734`

## Original problem

Claude Desktop / Claude web sessions were reporting that MCP tools either:

- hung for up to 4 minutes with no result
- failed with `Tool result could not be submitted`
- or returned `403` tier/permission errors for read-only tools like `check_system_info`

Two different classes of failure were mixed together:

1. MCP transport/session failures
2. NAS API validator misclassification of harmless read commands as write-tier

These are separate problems and should not be debugged as one issue.

## Resource-usage background

The system had a real NAS load problem before these MCP regressions.

The important historical fact is:

- recursive `grep -R` on Synology internal stores and orphaned child processes caused severe CPU and disk load on the NASes

The main protective changes were added to stop that:

- hard-block recursive `grep -R` against `@synologydrive`, `@SynologyDriveShareSync`, and `/var/packages/SynologyDrive`
- kill the entire process group on timeout in `nas-api`, not just the parent shell
- reduce expensive snapshot commands like recursive `lsof +D`

Those protections are correct and should stay.

## High-level diagnosis

There were three distinct behaviors seen during debugging:

### 1. False `403` on `check_system_info`

This came from `nas-api`, not from the MCP transport.

`check_system_info` includes:

```sh
cat /host/etc/VERSION 2>/dev/null
```

The validator treated `cat ... >` as a write pattern, even though this was just redirecting stderr to `/dev/null`.

Result:

- `check_system_info` returned `HTTP 403`
- Claude reported a tier/permissions error
- `run_command` remained a more reliable workaround

### 2. 4-minute total hangs

This was an MCP transport/session problem, not a heavy shell command problem.

Evidence:

- `check_system_info` is lightweight
- live `nas-mcp` logs showed:

```text
[nas-mcp] transport error Error: Bad Request: Server not initialized
```

**Root cause (confirmed May 14):** The claude.ai proxy sends `GET /mcp` without a session ID to open a standalone SSE notification stream before making tool calls. The server was creating a new stateful transport for this GET, which failed `validateSession` because `_initialized` was `false` — the transport had never seen an `initialize` message. The proxy treated the 400 response as a fatal error and never proceeded to call tools. The `withToolDeadline` 45-second wrapper never fired because the tool handler was never reached. Claude waited the full 4 minutes before timing out.

The fix is a stateless transport (`sessionIdGenerator: undefined`) for GET requests without a session ID, which bypasses `validateSession`. See the Resolution section at the top of this document.

### 3. “Tool result could not be submitted / connection interrupted”

This is a connection lifecycle problem between Claude, Traefik, and the Node server.

One relevant fix was increasing Node `keepAliveTimeout` beyond Traefik’s idle behavior so the backend did not close sockets first.

## Commits that matter

### Safe and important load-protection commits

#### `f2d8607`

Message:

```text
nas-api: kill entire process group on timeout; hard-block recursive grep on @synologydrive
```

Why it matters:

- prevents runaway child processes after timeout
- prevents destructive recursive grep patterns that can thrash storage for days

Risk if reverted:

- high NAS CPU/disk usage
- orphaned long-running processes
- recurrence of the original resource exhaustion issue

Status:

- must remain

#### `63c60e8` heavy-command reduction

This commit also changed:

- `get_resource_snapshot` to stop using recursive `lsof +D` against entire volumes
- predefined read tools to skip extra `preview` calls

Why it matters:

- reduces NAS command cost
- reduces NAS API traffic

Risk if reverted:

- resource usage goes back up
- snapshot tools become expensive again

Status:

- should remain

### MCP transport changes

#### `a0362da`

Message:

```text
fix(nas-mcp): reliable timeouts + 45s tool deadline to stop Claude hangs
```

What it changed:

- explicit timeout handling for NAS API requests
- `Connection: close`
- 45s tool deadline in `nas-mcp`

Intent:

- fail fast instead of hanging for 4 minutes

Assessment:

- generally reasonable
- aimed at MCP reliability, not NAS load

Risk:

- moderate protocol/request-lifecycle risk because it changed transport behavior
- not a NAS resource regression by itself

#### `7234d9e`

Message:

```text
fix(nas-mcp): set keepAliveTimeout > Traefik idle to stop connection resets
```

What it changed:

- Node `keepAliveTimeout = 120s`
- Node `headersTimeout = 125s`

Intent:

- stop Traefik from reusing a backend socket that Node already closed

Assessment:

- likely beneficial
- low NAS resource impact

Status:

- should remain unless disproven by live testing

#### `1bed1c4`

Message:

```text
Use JSON responses for nas-mcp streamable HTTP
```

What it changed:

- enabled `enableJsonResponse: true` on the MCP transport

Intent:

- return direct JSON responses for `/mcp` POST requests instead of holding SSE-style POST responses open

Assessment:

- may be correct in principle
- changed transport semantics for Claude clients
- could still be part of protocol compatibility issues, but it was not the clearest regression

Risk:

- MCP client compatibility risk
- not a NAS resource regression

### Validator and regression commits

#### `336348d`

Message:

```text
Fix MCP pre-init GET handling and read command validation
```

This commit did two unrelated things:

1. fixed read-command validation in `nas-api`
2. added special stateless handling for pre-init `GET /mcp` in `nas-mcp`

These need to be considered separately.

##### Part A — validator fix

File:

- `apps/nas-api/internal/validator/validator.go`

Change:

```go
- regexp.MustCompile(`(?i)\b(echo|printf|tee|cat)\b.*(>)`)
+ regexp.MustCompile(`(?i)\b(echo|printf|tee)\b.*(>)`)
```

Why:

- `cat /host/etc/VERSION 2>/dev/null` is read-only and should not be treated as a write

Assessment:

- correct
- safe
- no resource-risk

Important deployment nuance:

- this fix lives in `nas-api`, not `nas-mcp`
- it only goes live after the `nas-api` image is built and the NAS-side container updates via Watchtower

##### Part B — stateless `GET /mcp` branch

File:

- `apps/nas-mcp/src/index.ts`

What it did:

- when `/mcp` received `GET` without an `Mcp-Session-Id`, it created a stateless transport dynamically

Assessment (updated May 14):

- the *approach* is correct — a stateless transport for GET-without-session-ID is exactly the right fix
- the original implementation in `336348d` may have had a bug that caused a secondary regression; that specific implementation was reverted in `7bece88`
- the correctly-scoped fix (only `sessionIdGenerator: undefined`, only for `GET` without session ID, POST path unchanged) was applied on May 14 and confirmed working

Status:

- the reverted `336348d` implementation should stay reverted
- the May 14 fix supersedes it with a cleaner, verified implementation

#### `7bece88`

Message:

```text
Revert stateless GET handling for nas-mcp
```

What it did:

- removed the experimental stateless `GET /mcp` branch from `336348d`

Assessment (updated May 14):

- the revert was correct for *that specific implementation*, which correlated with a regression
- the revert returned to the state where GET-without-session-ID fails with 400, which turned out to be the remaining hang bug
- the May 14 fix reintroduces the stateless GET approach correctly; this commit is now superseded

Status:

- no longer the desired end state; the May 14 fix is the current correct state

## Live production observations during debugging

These were confirmed against production while the incident was active.

### `nas-mcp` health

The service was up and healthy via:

- `GET /health`

### Initialize worked

A direct `POST /mcp` initialize request with valid bearer auth returned:

- `200 OK`
- a valid `mcp-session-id`

That proved the server was not globally dead.

### `GET /mcp` without initialized session failed

Direct unaffiliated `GET /mcp` returned:

- `400 Bad Request: Server not initialized`

The same error appeared in live container logs.

This proved at least one client path was attempting `GET /mcp` before the session existed or before the session was wired the way the server expected.

### `check_system_info` false-403 reproduced directly

A direct production `tools/call` against `check_system_info` returned:

```text
[edgesynology1] Error: NAS exec failed (edgesynology1): HTTP 403 — {"error":"command requires tier 2 or higher (detected write pattern)"}
```

That proved the 403 came from the NAS API validator and was not a Claude UI artifact.

## Current intended state

### `nas-mcp`

Desired current state (as of May 14 2026):

- keep the timeout and connection-management fixes
- keep the current transport/timeout invariants documented at the top of this file
- keep the reduced-cost read-tool behavior
- keep `enableJsonResponse: true`
- keep the May 14 stateless-GET fix: `GET /mcp` without `Mcp-Session-Id` → stateless transport (`sessionIdGenerator: undefined`) → 200 OK SSE stream

### `nas-api`

Desired current state:

- keep the validator fix that removes `cat` from write detection
- keep process-group kill
- keep hard-blocks for recursive `grep -R`

## What must not be reverted

These are the load-safety protections.

- process-group kill in `apps/nas-api/internal/executor/executor.go`
- hard-block recursive `grep -R` against Synology internal stores in `apps/nas-api/internal/validator/validator.go`
- lighter `get_resource_snapshot` open-file query in `apps/nas-mcp/src/tool-definitions.ts`
- skipping extra preview calls for predefined read tools

If any of those are undone, the old NAS resource-usage problem can come back.

## What can be reverted without reintroducing NAS load issues

- the stateless `GET /mcp` transport experiment
- MCP transport/session experiments that do not change NAS shell commands
- validator false-positive fixes like the `cat` change

These affect reliability or permissions logic, not NAS resource usage.

## Deployment behavior

This part is critical.

### `nas-mcp`

- built and deployed on the VPS
- redeployed via Coolify webhook after pushes that touch `apps/nas-mcp/**`

### `nas-api`

- built by GitHub Actions workflow `nas-api-image.yml`
- not deployed by Coolify
- updated on the NASes by Watchtower polling GHCR every ~5 minutes

Implication:

- an MCP fix in `apps/nas-mcp/**` can be live while an NAS API validator fix is still not live
- this exact split happened during the incident

## If the false `403` is still happening

The code fix already exists on `main`.

If `check_system_info` still returns false `403`:

1. verify the `nas-api` image workflow built successfully for the commit containing the validator change
2. verify Watchtower pulled the new `synology-monitor-nas-api` image on both NAS units
3. if needed, force a recreate on the NAS

Manual recreate sequence:

```sh
DOCKER=/var/packages/ContainerManager/target/usr/bin/docker
cd /volume1/docker/synology-monitor-agent

$DOCKER compose -f compose.yaml pull
$DOCKER stop synology-monitor-agent synology-monitor-nas-api || true
$DOCKER rm synology-monitor-agent synology-monitor-nas-api || true
$DOCKER compose -f compose.yaml up -d
```

## If the 4-minute hang comes back

Check `nas-mcp` logs first.

Look for:

- `standalone SSE:` — GET-without-session errors; if these appear the stateless-GET fix may have been reverted
- `transport error` / `Bad Request: Server not initialized` — the pre-fix error pattern; should no longer appear
- `Session not found` — a client using a stale session ID; the server returns 404 and the client should reinitialize
- `Mcp-Session-Id header is required` — a POST tool call arriving with no session; the client skipped initialize
- proxy/socket reset symptoms

To diagnose quickly, test these directly:

```sh
# 1. GET without session ID — should return 200 OK text/event-stream (not 400)
curl -s --max-time 3 -X GET https://nas-mcp.designflow.app/mcp \
  -H "Authorization: Bearer <token>" \
  -H "Accept: text/event-stream" -D -

# 2. POST initialize — should return 200 with mcp-session-id header
curl -s -X POST https://nas-mcp.designflow.app/mcp \
  -H "Authorization: Bearer <token>" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -H "Mcp-Protocol-Version: 2024-11-05" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'

# 3. Tool call — should return result in < 1s
curl -s -X POST https://nas-mcp.designflow.app/mcp \
  -H "Authorization: Bearer <token>" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -H "Mcp-Protocol-Version: 2024-11-05" \
  -H "Mcp-Session-Id: <from step 2>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"check_disk_space","arguments":{"target":"edgesynology1"}}}'
```

If test 1 returns 400 again, the stateless-GET fix is missing from the deployed image. Push to `main` and let Coolify redeploy.

## Recommended debugging order for future sessions

1. Reproduce with direct MCP calls against production:
   - initialize
   - `tools/list`
   - `tools/call check_system_info`
2. Separate transport failures from NAS API failures.
3. If the response is `403`, debug `nas-api` validator and deployment state.
4. If the call hangs, debug `nas-mcp` transport/session behavior and live logs.
5. Do not change resource-safety protections while debugging MCP transport.

## Bottom line

There were two real bugs:

- a false write-pattern match in `nas-api`
- a transport/session problem in `nas-mcp`: `GET /mcp` without a session ID was routed into a stateful transport that hadn't been initialized, causing `validateSession` to return 400 and the client to hang for 4 minutes

Both are fixed and live:

- the false `403` fix (removing `cat` from the write-detection regex in `nas-api`) is safe and should stay
- the stateless-GET fix (stateless transport for `GET /mcp` without `Mcp-Session-Id`) is correct, verified May 14 2026, and should stay — see the Resolution section at the top of this document
- the resource-safety changes (process-group kill, hard-blocks, lighter `get_resource_snapshot`) are correct and should not be rolled back
