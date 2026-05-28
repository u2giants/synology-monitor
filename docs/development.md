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

The agent exits immediately if `DSM_USERNAME`, `DSM_PASSWORD`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, or a UUID-format `NAS_ID` are missing.

### Adding a collector

1. Create `apps/agent/internal/collector/yourname.go` with a struct that has a `Run(stop <-chan struct{})` method.
2. Wire it in `apps/agent/cmd/agent/main.go` alongside the other collectors. **You must use the WaitGroup pattern — no exceptions:**
   ```go
   wg.Add(1)
   go func() {
       defer wg.Done()
       yourCollector.Run(stop)
   }()
   ```
   Doing `go yourCollector.Run(stop)` without `wg.Add(1)` means graceful shutdown does not wait for the collector to finish, silently dropping in-flight WAL writes. This exact bug existed for the ShareSync collector until 2026 (see `AGENTS.md` safety rules).
3. If the collector needs to persist a cursor between restarts, use `sender.SaveCheckpoint` / `sender.LoadCheckpoint` — these write to the `checkpoints` table in the local WAL SQLite file.
4. To send data to Supabase, add a payload type to `sender/types.go` and a `Queue*` method to `sender/sender.go`. Add the target table name to `upsertTables` in `sender.go` only if the table has a unique constraint and you want merge-on-conflict semantics.

### Sender WAL

The agent buffers writes in `/app/data/wal.db` (configurable via `DATA_DIR`). A `checkpoints` table in the same SQLite file stores named string values — used by collectors to persist log file byte offsets and similar cursors across restarts.

Entries that fail to flush 5 times are abandoned (logged, not retried forever). WAL size is capped at `MAX_WAL_SIZE_MB` (default 100 MB); oldest entries are dropped when the cap is hit.

**When adding WAL cleanup code:** every `s.db.Exec(...)` call must check its error return. Silent discard means cleanup failures go unreported and the WAL can grow without bound with no log evidence. See `AGENTS.md` safety rules.

## NAS API (Go)

```sh
cd apps/nas-api

CGO_ENABLED=0 go build ./...
go test ./...
```

The validator (`internal/validator/validator.go`) is the authoritative source for which commands are allowed and at which tier. Add tests in `validator_test.go` whenever you add or reclassify a command pattern.

## Web app (Next.js)

```sh
cd apps/web    # or run from repo root with pnpm

pnpm install
pnpm dev       # starts on http://localhost:3000

pnpm build     # production build (requires env vars)
pnpm lint
pnpm typecheck
```

The web Dockerfile builds from the repo root (not `apps/web/`) because it needs access to shared packages. Run `docker build -f apps/web/Dockerfile .` from the repo root if building locally.

### Environment for local dev

Copy `apps/web/.env.example` to `apps/web/.env.local` and fill in:

```sh
NEXT_PUBLIC_SUPABASE_URL=https://qnjimovrsaacneqkggsn.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
NAS_EDGE1_API_URL=http://100.107.131.35:7734
NAS_EDGE1_API_SECRET=...
NAS_EDGE1_API_SIGNING_KEY=...
NAS_EDGE2_API_URL=http://100.107.131.36:7734
NAS_EDGE2_API_SECRET=...
NAS_EDGE2_API_SIGNING_KEY=...
```

NAS URLs are Tailscale IPs — you need Tailscale connected to reach the NAS API in local dev.

### Issue agent in local dev

The issue agent runs as a background worker. In local dev it runs inline (`ISSUE_WORKER_MODE=inline`, the default). The cycle runs on each request to the assistant page.

To test a specific issue cycle: open the assistant page, select an issue, and click the run button. Logs appear in the Next.js terminal.

## NAS MCP server (Node.js)

```sh
cd apps/nas-mcp

pnpm install
pnpm build     # compiles TypeScript to dist/

# Run locally
NAS_EDGE1_API_URL=... NAS_EDGE1_API_SECRET=... node dist/index.js
```

To add a tool:

1. Add a new `McpToolDef` entry to `ALL_TOOL_DEFS` in `src/tool-definitions.ts`.
2. Tag it: add `<name>: "<group>"` to `TOOL_GROUPS` in the same file. (Optional — untagged tools fall into `"misc"` and startup logs a warning. They remain searchable + invokable.)
3. Enable it: add the name to `enabled_read_tools` or `enabled_write_tools` in `tools-config.json`.
4. `pnpm build` to type-check.
5. Push to `main`.

**No `src/index.ts` change needed.** The server exposes a fixed always-on surface (`tool_search`, `invoke_tool`, `run_command`, plus `EAGER_TOOLS` — `check_disk_space`, `restart_nas_api`). Every other registry tool is discovered via `tool_search` and executed via `invoke_tool({ name, target, args })`. If a new tool truly needs to be eager (no one will ever `tool_search` for it), add its name to `EAGER_TOOLS` in `index.ts`. The default should always be registry-only.

**Non-obvious:** tools in the registry but not listed in `tools-config.json` are built into the image but rejected by `invoke_tool` with a "disabled" message and hidden from `tool_search`. This lets you ship a tool dark and enable it without a code deploy — edit the JSON and push.

## Debugging

### Agent not sending data

1. Check agent logs: `docker logs synology-monitor-agent --tail 200`
2. Look for `[sender] error` lines — indicates WAL flush failures
3. Look for collector-specific `[sharesync]`, `[drive]`, `[share-health]` prefix lines
4. Check WAL size: if it's at the cap, old entries are being dropped

### ShareSync detectors not firing

The detectors only read new content since the last offset. On first run after deploy the offset is 0 and they scan the full current log. If you want to force a rescan, delete the checkpoint rows from `/app/data/wal.db`:

```sh
docker exec synology-monitor-agent sqlite3 /app/data/wal.db \
  "DELETE FROM checkpoints WHERE name LIKE 'sharesync_%';"
```

### Web app showing stale data

The issue agent runs on a cycle triggered by page requests. If the assistant page shows stale content, check that `ISSUE_WORKER_MODE` is not set to `background` without a worker process running.

### NAS API returning 403

The `NAS_EDGE1_API_SECRET` in the web app env must exactly match `NAS_API_SECRET` in the NAS `.env`. They are separate deployments; a mismatch is silent until a request is made.
