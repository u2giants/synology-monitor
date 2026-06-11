# Architecture

## System purpose

Monitors two Synology NAS devices (`edgesynology1`, `edgesynology2`) and gives the operator:

- live telemetry (metrics, logs, storage, processes, network, containers)
- grouped issues with persistent conversation threads
- a 3-stage LLM-driven issue agent that diagnoses problems and proposes fixes
- a controlled approval gate for any state-modifying action on the NAS

Focus is Synology Drive / ShareSync reliability, file operation visibility, sync
and replication failures, storage and I/O attribution, and silent task/backup
failures.

## Component map

```
┌─────────────────────────────────────────────────────────────┐
│ NAS (×2: edgesynology1, edgesynology2)                      │
│  ┌──────────────────────┐  ┌────────────────────────────┐   │
│  │  agent (Go)          │  │  nas-api (Go)              │   │
│  │  polls DSM APIs      │  │  3-tier shell executor     │   │
│  │  reads /proc, /sys   │  │  port 7734                 │   │
│  │  watches logs        │  │  tier 1: read-only (auto)  │   │
│  │  → SQLite WAL        │  │  tier 2: service ops       │   │
│  └──────────────────────┘  │  tier 3: file ops          │   │
│           │                 └────────────┬───────────────┘   │
│           │ PostgREST (batch flush)       │ HTTPS/Tailscale   │
└───────────┼───────────────────────────────┼───────────────────┘
            ▼                               ▼
┌───────────────────┐    ┌───────────────────────────────────┐
│ Supabase          │◄───│ web app (Next.js)                  │
│ qnjimovrsaacneqk  │    │ mon.designflow.app                 │
│ 53 tables         │    │  - issue detector                  │
│ partitioned +     │    │  - 3-stage issue-agent pipeline    │
│ time-series       │    │  - operator approval UI            │
└───────────────────┘    │  - copilot chat                    │
                         └───────────────────────────────────┘
                                        ▲
                              MCP / Streamable HTTP
                         ┌───────────────────────────────────┐
                         │ nas-mcp (Node.js)                  │
                         │ nas-mcp.designflow.app/mcp         │
                         │ 119-definition registry (lazy-load)      │
                         │ 7 small always-on tools/session    │
                         └───────────────────────────────────┘
```

Everything is deployed via push to `main`. GitHub Actions builds and pushes four
Docker images to GHCR. The web app and nas-mcp redeploy automatically via Coolify
webhooks; the agent and nas-api are picked up by Watchtower on each NAS within
~5 minutes. There is one branch: `main`.

---

## Agent (`apps/agent`)

The Go agent runs on each NAS as a Docker container with `network_mode: host`.
It collects telemetry on a rolling schedule, buffers every write in a local SQLite
WAL at `/app/data/wal.db`, and flushes to Supabase in per-table batches every 30s
via PostgREST.

### Volume mounts

The NAS host filesystem is exposed to the agent container under `/host/` to avoid
shadowing the container's own kernel namespaces:

| Host path | Container path | Used by |
|---|---|---|
| `/proc` | `/host/proc` | process stats, mdstat, diskstats |
| `/sys` | `/host/sys` | cgroup I/O, btrfs counters, thermal |
| `/var/log` | `/host/log` | logwatcher, backup logs |
| `/volume1/@synologydrive` | `/host/shares/@synologydrive` | drive log collector |
| `/volume1/@SynologyDriveShareSync` | `/host/shares/@SynologyDriveShareSync` | sharesync log collector |

### Collector inventory

| Collector | File | Primary tables | Default interval |
|---|---|---|---|
| system | `collector/system.go` | `metrics`, `container_status`, `storage_snapshots` | 30s / 60s |
| drive | `collector/drive.go` | `sync_task_snapshots`, `drive_team_folders`, `nas_logs` | 30s |
| sharesync | `collector/sharesync.go` | `alerts`, `nas_logs` | 5m (hardcoded) |
| sharehealth | `collector/sharehealth.go` | `nas_logs`, `metrics`, `package_status`, `dsm_errors` | 2m |
| storagepool | `collector/storagepool.go` | `snapshot_replicas`, `metrics`, `nas_logs` | 60s (mdstat) / 5m (replicas) |
| process | `collector/process.go` | `process_snapshots` | 15s |
| diskstats | `collector/diskstats.go` | `disk_io_stats`, `metrics` (`disk_inflight_ios`) | 15s |
| container_io | `collector/container_io.go` | `container_io` | 30s |
| connections | `collector/connections.go` | `net_connections` | 30s |
| sysextras | `collector/sysextras.go` | `metrics` (cpu_iowait_pct, thermal, memory, NFS, VM pressure, btrfs errors) | 30s |
| services | `collector/services.go` | `service_health`, `nas_logs` | 60s |
| hyperbackup | `collector/hyperbackup.go` | `backup_tasks`, `nas_logs` | 5m |
| schedtasks | `collector/schedtasks.go` | `scheduled_tasks`, `nas_logs` | 5m |
| infra | `collector/infra.go` | `metrics`, `nas_logs` | 2m |
| custom | `collector/custom.go` | `custom_metric_data` | polls DB every 60s |
| logwatcher | `logwatcher/watcher.go` | `nas_logs` | 10s tail interval |
| security | `security/watcher.go` | `security_events` | inotify-driven |

