# Synology Monitor — Architecture Reference

For full documentation see [docs/architecture.md](docs/architecture.md).

## Quick orientation

Five components:

| Component | Language | Where it runs | Purpose |
|---|---|---|---|
| `apps/agent` | Go | Each NAS (Docker) | Collects telemetry, pushes to Supabase |
| `apps/nas-api` | Go | Each NAS (Docker) | Executes approved shell commands for the issue agent |
| `apps/nas-mcp` | Node.js | VPS (Docker) | MCP server — exposes NAS tools to AI agents over SSE |
| `apps/web` | Next.js | VPS (Docker via Coolify) | Dashboard, issue agent loop, operator UI |
| `apps/relay` | — | VPS | Relay for external clients |

**One branch: `main`.** Push to `main` → GitHub Actions builds images → Coolify deploys web/nas-api/nas-mcp automatically → agent images must be manually recreated on each NAS.

**Supabase** (`smon_*` tables) is the shared data layer between agent and web. NAS API does not touch Supabase.

## Key files

### Agent

- Entry point: `apps/agent/cmd/agent/main.go`
- Collectors: `apps/agent/internal/collector/*.go` — 15 collectors covering system metrics, ShareSync health, Drive activity, storage, processes, disk I/O, containers, network, security events
- WAL + sender: `apps/agent/internal/sender/`
- DSM API client: `apps/agent/internal/dsm/client.go`
- Config: `apps/agent/internal/config/config.go`

### Web

- Issue agent loop: `apps/web/src/lib/server/issue-agent.ts`
- Issue detector: `apps/web/src/lib/server/issue-detector.ts`
- Telemetry context: `apps/web/src/lib/server/issue-agent.ts` (`gatherTelemetryContext`)
- LLM stage models: `apps/web/src/lib/server/issue-stage-models.ts`
- NAS tools: `apps/web/src/lib/server/tools.ts`
- NAS API client: `apps/web/src/lib/server/nas-api-client.ts`
- Job workflow: `apps/web/src/lib/server/issue-workflow.ts`
- Facts: `apps/web/src/lib/server/fact-store.ts`

## Non-negotiable rules

- Do not commit directly to any branch other than `main`.
- Do not build Docker images or restart containers manually on the VPS.
- Do not hotfix the live NAS and commit after the fact.
- Do not interpret an empty Supabase table as a healthy subsystem — the collector may be hitting an unsupported DSM API. Check `smon_logs` for API-unavailable warnings.
- Do not add sender payload fields without a matching column in the target Supabase table.
