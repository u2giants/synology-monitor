# Synology Archive Inventory — Implementation Plan (Build Guide)

> **Audience:** an engineer or AI session with **zero prior context**. Read this
> top to bottom. It tells you exactly which files to create/edit, what to put in
> them, how to build/test each piece, and how to verify and ship. The companion
> **design** doc is [`synology-archive.md`](synology-archive.md) — read it first
> for *why*; this doc is the *how*.
>
> **Golden rule:** do not invent behavior. Every decision you might otherwise
> have to make is pinned in **§2 Locked Design Decisions**. If something is
> genuinely und/under-specified, stop and ask the repo owner rather than guess.

---

## 0. Repository orientation & prerequisites

### 0.1 What this repo is

`github.com/u2giants/synology-monitor` is a pnpm + Turbo monorepo that monitors
two Synology NAS units, **edgesynology1** and **edgesynology2**. Relevant apps:

| App | Path | Language | Role |
| --- | --- | --- | --- |
| **nas-api** | `apps/nas-api` | Go 1.23 (stdlib only) | HTTP service running **on each NAS** in a Docker container. Today it exposes `POST /exec` and `POST /preview` — a tiered, bearer-authenticated shell-execution gate. **This is where the scanner + job manager will live.** |
| **nas-mcp** | `apps/nas-mcp` | TypeScript (ESM) | MCP server. Exposes NAS tools to Claude. Tool registry lives in `packages/shared/src/nas-tools.ts` (symlinked into nas-mcp). |
| **web** | `apps/web` | Next.js 15 (App Router), React 19, TS, Tailwind v4 | Cloud dashboard (deployed on Coolify). Reads Supabase; calls nas-api over Tailscale for live actions. **This is where the operator page goes.** |
| **agent** | `apps/agent` | Go | Pushes metrics/logs to Supabase. Not touched by this work. |
| **relay** | `apps/relay` | Node | Not in the web→nas-api path for this feature. Not touched. |

Deploy config for the NAS-side containers: `deploy/synology/docker-compose.agent.yml`.

### 0.2 How the pieces connect (the flow we are building)

```
Operator (browser)
   │  HTTPS
   ▼
apps/web  /archive-inventory page  ──►  Next.js API routes under /app/api/archive/*
                                              │  server-side fetch over Tailscale
                                              ▼
                              nas-api (on the chosen NAS)  POST/GET /jobs/inventory/*
                                              │
                                              ▼
                              jobs.Manager → scanner goroutine (filepath.WalkDir)
                                              │  writes
                                              ▼
                              /app/data/jobs/file-inventory/<job_id>/  (durable host mount)

Claude (MCP)  ──►  nas-mcp 5 tools  ──►  same nas-api /jobs/inventory/* endpoints
```

Both the **web UI** and **MCP** are thin clients over the **same nas-api job
endpoints**. nas-api is the single source of truth for job state. There is **no
new Supabase table** (see §2).

### 0.3 Sandbox / git prerequisites (do this first, every session)

