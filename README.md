# Synology Monitor

AI-powered monitoring and incident management for two Synology NAS devices. The system collects telemetry from each NAS, groups it into issues, maintains persistent issue memory, and provides an operator-guided AI resolution path.

## Quick orientation

```
┌──────────────────────────────────────────────────────────┐
│  Each NAS (edgesynology1, edgesynology2)                  │
│  ├── synology-monitor-agent   (Go, passive collector)     │
│  ├── synology-monitor-nas-api (Go, shell execution API)   │
│  └── synology-monitor-watchtower                          │
└────────────────┬─────────────────────────────────────────┘
                 │ Supabase (shared source of truth)
┌────────────────▼─────────────────────────────────────────┐
│  Web app — mon.designflow.app  (Next.js on Coolify)       │
│  ├── reads telemetry from Supabase                        │
│  ├── groups events into issues                            │
│  ├── runs the AI issue agent loop                         │
│  └── calls NAS API (via Tailscale) for diagnostics        │
└──────────────────────────────────────────────────────────┘
                 │ (AI agents / Claude Desktop)
┌────────────────▼─────────────────────────────────────────┐
│  NAS MCP — nas-mcp.designflow.app  (TypeScript on Coolify)│
│  74 read tools + 35 write tools exposed over MCP/SSE      │
└──────────────────────────────────────────────────────────┘
```

## Repo structure

```
synology-monitor/
├── apps/
│   ├── agent/          Go agent — runs on each NAS, collects and pushes telemetry
│   ├── nas-api/        Go REST API — runs on each NAS, executes shell commands
│   ├── nas-mcp/        TypeScript MCP server — exposes NAS tools to AI agents
│   ├── relay/          TypeScript relay — public HTTPS bridge to private NAS APIs
│   └── web/            Next.js dashboard — issues, telemetry, AI agent, operator UI
├── deploy/
│   └── synology/       NAS-side docker-compose and .env examples
├── supabase/           Database migrations
├── packages/           pnpm workspace shared packages
└── .github/workflows/  One CI workflow per app, all trigger on push to main
```

## Documentation

| Doc | What it covers |
|-----|----------------|
| [AGENTS.md](AGENTS.md) | Architecture, components, data flow, collector inventory, known behaviors |
| [AI_OPERATING_RULES.md](AI_OPERATING_RULES.md) | Rules for AI tools working in this repo — read before making any change |
| [AI_INFRASTRUCTURE_GUIDE.md](AI_INFRASTRUCTURE_GUIDE.md) | Live infrastructure: URLs, env vars, credentials, Coolify, Supabase |
| [apps/nas-mcp/README.md](apps/nas-mcp/README.md) | MCP server — tool catalog, tiers, enabling/disabling tools, troubleshooting |
| [apps/nas-api/](apps/nas-api/) | NAS API — tier system, validator, auth |
| [apps/relay/README.md](apps/relay/README.md) | Relay service — endpoints, auth, supported actions |
| [deploy/synology/README.md](deploy/synology/README.md) | NAS deployment — compose layout, required mounts, update sequence |

## Deployment

**Single branch: `main`.** No feature branches, no staging.

Every app has its own GitHub Actions workflow that triggers on `push` to `main` when relevant paths change:

| App | Workflow | Trigger paths | What happens on push |
|-----|----------|--------------|---------------------|
| `apps/agent/` | `agent-image.yml` | `apps/agent/**` | Builds and pushes `synology-monitor-agent:latest` to GHCR; Watchtower picks it up on each NAS |
| `apps/nas-api/` | `nas-api-image.yml` | `apps/nas-api/**` | Builds and pushes `synology-monitor-nas-api:latest` to GHCR; Watchtower picks it up on each NAS |
| `apps/nas-mcp/` | `nas-mcp-image.yml` | `apps/nas-mcp/**` | Builds and pushes image, then triggers Coolify redeploy via webhook |
| `apps/web/` | `web-image.yml` | `apps/web/**`, `packages/shared/**`, root config | Builds and pushes image, then triggers Coolify redeploy via webhook |

**Watchtower limitation:** Watchtower pulls the new image and restarts the container, but it uses the original creation parameters — it does **not** re-read `docker-compose.agent.yml`. If you change compose config (volumes, `privileged`, env vars), you must manually run `docker compose up -d` on the NAS after Watchtower picks up the new image. See [deploy/synology/README.md](deploy/synology/README.md) for the update sequence.

## Key constraints

- No web-side direct SSH to the NASes. The runtime path is: web/AI → NAS API (via Tailscale) → NAS.
- Synology host binaries (`synopkg`, `synoacltool`, etc.) do not execute directly inside the Alpine-based containers. The nas-api entrypoint creates symlinks and the container is Debian-based to support glibc binaries.
- No recursive share scans or full-drive file walks — keep NAS I/O impact low.
- `tools-config.json` is baked into the nas-mcp image at build time. Changes require a push to `main`, not a file edit on the server.
