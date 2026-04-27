# Claude Code — Synology Monitor

## Read first

Before making any changes, read **[AI_OPERATING_RULES.md](./AI_OPERATING_RULES.md)** in full.
Those rules are non-negotiable and apply to every AI session.

Key constraints repeated here so they cannot be missed:

- **GitHub is the source of truth.** Do not edit files directly on the production server.
- **One branch: `main`.** No feature branches, no staging branches.
- **Only approved deployment path:** commit to `main` → GitHub Actions builds image → Coolify deploys.
- **Never build Docker images or restart containers manually on the server.**
- **Never hotfix the live machine and commit after the fact.**

## Codebase orientation

- `apps/nas-mcp/` — MCP server that exposes NAS tools to AI agents over HTTPS
- `apps/nas-api/` — REST API running on each Synology NAS (three-tier shell execution, NOT an SSH bridge)
- `apps/agent/` — monitoring agent deployed on each NAS via Docker
- `apps/web/` — Next.js dashboard at `https://mon.designflow.app`
- `apps/relay/` — relay service for external clients (web app talks to NAS API directly over Tailscale)
- `.github/workflows/` — one workflow per app, all trigger on push to `main`

## Infrastructure

- **VPS:** Coolify at `https://coolify.designflow.app` manages all containers
- **NAS MCP:** `https://nas-mcp.designflow.app/sse` (Bearer token in Coolify env vars)
- **DevOps MCP:** `https://mcp.designflow.app/mcp` — read-only server access for diagnostics only

## Further reading

- [AI_OPERATING_RULES.md](./AI_OPERATING_RULES.md) — deployment and safety rules
- [AGENTS.md](./AGENTS.md) — full architecture and component map
- [AI_INFRASTRUCTURE_GUIDE.md](./AI_INFRASTRUCTURE_GUIDE.md) — live infrastructure reference
- [apps/nas-mcp/README.md](./apps/nas-mcp/README.md) — MCP server tool catalog and details