All collector goroutines use the `wg.Add(1)` / `defer wg.Done()` WaitGroup
pattern in `cmd/agent/main.go`. Omitting this drops in-flight WAL writes on
shutdown (the ShareSync collector had this bug; see AGENTS.md §10).

### Notable collectors

**ShareSync health (`collector/sharesync.go`)** — scans `dscc.log` and
`dscc_monitor.log` directly at
`/host/shares/@SynologyDriveShareSync/log/` using byte-offset watermarks stored
in the WAL's `checkpoints` table. Detects three failure patterns invisible to the
DSM UI: queue jams (same path in `RedoEvent`/`PullEvent` ≥5 times without a
`DoneEvent`), basis-file corruption (`PrepareDownloadFile` repeat without
`DoneEvent`), and transport flaps (≥3 error-code-26 / daemon-socket / reconnect
events in a window).

**Storagepool (`collector/storagepool.go`)** — reads `/host/proc/mdstat` directly
every 60s for RAID scrub/rebuild/check progress. Also emits `disk_inflight_ios`
(instantaneous in-progress I/O count per device from `/proc/diskstats` field 9).
Alerts once on healthy→degraded state transitions.

**Log watcher (`logwatcher/watcher.go`)** — tails the following sources by default:

| Container path | Source label |
|---|---|
| `/host/log/messages` | `system` |
| `/host/log/synolog/synobackup.log` | `backup` |
| `/host/log/synologydrive.log` | `drive_server` |
| `/host/log/synolog/synosecurity.log` | `security` |
| `/host/log/synolog/synoconnection.log` | `connection` |
| `/host/log/synolog/synopkg.log` | `package` |
| `/host/log/samba/log.smbd` | `smb` |
| `/host/log/synolog/synowebapi.log` | `webapi` |
| `/host/log/synolog/synostorage.log` | `storage` |
| `/host/log/synolog/synoshare.log` | `share` |
| `/host/log/kern.log` | `kernel` |
| `/host/log/synolog/synoinfo.log` | `system_info` |
| `/host/log/synolog/synoservice.log` | `service` |
| `/host/shares/@synologydrive/log/*.log` | `drive` |
| `/host/shares/@synologydrive/log/syncfolder.log` | `drive_sharesync` |

The `@synologydrive` paths are mounted at `/host/shares/@synologydrive` (not under
`/host/volume1`); `inferDriveLogFiles` prepends `/host/shares` first.

**Custom collector (`collector/custom.go`)** — polls `custom_metric_schedules`
every 60s, claims due rows with an optimistic lock, and executes the scheduled
shell command. Output is stored in `custom_metric_data`. Used for ad-hoc deep
diagnostics and permanent nightly schedules (e.g. `nightly_disk_health` from
migration 00040, which runs at 2am UTC on weekdays and collects `/proc/diskstats`,
`/proc/mdstat`, and per-device inflight IOs).

### WAL and sender (`sender/sender.go`)

The SQLite WAL at `/app/data/wal.db` holds two logical stores: per-table row
queues (flushed to Supabase every 30s) and a `checkpoints` table (durable named
string values such as log file byte offsets and collector cursors).

**Poison-row isolation:** on a PostgREST `4xx` batch failure, the sender
re-sends each row individually so good rows land and only the bad row accumulates
retries. This prevents a single malformed row from silently freezing an entire
telemetry stream (as happened for ~19h/23d before the fix — see incidents).

**`package_status` is the only merge-duplicates upsert.** Every other table is
append-only inserts. The WAL is capped at `MAX_WAL_SIZE_MB` (default 100 MB);
oldest entries are dropped when the cap is reached.

---

## NAS API (`apps/nas-api`)

Runs on each NAS as a Docker container on port 7734 (`network_mode: host`,
`pid: host`). Accepts bearer-authenticated POST requests from the web app and
nas-mcp to classify and execute shell commands.

The service exposes three HTTP endpoints:

| Method + Path | Purpose |
|---|---|
| `GET /health` | Liveness check; returns build SHA and time |
| `POST /preview` | Classify a command's tier without executing it |
| `POST /exec` | Execute a command; requires tier + optional approval token |

It also exposes a native (non-shell) **file-inventory job** API (Phase 1 of the
archive work — see [synology-archive.md](synology-archive.md)): `POST/GET
/jobs/inventory`, `GET /jobs/inventory/{id}`, `…/{id}/result`,
`POST /jobs/inventory/schedule`, and `…/{id}/cancel`. These run an in-process Go
`filepath.WalkDir` scanner (`internal/jobs/`), persist state to the durable
`/app/data/jobs` mount, and gate state-changing ops with the same HMAC tier-2
approval token as `/exec` (signed over a canonical op string, not a shell command).
They do **not** pass through the validator or `/exec`.

