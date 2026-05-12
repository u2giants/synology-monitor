# Synology Monitor — Architecture Reference

For full documentation see [docs/architecture.md](docs/architecture.md).

## Quick orientation

Five components:

| Component | Language | Where it runs | Purpose |
|---|---|---|---|
| `apps/agent` | Go | Each NAS (Docker) | Collects telemetry, pushes to Supabase |
| `apps/nas-api` | Go | Each NAS (Docker) | Executes approved shell commands for the issue agent |
| `apps/nas-mcp` | Node.js | VPS (Docker) | MCP server — exposes NAS tools to AI agents over Streamable HTTP/SSE |
| `apps/web` | Next.js | VPS (Docker via Coolify) | Dashboard, issue agent loop, operator UI |
| `apps/relay` | Node.js | VPS (Docker) | Relay for external clients |

**One branch: `main`.** Push to `main` → GitHub Actions builds images → Coolify deploys web/nas-mcp automatically → agent/nas-api images are picked up by Watchtower on each NAS within 5 minutes and containers are automatically recreated.

**Supabase** (`smon_*` tables) is the shared data layer between agent and web. NAS API does not touch Supabase.

## Key files

### Agent

- Entry point: `apps/agent/cmd/agent/main.go`
- Collectors: `apps/agent/internal/collector/*.go` — see `docs/architecture.md` for the full collector inventory
- WAL + sender: `apps/agent/internal/sender/`
- DSM API client: `apps/agent/internal/dsm/client.go`
- Config: `apps/agent/internal/config/config.go`

### NAS API

- Validator (command allowlist and hard-blocks): `apps/nas-api/internal/validator/validator.go`
- Executor (process-group kill, timeout): `apps/nas-api/internal/executor/executor.go`
- Auth (HMAC tokens, bearer auth): `apps/nas-api/internal/auth/auth.go`

### Web

- Issue agent loop: `apps/web/src/lib/server/issue-agent.ts`
- Issue detector: `apps/web/src/lib/server/issue-detector.ts`
- NAS tools: `apps/web/src/lib/server/tools.ts`
- NAS API client: `apps/web/src/lib/server/nas-api-client.ts`
- Job workflow: `apps/web/src/lib/server/issue-workflow.ts`
- Facts: `apps/web/src/lib/server/fact-store.ts`
- Forensics: `apps/web/src/lib/server/forensics-drive.ts`, `forensics-hyperbackup.ts`

## Non-negotiable rules

- Do not commit directly to any branch other than `main`.
- Do not build Docker images or restart containers manually on the VPS.
- Do not hotfix the live NAS and commit after the fact.
- Do not interpret an empty Supabase table as a healthy subsystem — the collector may be hitting an unsupported DSM API. Check `smon_logs` for API-unavailable warnings.
- Do not add sender payload fields without a matching column in the target Supabase table.

## Safety rules — do not re-introduce these bugs

### 1. Every agent collector goroutine must be in the WaitGroup

In `apps/agent/cmd/agent/main.go`, every collector goroutine must follow this exact pattern:

```go
wg.Add(1)
go func() {
    defer wg.Done()
    collector.Run(stop)
}()
```

**Never** do `go collector.Run(stop)` without `wg.Add(1)`. Without WaitGroup registration, the agent's graceful shutdown (`wg.Wait()`) returns before the collector finishes, dropping in-flight WAL writes. This bug existed for the ShareSync collector until May 2026 (fixed in commit `268b9c9`).

### 2. All WAL `db.Exec` calls must check the error return

In `apps/agent/internal/sender/sender.go`, every `s.db.Exec(...)` call must check the returned error:

```go
if _, err := s.db.Exec("DELETE ..."); err != nil {
    log.Printf("[sender] cleanup failed: %v", err)
}
```

Silent discard of `db.Exec` errors means WAL growth failures go unreported. Fixed in commit `268b9c9`.

### 3. Never run recursive grep against Synology internal stores

`@synologydrive`, `@SynologyDriveShareSync`, and `/var/packages/SynologyDrive` contain millions of opaque file objects. A recursive grep never returns useful results and will thrash disk I/O for days. This is permanently hard-blocked in the NAS API validator. In May 2026 a `grep -R` ran for 4 days 11 hours on a production NAS before being discovered — the hard-block and process-group kill in the executor prevent recurrence.

### 4. NAS API executor must kill the entire process group, not just bash

`exec.CommandContext` only kills the direct bash child on context expiry — not the subprocess tree. The executor uses `Setpgid: true` and `syscall.Kill(-pid, SIGKILL)` to kill the entire process group. Do not simplify or remove this. See `apps/nas-api/internal/executor/executor.go` and `docs/architecture.md`.
