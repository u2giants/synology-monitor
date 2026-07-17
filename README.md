# Synology Monitor

Telemetry collection, issue detection, and AI-assisted remediation for POP
Creations' two production Synology NAS units. Go services collect telemetry and
execute guarded operations; a Next.js dashboard groups evidence into issues and
runs a three-stage diagnostic pipeline; a lazy-loaded MCP registry exposes 132 NAS
diagnostic and repair definitions behind approval controls.

Live at **[mon.designflow.app](https://mon.designflow.app)**.

## Docs

| | |
|---|---|
| [AGENTS.md](AGENTS.md) | **Start here** — canonical operating guide for AI sessions and engineers |
| [docs/architecture.md](docs/architecture.md) | System design, data flow, component constraints |
| [docs/development.md](docs/development.md) | Build, run, test, debug |
| [docs/configuration.md](docs/configuration.md) | All environment variables |
| [docs/deployment.md](docs/deployment.md) | CI/CD and release workflow |
| [docs/1password.md](docs/1password.md) | Pull secrets from 1Password via the MCP server or `op` CLI |
| [HANDOFF.md](HANDOFF.md) | Current unfinished operations work; read only when continuing it |
| [PLAN.md](PLAN.md) | Historical issue-agent rebuild plan; current behavior is documented in `docs/architecture.md` |

## Prerequisites

- **Go 1.23+** with CGO enabled
- **Node.js 22+** and **pnpm 9**
- **Docker**

## Getting started

```sh
pnpm install
pnpm build
```

| Task | Command |
|---|---|
| Run web app locally | `cd apps/web && pnpm dev` (needs `.env.local` — see `docs/development.md`) |
| Build the Go agent | `cd apps/agent && CGO_ENABLED=1 go build ./...` |
| Run type checks | `pnpm type-check` |
| Run all Go tests | `(cd apps/agent && go test ./...) && (cd apps/nas-api && go test ./...)` |
| Run shared NAS-tool tests | `pnpm --filter @synology-monitor/shared test` |

## Where to look for what

| You want to... | Start here |
|---|---|
| Add or modify a NAS diagnostic tool | `packages/shared/src/nas-tools.ts`, `apps/nas-mcp/tools-config.json` |
| Add a new agent telemetry collector | `apps/agent/internal/collector/` + wire in `cmd/agent/main.go` |
| Change how issues are detected or diagnosed | `apps/web/src/lib/server/issue-detector.ts`, `ai/pipeline-v2.ts` |
| Allow a new NAS shell command | `apps/nas-api/internal/validator/validator.go` + `validator_test.go` |
| Continue unfinished production work | `HANDOFF.md`, then only the topic docs it names |

## Deployment

Push to `main`. GitHub Actions builds and pushes images to GHCR. The web app and NAS MCP server redeploy automatically via Coolify webhook; the agent and NAS API are picked up by Watchtower on each NAS within 5 minutes.

That covers ordinary image deploys. Compose changes such as new mounts, capabilities, or env keys require an explicit `docker compose up -d` on the NAS after the file is updated there, because Watchtower does not apply compose-file changes. See [docs/deployment.md](docs/deployment.md) for rollback, pinning, and the exceptional manual-compose path.