Phase 2 adds a staged, reversible **archive-move** API under
`/jobs/archive-move/*` (`plan`, `{id}`, `{id}/manifest`, `{id}/result`,
`{id}/execute`, `{id}/cancel`, `{id}/rollback`, `{id}/verify`). The move state
machine (plan → preflight → snapshot → execute → verify → rollback, plus a
`clean_empty_dirs` mode) relocates cutoff-qualified files, or selected-root files
when `force_archive` is explicitly enabled, into `<share>/Archive` by atomic
**rename within the same Btrfs subvolume** (verifying inode/size/mtime/btime per
file, rolling back any mismatch). `protect_newer_than` still blocks force-mode
candidates. The executor takes a read-only Btrfs snapshot before any
write, and records every file and pruned directory in a JSONL manifest for
reversibility. It writes via the **writable `/btrfs/volume1/<share>`** mount (the
per-share `/volume1/<share>` mounts stay read-only); `execute` and `rollback` are
**tier 3**. Btrfs subvolume/snapshot calls sit behind an injectable interface so
the logic is unit-tested on temp trees.

### Three-tier execution model

| Tier | Label | Approval required | Examples |
|---|---|---|---|
| 1 | read-only | No — auto-executes | `cat /proc/mdstat`, `df -h`, `smartctl -a`, `tail -n 100 /var/log/kern.log` |
| 2 | service ops | HMAC approval token | `synopkg restart SynologyDrive`, `docker compose restart` |
| 3 | file ops | HMAC approval token | `mv /volume1/file.old /volume1/file`, `btrfs scrub start /volume1` |

### Validator (`internal/validator/validator.go`)

`ClassifyTier(command)` returns the minimum required tier. `Validate(command, tier)`
enforces that the requested tier is sufficient and that no hard-block patterns match.

**Hard-blocked regardless of tier:** disk destruction (`mkfs`, `fdisk`, `parted`,
`dd if=`, `wipefs`), root filesystem destruction (`rm -rf /`), DSM binary writes,
`synopkg install/uninstall`, firmware writes (`flash_eraseall`, `nandwrite`,
`insmod`, `rmmod`), ptrace code-injection (`gdb`, `lldb`), destructive `hdparm`
flags (`--security-`, `-y`, `-Y`, `-W`), user account changes (`useradd`,
`userdel`, `passwd <user>`), shutdown/reboot/poweroff, package managers
(`apt-get install`, `opkg install`, `pip install`), recursive grep on
`@synologydrive`/`@SynologyDriveShareSync` (a 4-day runaway grep incident on
production triggered this — see AGENTS.md §13), unrestricted `docker run/create`
(only the monitor-stack compose subset is allowed).

**Tier 1 enforcement:** `writePatterns` (regex list) is checked; any match elevates
to tier 2+. Real output redirection (`> file`, not `>/dev/null` or `2>&1`) is also
a write.

The validator is compiled by Go's standard `regexp` package, so every regex must
be valid RE2 syntax. Lookahead, lookbehind, and backreferences are not supported.
Do not use patterns such as `(?!...)` in `regexp.MustCompile`; an invalid pattern
panics at process startup and prevents the NAS API from binding port 7734.

**Tier 2 enforcement:** commands touching `/volume*/` paths outside the monitor
stack are elevated to tier 3.

**HMAC approval tokens** are minted fresh by the web app at execution time in
`pipeline-v2.ts::executeApprovedAction` and `nas-api-client.ts::buildNasApiApprovalToken`.
They are never persisted; the 15-minute expiry bounds only the exec→exec window,
not the operator's think time. Persisting tokens would cause 403s after expiry.

**Container capabilities:** `apparmor=unconfined` (DSM rejects the default AppArmor
profile on container init), `SYS_ADMIN` (required for btrfs subvolume, scrub, and
snapshot operations), `SYS_PTRACE` (enables `strace` for D-state process diagnosis;
`gdb`/`lldb` are hard-blocked by the validator to prevent code injection).

**Executor process group kill:** `executor.go` sets `Setpgid: true` and uses
`syscall.Kill(-pid, SIGKILL)` with a `WaitDelay: 2s`. This kills the entire process
group on timeout, not just the bash parent — preventing orphaned subprocesses
(e.g. a `grep` forked by `grep ... | head`).

---

## NAS MCP (`apps/nas-mcp`)

FastMCP Node.js server at `nas-mcp.designflow.app/mcp`. AI chat clients
(claude.ai, Claude Desktop) connect over Streamable HTTP. The server is
**fully stateless** (`transportType: "httpStream"`, `stateless: true`) and does
not rely on persistent `mcp-session-id` state. This eliminates stale-session
problems after redeploys and avoids the 4-minute hang class that stateful
transport caused via the claude.ai proxy.

### Tool surface

Seven small tools are registered eagerly on every request:

