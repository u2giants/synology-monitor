# Development

## Prerequisites

- **Go 1.23+** with CGO enabled (agent and nas-api require `go-sqlite3`)
- **Node.js 22+** and **pnpm 9** (web app and nas-mcp)
- **Docker** (to run Supabase locally or build images)
- `gcc` and `musl-dev` (or equivalent libc headers) for CGO builds on Linux/Alpine

## Agent (Go)

```sh
cd apps/agent

# Build
CGO_ENABLED=1 go build ./...

# Test
go test ./...

# Run locally (needs DSM and Supabase env vars)
export DSM_URL=https://192.168.1.x:5001
export DSM_USERNAME=...
export DSM_PASSWORD=...
export SUPABASE_URL=https://...
export SUPABASE_SERVICE_KEY=...
export NAS_ID=<uuid>
export NAS_NAME="Dev NAS"
go run ./cmd/agent
```

The agent exits immediately if `DSM_USERNAME`, `DSM_PASSWORD`, `SUPABASE_URL`,
`SUPABASE_SERVICE_KEY`, or a UUID-format `NAS_ID` are missing.

### Adding a collector

1. Create `apps/agent/internal/collector/yourname.go` with a struct that has a
   `Run(stop <-chan struct{})` method.
2. Wire it in `apps/agent/cmd/agent/main.go`. **You must use the WaitGroup pattern:**
   ```go
   wg.Add(1)
   go func() {
       defer wg.Done()
       yourCollector.Run(stop)
   }()
   ```
   Omitting `wg.Add(1)` means graceful shutdown does not wait for the collector,
   silently dropping in-flight WAL writes (this exact bug existed in the ShareSync
   collector — see AGENTS.md §10).
3. To persist a cursor between restarts, use `sender.SaveCheckpoint` /
   `sender.LoadCheckpoint` (writes to the `checkpoints` SQLite table in the WAL).
4. To send data to Supabase, add a payload type to `sender/types.go` and a
   `Queue*` method to `sender/sender.go`. Add the target table name to
   `upsertTables` in `sender.go` only if the table uses merge-on-conflict semantics
   (currently only `package_status`).

### Sender WAL

The agent buffers writes in `/app/data/wal.db` (configurable via `DATA_DIR`).
Entries that fail to flush 5 times are abandoned. WAL size is capped at
`MAX_WAL_SIZE_MB` (default 100 MB); oldest entries are dropped at the cap.

### Adding a new /proc or /sys metric

The NAS compose mounts `/proc:/host/proc:ro` and `/sys:/host/sys:ro`. Access host
kernel data at `/host/proc/...` and `/host/sys/...` — the `/host/` prefix keeps
host and container namespaces distinct. See `diskstats.go` and `sysextras.go` for
examples.

## NAS API (Go)

```sh
cd apps/nas-api

CGO_ENABLED=0 go build ./...
go test ./...
```

The validator (`internal/validator/validator.go`) is the authoritative source for
which commands are allowed and at which tier. Add tests in `validator_test.go`
whenever you add or reclassify a command pattern.

### Tier model

- Tier 1: read-only, auto-executes
- Tier 2: service ops, requires HMAC token
- Tier 3: file ops on `/volume*`, requires HMAC token

Hard-blocked commands are rejected regardless of tier. See `hardBlocked` in
`validator.go` for the current list.

## Web app (Next.js)

```sh
cd apps/web    # or run from repo root

pnpm install
pnpm dev       # starts on http://localhost:3000

pnpm build     # production build (requires env vars)
pnpm lint
pnpm type-check
```

### Key source areas

```
apps/web/src/
  app/
    (dashboard)/    — operator-facing pages
    api/            — API routes
  lib/server/
    ai/             — 3-stage pipeline (stage1-structurer, stage2-reasoning, stage3-explainer, pipeline-v2)
    issue-agent.ts  — telemetry gathering (gatherTelemetryContext)
    issue-detector.ts — fingerprinting raw telemetry into issues
    issue-store.ts  — issue CRUD
    issue-workflow.ts — job queue + status transitions
    nas-api-client.ts — HTTP client for nas-api
    backend-findings.ts — builds context snapshot for copilot
    copilot.ts      — legacy NAS assistant chat
    ai-settings.ts  — model selection + fallback chain
  hooks/            — React hooks for dashboard data
```

### AI pipeline

