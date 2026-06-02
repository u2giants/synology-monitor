# Development

## Prerequisites

- **Go 1.23+** with CGO enabled (agent requires `go-sqlite3`; nas-api does not but uses the same toolchain)
- **Node.js 22+** and **pnpm 9** (web app and nas-mcp)
- **Docker** (to run Supabase locally or build images)
- `gcc` and `musl-dev` (or equivalent libc headers) for CGO builds on Linux/Alpine
- Tailscale connected (for live NAS API calls from dev; not needed if using stored evidence only)
- Supabase CLI (`npm i -g supabase`) for local migration management

## Local setup

```sh
# From repo root
pnpm install          # install all workspace deps
pnpm build            # build all packages in dependency order (turbo)
                      # pipeline: shared:build → web:build, nas-mcp:build
```

For the web app, copy the example env file and fill in values:

```sh
cp apps/web/.env.example apps/web/.env.local
# Edit .env.local — at minimum set:
#   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY
#   SUPABASE_SERVICE_ROLE_KEY
#   NAS_EDGE1_API_URL, NAS_EDGE1_API_SECRET, NAS_EDGE1_API_SIGNING_KEY
#   NAS_EDGE2_API_URL, NAS_EDGE2_API_SECRET, NAS_EDGE2_API_SIGNING_KEY
#   OPENAI_API_KEY or ANTHROPIC_API_KEY
```

`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are baked into the
Next.js client bundle at build time. In development `pnpm dev` reads them from
`.env.local` at runtime; in production they must be GitHub Secrets for the build
workflow to bake them in — changing them in Coolify after the image is built has no
effect.

## Running each service locally

### Web app (Next.js)

```sh
cd apps/web
pnpm dev              # http://localhost:3000
```

Or from the repo root:

```sh
pnpm dev              # turbo dev — runs all workspace apps with a dev script
```

The dashboard requires a live Supabase project (the production one is fine for
read-heavy dev). The issue agent requires `NAS_EDGE*` env vars and Tailscale
connectivity to reach the NAS APIs.

### Agent (Go)

```sh
cd apps/agent

export DSM_URL=https://192.168.1.x:5001
export DSM_USERNAME=admin
export DSM_PASSWORD=...
export SUPABASE_URL=https://qnjimovrsaacneqkggsn.supabase.co
export SUPABASE_SERVICE_KEY=...
export NAS_ID=4f1d7e2a-7d5d-4d5f-8b55-0f8efb0d1001   # must match nas_units.id
export NAS_NAME="Dev NAS"

CGO_ENABLED=1 go run ./cmd/agent
```

The agent exits immediately if `DSM_USERNAME`, `DSM_PASSWORD`, `SUPABASE_URL`,
`SUPABASE_SERVICE_KEY`, or a UUID-format `NAS_ID` are missing. It will not start
with a placeholder `NAS_ID`.

### NAS API (Go)

```sh
cd apps/nas-api

export NAS_API_SECRET=devSecret
export NAS_API_APPROVAL_SIGNING_KEY=devSigningKey
export DSM_USERNAME=admin
export DSM_PASSWORD=...

CGO_ENABLED=0 go run ./cmd/server
# Listens on :7734
```

Test that it started:
```sh
curl http://localhost:7734/health
# → {"status":"ok","build_sha":"dev","build_time":"unknown"}
```

### NAS MCP server (Node.js)

```sh
cd apps/nas-mcp

export MCP_BEARER_TOKEN=devToken
export NAS_EDGE1_API_URL=http://100.107.131.35:7734
export NAS_EDGE1_API_SECRET=...
export NAS_EDGE1_API_SIGNING_KEY=...
export NAS_EDGE2_API_URL=http://100.107.131.36:7734
export NAS_EDGE2_API_SECRET=...
export NAS_EDGE2_API_SIGNING_KEY=...

pnpm build            # compile TypeScript to dist/
pnpm start            # runs dist/index.js on port 3001
```

The MCP server is fully stateless. Every HTTP request builds a new `McpServer`,
handles it, and discards state. Do not add session state.

## Running tests

### Go (agent + nas-api)

```sh
# Agent
cd apps/agent && go test ./...

# NAS API
cd apps/nas-api && go test ./...
```

The validator tests are the most important — run them whenever you add or reclassify
a command pattern:

```sh
cd apps/nas-api && go test ./internal/validator/...
```

The NAS API validator uses Go's `regexp` package, which is RE2 syntax. Do not use
PCRE/JavaScript-only features such as lookahead, lookbehind, or backreferences in
`regexp.MustCompile` patterns. An invalid `MustCompile` pattern panics during
package initialization and crash-loops `synology-monitor-nas-api` after Watchtower
pulls the image. If the local machine lacks Go, run the validator tests in Docker:

```sh
docker run --rm -v "$PWD/../..:/src" -w /src/apps/nas-api golang:1.23-alpine \
  go test ./internal/validator/...