| Always-on tool | Purpose |
|---|---|
| `list_capabilities({ group, safety, limit })` | Browse enabled operations by group/safety without invoking anything |
| `get_capability_details({ name })` | Return one operation's full contract, examples, safety metadata, and related tools |
| `tool_search({ query, limit })` | Search the 119-definition registry by keyword; returns names, descriptions, safety class, groups, parameter shapes, and exact `invoke_tool` call shape as text |
| `invoke_tool({ name, target, args })` | Execute any registry tool by name |
| `run_command({ target, command })` | Free-form tier-1-only shell command |
| `check_disk_space({ target })` | Disk and inode usage across all volumes |
| `restart_nas_api({ target, confirmed })` | Restart the NAS API container |

The full 119-definition registry is in `packages/shared/src/nas-tools.ts` (the
`ALL_TOOL_DEFS` array). Clients browse with `list_capabilities`, inspect one
operation with `get_capability_details`, search with `tool_search`, and execute
with `invoke_tool`. The registry is never loaded eagerly — loading all 119 schemas
put ~50k tokens into every session and degraded it after ~10–15 tool calls.
FastMCP session-level instructions tell clients to browse/search/detail before
most NAS tasks and then call `invoke_tool` with the exact returned operation name.

Tool enablement is controlled by `apps/nas-mcp/tools-config.json`. A tool present
in `ALL_TOOL_DEFS` but absent from `enabled_read_tools` or `enabled_write_tools` is
rejected by `invoke_tool` with a "disabled" message. Adding a new always-on tool
requires adding it to the `EAGER_TOOLS` constant in `src/index.ts`.

### NAS API filesystem view used by tools

Predefined NAS tools run inside the `synology-monitor-nas-api` container, not in
the telemetry agent container. The most important mounts from
`deploy/synology/docker-compose.agent.yml` are:

| Host path | NAS API path | Notes |
|---|---|---|
| `/usr/syno` | `/host/usr/syno` | DSM binaries/config |
| `/var/packages` | `/host/packages` | DSM package state; not `/host/var/packages` |
| `/var/log` | `/host/log` | DSM logs |
| `/volume1` | `/btrfs/volume1` | Full Btrfs volume for subvolume/snapshot commands |
| selected shares | `/volume1/<share>` | Narrow read-only shared-folder mounts |

This is why snapshot tools check `/btrfs/volumeN`, and DSM/package inspectors check
`/host/packages`. Read-only tools may also use DSM WebAPI `list`/`query` methods
when SQLite/config files are hidden by DSM 7 package layout.

### Approval flow for write tools

For tier-2/3 write tools, `invoke_tool` calls `POST /preview` on the NAS API first.
If the command requires approval and `args.confirmed` is not `true`, the tool
returns a plain-text preview of the command. The client must call `invoke_tool`
again with `confirmed: true`. On confirmation, `src/index.ts::buildApprovalToken`
mints the HMAC token and passes it to `POST /exec`.

### Network and timeout architecture

- `Connection: close` on every nas-api request — prevents undici pool exhaustion
  when timed-out requests do not return their socket (sub-ms Tailscale RTT makes
  re-handshake cost negligible).
- Tool deadline: 45s hard cap per `invoke_tool` call, implemented in
  `withToolDeadline`. Returns a clear timeout error rather than holding the
  connection until Claude's 4-minute client timeout.
- `/exec` AbortController: 25s command + 5s buffer = 30s, with `timeout_ms: 25000`
  sent to the NAS API so it kills the subprocess first.

---

## Web app (`apps/web`)

Next.js 14 app at `mon.designflow.app`. Uses Supabase for auth and data. Server
components and API routes call Supabase with the service role key via
`createAdminClient()`. Client-side components use the anon key.

`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are baked into the
client bundle at `docker build` time via build args in `web-image.yml`. Changing
them in Coolify after the image is built has no effect.

Key subsystems:

| File | Purpose |
|---|---|
| `lib/server/issue-detector.ts` | Fingerprints alerts + logs into issues by family |
| `lib/server/ai/pipeline-v2.ts` | 3-stage pipeline orchestrator, one job per turn |
| `lib/server/issue-workflow.ts` | Job queue and status state machine |
| `lib/server/issue-agent.ts` | `gatherTelemetryContext` — queries 13+ tables in parallel |
| `lib/server/nas-api-client.ts` | HTTP client for nas-api; mints HMAC tokens |
| `lib/server/ai-settings.ts` | Model selection + fallback chain from `ai_settings` table |
| `lib/server/copilot.ts` | Legacy NAS assistant chat (OpenRouter/MiniMax) |

The issue worker mode is controlled by `ISSUE_WORKER_MODE` (`inline` = drains on
API requests; `background` = dedicated loop). The worker polls `issue_jobs` and
calls `runIssueAgentV2` for each pending job.

---

## 3-stage AI issue-agent pipeline

The only active pipeline as of 2026-05-30. The legacy 7-stage pipeline and
OpenRouter inference path were removed. Entrypoint: `pipeline-v2.ts::runIssueAgentV2`.

One invocation of `runIssueAgentV2` is one job = one resumable step:

```
runIssueAgentV2(supabase, userId, issueId)
  │
  ├─ 1. executeApprovedAction — execute any pending tier-2/3 action,
  │      persist result to issue_evidence_items, post system message
  │
  ├─ 2. Stage 1 (first turn only) — gather telemetry, dedupe, persist
  │      lossless set to issue_evidence_items
  │
  ├─ 3. Stage 2 — one agentic reasoning turn with read-only tool loop
  │      → one of: continue | propose_remediation | ask_user |
  │                blocked_on_issue | resolved | stuck
  │
  └─ 4. Stage 3 (on resolved/stuck) — operator message + durable memories