The 3-stage pipeline is in `apps/web/src/lib/server/ai/`:

- `stage1-structurer.ts` — deterministic dedup + evidence persistence
- `stage2-reasoning.ts` — agentic reasoning loop with tool execution
- `stage3-explainer.ts` — operator message + durable memory extraction
- `pipeline-v2.ts` — orchestrator: runs Stage 1 once, Stage 2 per turn, Stage 3 on resolve
- `stage2-turn.ts` — turn state machine (terminals, approval persistence)
- `fetch-evidence.ts` — `fetch_evidence` tool implementation
- `context-compiler.ts` — enforces stable→dynamic block ordering for cache correctness

### Adding a new AI stage capability

To give Stage 2 a new predefined NAS tool:
1. Add the tool definition to `packages/shared/src/nas-tools.ts` (name, description, params, `buildCommand`, tier, group)
2. Enable it in `apps/nas-mcp/tools-config.json` under `enabled_read_tools` or `enabled_write_tools`
3. Stage 2 picks it up automatically via `ALL_TOOL_DEFS.filter(def => !def.write)`

To add a free-form command (like the existing `run_command`), add a handler in
`stage2-reasoning.ts::makeToolExecutor` and add the tool schema to
`buildStage2Tools`.

## NAS MCP server (Node.js)

```sh
cd apps/nas-mcp

pnpm install
pnpm build      # compiles TypeScript to dist/
pnpm start      # runs compiled server
```

Tool definitions live in `packages/shared/src/nas-tools.ts`. Tool enablement is
controlled by `apps/nas-mcp/tools-config.json` — changes require a push to `main`
to deploy.

The server is stateless (per-request). Do not add session state.

## Monorepo commands (from repo root)

```sh
pnpm install        # install all workspace deps
pnpm build          # build all packages (turbo)
pnpm type-check     # TypeScript check across all apps
pnpm lint           # lint across all apps
```

Turbo caches build outputs in `.turbo/`. The build pipeline:
`shared:build → (web:build, nas-mcp:build)`.

## Database migrations

Migrations are in `supabase/migrations/`. Naming convention:
`000NN_short_description.sql` where NN is the next number after the current max.

Current max: **00041**.

To apply locally with the Supabase CLI:
```sh
supabase db push   # apply pending migrations to your local Supabase
```

Applied migrations are permanent — do not edit them. Write a new migration to
correct a previous one.

## Custom metric schedules

To add a new scheduled command (without code changes):
```sql
INSERT INTO custom_metric_schedules
  (name, description, nas_id, collection_command, interval_minutes, is_active, next_run_at)
VALUES
  ('my_check', 'What it does', 'edgesynology1', 'cat /proc/loadavg', 60, true, now());
```

The agent picks it up within 60 seconds and stores output in `custom_metric_data`.
Stage 2 can read recent output via `fetch_evidence` (source: `custom_metric_data`
rows surface in the evidence store after the next Stage 1 run).

## Debugging

### Agent not sending data
1. Check `/app/data/wal.db` size — if growing, data is queuing but not flushing
2. Check agent container logs: `docker logs synology-monitor-agent`
3. Check `nas_logs` freshness in Supabase — if metrics are fresh but logs are stale,
   one source is probably hitting a bad row; check sender's poison-row isolation log

### NAS API not responding
1. Check `docker logs synology-monitor-nas-api` on the NAS
2. Verify Tailscale is connected between the VPS and the NAS
3. `GET http://<nas-tailscale-ip>:7734/health` should return `{"status":"ok"}`

### Stage 2 / issue-agent not running
1. Check `issue_jobs` table — are jobs being enqueued?
2. Check `ISSUE_WORKER_MODE` env var (`inline` runs on-request; `background` needs the worker process)
3. Check `ai_model_calls` for model errors

### Type errors
```sh
pnpm type-check
```
The most common cause is a new DB column added without a matching type annotation,
or a `fetch()` call without proper response typing.

## WAL mechanism

If the agent cannot reach Supabase (network outage, Supabase maintenance), all
telemetry queues in `/app/data/wal.db` on the NAS disk. The WAL is capped at
`MAX_WAL_SIZE_MB` (default 100 MB). Once connectivity resumes, the agent flushes
the backlog automatically. The `checkpoints` table in the same SQLite file stores
durable collector cursors (log file byte offsets, etc.) so collectors resume from
the right position after restarts.
