# Development Guide

## Monorepo structure

This is a pnpm workspace managed with Turborepo.

```
synology-monitor/
├── apps/
│   ├── agent/      Go — NAS telemetry collector (deployed to each NAS via Docker)
│   ├── nas-api/    Go — three-tier shell execution API (deployed to each NAS via Docker)
│   ├── nas-mcp/    TypeScript — MCP server (deployed to Coolify VPS)
│   ├── relay/      TypeScript — HTTPS bridge for legacy clients (deployed to Coolify VPS)
│   └── web/        Next.js — operator dashboard (deployed to Coolify VPS)
├── packages/
│   └── shared/     TypeScript types and utilities shared by web and relay
├── deploy/synology/  NAS-side compose file and .env examples
├── supabase/migrations/  Database schema migrations
└── docs/           Developer docs (this directory)
```

Each app has its own Dockerfile and GitHub Actions workflow. They build and deploy independently.

## Prerequisites

| Tool | Minimum version | Used by |
|------|----------------|---------|
| Node.js | 22 | nas-mcp, relay, web |
| pnpm | 9.15 | all JS/TS apps |
| Go | 1.22 | agent, nas-api |
| Docker | any recent | building images locally |

## JavaScript / TypeScript apps

Install all workspace dependencies from the repo root:

```sh
pnpm install
```

### Web app (`apps/web/`)

```sh
# Run dev server (Next.js on :3000)
pnpm --filter @synology-monitor/web dev

# Type-check
pnpm --filter @synology-monitor/web type-check

# Lint
pnpm --filter @synology-monitor/web lint
```

The web app requires Supabase credentials (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) and NAS API URLs/secrets to do anything useful. Copy `apps/web/.env.local.example` if it exists, or see [AI_INFRASTRUCTURE_GUIDE.md](../AI_INFRASTRUCTURE_GUIDE.md) for the variable list.

### NAS MCP server (`apps/nas-mcp/`)

```sh
# Build TypeScript
pnpm --filter @synology-monitor/nas-mcp build

# Run locally (requires NAS_* env vars pointing at a real or tunneled NAS API)
MCP_PORT=3001 MCP_BEARER_TOKEN=dev node apps/nas-mcp/dist/index.js
```

`tools-config.json` is read at startup from the same directory as the built `index.js`. Edit it locally to enable/disable tools without a rebuild. In production, the config is baked into the image.

## Go apps

Both Go apps follow the same pattern:

```sh
# Test (runs go vet + go test)
cd apps/nas-api   # or apps/agent
go test ./...

# Build binary
go build ./cmd/server/...   # nas-api
go build ./cmd/agent/...    # agent

# Run validator tests specifically
go test ./internal/validator/... -v
```

The Dockerfiles run `go vet` and `go test ./...` as part of the build stage, so CI will fail if tests break.

### Running the NAS API locally

```sh
NAS_API_SECRET=dev \
NAS_API_APPROVAL_SIGNING_KEY=dev \
NAS_API_PORT=7734 \
  go run ./apps/nas-api/cmd/server/...
```

This runs on your local machine, not a NAS. Commands that need NAS-specific binaries (`smartctl`, `synopkg`, etc.) will fail, but the tier classification and approval token flow can be tested without a real NAS.

## Database migrations

Migrations live in `supabase/migrations/`. Apply them to the live Supabase project:

```sh
# Requires Supabase CLI and SUPABASE_ACCESS_TOKEN env var
supabase db push --project-ref <project_ref>
```

The `supabase-migrations.yml` workflow applies migrations automatically when migration files are pushed to `main`.

## Running Turbo tasks across the monorepo

```sh
# Build all apps
pnpm build

# Type-check all apps
pnpm type-check

# Lint all apps
pnpm lint
```

Turbo caches build outputs. If you want a clean build: `pnpm turbo build --force`.

## Adding or changing a NAS MCP tool

1. Add a new `McpToolDef` entry in `apps/nas-mcp/src/tool-definitions.ts`. The `buildCommand` function receives the validated tool input and must return a shell command string.
2. Add the tool name to `enabled_read_tools` or `enabled_write_tools` in `apps/nas-mcp/tools-config.json`.
3. Push to `main`. CI builds a new image; Coolify auto-deploys.

Write tools (`write: true`) always go through the preview-and-confirm flow. The MCP server shows the raw command to the operator before executing. Set `confirmed: true` to approve.

## Adding a new Supabase table or column

1. Run `supabase migration new <description>` to create a migration file.
2. Write the SQL in `supabase/migrations/<timestamp>_<description>.sql`.
3. Push to `main`. The `supabase-migrations.yml` workflow applies the migration automatically.

## Debugging a deployed service

**NAS MCP** (Coolify):
- `GET /health` returns session count, tool counts, and service status — no auth required
- `GET /tools` returns the enabled tool catalog — no auth required
- Container logs in Coolify UI, or via the DevOps MCP `docker_logs` tool

**NAS API** (on-NAS container):
- `curl http://localhost:7734/health` from inside the NAS
- `docker logs synology-monitor-nas-api` on the NAS

**Agent** (on-NAS container):
- `docker logs synology-monitor-agent` on the NAS
- Agent sends a heartbeat on startup with its build SHA — grep for `sha=` to confirm the right version is running

See [deploy/synology/README.md](../deploy/synology/README.md) for the full verification command set.

## Deployment workflow

All production deploys go through GitHub Actions on push to `main`. There is exactly one branch. Do not create feature branches.

See [AI_OPERATING_RULES.md](../AI_OPERATING_RULES.md) for the full deployment constraints.