```

### Stage 1 — Lossless Structurer (`ai/stage1-structurer.ts`)

Deterministic, no model call. Runs once per issue on the first turn.

**Input:** raw telemetry from `gatherTelemetryContext` (`issue-agent.ts`), which
queries these tables in parallel: `alerts`, `nas_logs` (general + high-signal
sources), `process_snapshots`, `disk_io_stats`, `scheduled_tasks`, `backup_tasks`,
`snapshot_replicas`, `container_io`, `sync_task_snapshots`, `metrics`,
`storage_snapshots`, `dsm_errors`.

**Processing:** `telemetryToRawItems` maps each table to a `RawEvidenceItem` using
the `TELEMETRY_SOURCES` map. For structured rows (process snapshots, container I/O,
disk I/O), the full JSON of the row becomes the evidence `body` — no fields are
stripped into metadata, ensuring `cpu_pct`, `state`, `read_bps`, `write_bps`, and
`queue_depth` are visible to Stage 2.

`dedupeEvidence` collapses byte-identical `(source, body)` pairs into groups with
`{ dedup_count, first_ts, last_ts }`. Each distinct event is kept verbatim.

`classifyEvidence` marks each item `in_scope` (matches `affected_nas` or is
severity ≥ error) and `anomalous` (severity ≥ error, or warning with a state-change
keyword like "failed", "timeout", "crash").

**Output:**
1. Full deduped set persisted to `issue_evidence_items` (lossless store,
   idempotent — deletes prior rows for the issue first).
2. A bounded prioritized evidence slice for the Stage 2 prompt:
   - Budget: 12,000 tokens / 48,000 chars.
   - 70% of budget: in-scope/anomalous events rendered verbatim.
   - 30% of budget: high-volume noise rendered as dedup-with-count summaries.
   - Always includes the evidence index (source × hour bucket, sorted by event count).
   - If the priority set exceeds budget, a visible truncation notice is appended
     (never silent).

Stage 2 can retrieve any item from the lossless store at any time via
`fetch_evidence`, which reads `issue_evidence_items` — not the raw tables.

**Why Stage 1 is deterministic:** the previous issue-agent compressed logs with a
model before the reasoner saw them. That made the pipeline lossy: raw log messages
were shortened, repeated-but-distinct events were summarized away, and the
reasoning stages could miss the evidence that would falsify a bad hypothesis.
Stage 1 deliberately preserves every distinct `(source, body)` item and only
deduplicates byte-identical repetitions. The prompt slice is bounded, but the DB
store is the lossless source of truth.

### Stage 2 — Reasoning Core (`ai/stage2-reasoning.ts`)

One agentic turn per job invocation. Model: operator-configured via `ai_settings`
table (`stage_reasoning_model`); default `claude-sonnet-4-6` / high effort.

**Context is rebuilt from the DB on every turn** (resumable invariant): the worker
that picks up a job may be a different process after an approval gate or restart.
Three parallel loads:

1. `getReasoningConfig()` — model + effort from `ai_settings`
2. `loadEvidenceSlice(supabase, issueId)` — reads `issue_evidence_items`, rebuilds the
   bounded slice without re-running ingestion
3. `buildWholeSystemSnapshot(supabase, userId, issue)` — parallel: active alerts
   (6h), open issues, NAS reachability probe (3s timeout to primary NAS)
4. `loadTranscript(supabase, userId, issueId)` — last 60 `issue_messages` rows
   mapped to `{role, content}` pairs

**Prompt assembly (stable → dynamic for cache correctness):**

| Block | Stability | Content |
|---|---|---|
| `system` | stable | `SYSTEM_PROMPT` constant — operating rules, tool inventory |
| `output_schema` | stable | `OUTPUT_SCHEMA` constant — required JSON fields and decision values |
| `taxonomy` | stable | `NAS_TAXONOMY` constant — issue families, iowait interpretation guide, DSM blind spots |
| `snapshot` | semi-stable | NAS reachability, active alert counts, open sibling issues |
| `issue` | semi-stable | Issue title, severity, status, affected_nas, current hypothesis |
| `evidence` | dynamic | Bounded evidence slice from `loadEvidenceSlice` |
| `instruction` | dynamic | Per-turn instruction; includes re-chew guard text when triggered |

Stable blocks are passed to `context-compiler.ts::block.stable()`, which marks them
for prefix caching. Only the last two blocks change per turn.

**Tool catalog available to Stage 2 (all tier-1, auto-execute):**

- `fetch_evidence` — queries `issue_evidence_items` for this issue; aggregation
  (`group_by`) or pagination (`page`, `filter`). Works when NAS is offline.
- `run_command` — free-form shell command validated at tier 1 by nas-api. Results
  are persisted to `issue_evidence_items` with `source: "tool:run_command"`.
- All `write:false` tools from `ALL_TOOL_DEFS` (packages/shared/src/nas-tools.ts)
  with the `target` parameter removed from the schema (it is inferred from
  `issue.affected_nas[0]`). Tool results are also persisted to
  `issue_evidence_items` with `source: "tool:<name>"`.

Write tools (`def.write === true`) are excluded entirely from Stage 2's tool
catalog. The model proposes write actions via the `propose_remediation` terminal;
the operator approves them; `executeApprovedAction` in `pipeline-v2.ts` runs them
on the next job invocation.

**Tool-use discipline:** Stage 2 should prefer predefined read-only tools when
they cover the question because they have tuned command shapes and timeouts. Use
`run_command` only for precise read-only probes that are not covered by the catalog.
Use `fetch_evidence` aggregation first (`group_by`) before paging raw rows when
the evidence store may be large. Do not re-run a tool whose result is already in
`issue_evidence_items` unless the live value is expected to have changed and the
new sample is diagnostically meaningful.

**Re-chew guard:** each turn, Stage 2 hashes the evidence slice text. If the hash
matches the previous turn's hash and `decision=continue` is returned again, a
`rechew_repeat` counter increments in `issue.metadata`. After ≥2 repeats the
per-turn instruction becomes a re-chew guard message, and if the model still returns
`continue` after 2 repeats, `toTurnOutcome` forces `decision=ask_user`.

**Turn cap:** `TURN_CAP` (from `stage2-turn.ts`) bounds the total number of turns.
If exceeded, Stage 2 returns `stuck` without calling the model.

**Terminal mapping** (`applyTurnOutcome` in `stage2-turn.ts`):

| `decision` | Outcome | Issue status |
|---|---|---|
| `continue` | enqueue next job | `running` |
| `propose_remediation` | persist `issue_actions` row with command/tier/target/summary | `waiting_for_approval` |
| `ask_user` | post `issue_messages` with question | `waiting_on_user` |
| `blocked_on_issue` | record dependency | `waiting_on_issue` |
| `resolved` | close issue; trigger Stage 3 | `resolved` |
| `stuck` | close issue; trigger Stage 3 | `stuck` |

**Model fit:** Stage 2 needs the strongest reasoning model in the pipeline. The
important capabilities are reliable tool calling, long-context coherence,
structured JSON output, calibrated uncertainty, and the ability to form and test a
ranked hypothesis across several resumable turns. Low-latency or prose quality is
less important than converging in a small number of turns without proposing unsafe
or vague remediations. Domain familiarity with Linux storage, Btrfs, `/proc`, and
Synology DSM helps, but the taxonomy prompt is intended to make a strong general
reasoner effective.

### Stage 3 — Explainer / Memory (`ai/stage3-explainer.ts`)

Single-shot, cheap, low-effort. Model: `stage_explainer_model` from `ai_settings`;
default `gemini-3.1-flash-lite-preview` / low effort. Runs after Stage 2 reaches
`resolved` or `stuck`. Best-effort — a Stage 3 failure never fails the resolution.

**Input:** two parallel reads from Supabase:
- `issue_evidence_items` where `in_scope=true`, ordered by `ts` desc, limit 30
- `issue_actions` for this issue, limit 20 (command, summary, status, result excerpt)

**Prompt:** three blocks:
- `system` (stable): "write the closing operator update and extract durable knowledge"
- `output_schema` (stable): JSON schema for `operator_message` and `memories[]`
- `issue_context` (dynamic): JSON blob of issue title, final hypothesis, conversation
  summary, evidence highlights, and action results

**Output:**
1. `operator_message` (2–5 sentences, plain language) posted to `issue_messages` as
   role `agent`.
2. Up to 5 `agent_memory` entries inserted into `agent_memory` table with
   `source_issue_id`. Valid `memory_type` values: `nas_profile`, `issue_pattern`,
   `calibration`, `institutional`. Empty memories are skipped. `nas_id: null` means
   the lesson is universal across both NASes.

Memories are loaded at the start of Stage 2 investigations via
`agent-memory-store.ts::loadMemoriesForIssue`, classified by subject so only
relevant topics are included (e.g. HyperBackup memories for backup issues).

### Stage model selection (live, de-curated)

The per-stage model dropdowns in the AI Stages settings panel are populated
**live** from every connected provider — a provider counts as connected when its
API key env (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`DEEPSEEK_API_KEY`, `DASHSCOPE_API_KEY`) is present. `provider-models.ts` calls
each connected provider's list-models endpoint (cached in-process ~10 min) and the
`/api/ai-models` route serves the union to the UI. `MODEL_CATALOG` in
`packages/shared/src/ai-capabilities.ts` is no longer the menu — it is a
precise-metadata **override** (hand-verified effort/cache/tool-use per model) and
the offline/no-keys fallback.

At runtime, `callModel` resolves a model id through a three-step chain
(`resolveModelDescriptor` → `resolveLiveDescriptor`):

1. **catalog** — exact match in `MODEL_CATALOG` (verified metadata),
2. **derived** — for catalog-miss ids, a descriptor inferred from the id (provider
   by prefix; cache style per provider; effort/tool-use by conservative id
   patterns),
3. **live map** — for off-pattern ids (e.g. third-party models hosted on
   DashScope), the provider recovered from the live provider→models map.

It only throws when no connected provider offers the id. A selected model whose
capabilities are *derived* (not catalog-backed) is flagged with an amber "inferred
model" warning in the UI, because its effort knob and tool-use support are
best-guess until a catalog row is added. Capability gating per stage (Stage 2
requires tool use; all stages require structured output) still applies to the live
list.

**Model fit:** Stage 3 is a communication and memory-distillation task, not a
diagnostic task. It benefits from clear writing, good compression, and the ability
to extract specific reusable lessons. It does not need live tools, long multi-turn
state, or high reasoning effort. A cheaper model is acceptable because Stage 3 is
best-effort and must never undo Stage 2's terminal outcome.

---

## Data flow summary

```
NAS hardware / DSM APIs
        │
        │ (each collector at its interval)
        ▼
