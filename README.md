# Synology Monitor

AI-powered monitoring and incident management for two Synology NAS devices. The system
collects telemetry from each NAS, groups it into issues, maintains a persistent issue
memory, and provides an operator-guided resolution path with AI assistance.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Each NAS (edgesynology1, edgesynology2)                        │
│    Go agent container                                            │
│    - polls DSM APIs                                              │
│    - reads /proc, /sys, logs                                     │
│    - watches shared folders                                      │
│    - writes telemetry → Supabase (batch flush)                   │
└─────────────────────────────────────────────────────────────────┘
                          │
                    Supabase (shared source of truth)
                          │
┌─────────────────────────────────────────────────────────────────┐
│  Web app (Next.js on Coolify)                                    │
│  mon.designflow.app                                              │
│    - reads telemetry from Supabase                               │
│    - groups telemetry into issues                                │
│    - stores issue threads, evidence, actions, messages           │
│    - runs AI issue agent loop                                    │
│    - exposes monitor-stack controls to operators                 │
└─────────────────────────────────────────────────────────────────┘
```

## Documentation

| Doc | What it's for |
|-----|---------------|
| [AGENTS.md](AGENTS.md) | **Start here.** Canonical architecture guide — subsystems, key files, non-negotiable rules |
| [HANDOFF.md](HANDOFF.md) | Forensic capability handoff — remaining work and implementation constraints |
| [CAPABILITY_AUDIT.md](CAPABILITY_AUDIT.md) | Current capability vs. gap analysis |
| [PLAN.md](PLAN.md) | Reality-based status — what is implemented, deployed, and still missing |
| [AI_INFRASTRUCTURE_GUIDE.md](AI_INFRASTRUCTURE_GUIDE.md) | Full stack access guide for AI agents and new sessions |
| [AI_OPERATING_RULES.md](AI_OPERATING_RULES.md) | Rules for AI tools working in this repo |
| [deploy/synology/README.md](deploy/synology/README.md) | NAS-side deployment: agent docker-compose and setup |
| [apps/relay/README.md](apps/relay/README.md) | NAS API relay service |
| [apps/nas-mcp/README.md](apps/nas-mcp/README.md) | NAS MCP server |

Non-authoritative reference material (owner notes, not required reading for new sessions):
- [MODEL_MATRIX.md](MODEL_MATRIX.md) — target model orchestration architecture spec
- [MODEL_SELECTION_GUIDE.md](MODEL_SELECTION_GUIDE.md) — model selection guidance
- [rebuild_plan.md](rebuild_plan.md) — historical rebuild plan
- [ROO_MCP_GUIDE.md](ROO_MCP_GUIDE.md) — MCP guide for Roo Code

Operational trackers (work-in-progress state, not architecture docs):
- [CURRENT_TASK.md](CURRENT_TASK.md) — active work tracker
- [INGESTION_BACKLOG.md](INGESTION_BACKLOG.md) — ingestion task backlog
- [HANDOFF.md](HANDOFF.md) — next-session handoff notes

## Repo structure

```
synology-monitor/
├── apps/
│   ├── web/            ← Next.js web app (issues, telemetry, AI agent, operator UI)
│   ├── agent/          ← Go agent (runs on each NAS, collects telemetry)
│   ├── relay/          ← NAS API relay service
│   └── nas-mcp/        ← NAS MCP server
├── deploy/
│   └── synology/       ← NAS-side docker-compose and deployment scripts
├── supabase/           ← Supabase migrations
├── packages/           ← Shared packages (pnpm workspace)
└── scripts/            ← Build and operational scripts
```

## Deployment

### Web app

Push to `main` → GitHub Actions builds Docker image → triggers Coolify redeploy.

See [AGENTS.md](AGENTS.md) for the full deployment architecture.

### Agent

Push to `main` → GitHub Actions builds agent image → each NAS recreates the `synology-monitor-agent` container.

Canonical compose file: [deploy/synology/docker-compose.agent.yml](deploy/synology/docker-compose.agent.yml)

## Key constraints

- **Do not add web-side direct SSH.** The access path is: web/AI/operator → relay → NAS API → NAS.
- **Do not assume Synology host binaries execute inside the Alpine NAS API container.** Preferred sources: mounted logs, DSM API responses, agent-collected telemetry.
- **Keep NAS I/O impact low.** No recursive share scans or full-drive file walks.

See [HANDOFF.md](HANDOFF.md) for the full constraint list before adding any new features.