```

### TypeScript

There are no Jest/Vitest test suites in the TS workspace. The CI equivalent is:

```sh
pnpm type-check       # TypeScript check across all apps (from repo root)
```

The web image build also runs an AI cache guard before Docker build:

```sh
pnpm --filter @synology-monitor/web run guard:ai
```

This guard is a hard build blocker in CI (`web-image.yml`). Run it locally after
touching pipeline prompt ordering, provider usage fields, or context compiler logic.

## Linting

```sh
pnpm lint             # ESLint across all apps (from repo root)
pnpm type-check       # TypeScript type check across all apps
```

Per-app:

```sh
cd apps/web && pnpm lint
cd apps/nas-mcp && pnpm lint
```

There is no Go linter wired into the monorepo scripts. Run `go vet ./...` manually
in `apps/agent` or `apps/nas-api` if needed.

## Key source areas

```
apps/web/src/
  app/
    (dashboard)/      — operator-facing pages (metrics, logs, sync-triage, settings, etc.)
    api/              — API routes
  lib/server/
    ai/               — 3-stage pipeline:
      stage1-structurer.ts   — deterministic dedup + evidence persistence
      stage2-reasoning.ts    — agentic reasoning loop with tool execution
      stage3-explainer.ts    — operator message + durable memory extraction
      pipeline-v2.ts         — orchestrator
      stage2-turn.ts         — turn state machine (terminals, approval persistence)
      fetch-evidence.ts      — fetch_evidence tool implementation
      context-compiler.ts    — stable→dynamic block ordering for cache correctness
      call-model.ts          — provider-agnostic model call wrapper
    issue-agent.ts     — telemetry gathering (gatherTelemetryContext)
    issue-detector.ts  — fingerprinting raw telemetry into issues
    issue-store.ts     — issue CRUD
    issue-workflow.ts  — job queue + status transitions
    nas-api-client.ts  — HTTP client for nas-api
    ai-settings.ts     — model selection + fallback chain
    copilot.ts         — legacy NAS assistant chat
  hooks/               — React hooks for dashboard data

apps/agent/internal/
  collector/           — per-domain telemetry collectors (system, drive, diskstats, etc.)
  logwatcher/          — inotify + tail-based log watcher
  sender/              — SQLite WAL + Supabase flush, poison-row isolation
  security/            — inotify-driven security event watcher

apps/nas-api/internal/
  validator/           — tier classification + hard-block list
  executor/            — subprocess runner (process group kill, WaitDelay)
  auth/                — bearer token + HMAC verifier

packages/shared/src/
  nas-tools.ts         — 118 NAS tool definitions (McpToolDef, ALL_TOOL_DEFS)