agent collectors (Go) ──────────────────────────────┐
        │ Queue* methods                             │
        ▼                                            │
SQLite WAL (/app/data/wal.db)                        │
        │ sender.go flush every 30s                  │
        │ PostgREST batch insert                     │
        ▼                                            │
Supabase telemetry tables                            │
  metrics, nas_logs, disk_io_stats,                  │
  process_snapshots, backup_tasks, ...               │
        │                                            │
        │ issue-detector.ts (fingerprint)            │
        ▼                                            │
issues table (one row per grouped problem)           │
        │                                            │
        │ pipeline-v2.ts job                         │
        ▼                                            │
Stage 1: gatherTelemetryContext ─────────────────────┘
  → telemetryToRawItems
  → dedupeEvidence + classifyEvidence
  → persistEvidenceItems (issue_evidence_items)
  → buildEvidenceSlice
        │
        ▼
Stage 2: runStage2Turn (agentic loop)
  context: evidence slice + transcript + snapshot
  tools: fetch_evidence, run_command, 100+ NAS tools
  each tool result → issue_evidence_items
  terminal → issue_actions (remediation) or status change
        │
        │ (on resolved/stuck)
        ▼
Stage 3: runStage3Explainer (single-shot)
  → operator_message → issue_messages
  → agent_memory entries