This workspace has two known quirks (see the operator's memory):

1. **A root process intermittently breaks `.git` ownership.** If any `git`
   command fails with `Permission denied` on a loose object, run:
   ```bash
   sudo chown -R ai:ai /worksp/monitor/app
   ```
2. **Local `main` may have diverged from `origin/main`** (the working copy
   sometimes has local-only commits and uncommitted config edits). **Do not**
   force-merge or reset the working tree. To get authoritative file contents,
   read from `origin/main` explicitly:
   ```bash
   git -C /worksp/monitor/app fetch origin
   git -C /worksp/monitor/app show origin/main:apps/nas-api/cmd/server/main.go
   ```
   When you ship, push files via the GitHub API/`gh` (see §10) so you never have
   to reconcile the diverged local tree. `gh` is authenticated (`gh auth status`).
3. **Go is not preinstalled.** Install it before building nas-api:
   ```bash
   which go || (cd /tmp && curl -sSL https://go.dev/dl/go1.23.6.linux-amd64.tar.gz | sudo tar -C /usr/local -xz && export PATH=$PATH:/usr/local/go/bin)
   ```

### 0.4 Build/test commands you will use

```bash
# nas-api (Go) — from apps/nas-api
go build ./... && go test ./...

# nas-mcp + web (TS) — from repo root
pnpm install                      # if node_modules is stale
pnpm --filter @synology-monitor/nas-mcp build      # or: cd apps/nas-mcp && pnpm build
pnpm --filter web build
pnpm --filter web lint
pnpm --filter web type-check
```
(If the `--filter` names differ, `cd` into the app dir and run the script from
its own `package.json` — check `name` field first.)

---

## 1. Scope

This guide covers **two phases**, both required for the app to be useful and
end-to-end testable. Build Phase 1 first and ship it; then build Phase 2.

- **Phase 1 — Inventory** (read-only reporting). Detailed in §§3–9.
- **Phase 2 — Archive Move** (relocation with verify-and-rollback). Detailed in
  §11, and specified comprehensively in
  [`synology-archive.md` → *Phase 2 — Archive Move*](synology-archive.md).

### 1.1 Phase 1 scope

Build the **smallest useful, fully GUI-covered** inventory:

- Durable nas-api jobs mount (compose + env).
- nas-api: job manager + mtime-year scanner + Drive/ShareSync overlay +
  six REST endpoints (start, schedule, list, status, result, cancel).

> **The overlay is REQUIRED in this PR — build it.** Its purpose is safety: it
> reports which folders had recent Synology Drive / ShareSync activity so the
> operator never archives data that is still actively in use. "Best-effort" in
> §5.4 refers only to *runtime error handling* (if a database is locked, skip
> that source and record why) — it does **not** mean the feature is optional to
> implement. The per-job `overlay` flag defaults to **on**.
- nas-mcp: 5 MCP operations proxying those endpoints, correctly tiered.
- web: `/archive-inventory` operator page covering **all five operations
  including scheduling**, plus the supporting Next.js API routes.
- Tests + docs.

**Deferred to a later, separate effort (NOT Phase 2):** Supabase persistence of
results, atime/relatime changes. (Archive *move* execution and per-file manifests
are **Phase 2**, specified here — not deferred.)

---

## 2. Locked Design Decisions (do not deviate)

These resolve every ambiguity. If you find yourself about to choose, the choice
is already made here.

1. **Job endpoints are native REST on nas-api, not shell commands.** They do
   **not** pass through `internal/validator` or `/exec`. The scanner runs
   in-process Go (`filepath.WalkDir`), never shells out to `find`.
2. **Authorization reuses the existing HMAC tier model.** Read ops
   (status/list/result) need only the bearer token (tier-1 equivalent). State-
   changing ops (start/schedule/cancel) additionally require an **approval
   token** — the *same* `auth.Verifier.VerifyApprovalToken` used by `/exec`,
   but the signed "command" is a **canonical operation string** (§Appendix A).
3. **nas-api is the single source of truth.** State persists to disk under the
   new mount. **No new Supabase tables. No nas-api→Supabase writes.**
4. **Live progress = polling.** The web UI polls a status endpoint every 2s.
   MCP fetches status on demand. No realtime channel for jobs.
5. **One inventory job per NAS at a time.** A second `start`/`schedule` while one
   is `queued`/`running` returns `409 Conflict`.
6. **Scheduling lives in nas-api**, persisted to disk, re-armed on startup. A
   scheduled job has status `scheduled` + `scheduled_for`. A ticker promotes due
   jobs to `queued`. (Survives Watchtower container recreation via disk state.)
7. **The Drive/ShareSync overlay is part of this PR (not deferred)** and exists
   to prevent archiving active data. It uses the `sqlite3` CLI already in the
   nas-api runtime image (via `os/exec` on a *copy* of the DB files). No cgo, no
   Go SQLite driver. The per-job `overlay` flag defaults to **on**. "Best-effort"
   means runtime degradation only: failures (locked/missing/malformed DB) are
   recorded in `overlay_note` and skipped, never fatal to the job.
8. **I/O priority is best-effort.** Lower the scanner goroutine's niceness and
   set idle ioprio via raw Linux syscalls; on any error, log and continue.
9. **Result fetching is bounded** for MCP (paginated, capped rows/bytes). The
   web CSV download streams the full file (not model-facing).
10. **No feature branches.** Repo is single-branch `main` (see `CLAUDE.md`).
    Commit style: `area: short imperative`, co-author trailer
    `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`.
11. **Full option parity in the GUI.** *Every* scanner option is exposed in the
    web page — not just the common ones. Beyond NAS/shares/cutoff/overlay/
    schedule, the page exposes an **Advanced options** panel for I/O priority,
    throttle (`max_files_per_second`), `sleep_every_files`, `sleep_ms`, and the
    **date protection** control below. MCP exposes the same via tool params.
12. **Date-based protection (whitelist), independent of activity.**
    `protect_newer_than` (an RFC3339 UTC date) protects any file whose
    *newest* timestamp — `max(mtime, ctime, btime)` — is at or after that date,
    so recently-created or recently-changed files are never treated as archive
    candidates **even if the activity overlay shows nothing**. Defaults to empty
    (no extra protection) but is always exposed in the GUI and MCP. btime
    (creation/birth time) is read via `statx`; if unavailable, fall back to
    `max(mtime, ctime)` and note it.

---

## 3. Phase 0 — Sanity baseline

1. Do §0.3 (fix ownership, fetch, install Go).
2. Confirm the three target files match what this plan assumes (line anchors may
   drift; the *patterns* are what matter):
   ```bash
   git -C /worksp/monitor/app show origin/main:apps/nas-api/cmd/server/main.go | head -90
   git -C /worksp/monitor/app show origin/main:apps/nas-mcp/src/index.ts | sed -n '1,60p'
   git -C /worksp/monitor/app show origin/main:apps/web/src/lib/server/nas-api-client.ts | head -75
   ```
3. Note the exposed nas-api endpoints today: `GET /health`, `POST /exec`,
   `POST /preview`, all in `apps/nas-api/cmd/server/main.go`. Auth via
   `requireAuth(v, handler)`. Helpers: `writeJSON`, `mustEnv`, `envOr`.

---

## 4. Phase 1 — Deploy: durable jobs mount

**File:** `deploy/synology/docker-compose.agent.yml`

Under the `nas-api:` service `volumes:` list, **add** (place it right after the
`agent`-stack mount line `…/synology-monitor-agent:ro`, around line 98):

```yaml
      # Durable job state for the file-inventory scanner. Host-path mount so the
      # operator can inspect/recover results directly. Survives Watchtower
      # container recreation (named volume would also work; host path is friendlier).
      - ${NAS_API_JOBS_PATH:-/volume1/docker/synology-monitor-agent/nas-api-jobs}:/app/data/jobs:rw
```

Also add `NAS_NAME` to the nas-api `environment:` block (the scanner stamps it
into result CSVs):

```yaml
    environment:
      TZ: ${TZ:-UTC}
      NAS_NAME: ${NAS_NAME:-}
```

**Env examples:** add to `deploy/synology/nas-1.env.example`,
`deploy/synology/nas-2.env.example`, and `deploy/synology/.env.agent.example`:

```bash
# Logical name of THIS NAS (must match the names the web/MCP target by:
# edgesynology1 or edgesynology2). Falls back to hostname if unset.
NAS_NAME=edgesynology1            # nas-1.env.example
# NAS_NAME=edgesynology2          # nas-2.env.example
# Optional override for where inventory job state is stored on the host:
# NAS_API_JOBS_PATH=/volume1/docker/synology-monitor-agent/nas-api-jobs
```

**Deployment note (put in the PR description and AGENTS.md):** Watchtower applies
new **images**, not compose changes. After this PR ships and the new image is
pulled, the operator must run **once on each NAS**:
```bash
cd /volume1/docker/synology-monitor-agent && docker compose up -d
```
to materialize the new mount and `NAS_NAME` env. Until then the job endpoints
return `503` (see §5.6 startup guard).

---

## 5. Phase 2 — Backend (nas-api, Go)

New package: `apps/nas-api/internal/jobs/`. New endpoints wired in
`cmd/server/main.go`. All code is **stdlib-only** except the overlay which
`os/exec`s the `sqlite3` binary.

### 5.0 Directory layout to create

```
apps/nas-api/internal/jobs/
  types.go        # Job, Status, request/response structs, canonical op strings
  store.go        # disk persistence: atomic read/write of status.json, result CSVs
  manager.go      # lifecycle: single worker, scheduler ticker, cancel, startup recovery
  scanner.go      # filepath.WalkDir aggregation by mtime year + dir/empty-dir counts
  overlay.go      # optional Drive/ShareSync sqlite3 overlay (best-effort)
  priority.go     # best-effort nice + ionice via raw syscalls
  manager_test.go
  scanner_test.go
```

### 5.1 `types.go`

Define exactly these (JSON tags matter — the web/MCP depend on them):

```go
package jobs

type Status string

const (
	StatusQueued      Status = "queued"
	StatusScheduled   Status = "scheduled"
	StatusRunning     Status = "running"
	StatusComplete    Status = "complete"
	StatusFailed      Status = "failed"
	StatusCancelled   Status = "cancelled"
	StatusInterrupted Status = "interrupted"
)

// Job is the persisted metadata for one inventory run.
type Job struct {
	ID            string   `json:"id"`              // inv_<utc8>_<nas>_<rand4>
	Type          string   `json:"type"`            // always "file_inventory"
	NAS           string   `json:"nas"`             // NAS_NAME
	Status        Status   `json:"status"`
	TargetShares  []string `json:"target_shares"`   // e.g. ["files","styleguides"]
	CutoffYears   []int    `json:"cutoff_years"`    // e.g. [2021,2022]
	Overlay       bool     `json:"overlay"`         // run Drive/ShareSync overlay?
	ScheduledFor  string   `json:"scheduled_for"`   // RFC3339 UTC or ""
	StartedAt     string   `json:"started_at"`      // RFC3339 or ""
	FinishedAt    string   `json:"finished_at"`     // RFC3339 or ""
	CurrentShare  string   `json:"current_share"`
	FilesScanned  int64    `json:"files_scanned"`
	BytesScanned  int64    `json:"bytes_scanned"`
	ElapsedSecond int64    `json:"elapsed_seconds"`
	ResultReady   bool     `json:"result_available"`
	Error         string   `json:"error"`
	OverlayNote   string   `json:"overlay_note"`    // why overlay skipped, if any
}

// StartRequest is the body for POST /jobs/inventory and …/schedule.
type StartRequest struct {
	Shares           []string `json:"shares"`             // required, non-empty, allowlisted
	CutoffYears      []int    `json:"cutoff_years"`       // optional
	Overlay          *bool    `json:"overlay"`            // optional; nil → default TRUE
	ProtectNewerThan string   `json:"protect_newer_than"` // optional RFC3339 UTC date; see §2.11
	MaxFilesPerSec   int      `json:"max_files_per_second"` // optional throttle; 0 = unlimited
	UseIdleIO        *bool    `json:"use_idle_io_priority"` // optional; nil → default TRUE
	SleepEveryFiles  int      `json:"sleep_every_files"`  // optional; default 5000
	SleepMs          int      `json:"sleep_ms"`           // optional; default 25
	ScheduledFor     string   `json:"scheduled_for"`      // schedule endpoint only; RFC3339 UTC, future
}
```

**Allowlisted shares** (must match the compose mounts, §0/§Appendix C):
`files, styleguides, users, homes, Coldlion, Photography, freelancers, mgmt, mac,
oldStyleguides`. Reject anything else with `400`. Map share name → absolute path
`/volume1/<share>` (these are the read-only mounts that already exist).

**Excluded dir names while walking:** `#snapshot`, `@eaDir`, `@tmp`,
`.SynologyWorkingDirectory`, `Archive`.

### 5.2 `store.go`

- Base dir from env `NAS_API_JOBS_DIR` (default `/app/data/jobs`). Per-job dir:
  `<base>/file-inventory/<job_id>/`.
- `func SaveJob(j *Job) error` — write `status.json` **atomically**: write
  `status.json.tmp` then `os.Rename` to `status.json`. (`os.Rename` is atomic on
  same filesystem.)
- `func LoadJob(id string) (*Job, error)`, `func ListJobs() ([]*Job, error)`
  (scan subdirs, read each `status.json`).
- Result files written by the scanner into the job dir:
  `yearly.csv`, `cutoff.csv`, `dirs.csv`, and (if overlay ran) `overlay.csv`.
- `func ResultPath(id, kind string) string` mapping `kind ∈ {yearly,cutoff,dirs,overlay}`.
- Job ID helper: `inv_YYYYMMDDHHMMSS_<nas>_<rand4>` — timestamp from the caller
  (manager) using `time.Now().UTC()`, `rand4` from `crypto/rand` hex. (Do **not**
  use package-level `Date.now`/random in a way that breaks determinism — this is
  Go, normal `time.Now()` is fine here.)

### 5.3 `scanner.go`

Signature: `func (m *Manager) scan(ctx context.Context, j *Job) error`.

Algorithm per the design doc (§Scanner Implementation):

- For each share in `j.TargetShares`, resolve to `/volume1/<share>`, then
  `filepath.WalkDir(root, fn)`.
- In `fn`:
  - If `d.IsDir()` and `d.Name()` is in the excluded set → `return filepath.SkipDir`.
  - **Skip symlinks:** check `d.Type()&os.ModeSymlink != 0` → `return nil`
    (never `Info()`/descend symlinks — avoids Synology `@eaDir`/snapshot link traps).
  - For directories, increment `total_dirs`; track per-dir child count to compute
    `empty_dirs` (a dir with zero non-excluded entries).
  - For regular files: `info, _ := d.Info()`; aggregate
    `byYear[share][info.ModTime().Year()] += {count:1, bytes:info.Size()}`.
  - **Protection classification (§2.11):** compute the file's *newest* timestamp
    `newest = max(mtime, ctime, btime)`. `mtime` = `info.ModTime()`; `ctime` =
    `info.Sys().(*syscall.Stat_t).Ctim`; `btime` via `statx` (raw syscall —
    `unix.Statx`/raw `SYS_STATX`, amd64; best-effort, fall back to `max(mtime,
    ctime)` if statx unavailable). If `ProtectNewerThan` is set and
    `newest >= ProtectNewerThan`, mark the file **protected**: still counted in
    `yearly`, but excluded from archive-candidate totals in `cutoff` and tallied
    into `protected_count`/`protected_bytes`. Protection is independent of the
    activity overlay — a file is protected by date *even if it shows no sync
    activity*, which is the point of the rule.
  - Every `sleep_every_files` (default 5000) files: persist progress
    (`m.store.SaveJob`), check `ctx.Err()` for cancellation (`return ctx.Err()`),
    and optional throttle `time.Sleep(sleep_ms)`.
- After walking all shares, write the three CSVs (schemas in §Appendix B), set
  `ResultReady=true`, `Status=complete`, `FinishedAt`.
- If `ctx` cancelled → `Status=cancelled`. On error → `Status=failed`, `Error=…`.

Set best-effort I/O priority at scan start: call `priority.LowerSelf()` (see 5.5)
inside the worker goroutine after `runtime.LockOSThread()` (priority is per-thread
on Linux).

### 5.4 `overlay.go` (required feature; runs when `j.Overlay`, which defaults true)

> Build this in the first PR. It is the safety mechanism that stops the operator
> from archiving folders that are still being synced/used. Default `overlay` to
> `true` when the start/schedule request omits the field (decode into a pointer
> or default after decode). "Best-effort" below = graceful runtime degradation,
> not optional implementation.

- Candidate DBs (read-only mounts already present):
  `/volume1/@synologydrive/...` and `/volume1/@SynologyDriveShareSync/...`
  SQLite files. Locate the relevant `*.sqlite` (+ `-wal`,`-shm`).
- Copy the triad into a temp workdir under the job dir
  (`<jobdir>/_overlay_tmp/`). If copy incomplete → set `j.OverlayNote`, skip.
- Query the **copy** via the `sqlite3` CLI:
  ```go
  out, err := exec.CommandContext(ctx, "sqlite3", "-readonly", "-csv", dbCopy,
      "SELECT ...").CombinedOutput()
  ```
  Aggregate to `overlay.csv` (schema §Appendix B). On any error (missing table,
  busy, malformed) → record `j.OverlayNote = "..."`, **do not fail the job**.
- **Pre-flight:** ensure `sqlite3` exists in the runtime image. It is listed in
  the nas-api `Dockerfile` apt install set — **verify** with
  `grep -n sqlite3 apps/nas-api/Dockerfile`; if absent, add `sqlite3` to the
  `apt-get install` line.

### 5.5 `priority.go` (best-effort)

```go
package jobs

import (
	"runtime"
	"syscall"
)

// LowerSelf drops CPU niceness and sets idle I/O priority for the CURRENT OS
// thread. Best-effort: any failure is returned for logging but is non-fatal.
// Caller must runtime.LockOSThread() so the thread running the scan is the one
// reniced. Linux/amd64 assumed (Synology DS923+ is amd64).
func LowerSelf() error {
	runtime.LockOSThread()
	// nice +10
	if err := syscall.Setpriority(syscall.PRIO_PROCESS, 0, 10); err != nil {
		return err
	}
	// ioprio_set(IOPRIO_WHO_PROCESS=1, who=0, IOPRIO_PRIO_VALUE(IDLE=3, 0))
	const sysIoprioSet = 251 // amd64
	const ioprioClassIdle = 3
	const ioprioClassShift = 13
	prio := uintptr(ioprioClassIdle << ioprioClassShift)
	if _, _, errno := syscall.Syscall(sysIoprioSet, 1, 0, prio); errno != 0 {
		return errno
	}
	return nil
}
```
Call it; if it errors, `log.Printf("inventory: priority best-effort failed: %v", err)`
and continue.

### 5.6 `manager.go`

Responsibilities:

- `New(store *Store, nasName string) *Manager` — holds `sync.Mutex`, the current
  active job (if any), a `context.CancelFunc` for the running scan, and the base
  store.
- **Single-job invariant:** `Start`/`Schedule` return `ErrBusy` (mapped to `409`)
  if an active job is `queued`/`running`.
- `Start(req StartRequest) (*Job, error)` — validate shares (allowlist), create
  Job (`StatusQueued`), persist, then launch the worker goroutine.
- `Schedule(req StartRequest) (*Job, error)` — validate `ScheduledFor` is RFC3339
  UTC and in the future; create Job (`StatusScheduled`), persist. Do **not** start
  a worker now.
- Worker goroutine: set `StartedAt`, `StatusRunning`, run `priority.LowerSelf()`,
  call `scan(ctx, job)`, persist terminal state.
- **Scheduler ticker:** a goroutine `time.NewTicker(30 * time.Second)`; on each
  tick, scan persisted jobs for `StatusScheduled` with `ScheduledFor <= now`;
  promote the earliest due one to `queued` and launch it (respecting the single-
  job invariant — if busy, leave it scheduled).
- **Cancel(id):** if it's the running job → call the stored cancel func; if it's a
  `scheduled` job → mark `cancelled`, persist.
- **Startup recovery (`RecoverOnStart()`):** on construction, scan all persisted
  jobs; any in `StatusRunning` → set `StatusInterrupted` (no resume support),
  persist. Past-due `StatusScheduled` are left for the ticker to promote.

### 5.7 HTTP endpoints — wire in `cmd/server/main.go`

Add to `main()` after the existing routes:

```go
	jobsDir := envOr("NAS_API_JOBS_DIR", "/app/data/jobs")
	nasName := envOr("NAS_NAME", hostnameOrEmpty())
	store := jobs.NewStore(jobsDir)
	mgr := jobs.New(store, nasName)
	mgr.RecoverOnStart()   // marks interrupted jobs
	mgr.StartScheduler()   // launches the ticker goroutine

	mux.HandleFunc("POST /jobs/inventory",        requireAuth(v, requireApproval(v, jobs.OpStart,    handleInventoryStart(mgr))))
	mux.HandleFunc("POST /jobs/inventory/schedule", requireAuth(v, requireApproval(v, jobs.OpSchedule, handleInventorySchedule(mgr))))
	mux.HandleFunc("GET  /jobs/inventory",        requireAuth(v, handleInventoryList(mgr)))
	mux.HandleFunc("GET  /jobs/inventory/{id}",   requireAuth(v, handleInventoryStatus(mgr)))
	mux.HandleFunc("GET  /jobs/inventory/{id}/result", requireAuth(v, handleInventoryResult(mgr)))
	mux.HandleFunc("POST /jobs/inventory/{id}/cancel", requireAuth(v, requireApproval(v, jobs.OpCancel, handleInventoryCancel(mgr))))
```

Notes:
- Go 1.22+ `ServeMux` supports method+pattern and `{id}` wildcards; read with
  `r.PathValue("id")`.
- **Startup guard:** if `jobsDir` is not writable (mount missing), the manager
  records that and every job handler returns `503` with a clear message ("jobs
  mount not present — run docker compose up -d"). Implement by attempting a
  `MkdirAll`+write probe in `NewStore`; expose `store.Ready() bool`.

`requireApproval` is a **new middleware** mirroring tier-2 in `/exec`:

```go
// requireApproval enforces an HMAC approval token for state-changing job ops.
// It rebuilds the canonical op string from the request body and verifies the
// token via the SAME auth.Verifier used by /exec (tier 2).
func requireApproval(v *auth.Verifier, op jobs.Op, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// read+buffer body so the handler can re-read it
		body, _ := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
		token := r.Header.Get("X-Approval-Token")
		canonical := jobs.CanonicalOpString(op, r.PathValue("id"), body) // deterministic, see Appendix A
		if token == "" {
			writeJSON(w, http.StatusForbidden, errResp{"approval_token required"})
			return
		}
		if err := v.VerifyApprovalToken(token, canonical, 2); err != nil {
			writeJSON(w, http.StatusForbidden, errResp{err.Error()})
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body)) // restore for handler
		next(w, r)
	}
}
```

Handlers follow the existing pattern (decode JSON, validate, `writeJSON`):
- `handleInventoryStart` → `mgr.Start(req)` → `201` with the Job; `ErrBusy` → `409`;
  bad shares → `400`.
- `handleInventorySchedule` → `mgr.Schedule(req)` → `201`; invalid time → `400`.
- `handleInventoryList` → `mgr.List()` → `200` `{ "jobs": [...] }`.
- `handleInventoryStatus` → `mgr.Get(id)` → `200` Job; not found → `404`.
- `handleInventoryResult` → query params `?result=yearly|cutoff|dirs|overlay&limit=&cursor=`.
  Stream the CSV with bounded rows when `limit` set (MCP path); when
  `?download=1` stream the whole file with
  `Content-Disposition: attachment; filename="<id>-<kind>.csv"` (web path).
  Enforce a hard cap (e.g. 5000 rows or 1 MB) on the non-download path.
- `handleInventoryCancel` → `mgr.Cancel(id)` → `200`.

Add helper `hostnameOrEmpty()` using `os.Hostname()`.

### 5.8 Tests (`*_test.go`, table-driven like `internal/validator/validator_test.go`)

- `scanner_test.go`: build a temp tree with `t.TempDir()`; assert year
  aggregation, exclusion of `@eaDir`/`#snapshot`/`Archive`/`@tmp`, **symlink
  skipping** (create a symlink, assert not counted/followed), **empty-dir
  counting**, cancellation (`ctx` cancelled mid-walk yields `cancelled`), and
  **date protection**: a file older than the cutoff year but with `mtime`
  (and separately `ctime`) at/after `protect_newer_than` lands in
  `protected_count`, NOT `candidate_count` — assert each timestamp triggers
  protection independently.
- `manager_test.go`: single-job invariant (second Start → `ErrBusy`); startup
  recovery (`running` → `interrupted`); scheduled-due promotion; atomic write
  (status.json never partially written — assert temp file gone after save).
- Run: `go test ./...` from `apps/nas-api`. All green before moving on.

### 5.9 Build gate

```bash
cd apps/nas-api && go build ./... && go vet ./... && go test ./...
```

---

## 6. Phase 3 — MCP (nas-mcp, TypeScript)

Goal: 5 tools — `start_file_inventory`, `schedule_file_inventory`,
`get_file_inventory_status`, `fetch_file_inventory_result`,
`cancel_file_inventory` — discoverable via `tool_search`, callable via
`invoke_tool`, hitting the nas-api job endpoints (NOT `/exec`).

Because the existing tool framework is **command-based** (`buildCommand` →
`/preview` → `/exec`), job tools need a small **native dispatch path**. Implement
it cleanly:

### 6.1 New job client: `apps/nas-mcp/src/job-client.ts`

Mirror `nas-api-client.ts` from web. Reuse `getNasConfigs`/`NasConfig` from the
existing `src/nas-client.ts` (it already reads `NAS_EDGE1_API_URL` etc. and holds
`approvalSigningKey`). Add:

```ts
import { createHmac } from "node:crypto";
// canonical op string MUST byte-match nas-api jobs.CanonicalOpString (Appendix A)
export function canonicalOpString(op: string, id: string, bodyJson: string): string { /* … */ }
export function buildApprovalToken(cfg: NasConfig, canonical: string): string {
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const signature = createHmac("sha256", cfg.approvalSigningKey)
    .update(`${canonical}\n${expiresAt}`).digest("hex");
  return Buffer.from(JSON.stringify({ command: canonical, tier: 2, expires_at: expiresAt, signature }))
    .toString("base64url");
}
// fetch helpers: startInventory, scheduleInventory, listInventory, statusInventory,
// fetchResult (bounded), cancelInventory — each sets Authorization: Bearer cfg.apiSecret
// and, for state-changing calls, header X-Approval-Token: <token>.
```

### 6.2 Register the 5 tools in the registry

**File:** `packages/shared/src/nas-tools.ts`.

1. Extend the tool interface to support native job tools without breaking the
   command tools. Add an optional field:
   ```ts
   export interface McpToolDef {
     name: string;
     description: string;
     write: boolean;
     params: Record<string, z.ZodTypeAny>;
     buildCommand?: (input: Record<string, unknown>) => string; // now optional
     job?: { op: "start" | "schedule" | "status" | "result" | "cancel" }; // NEW
   }
   ```
2. Append the 5 defs to `ALL_TOOL_DEFS` and tag them in `TOOL_GROUPS` under a new
   group `archive` (so `tool_search "archive"` / `"inventory"` surfaces them). Use
   shared `target` enum + zod params:
   - `start_file_inventory` (write:true, job.op:"start"): params `target`,
     `shares` (string csv), `cutoff_years?`, `overlay?` (default true),
     `protect_newer_than?` (ISO date), `max_files_per_second?`,
     `use_idle_io_priority?` (default true), `sleep_every_files?`, `sleep_ms?`.
     (Full parity with the GUI per §2.11/§2.12.)
   - `schedule_file_inventory` (write:true, job.op:"schedule"): same params as
     start, plus `scheduled_for` (ISO).
   - `get_file_inventory_status` (write:false, job.op:"status"): `target`, `job_id?`.
   - `fetch_file_inventory_result` (write:false, job.op:"result"): `target`,
     `job_id`, `result?` (yearly|cutoff|dirs|overlay, default yearly), `limit?`,
     `cursor?`.
   - `cancel_file_inventory` (write:true, job.op:"cancel"): `target`, `job_id`.
   Descriptions for write ops must start with `WRITE — …` (matches convention)
   and state they require `confirmed: true`.

### 6.3 Dispatch branch

**File:** `apps/nas-mcp/src/index.ts`. In the function that executes a predefined
tool per-NAS (the one that today calls `buildCommand` → `nasPreview`/`nasExec`),
add a branch at the top:

```ts
if (tool.job) {
  return runJobTool(tool, input, config); // from job-client.ts
}
```

`runJobTool`:
- For read ops (`status`/`result`): call the endpoint, return formatted text.
- For write ops (`start`/`schedule`/`cancel`): if `!input.confirmed`, return the
  **preview text** ("This will start an inventory on <nas> for shares <…>. It may
  run for hours. Call again with confirmed: true.") — mirroring the existing
  tier-2 gate. If `confirmed`, build the canonical string + approval token and
  call the endpoint with `X-Approval-Token`.

### 6.4 Enable in `tools-config.json`

**File:** `apps/nas-mcp/tools-config.json`. Add to:
- `enabled_read_tools`: `get_file_inventory_status`, `fetch_file_inventory_result`.
- `enabled_write_tools`: `start_file_inventory`, `schedule_file_inventory`,
  `cancel_file_inventory`.

### 6.5 Build gate

```bash
cd apps/nas-mcp && pnpm build      # tsc must pass (strict)
```
There are no MCP unit tests; validate by reasoning + the type check. After
deploy, smoke-test with `tool_search { query: "inventory" }` then a
`get_file_inventory_status` call.

---

## 7. Phase 4 — Web (apps/web, Next.js)

All five operations must be reachable in the GUI. Browser → Next.js API routes
(server-side, where NAS secrets live) → nas-api over Tailscale.

### 7.1 Extend the server NAS client

**File:** `apps/web/src/lib/server/nas-api-client.ts`. Add job helpers next to the
existing `nasApiExec`/`nasApiPreview`. Reuse `resolveNasApiConfig(nasName)` and
`buildNasApiApprovalToken` patterns, but sign the **canonical op string**
(Appendix A) and send it as header `X-Approval-Token` to the job endpoints
(not `/exec`). Implement: `startInventory`, `scheduleInventory`, `listInventory`,
`statusInventory`, `fetchInventoryResult`, `cancelInventory`. Each takes a
`nasName` and calls `${config.url}/jobs/inventory…` with
`Authorization: Bearer config.apiSecret` and `AbortSignal.timeout(...)`.

### 7.2 Next.js API routes (App Router, `runtime = "nodejs"`)

Create under `apps/web/src/app/api/archive/`:

| Route file | Methods | Calls |
| --- | --- | --- |
| `jobs/route.ts` | `GET` (list, `?nas=`), `POST` (start) | `listInventory` / `startInventory` |
| `jobs/schedule/route.ts` | `POST` | `scheduleInventory` |
| `jobs/[id]/route.ts` | `GET` (status, `?nas=`) | `statusInventory` |
| `jobs/[id]/cancel/route.ts` | `POST` | `cancelInventory` |
| `jobs/[id]/result/route.ts` | `GET` (`?nas=&result=&download=1`) | `fetchInventoryResult` (stream CSV through) |

Each route follows the existing pattern in
`apps/web/src/app/api/settings/route.ts`: `export const runtime = "nodejs";
export const dynamic = "force-dynamic";`, get the Supabase user via
`createSupabaseServerClient()` and return `401` if unauthenticated, then call the
nas-api helper and return `NextResponse.json(...)`. The result download route
sets `Content-Type: text/csv` and `Content-Disposition: attachment`.

### 7.3 The page

**File:** `apps/web/src/app/(dashboard)/archive-inventory/page.tsx`
(`"use client"`). Model it on `apps/web/src/app/(dashboard)/storage/page.tsx` and
`metrics/page.tsx`. Use:
- `useNasUnits()` (`@/hooks/use-nas-units`) for the NAS selector (`<select>` if
  >1 unit, like metrics page).
- Native controls only (no UI lib): `<select>`, `<input type="checkbox">` for the
  share list, `<input type="datetime-local">` for scheduling, plain `<button>`s
  styled with `cn()` + Tailwind tokens (`bg-primary`, `text-primary-foreground`,
  `border-border`, `bg-card`, etc. — see globals.css tokens).
- `lucide-react` icons (`Play`, `CalendarClock`, `Square`, `Download`, `Trash2`,
  `Loader2`).
- **recharts** `BarChart` for the yearly file-count/size view (already a dep).

Page sections (all required for GUI parity):
1. **Target NAS** selector.
2. **Shares** checkbox list (the 10 allowlisted shares; source the list from a
   shared constant — see 7.5).
3. Options: cutoff years (comma input), overlay toggle (checkbox, default on),
   and a **"Protect files newer than"** `datetime-local` control → sent as
   `protect_newer_than` (convert to UTC ISO). Inline help: "Files modified,
   changed, or created on/after this date are never archive candidates, even if
   they show no sync activity."
4. **Advanced options** (collapsible `<details>` panel — full parity per §2.11):
   - "Use idle I/O priority" checkbox → `use_idle_io_priority` (default on).
   - "Max files/sec (0 = unlimited)" number → `max_files_per_second`.
   - "Pause every N files" number → `sleep_every_files` (default 5000).
   - "Pause duration (ms)" number → `sleep_ms` (default 25).
5. **Start now** button → `POST /api/archive/jobs`.
6. **Schedule** row: `datetime-local` + **Schedule** button →
   `POST /api/archive/jobs/schedule`. Convert local time → UTC ISO before
   sending (the input is local; do `new Date(value).toISOString()`).
7. **Scheduled jobs** list (filter list for status `scheduled`) each with a
   **Cancel** button → `POST /api/archive/jobs/[id]/cancel`.
8. **Active job** panel: progress (files/bytes scanned, current share, elapsed),
   a **Cancel** button. Poll `GET /api/archive/jobs/[id]` every **2s** with
   `setInterval` (see use-metrics.ts pattern) while status is
   `queued`/`running`; stop on terminal status.
9. **Results** (when `result_available`): the BarChart (yearly), the cutoff
   summary table (incl. `protected_count`/`protected_bytes`), the directory
   summary table, and **Download CSV** buttons (links to
   `/api/archive/jobs/[id]/result?...&download=1` for each kind).

Handle the `409` (busy), `503` (mount missing), and `403` errors with inline
message boxes (`bg-critical/10 text-critical`).

### 7.4 Navigation

**File:** `apps/web/src/components/dashboard/sidebar.tsx`. Add to `navItems`:
```ts
{ href: "/archive-inventory", label: "Archive Inventory", icon: Archive },
```
and `import { Archive } from "lucide-react";`.

### 7.5 Shared shares constant

To avoid drift between scanner allowlist and UI, add the canonical share list to
`packages/shared/src/` (e.g. `archive.ts` exporting
`ARCHIVE_SHARES = ["files","styleguides",…]`) and import it in the web page. The
nas-api Go allowlist must mirror it (Go can't import TS — leave a comment in both
files pointing at each other, per the existing "intentional coupling" note in the
design doc).

### 7.6 Build gate

```bash
pnpm --filter web type-check && pnpm --filter web lint && pnpm --filter web build
```

---

## 8. Phase 5 — End-to-end verification matrix

Map the design doc's Verification Plan (its §Verification Plan, items 1–21) to
concrete checks. Do not mark done until each passes.

Backend (local, `go test`): scanner aggregation; exclusions; cancellation;
startup recovery (running→interrupted); atomic writes; symlink skip; empty-dir
count; scheduled-due promotion.

Integration (on a NAS, after `docker compose up -d`): run a tiny test share;
run a real small share (`Coldlion`); confirm status polling returns instantly;
spot-check one share's yearly count vs `find <share> -type f -newermt … | wc -l`;
confirm **no writes** occur outside `/app/data/jobs/file-inventory/` (e.g.
`inotifywait`/audit or simply review the code paths); confirm the mount survives
`docker compose up -d --force-recreate`; confirm overlay errors are recorded, not
fatal; confirm `fetch_file_inventory_result` honors `limit`/cap.

Web: start an immediate job and watch live progress; schedule a future job, see
it listed, cancel it before it fires; after completion see the yearly chart +
cutoff + dirs tables; CSV downloads match the files nas-api wrote. **Confirm
every option is reachable**: shares, cutoff, overlay toggle, "protect newer
than" date, and the Advanced panel (I/O priority, max files/sec, sleep settings)
— set each and confirm it reaches nas-api (echoed in the job's `status.json`).
Confirm a recent file is reported `protected`, not `candidate`.

MCP: `tool_search "inventory"` lists all 5; a read tool runs without `confirmed`;
a write tool returns a preview without `confirmed` and executes with
`confirmed: true`.

---

## 9. Phase 6 — Documentation updates

- **`synology-archive.md`**: change the status of the items this PR implements
  (move web UI / endpoints from "planned" to "done in PR #<n>").
- **`AGENTS.md`**: add the new nas-api endpoints to the container/service
  inventory and the task-to-file navigation; add the **one-time
  `docker compose up -d`** deploy note to the deployment + pending-work sections;
  add the new env vars (`NAS_NAME`, `NAS_API_JOBS_PATH`, `NAS_API_JOBS_DIR`).
- **`CLAUDE.md`**: note that nas-api now has a job system and a `/app/data/jobs`
  mount (memory/context notes section).
- **`deploy/synology/README.md`**: document the new mount + env + the one-time
  recreate step.

---

## 10. Phase 7 — Ship

Because local `main` is diverged (§0.3), prefer pushing via `gh` so you don't
fight the working tree. Two options:

**A. Commit locally then push (if the tree is clean enough):** stage only the
files you created/edited, commit with the convention, `git push origin main`.

**B. Push file-by-file via the GitHub API** (robust against divergence):
```bash
gh api repos/u2giants/synology-monitor/contents/<path> --method PUT \
  -f message="area: …" -f branch=main \
  -f content="$(base64 -w0 <localfile>)" \
  -f sha="$(gh api repos/u2giants/synology-monitor/contents/<path>?ref=main -q .sha)"
```
(omit `sha` for new files). This is how the design doc itself was updated.

Commit grouping (suggested, one area per commit):
1. `deploy: add durable nas-api jobs mount + NAS_NAME`
2. `nas-api: file inventory job manager, scanner, and REST endpoints`
3. `nas-mcp: add file inventory operations`
4. `web: archive inventory operator page + API routes`
5. `docs: document archive inventory feature + deploy step`

Each commit message body: one short paragraph on *why*, plus the co-author
trailer. After pushing, the CI image builds publish to GHCR; Watchtower pulls
within ~5 min; then the operator runs the one-time `docker compose up -d` per §4.

PR description must include the **operator action checklist**:
- [ ] `git pull` not needed (images auto-pull) — but run
  `cd /volume1/docker/synology-monitor-agent && docker compose up -d` on **both**
  NAS units once.
- [ ] Set `NAS_NAME` in each NAS `.env` (`edgesynology1` / `edgesynology2`).
- [ ] Verify `/archive-inventory` page loads and lists both NAS units.

---

## 11. Phase 2 — Archive Move (build guide)

> Build this **after Phase 1 ships and the inventory is validated**. The full
> behavioral spec — staged workflow, manifest schema, preflight gates, snapshot,
> verify-and-rollback rules, sync exclusion, tiering, and the end-to-end
> verification plan — is in
> [`synology-archive.md` → *Phase 2 — Archive Move*](synology-archive.md). This
> section maps that spec onto exact files, reusing all Phase 1 infrastructure.

### 11.1 What Phase 2 reuses from Phase 1 (do not rebuild)

- The job manager, persistence/atomic-write store, scheduler, startup recovery,
  single-heavyweight-job-per-NAS lock (extend the lock to also block a move while
  an inventory runs and vice-versa).
- The scanner core (`filepath.WalkDir`, symlink-skip, default exclusions, idle
  I/O priority) for the Plan stage.
- The classification logic (cutoff, `protect_newer_than`, overlay) — call the
  same code paths at **plan time** with fresh `stat`.
- The HMAC approval mechanism (`requireApproval` middleware / canonical op
  string / `VerifyApprovalToken`) — extend the tier handling to **tier 3** for
  `execute`/`rollback` (the existing verifier already accepts a tier argument;
  pass `3` and sign with tier `3`).

### 11.2 New nas-api files

```
apps/nas-api/internal/jobs/
  move.go        # archive_move job type; plan→preflight→snapshot→execute→verify state machine; resume
  manifest.go    # JSONL manifest read/write (append + rewrite-with-status), bounded paged reads
  btrfs.go       # subvolume id lookup (stat + `btrfs subvolume show` via os/exec), same-subvol check
  snapshot.go    # create/list/drop read-only Btrfs snapshot of a share subvolume (os/exec `btrfs subvolume snapshot -r`)
  statx.go       # btime via raw statx syscall (shared with Phase 1 protection; amd64), with fallback
  move_test.go
```

Notes:
- The nas-api container already has `CAP_SYS_ADMIN` and the full
  `/btrfs/volume1:rw` mount (see `docker-compose.agent.yml`) — required for
  `btrfs subvolume` operations and for writing into shares. **Phase 2 needs the
  share mounts to be writable for the targeted share.** They are currently `:ro`
  in compose. Add a writable mount (or remount) for the share(s) being archived,
  e.g. keep `/volume1/<share>:ro` for inventory and add a separate writable path,
  **or** perform the rename via the `/btrfs/volume1` rw mount
  (`/btrfs/volume1/<share>/...`). **Prefer the `/btrfs/volume1` rw path** so no
  compose change to the per-share mounts is needed; resolve all move paths under
  `/btrfs/volume1/<share>/…` and verify the subvolume there.
- `btrfs` CLI must be present in the runtime image — verify with
  `grep -n btrfs apps/nas-api/Dockerfile`; the image already runs btrfs scrub/
  snapshot tools for other features, but confirm and add `btrfs-progs` if absent.

### 11.3 New nas-api endpoints (wire in `cmd/server/main.go`)

```go
mux.HandleFunc("POST /jobs/archive-move/plan",            requireAuth(v, requireApproval(v, jobs.OpMovePlan,     handleMovePlan(mgr))))
mux.HandleFunc("GET  /jobs/archive-move/{id}",            requireAuth(v, handleMoveStatus(mgr)))
mux.HandleFunc("GET  /jobs/archive-move/{id}/manifest",   requireAuth(v, handleMoveManifest(mgr)))   // bounded/paged
mux.HandleFunc("POST /jobs/archive-move/{id}/execute",    requireAuth(v, requireApprovalTier3(v, jobs.OpMoveExecute,  handleMoveExecute(mgr))))
mux.HandleFunc("POST /jobs/archive-move/{id}/cancel",     requireAuth(v, requireApproval(v, jobs.OpMoveCancel,   handleMoveCancel(mgr))))
mux.HandleFunc("POST /jobs/archive-move/{id}/rollback",   requireAuth(v, requireApprovalTier3(v, jobs.OpMoveRollback, handleMoveRollback(mgr))))
mux.HandleFunc("POST /jobs/archive-move/{id}/verify",     requireAuth(v, handleMoveVerify(mgr)))
```
`requireApprovalTier3` is `requireApproval` with tier `3`. Preflight runs inside
`handleMoveExecute` before the snapshot+rename loop (or expose it as part of plan
output); either way every preflight gate in the design must pass or the job goes
`preflight_failed` and execute refuses.

### 11.4 nas-mcp — 7 tools

Add to `packages/shared/src/nas-tools.ts` (group `archive`) and enable in
`tools-config.json`, using the same native `job` dispatch branch added in §6.3
(extend the `job.op` union with the move ops). Tiering: `get_archive_move_status`,
`fetch_archive_move_manifest`, `verify_archive_move` → read; `plan_archive_move`,
`cancel_archive_move` → tier 2 (confirm gate); `execute_archive_move`,
`rollback_archive_move` → tier 3 (confirm gate + tier-3 token). The execute/
rollback tools require a `job_id` referencing a planned manifest.

### 11.5 web — staged move flow

Extend `apps/web/src/lib/server/nas-api-client.ts` with the seven move helpers
(tier-3 ones sign a tier-3 canonical op string). Add API routes under
`apps/web/src/app/api/archive/move/…` mirroring §7.2. Extend the
`/archive-inventory` page (or add a sibling) with the staged panel from the
design's *Web UI* subsection: folder-level scope picker, Plan (dry-run) →
manifest preview (downloadable) → review gate → Execute (type-the-share-name
confirmation, snapshot id shown, live per-file progress, cancel) → Verify
(report download) → Rollback (own confirmation). Full option + operation parity.

### 11.6 Phase 2 build + verification gate

`go build ./... && go vet ./... && go test ./...` (move_test.go covers plan
manifest, collision skip, identity-preservation assertions on a temp tree,
injected-mismatch rollback, resume, whole-run rollback). Then the **end-to-end
test on a small real share** from the design's Phase 2 verification plan item 14
(plan → execute → verify → confirm sync skips `Archive/` → rollback → confirm
restored). Ship as its own commit group: `nas-api: archive move`, `nas-mcp:
archive move ops`, `web: archive move flow`, `docs: archive move`.

---

## Appendix A — Canonical operation string (MUST byte-match across Go/TS)

The approval token's signed payload is `command = CanonicalOpString(...)`. All
three implementations (nas-api Go verifier, nas-mcp signer, web signer) must
produce **identical** strings. Definition:

```
start:    "inventory.start|nas=<NAS_NAME>|shares=<s1,s2,...>|cutoff=<y1,y2,...>|overlay=<true|false>|protect=<RFC3339 or empty>"
schedule: "inventory.schedule|nas=<NAS_NAME>|shares=<...>|cutoff=<...>|overlay=<...>|protect=<...>|scheduled_for=<RFC3339 UTC>"
cancel:   "inventory.cancel|nas=<NAS_NAME>|job_id=<id>"
```

The token **must bind every safety-relevant field**, so `protect` (the
`protect_newer_than` date) is included in the canonical string — a tampered
request that weakened protection would then fail signature verification. The
non-safety tuning fields (`max_files_per_second`, `sleep_*`,
`use_idle_io_priority`) are *not* part of the signed string (they cannot cause
data loss; binding them would only add brittleness).

Rules: shares and cutoff years are sorted ascending and comma-joined with no
spaces; booleans are lowercase `true`/`false`; empty cutoff → `cutoff=` (nothing
after `=`); empty protect → `protect=`; times are the exact RFC3339 string the
client sent (UTC, `Z`). The
nas-api `requireApproval` middleware rebuilds this string from the **server-side
NAS_NAME** and the request body — so the client must use the same NAS_NAME it
targets (it does: it's resolving that NAS's config). Tier is always `2`. Token
expiry 15 min, signature `HMAC-SHA256(signingKey, command + "\n" + expires_at)`,
payload base64url-encoded `{command,tier,expires_at,signature}` — identical to
the existing `/exec` token format in `auth.go` / `nas-api-client.ts`.

## Appendix B — Result CSV schemas (exact headers)

```
yearly.csv : nas,share,year,file_count,total_bytes,total_gib
cutoff.csv : nas,share,cutoff,candidate_count,candidate_bytes,candidate_gib,protected_count,protected_bytes
             # cutoff e.g. "older_than_2021"; candidate_* = older-than AND not date-protected AND
             # (if overlay on) not in an active folder; protected_* = excluded by protect_newer_than
dirs.csv   : nas,share,total_dirs,empty_dirs
overlay.csv: nas,share,source,first_seen,last_seen,event_count      # source: drive_log | sharesync_history
```
`total_gib = round(total_bytes / 1024^3, 2)`.

## Appendix C — Allowlisted shares ↔ mount paths

`files, styleguides, users, homes, Coldlion, Photography, freelancers, mgmt, mac,
oldStyleguides` → `/volume1/<share>` (each already a read-only mount in
`docker-compose.agent.yml`). Reject any share not in this set with `400`. If a
new share is added to the compose mounts later, update this list **and** the web
`ARCHIVE_SHARES` constant (§7.5).

## Appendix D — Env var reference (added by this PR)

| Var | Where set | Default | Purpose |
| --- | --- | --- | --- |
| `NAS_NAME` | each NAS `.env` | `os.Hostname()` | Logical NAS name stamped into results + canonical op string |
| `NAS_API_JOBS_PATH` | each NAS `.env` (optional) | `/volume1/docker/synology-monitor-agent/nas-api-jobs` | Host path for the jobs bind-mount |
| `NAS_API_JOBS_DIR` | nas-api container (optional) | `/app/data/jobs` | In-container jobs dir (matches the mount target) |

Existing vars reused (no change): `NAS_API_SECRET`,
`NAS_API_APPROVAL_SIGNING_KEY` (nas-api side); `NAS_EDGE1_API_URL/_SECRET/_SIGNING_KEY`,
`NAS_EDGE2_…` (web + MCP side).

## Appendix E — Rollback

The feature is additive and inert until used. To disable without reverting code:
remove the 5 tool names from `apps/nas-mcp/tools-config.json` (hides MCP ops) and
remove the sidebar entry (hides the page). To fully remove, revert the five
commits in §10 and run `docker compose up -d` once per NAS to drop the mount.
Job state under `/app/data/jobs` is safe to delete (read-only inventory data).
