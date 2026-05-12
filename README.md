# Synology Monitor

AI-powered monitoring dashboard for Synology NAS. The system collects telemetry from two NAS boxes, groups it into issues, and runs an LLM-driven issue agent that diagnoses problems and proposes fixes with an operator approval gate.

Live at **[mon.designflow.app](https://mon.designflow.app)**.

## Repository layout

```
apps/
  agent/       Go monitoring agent — runs on each NAS, pushes telemetry to Supabase
  nas-api/     Go REST API — runs on each NAS, executes approved shell commands
  nas-mcp/     Node.js MCP server — exposes NAS tools to AI agents over Streamable HTTP/SSE
  web/         Next.js dashboard — issues, telemetry, operator UI
  relay/       Relay service for external clients
deploy/
  synology/    NAS compose files, env examples, deployment scripts
.github/
  workflows/   One build+push workflow per app, all trigger on main
```

## Docs

| | |
|---|---|
| [docs/architecture.md](docs/architecture.md) | System design, components, data flow, constraints |
| [docs/development.md](docs/development.md) | Build, run, test, debug |
| [docs/configuration.md](docs/configuration.md) | Environment variables and config |
| [docs/deployment.md](docs/deployment.md) | Deploy and release workflow |
| [deploy/synology/README.md](deploy/synology/README.md) | NAS-side agent deployment detail |
| [apps/nas-mcp/README.md](apps/nas-mcp/README.md) | MCP server tool catalog |

## Quick orientation

**Push to `main`** triggers GitHub Actions builds for whichever apps have changed. The web app and nas-mcp workflows call the Coolify webhook at the end to redeploy automatically. The agent and nas-api images are picked up by Watchtower on each NAS within 5 minutes and the containers are automatically recreated — no manual steps required.

**Supabase** is the shared data layer. The agent writes to it; the web app reads from it. The NAS API does not touch Supabase directly.

**NAS API** is a three-tier command executor — read-only (auto-approved), reversible writes (require `confirmed: true`), destructive writes (require HMAC token). It is not an SSH bridge; every allowed command is statically declared in `apps/nas-api/internal/validator/validator.go`. Recursive grep against Synology internal stores (`@synologydrive`, `@SynologyDriveShareSync`) is permanently hard-blocked regardless of tier — see `docs/architecture.md` for why.