```

---

## Database

Supabase project `qnjimovrsaacneqkggsn`. 53 tables total (migrations 00001–00041).

**Partitioned tables** (pg_partman, monthly, auto-retention): `metrics`,
`nas_logs`, `storage_snapshots`, `container_status`, `drive_activities`.

**Key table groups:**

| Group | Tables |
|---|---|
| Telemetry | `metrics`, `nas_logs`, `disk_io_stats`, `process_snapshots`, `net_connections`, `container_io`, `backup_tasks`, `scheduled_tasks`, `snapshot_replicas`, `service_health`, `dsm_errors`, `package_status`, `security_events`, `drive_activities`, `sync_task_snapshots`, `drive_team_folders` |
| Issue pipeline | `issues`, `issue_messages`, `issue_evidence`, `issue_evidence_items`, `issue_actions`, `issue_jobs`, `issue_stage_runs`, `issue_state_transitions`, `agent_memory` |
| AI config | `ai_settings`, `ai_model_calls` |
| Copilot / resolution | `copilot_sessions`, `copilot_messages`, `copilot_actions`, `sync_remediations` |
| Custom collection | `custom_metric_schedules`, `custom_metric_data` |

**`issue_evidence` vs `issue_evidence_items` — different tables, different purposes:**

- `issue_evidence` (migration 00022): curated human-readable notes (title/detail)
  written by the copilot, the resolution API, and `seedIssueFromOrigin`. Not used
  by the 3-stage pipeline.
- `issue_evidence_items` (migration 00038): the lossless telemetry store for the
  3-stage pipeline. Written by Stage 1 and by every Stage 2 tool call. Read by
  Stage 2 `fetch_evidence` and Stage 3. Do not query the wrong one.

**`package_status`** is the only merge-duplicates upsert (current state, one row
per NAS+package). All other telemetry tables are append-only inserts.

**AI settings** (`ai_settings` table) must be read via `createAdminClient()`
(service role). The issue agent runs as a background worker with no user session;
the session client returns empty under RLS, silently falling back to hardcoded
defaults.

---

## Key design constraints and intentional decisions

### No source whitelists on `nas_logs` / `alerts`

`CHECK` constraints that enumerated allowed source values were dropped in migration
00035. They had to be hand-expanded every time a collector added a source, and one
bad row failing the whole PostgREST batch silently froze ingestion for ~19h/23d.
The agent governs what it writes; the sender isolates bad rows.

### NAS MCP is fully stateless (FastMCP HTTP Stream)

`apps/nas-mcp` uses TypeScript FastMCP with `transportType: "httpStream"` and
`stateless: true`. It does not depend on persistent `mcp-session-id` state across
requests or redeploys. Stateful mode brings back session-resume failures after
Coolify restarts, and the claude.ai proxy's old 4-minute hang class was traced to
stateful transport behavior.

### NAS MCP exposes 7 small tools but has a 119-definition registry

Pre-loading 119 schemas puts ~50k tokens into every session and degrades it after
~10–15 calls. Lazy-load via catalog/search/detail + `invoke_tool` keeps the
always-on surface compact. `notifications/tools/list_changed` is not used because
Claude clients cache the initial `tools/list` and do not re-fetch on the
notification.

### HMAC approval tokens are never persisted

Stage 2 persists the action intent (command, tier, target, summary) in
`issue_actions` but never the HMAC token. The token is minted fresh in
`pipeline-v2.ts::executeApprovedAction` at execution time. Persisting tokens would
cause 403s after the 15-minute expiry; the operator's approval window is often hours.

### Stage 2 tool results go into `issue_evidence_items`

Every `run_command` and predefined NAS tool call in Stage 2 inserts a row into
`issue_evidence_items` with `source: "tool:<name>"`. This means later turns can
page the result via `fetch_evidence` without re-running the command — and the
Stage 3 explainer sees the full investigative trail without needing a separate
transcript of tool outputs.

### Prompt order: stable → dynamic

`context-compiler.ts` enforces that system/output-schema/taxonomy blocks come
before snapshot/issue/evidence/instruction blocks. This keeps the cacheable prefix
maximally long (stable blocks are identical across all issues and all turns), so
only the evidence slice and per-turn instruction incur full token costs.

### Provider cache observability matters

The issue agent calls providers directly so provider-specific cache controls and
usage fields remain visible. Do not route the cached inference path through an
aggregator that flattens request/response shapes. A thin wrapper for timeouts,
retry classification, and normalized accounting is fine, but raw provider usage
must still be persisted or inspectable.

Provider-specific details that have caused bugs in similar systems:
- Anthropic explicit cache reads/writes are reported as
  `cache_read_input_tokens` and `cache_creation_input_tokens`; extended thinking
  requires the provider's required temperature shape.
- OpenAI caches stable prefixes automatically; cache reads surface under
  `prompt_tokens_details.cached_tokens`.
- DeepSeek's cache fields are `prompt_cache_hit_tokens` and
  `prompt_cache_miss_tokens`, not the OpenAI names.
- Qwen/DashScope multi-turn cache behavior depends on preserving the provider's
  response/session id between turns.
- Gemini explicit cached content, if used, must have a tracked lifecycle so paid
  caches are cleaned up even when workers restart.

Cache is an optimization only. Every Stage 2 turn must rebuild its context from
the database transcript, evidence store, issue state, and settings. A cache miss
may cost more tokens, but must not change behavior.

### `connection: close` on all NAS API HTTP calls

Undici's keep-alive pool exhausts after ~10–15 calls when timed-out requests do
not return their socket. NAS API is reached over Tailscale (sub-ms RTT), making
re-handshake cost negligible.

### Executor kills the process group

`executor.go` uses `cmd.SysProcAttr{Setpgid: true}` and
`syscall.Kill(-pid, SIGKILL)` on timeout. `exec.CommandContext` kills only the
direct bash child; without process-group kill, `grep ... | head` orphans the
`grep` subprocess. Combined with the hard-block on recursive grep against Synology
internal stores, this prevents the runaway that ran for 4d11h on production.

### `NEXT_PUBLIC_SUPABASE_*` baked at build time

These variables are passed as Docker build args in `web-image.yml` and embedded
into the Next.js client bundle at `docker build` time. Setting them in Coolify
after the image is built has no effect. A new push to `main` is required to change
them.

---

## Known constraints and blind spots

- `container_status` CPU/mem always reads 0 — use `container_io` instead
- `scheduled_tasks` returns DSM error 103 on edgesynology1 (unsupported API version)
- Some snapshot-replication APIs are unsupported on certain DSM versions
- Log-derived fields are regex-parsed — categorizations imperfect, raw text faithful
- `analyzeRecentLogs` in `log-analyzer.ts` has no callers; tables preserved for a
  future AI clustering layer
- `second_opinion_model` and `cluster_model` exist in `ai-settings.ts` but are not
  wired to any pipeline stage
- `drive_team_folders` is written by the agent but never queried by the web app
- `drive_team_folders_partitioned` has no child partitions and receives no writes;
  it is forward infrastructure — do not drop it
- `issue_resolutions` / `resolution_steps` / `resolution_log` / `resolution_messages`
  are superseded by the `issues` pipeline but not yet dropped

---

## Relay (`apps/relay`)

A narrow named-action HTTP proxy for an external (Lovable) frontend. No CI
workflow exists — there is no `.github/workflows/relay-*.yml`. The relay image is
built and deployed manually on the VPS. Treat this as an exceptional deploy path,
not the routine one. See `apps/relay/OPERATIONS.md`.
