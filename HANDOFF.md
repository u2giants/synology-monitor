# HANDOFF — nas-mcp hang fix (May 2026)

Delete this file once the user confirms MCP tools are working reliably in claude.ai and Claude Desktop.

## What was being fixed and why

Claude chat sessions (both claude.ai web and Claude Desktop for Windows) were unable to use any nas-mcp tool reliably. Tool calls would either:
- hang indefinitely until Claude's 4-minute client timeout fired ("No result received after 4 minutes"), or
- fail immediately with "Tool result could not be submitted. The request may have expired or the connection was interrupted."

Root causes identified and fixed:

### 1. `AbortSignal.timeout()` not aborting stalled TCP connections (primary cause of 4-minute hang)

`nas-client.ts` used `AbortSignal.timeout()` to abort `fetch()` calls to the NAS API. Under load, undici (Node.js's fetch implementation) fails to abort requests stalled at the TCP connection-establishment phase when the abort signal comes from `AbortSignal.timeout()`. The explicit `AbortController` + `setTimeout` pattern fires unconditionally regardless of undici's internal state.

### 2. Keep-alive pool exhaustion (cause of session-degradation pattern)

All requests to nas-api used HTTP keep-alive by default. Requests that time out don't always return their connection to undici's pool cleanly. After ~10–15 tool calls in a session, the pool exhausts and new calls hang waiting for a free connection. Fixed with `Connection: close` header on all outbound requests.

### 3. 90-second exec timeout left too little margin

With a 90s default exec timeout + 15s abort buffer = 105s worst case per NAS call, a session with several consecutive tool calls could easily hit Claude Desktop's 4-minute ceiling, especially when running against both NASes. Reduced to 25s + 5s = 30s.

### 4. No tool-level deadline (no fallback if all else fails)

If nas-client somehow didn't abort (e.g. both NASes stalled simultaneously), there was nothing to break the MCP tool handler out of its `await`. Added `withToolDeadline()` — a 45s `Promise.race` in every tool handler that resolves with a clear error message rather than hanging.

### 5. Node.js + Traefik keepalive mismatch (cause of "connection interrupted" error)

Node.js 18+ defaults `keepAliveTimeout` to 5 seconds. Traefik (Coolify's reverse proxy) keeps connections alive for ~90 seconds. When Node closes a socket after 5s idle, Traefik tries to reuse it and gets a TCP reset. Claude.ai surfaces this as "Tool result could not be submitted / connection interrupted." Fixed by setting `httpServer.keepAliveTimeout = 120_000` and `httpServer.headersTimeout = 125_000`.

## What is fully done

All code changes are committed to `main` and deployed:

| Commit | What it does |
|---|---|
| `a0362da` | `AbortController` + `setTimeout`, `Connection: close`, 25s exec cap, `withToolDeadline` |
| `7234d9e` | `keepAliveTimeout: 120s`, `headersTimeout: 125s` |

Both commits built successfully via GitHub Actions and Coolify redeployed. Health endpoint (`https://nas-mcp.designflow.app/health`) confirmed responding.

## What is partially done — needs user verification

**The user has not yet confirmed whether tools work after the fixes.** After the first commit deployed, the user reported "I still get: Tool result could not be submitted." This error was the Traefik/Node keepalive mismatch (fixed in `7234d9e`), plus possibly a stale session from the redeployment.

The user has not reported back since `7234d9e` was pushed.

## Exact next action

Ask the user: "After opening a **brand new conversation** in claude.ai (not reloading an old one), do MCP tools work now?"

A new conversation is required because Coolify's redeploy wiped all in-memory MCP sessions. Any existing conversation's `mcp-session-id` returns 404, which claude.ai shows as "connection interrupted."

If tools still fail in a fresh conversation, the next diagnostic steps are:
1. Check Coolify container logs for `[nas-mcp] Tool "..." deadline reached` — if present, the 45s deadline is firing, meaning nas-api is still not responding within 25s.
2. Check `https://nas-mcp.designflow.app/health` — if `sessions` is incrementing but tools fail, the issue is in the tool execution path, not session setup.
3. Check Tailscale connectivity between VPS and NAS: `curl -v --max-time 5 http://100.107.131.35:7734/health` from inside the nas-mcp container.

## Decisions made during this session and reasoning

- **25s exec timeout** (was 90s): Leaves >180s of headroom under Claude's 4-minute limit even for many sequential calls. The NAS API sends `timeout_ms: 25000` in the request body so nas-api kills the subprocess at 25s too; the HTTP abort fires at 30s as a safety net if nas-api doesn't respond.
- **45s tool deadline**: Must be > worst-case execution time (preview 8s + exec 30s = 38s) but well under 4 minutes. 45s gives 7s margin on the execution and 195s margin on Claude's limit.
- **`Connection: close`**: This is intentional even though it prevents HTTP connection reuse. The NAS API is local over Tailscale (sub-millisecond RTT), so the cost of a new TCP handshake per request is negligible compared to the risk of pool exhaustion.
- **`keepAliveTimeout: 120_000`**: Traefik's idle timeout is 90s. We set Node's keepalive to 120s so Node never closes first. Setting it to exactly 90s would create a race; 120s eliminates it.

## Dead ends

- Suspected `AbortSignal.timeout()` was unsupported in Node 22 — it is supported; the issue is undici's handling of it with stalled TCP, not missing API support.
- Suspected the Coolify webhook secret name was `COOLIFY_WEBHOOK_UUID` — it's not; the UUID is hardcoded in the workflow and only `COOLIFY_TOKEN` is a secret.

## Context that only exists in this session

- The original bug was reported by the user via a copy-paste from Claude chat sessions describing the 4-minute hang and session degradation pattern. The user confirmed the "connection interrupted" error appeared AFTER the first two commits deployed, which is what triggered investigation of the Traefik/Node keepalive issue.
- Public SSH (port 22) is disabled on the VPS public IP for security — this is intentional and unrelated to the MCP issues. The deployment path uses the GitHub → Coolify webhook, not SSH.
- The `/worksp/monitor` directory on this machine is NOT the git repo. It's a local workspace copy. The actual git repo was cloned to `/tmp/synology-monitor` to make commits.

## Known risks and unknowns

- **`run_command` in the old README showed `both` as the `target` default** but the tool handler code actually defaults to `"both"` if no target is provided. This is intentional — the README has been corrected.
- **All 37 write tools are enabled** in `tools-config.json`. The old README's "Available but disabled" section was stale — those tools are now enabled. Corrected in the README.
- **`/sse` endpoint is still served** alongside `/mcp`. No clients are known to use it but it's kept for backward compatibility. The `StreamableHTTPServerTransport` handles both paths — this is intentional but not explicitly tested.