```

## Database migrations

Migrations are in `supabase/migrations/`. Naming convention:
`000NN_short_description.sql` where NN is the next number after the current max.

Current max: **00041**.

To apply locally with the Supabase CLI:

```sh
supabase db push      # apply pending migrations to your local Supabase
```

Applied migrations are permanent. Do not edit them. Write a new migration to
correct a previous one.

## Monorepo build pipeline

```sh
pnpm install          # install all workspace deps
pnpm build            # build all packages (turbo)
pnpm type-check       # TypeScript check across all apps
pnpm lint             # lint across all apps
pnpm check:dashboard-data   # runs scripts/check-dashboard-data.mjs
```

Turbo caches build outputs in `.turbo/`. The dependency order:
`shared:build → (web:build, nas-mcp:build)`.

## Workflow: adding a new NAS tool

This is the most common extension task. A "NAS tool" is a predefined diagnostic or
remediation command the MCP server and/or the Stage 2 issue agent can invoke.

### Step 1 — Define the tool in `packages/shared/src/nas-tools.ts`

Add an entry to `ALL_TOOL_DEFS`:

```typescript
{
  name: "my_new_tool",
  description: "What it does — be specific, Stage 2 picks tools by description.",
  write: false,          // true if it modifies NAS state (tier 2/3)
  params: {
    target,              // import the shared target param
    // add any other zod params your command needs
    filter: z.string().optional().describe("optional search term"),
  },
  buildCommand: (input) => [
    "echo '=== MY TOOL ==='",
    `grep -r ${quote(String(input.filter ?? ""))} /var/log/my-log.log | tail -n 50`,
  ].join("\n"),
},
```

Add it to `TOOL_GROUPS` in the same file so `tool_search` can find it by group:

```typescript
const TOOL_GROUPS: Record<string, string> = {
  // ... existing entries ...
  my_new_tool: "logs",   // pick the closest group
};
```

If you skip `TOOL_GROUPS`, the tool falls into `"misc"` and startup logs a warning.
It still works, but won't surface in group-based searches.

Path rule for NAS tools: commands run inside the `synology-monitor-nas-api`
container. Do not assume the telemetry agent's mount layout. Package state is
mounted at `/host/packages`, DSM binaries at `/host/usr/syno`, DSM logs at
`/host/log`, and the full Btrfs volume at `/btrfs/volumeN`. Individual shared
folders are mounted under `/volume1/<share>`, but that is not enough for snapshot
enumeration. If DSM 7 hides scheduler or Snapshot Replication details behind
package state or WebAPI, prefer narrow read-only path discovery plus DSM WebAPI
`list`/`query` methods over broad filesystem scans.

### Step 2 — Enable the tool in `apps/nas-mcp/tools-config.json`

Add the tool name to `enabled_read_tools` (read-only) or `enabled_write_tools`
(state-modifying):

```json
{
  "enabled_read_tools": [
    "...",
    "my_new_tool"
  ]
}
```

A tool present in `ALL_TOOL_DEFS` but absent from `tools-config.json` is invisible
to `tool_search` and rejected by `invoke_tool` with a "disabled" message. This lets
you ship a tool dark and enable it without a code deploy.

### Step 3 — For write tools: update the NAS API validator

If `write: true`, the validator at `apps/nas-api/internal/validator/validator.go`
must be able to classify the generated command at the right tier.

- **Tier 2** (service ops — reversible, no `/volume*` touch): the command probably
  already matches a `writePatterns` regex. Verify with a test.
- **Tier 3** (file ops — touches `/volume*`): ensure a `filePatterns` entry matches.
- **Allowlisted Docker compose commands**: add to `allowedServiceCommands` in
  `validator.go` if it's a `docker compose ...` variant.

Always add a test in `apps/nas-api/internal/validator/validator_test.go`:

```go
{name: "my_new_tool tier2", command: "synopkg restart MyPackage", wantTier: 2},
```

Regex rule: `apps/nas-api` is Go, so `regexp.MustCompile` patterns must be valid
Go/RE2 regular expressions. Do not use negative lookahead like `(?!...)` to make
exceptions. Express the positive match instead, or write a small Go helper and test
both the matching and exception cases.

Run:
```sh
cd apps/nas-api && go test ./internal/validator/...
```

If the local machine lacks Go, use the same containerized test command as CI/debug
sessions:

```sh
docker run --rm -v "$PWD/../..:/src" -w /src/apps/nas-api golang:1.23-alpine \
  go test ./internal/validator/...
```

### Step 4 — Stage 2 picks it up automatically

Stage 2's `buildStage2Tools()` in `stage2-reasoning.ts` loads all
`ALL_TOOL_DEFS.filter(def => !def.write)` automatically. No registration needed.
Write tools never appear in Stage 2 (the agent proposes remediations; it does not
auto-execute tier-2/3 actions).

### Step 5 — Build and verify

```sh
pnpm build            # from repo root — compiles shared, web, nas-mcp
pnpm type-check
```

Push to `main`. `nas-mcp-image.yml` triggers on changes to `apps/nas-mcp/**` and
`packages/shared/**` and redeploys the MCP server. `web-image.yml` also watches
`packages/shared/**`, so shared tool changes may build/redeploy the web image too.

## Workflow: adding a new metric or telemetry type

This is the pipeline for getting a new data source into the issue agent's evidence
store and prompt.

### Step 1 — Agent collector

Create `apps/agent/internal/collector/yourname.go`. The collector must:

1. Implement a `Run(stop <-chan struct{})` method.
2. Use the WaitGroup pattern when wired in `main.go`:

   ```go
   wg.Add(1)
   go func() {
       defer wg.Done()
       yourCollector.Run(stop)
   }()
   ```

   Omitting `wg.Add(1)` means graceful shutdown returns before the collector
   finishes, silently dropping in-flight WAL writes. This exact bug existed in the
   ShareSync collector (see AGENTS.md §10).

3. Call `sender.Queue*` to buffer rows. Add a payload type to `sender/types.go`
   and a `Queue*` method to `sender/sender.go` if this is a new table.

4. To persist a cursor between restarts, use `sender.SaveCheckpoint` /
   `sender.LoadCheckpoint` (writes to the `checkpoints` SQLite table in the WAL).

5. Access host kernel data at `/host/proc/...` and `/host/sys/...` — the NAS
   compose mounts `/proc:/host/proc:ro` and `/sys:/host/sys:ro`. See `diskstats.go`
   and `sysextras.go` for examples.

**Do not add a sender payload field without a matching Supabase column.** The
PostgREST batch will reject the row and trigger poison-row isolation (5 retries,
then drop).

### Step 2 — Database migration

Add a migration for the new table or column:

```sh
# Next number after 00041:
supabase/migrations/00042_add_my_new_table.sql
```

For a new time-series table, follow the pattern in existing migrations for
pg_partman monthly partitioning. Applied migrations are immutable — never edit
them.

### Step 3 — Supabase sender

If the new data belongs in an existing table (e.g. a new `type` in `metrics`), no
schema change is needed. If it is a new table:

- Add to `upsertTables` in `sender/sender.go` **only** if the table uses
  merge-on-conflict semantics (like `package_status`). All other tables are
  append-only inserts.
- Add the table name to the Go sender payload types in `sender/types.go`.

### Step 4 — `gatherTelemetryContext` in `issue-agent.ts`

Add a Supabase query for the new table in `apps/web/src/lib/server/issue-agent.ts`
inside the `Promise.all([...])` block:

```typescript
supabase
  .from("my_new_table")
  .select("nas_id, captured_at, my_field, another_field")
  .gte("captured_at", since6h)
  .order("captured_at", { ascending: false })
  .limit(20),
```

Collect the result:

```typescript
const myNewData = collectResult("my_new_data", myNewResult, telemetry_errors);
```

Return it from the function:

```typescript
return {
  // ... existing fields ...
  my_new_data: myNewData,
};
```

### Step 5 — Stage 1 `TELEMETRY_SOURCES` in `stage1-structurer.ts`

Add a `SourceMap` entry to the `TELEMETRY_SOURCES` array in
`apps/web/src/lib/server/ai/stage1-structurer.ts`:

```typescript
{
  key: "my_new_data",         // must match the key returned by gatherTelemetryContext
  source: "my_source_label",  // appears in evidence bodies as "source/severity: body"
  tsFields: ["captured_at"],  // fields tried in order for the timestamp
  // bodyFields: ["field1", "field2"], // optional: joined with " — "; omit to use full JSON
},
```

**Omit `bodyFields` when diagnostic numbers must be visible.** If you use
`bodyFields`, only those fields form the evidence body — metric values land in
`metadata` which `fetch_evidence` never returns, making the data invisible to Stage
2. See the comment on `top_processes` in the source file.

Stage 1 runs automatically before every Stage 2 turn. Once added here, the new data
surfaces in `issue_evidence_items` and the bounded evidence slice that Stage 2
receives in its prompt.

### Step 6 — Stage 2 taxonomy (optional)

If the new data requires interpretation rules (e.g. thresholds, DSM blind spots,
known false-positive patterns), add them to the `NAS_TAXONOMY` constant in
`apps/web/src/lib/server/ai/stage2-reasoning.ts`. Keep additions concise — the
taxonomy is in the stable cacheable prefix, so additions persist across all turns.

### Step 7 — Verify the pipeline

```sh
pnpm type-check       # catch type mismatches across issue-agent / stage1 / stage2
```

Check that a new issue run populates `issue_evidence_items` with the expected
`source` label. The Supabase dashboard or `fetch_evidence` (from Stage 2) can
confirm rows are landing.

## Debugging

### Agent not sending data

1. Check `/app/data/wal.db` size — if growing, data is queuing but not flushing.
2. Check agent container logs: `docker logs synology-monitor-agent`.
3. Check `nas_logs` and `metrics` freshness in Supabase. If metrics are fresh but
   logs are stale, one source is hitting a bad row — check the sender log for
   `[sender] isolating bad row` lines.
4. An empty table is a bug, not a healthy state. A collector may be hitting an
   unsupported DSM API — check `nas_logs` for `API unavailable` or error 103 entries.

### NAS API not responding

1. Check `docker logs synology-monitor-nas-api` on the NAS.
2. Verify Tailscale is connected: the web app reaches NAS API over Tailscale IPs
   (`100.107.131.35:7734` / `100.107.131.36:7734`).
3. Health check: `GET http://<nas-tailscale-ip>:7734/health` returns `{"status":"ok"}`.
   This endpoint requires no auth.
4. A silent 403 on every request usually means the `NAS_API_SECRET` in Coolify does
   not match `NAS_API_SECRET` in the NAS `.env` — credential parity mismatch.
5. `ECONNREFUSED` means the NAS is reachable but nothing is listening on `:7734`.
   Check `docker ps -a` and `docker logs synology-monitor-nas-api --tail 100`. If
   the logs show a Go panic from `regexp.MustCompile`, fix the validator regex,
   push, wait for `nas-api-image.yml`, then pull/recreate `nas-api` on both NASes.

### Stage 2 / issue-agent not running

1. Check `issue_jobs` table — are jobs being enqueued with `status='pending'`?
2. Check `ISSUE_WORKER_MODE` env var:
   - `inline` — jobs drain on the next API request to the dashboard
   - `background` — a separate worker loop drains via `ISSUE_WORKER_TOKEN`
3. Check `ai_model_calls` table for model errors (rate limits, invalid key, context
   window exceeded).
4. Check `issue_stage_runs` for per-stage failure messages.

### Stage 1 evidence missing

If Stage 2 says evidence is empty but data is in the DB:

1. Check `issue_evidence_items` for the issue ID — Stage 1 replaces rows on each
   run (idempotent delete + insert).
2. Check the `source` label in `issue_evidence_items` against `TELEMETRY_SOURCES`
   in `stage1-structurer.ts` — a mismatch in the `key` field silently skips the
   source.
3. Check `gatherTelemetryContext` return value — the key must match exactly.

### NAS API validator rejecting a command

Run the validator tests with the new command to diagnose the tier:

```sh
cd apps/nas-api && go test ./internal/validator/... -v
```

`ClassifyTier` returns `-1` for hard-blocked, `1` for read-only, `2` for service
ops, `3` for file ops. Add a targeted test case rather than guessing at regex
matches.

If the validator change introduces a new `regexp.MustCompile`, first confirm the
pattern is valid Go/RE2 syntax. A bad pattern will not merely reject a command; it
will panic at process start and take the whole NAS API offline.

### Type errors

```sh
pnpm type-check
```

The most common causes:

- A new DB column added without a matching TypeScript type annotation.
- A `fetch()` call without proper response typing.
- A new `gatherTelemetryContext` return field not reflected in `TELEMETRY_SOURCES`.
- The `shared` package not rebuilt after changing `nas-tools.ts` — run `pnpm build`
  from the repo root to regenerate `packages/shared/dist/`.

### Build: `guard:ai` CI check failing

The web app has an AI cache guard (`pnpm --filter @synology-monitor/web run guard:ai`)
that enforces stable→dynamic prompt block ordering and normalized provider usage
fields. If the CI build fails at this step, run the guard locally:

```sh
cd apps/web && pnpm run guard:ai
```

The error message identifies which file and which invariant failed.

## WAL mechanism

If the agent cannot reach Supabase (network outage, maintenance), all telemetry
queues in `/app/data/wal.db` on the NAS disk. The WAL is capped at
`MAX_WAL_SIZE_MB` (default 100 MB) — oldest entries are dropped at the cap. Once
connectivity resumes, the agent flushes the backlog automatically.

The `checkpoints` table in the same SQLite file stores durable collector cursors
(log file byte offsets, ShareSync watermarks, etc.) so collectors resume from the
right position after restarts.

**Poison-row isolation:** on a PostgREST `4xx`, the sender re-sends each row in
the failed batch individually. Good rows land; only the bad row accumulates retries
(max 5, then dropped). This was added after a single bad row silently froze log and
alert ingestion for 19h and 23 days respectively (see AGENTS.md §13).

## Custom metric schedules

To schedule a recurring shell command without a code change or deploy:

```sql
INSERT INTO custom_metric_schedules
  (name, description, nas_id, collection_command, interval_minutes, is_active, next_run_at)
VALUES
  ('my_check', 'What it does', 'edgesynology1', 'cat /proc/loadavg', 60, true, now());
```

The agent polls every 60s, claims due rows with an optimistic lock, and stores
output in `custom_metric_data`. Stage 2 can read recent output via `fetch_evidence`
(source: `custom_metric_data` rows surface after the next Stage 1 run for the issue).

Available paths in the agent container:

| Host path | Container path |
|---|---|
| `/proc` | `/host/proc` |
| `/sys` | `/host/sys` |
| `/var/log` | `/host/log` |
| `/volume1/@synologydrive` | `/host/shares/@synologydrive` |
| `/volume1/@SynologyDriveShareSync` | `/host/shares/@SynologyDriveShareSync` |
| (other shares) | `/host/shares/<name>` |
