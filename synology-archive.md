# Synology Archive Inventory Plan

## Goal

Build a NAS-side archive planning workflow that can classify old versus active files without forcing MCP calls to wait for multi-million-file scans.

The immediate need is a reliable read-only inventory report by shared folder, modified year, file count, and total size. The longer-term need is a safe path toward moving archive candidates into an `Archive` tree inside the same Btrfs shared folder while preserving file identity and timestamps as much as possible.

## Why This Exists

The current directory structure mixes old inactive files with new active files in the same folder trees. Resilio and similar sync tools still have to traverse those old files, which can bog down sync when the NAS has millions of files.

The goal is not to flatten old files into a single archive bucket. Old files need to keep the same relative organization they have today, just under an `Archive` root inside the same shared folder. That lets active sync jobs focus on newer working files while preserving the archive's existing structure.

Timestamp preservation is also a hard requirement. On Synology Btrfs, each shared folder is commonly its own Btrfs subvolume. Moving files to a different shared folder, even on the same `/volume1`, can become copy-and-delete behavior and may change birth time or inode identity. Keeping the archive inside the same shared folder gives us the best chance of preserving file identity through same-subvolume rename semantics.

Before moving anything, the system needs evidence. A read-only inventory by modified year and size gives us a concrete picture of how much data would be considered old, where it lives, and where the archive boundary should be.

## Expected Outcome

The first version should produce compact read-only reports that answer:

- How many files exist in each shared folder by modified year.
- How much storage those files consume by modified year.
- How many files and bytes would be affected by candidate archive cutoffs.
- Which shares have recent Synology Drive or ShareSync activity that should be treated cautiously.

The inventory job should not move, delete, rename, touch, or modify user files. It should only walk metadata, aggregate results, and store small result files in the NAS API job directory.

After the inventory is complete, the report should make it possible to choose archive rules with less guesswork and then design a separate dry-run archive move workflow.

## Current Findings

- Shared folders are mounted with `noatime`, so normal reads do not update file access time.
- Existing `atime` values are therefore not reliable for active-versus-archive decisions.
- Synology connection logs show share-level SMB access, not per-file usage.
- Synology Drive and ShareSync logs provide recent sync/change activity, but not a full historical file inventory.
- Each Synology shared folder is a Btrfs subvolume. Moving files between shared folders can become copy-and-delete behavior even when both folders live on `/volume1`.
- For preserving Btrfs birth time and inode identity, archive moves should stay inside the same shared folder/subvolume, for example:

```text
/volume1/files/Archive/...
/volume1/styleguides/Archive/...
```

## Design Summary

Implement a NAS-side background file inventory job. The NAS performs the long filesystem walk locally, stores compact results locally, and exposes status/results through the existing NAS API and MCP operation registry.

This avoids MCP request timeouts because MCP starts the job, then polls for status and fetches the small result when complete.

## Phases

This project ships in two phases. Both are fully specified in this document.

- **Phase 1 — Inventory (read-only).** Scan shares, classify files by modified
  year, apply protection and activity rules, and report archive candidates. It
  never touches user data. Phase 1 produces the *evidence* for choosing archive
  rules. Sections up to and including *Phase 1 Scope* describe it.
- **Phase 2 — Archive Move (relocation).** Relocate the archive candidates into
  an `Archive/` tree inside the same shared folder/subvolume, preserving file
  identity and timestamps, verify every move, exclude `Archive/` from sync, and
  keep a complete reversible record. **Phase 2 is what makes the application
  actually useful** — it is the step that removes old files from the sync path
  and lets the operator validate the system end to end. It is built as a staged,
  reviewable, self-verifying, reversible workflow. The *Phase 2 — Archive Move*
  section describes it in full.

Phase 2 depends on Phase 1's classification logic and job runtime, but is a
distinct job type with its own operations, UI flow, and tiering.

## User-Facing Operations

Expose five operations:

```text
start_file_inventory
schedule_file_inventory
get_file_inventory_status
fetch_file_inventory_result
cancel_file_inventory
```

Recommended safety labels:

- `start_file_inventory`: read-only, expensive read
- `schedule_file_inventory`: state-changing, non-destructive
- `get_file_inventory_status`: read-only
- `fetch_file_inventory_result`: read-only
- `cancel_file_inventory`: state-changing but non-destructive

## NAS-Side Job Runtime

Add a small job manager to the NAS API container.

Persistent job storage is required before any long-running scan is implemented. The NAS API container currently does not have a named Docker volume mounted at `/app/data`; only the agent has `agent-data:/app/data`. Because Watchtower recreates `synology-monitor-nas-api` when a new image is published, job state stored only in the container writable layer would be lost on update or restart.

First add a durable NAS API jobs mount in `deploy/synology/docker-compose.agent.yml`.

Preferred host-path mount:

```yaml
nas-api:
  volumes:
    - ${NAS_API_JOBS_PATH:-/volume1/docker/synology-monitor-agent/nas-api-jobs}:/app/data/jobs:rw
```

This path is easy to inspect directly on the NAS and avoids hiding job results inside an anonymous or named Docker volume. A named volume is also acceptable, but the host path is more operator-friendly for recovery and auditing.

Important deployment note: Watchtower applies new images, not compose-file changes. Adding this mount requires updating the NAS compose file and running `docker compose up -d` on each NAS once.

Suggested durable state path:

```text
/app/data/jobs/file-inventory/
```

Each job should have a metadata file:

```json
{
  "id": "inv_20260607_edgesynology1_files",
  "type": "file_inventory",
  "status": "queued",
  "started_at": null,
  "scheduled_for": null,
  "finished_at": null,
  "target_shares": ["files", "styleguides"],
  "current_share": null,
  "files_scanned": 0,
  "bytes_scanned": 0,
  "error": null
}
```

Statuses:

```text
queued
scheduled
running
complete
failed
cancelled
interrupted
```

Default behavior:

- Allow only one inventory job per NAS at a time.
- Persist status and partial progress so a restarted request path can still report what happened.
- Write results only under `/app/data/jobs/file-inventory/`.
- Do not write into the shared folders.
- On startup, detect jobs that were `running` before a container restart and mark them `interrupted` unless resume support has been explicitly implemented.
- Write progress to disk atomically every N files so status polling and crash recovery are never stale by more than that interval.
- On startup, check for `scheduled` jobs whose `scheduled_for` time has passed and promote them to `queued`.

Persistence does not keep a scan alive through a Watchtower restart. The first implementation should report an interrupted job clearly rather than silently losing it.

## Scanner Scope

Walk explicit mounted shares only. Do not scan `/volume1` wholesale.

Allowed share roots should match the existing compose mounts:

```text
/volume1/files
/volume1/styleguides
/volume1/users
/volume1/homes
/volume1/Coldlion
/volume1/Photography
/volume1/freelancers
/volume1/mgmt
/volume1/mac
/volume1/oldStyleguides
```

There is an intentional coupling here: the scanner can only walk shares mounted into the NAS API container. If a new share is added to `docker-compose.agent.yml`, the scanner allowlist or share-discovery logic must be updated too. Prefer deriving the allowlist from a single shared config or from the actual mounted paths; if hardcoding is used, add a code comment and test that make this dependency obvious.

Skip:

```text
#snapshot
@eaDir
@tmp
.SynologyWorkingDirectory
Archive
```

The first version should not emit individual file paths by default.

## Scanner Implementation

Use Go filesystem walking rather than shelling out to `find`.

Recommended approach:

- Use `filepath.WalkDir` or a controlled iterative stack.
- Explicitly ignore symlinks. Check `DirEntry.Type()` before calling `Info()` and skip entries where `mode&os.ModeSymlink != 0`.
- Call `DirEntry.Info()` only for files.
- Aggregate by `mtime.Year()`.
- Track empty directory counts per share. This gives a baseline for how many skeleton directories may remain after a future archive move.
- Track total file count and total bytes per share/year.
- Track progress every N files.
- Persist progress every N files with an atomic write, such as writing `status.tmp` and renaming it to `status.json`.
- Check cancellation between directories and every N files.
- Run the scanner at low CPU and I/O priority where possible, for example via `nice` plus `ionice -c 3`, so active SMB/Drive workloads win scheduling priority.
- Keep periodic manual throttling as a secondary control to reduce NAS impact.

Suggested scanner options:

```json
{
  "shares": ["files", "styleguides"],
  "exclude_default_dirs": true,
  "archive_dir_name": "Archive",
  "cutoff_years": [2021, 2022],
  "protect_newer_than": "2025-01-01T00:00:00Z",
  "max_files_per_second": 0,
  "use_idle_io_priority": true,
  "sleep_every_files": 5000,
  "sleep_ms": 25
}
```

The `max_files_per_second` field can be `0` for unlimited.

Every one of these options is exposed in the web UI (an Advanced panel for the
throttle/priority fields) and as MCP tool parameters — there are no
scanner options that can only be set from code.

## Protection Rules (date whitelist)

Age by modified-year alone is not sufficient to decide what is safe to archive.
A file can be old by `mtime` yet have been recently created, restored, or had its
metadata changed — and the activity overlay only sees Drive/ShareSync events, not
every access path (SMB copies, restores, rsync, local edits).

So the inventory supports an explicit **date protection whitelist**,
`protect_newer_than`. A file is **protected** (never an archive candidate) when
its *newest* timestamp is at or after that date:

```text
newest = max(mtime, ctime, btime)
protected = newest >= protect_newer_than
```

- `mtime` — last content modification.
- `ctime` — last inode/metadata change (permissions, rename, restore).
- `btime` — birth/creation time, read via `statx` on Btrfs. If `btime` is
  unavailable, fall back to `max(mtime, ctime)` and record that the fallback was
  used.

Protection is **independent of the activity overlay**: a file is protected by
date even if it shows zero sync activity. This is the safeguard that prevents
archiving data that is genuinely current but quiet. Protected files are still
counted in the yearly report; they are excluded from the cutoff archive-candidate
totals and reported separately so the operator can see how much was held back and
why.

## Result Format

Primary CSV:

```text
nas,share,year,file_count,total_bytes,total_gib
edgesynology1,files,2020,24584,982589180666,915.11
```

Cutoff summary CSV (candidate = older-than AND not date-protected AND, when the
overlay is on, not in an active folder):

```text
nas,share,cutoff,candidate_count,candidate_bytes,candidate_gib,protected_count,protected_bytes
edgesynology1,files,older_than_2021,61240,1402000000000,1305.7,4515,97000000000
```

Directory summary CSV:

```text
nas,share,total_dirs,empty_dirs
edgesynology1,files,52110,8321
```

Status JSON should include:

```json
{
  "job_id": "inv_20260607_all",
  "status": "running",
  "current_share": "files",
  "files_scanned": 248000,
  "bytes_scanned": 4900000000000,
  "elapsed_seconds": 180,
  "scheduled_for": null,
  "result_available": false
}
```

## Recent Activity Overlay

Add an optional second report mode that aggregates recent Synology Drive and ShareSync event databases by share/folder.

This should be treated as a recent-change overlay, not a complete access history.

The overlay must be best-effort. Synology Drive keeps its SQLite databases open, and the NAS API mounts those paths read-only. Open the databases in read-only mode with a short busy timeout. If SQLite returns `SQLITE_BUSY`, missing-table errors, or WAL-related read errors, skip the overlay and record the reason in the job result instead of failing the whole inventory.

Prefer copying the relevant SQLite files into the job's temporary workspace before querying them. Copy the main `.sqlite` file plus any adjacent `-wal` and `-shm` files, then open the copied database read-only. This avoids placing read locks on Synology's live Drive or ShareSync databases during active sync cycles. If the copy is incomplete or the copied database cannot be queried consistently, skip that overlay and record the reason.

Example result:

```text
nas,share,source,first_seen,last_seen,event_count
edgesynology1,files,drive_log,2026-05-04,2026-06-07,9977
edgesynology2,files,sharesync_history,2026-05-01,2026-06-06,6124
```

Use this overlay to protect recently active shares or folders from aggressive archive rules.

## Atime Policy

Do not use `atime` as the primary archive signal.

The NAS currently uses `noatime`, so read access does not update file access timestamps. The system could be remounted with `relatime`, but that only helps going forward and can be polluted by indexing, thumbnail generation, backups, Resilio, Synology Drive, previews, and other background reads.

If `atime` support is still desired later, implement it as a separate explicit capability:

```text
check_mount_atime_policy
preview_enable_relatime
enable_relatime confirmed=true
```

That capability should not be bundled into the inventory job.

## MCP Integration

Add hidden MCP operations for the job lifecycle:

```text
start_file_inventory
schedule_file_inventory
get_file_inventory_status
fetch_file_inventory_result
cancel_file_inventory
```

The operations should call the NAS API rather than running long shell commands. MCP should only receive compact JSON/CSV results.

Tiering:

- `start_file_inventory`: tier 2. It is read-only, but it can impose hours of metadata I/O on a NAS with millions of files, so it should require preview and approval.
- `schedule_file_inventory`: tier 2. Schedules a future one-shot run; changes job state and should require approval.
- `cancel_file_inventory`: tier 2. It changes job state and should require approval.
- `get_file_inventory_status`: tier 1.
- `fetch_file_inventory_result`: tier 1.

The start preview should show:

- target NAS
- target shares
- excluded directories
- result path
- whether the recent activity overlay is enabled
- a warning that the scan may take hours on large shares

The schedule preview should show the same fields plus the scheduled start time in local and UTC.

The operation descriptions should make the I/O cost explicit:

- This is read-only but may perform a long metadata walk.
- It should be run during quiet hours for very large shares.
- It does not move, delete, or modify files.

Result fetching must be bounded. `fetch_file_inventory_result` should default to compact summaries and enforce maximum response rows/bytes so an MCP client cannot accidentally pull an oversized CSV into the model context. Full results should be fetched by result kind and page, or exposed as an artifact/path reference with explicit pagination.

Suggested fetch options:

```json
{
  "job_id": "inv_20260607_all",
  "result": "yearly",
  "limit": 100,
  "cursor": null
}
```

## Web UI

All operations must have GUI coverage. Add an operator page in the web app at `/archive-inventory`.

Required controls:

- Target NAS selector
- Share checkboxes (top-level shared folders; see the folder-granularity note below)
- Cutoff years
- "Protect files newer than" date control (`protect_newer_than`)
- Overlay toggle (default on)
- Advanced panel: idle I/O priority toggle, max files/sec, sleep-every-files, sleep-ms
- Start job (immediate)
- Schedule job (date/time picker for a future one-shot run)
- Scheduled jobs list with per-job cancel control
- Active job progress and status display
- Cancel running job
- Download CSV (yearly, cutoff summary, directory summary)
- View yearly file count and size chart/table
- View cutoff summary (including protected vs candidate counts)

Every operation **and every option** exposed via MCP must also be reachable
through the web UI, including scheduling and all scanner tuning/protection
options. MCP and web UI must reach full feature and option parity. The web UI is
required in the first PR.

**Folder granularity.** For the inventory phase the selectable unit is the
top-level shared folder (the set of read-only mounts the NAS API container has).
Sub-folder selection is *not* part of the inventory UI. When the separate archive
**move** workflow is built (see Archive Move Follow-Up), its UI must let the
operator choose archive scope at the folder level within a share and preview the
exact set of files that would move before anything happens.

## Verification Plan

1. Unit-test scanner aggregation with fake directory trees.
2. Unit-test exclusion behavior for `#snapshot`, `@eaDir`, `Archive`, and `@tmp`.
3. Unit-test cancellation.
4. Unit-test startup recovery for a job left in `running` state.
5. Unit-test atomic progress writes.
6. Unit-test symlink skipping.
7. Unit-test empty directory counting.
8. Unit-test that `scheduled` jobs whose `scheduled_for` time has passed are promoted to `queued` on startup.
9. Run scanner against a tiny mounted test folder.
10. Run one real small share, such as `Coldlion`.
11. Run one medium share with low I/O priority and throttling enabled.
12. Confirm MCP timeout no longer matters because status polling returns immediately.
13. Compare one completed share report against a manual `find` spot check.
14. Confirm no writes occur outside `/app/data/jobs/file-inventory/`.
15. Confirm the durable NAS API jobs mount survives a container recreate.
16. Confirm Drive/ShareSync overlay errors are recorded without failing the inventory.
17. Confirm `fetch_file_inventory_result` enforces pagination or response-size limits.
18. Confirm web UI can start an immediate job and display live progress.
19. Confirm web UI can schedule a future job, list it, and cancel it before it fires.
20. Confirm web UI displays yearly chart, cutoff summary, and directory summary after job completes.
21. Confirm web UI CSV downloads match the files written by the NAS API.
22. Unit-test date protection: a file older than the cutoff but with `mtime`, or `ctime`, or `btime` at/after `protect_newer_than` is reported as protected, not as an archive candidate — assert each timestamp triggers protection on its own.
23. Confirm every scanner option (overlay, protect-newer-than, I/O priority, max files/sec, sleep settings) set from the web UI is echoed back in the job's persisted state.

## Phase 1 Scope — Inventory

Build the read-only inventory:

- Durable NAS API jobs mount in `deploy/synology/docker-compose.agent.yml`
- NAS API local file inventory job manager
- Mtime-year scanner with date protection and the activity overlay
- Status/result/cancel/schedule endpoints
- MCP operations wired to those endpoints
- Web UI at `/archive-inventory` covering all five operations and every option
- Documentation and safety notes

Defer to a later, separate effort (NOT Phase 2):

- Supabase persistence of results
- Atime/relatime remount changes

## Phase 2 — Archive Move (Relocation)

Phase 1 only reports. **Phase 2 is what makes this application useful and
testable end to end:** it relocates the archive candidates into an `Archive/`
tree inside the same shared folder/subvolume, preserving file identity and
timestamps, verifies every move, excludes `Archive/` from sync so Resilio/Drive
stop traversing old data, and keeps a complete reversible record. This is the
step that actually fixes the slow-sync problem. It is also the only step that
writes to user data, so it is built as a staged, reviewable, self-verifying,
reversible workflow with hard safety gates between stages.

### Relationship to Phase 1

- Phase 2 reuses Phase 1's classification logic (cutoff years,
  `protect_newer_than`, the Drive/ShareSync activity overlay) and the same
  scanner core (symlink-skipping, default exclusions, idle I/O priority).
- It re-evaluates every rule at **plan time with fresh `stat` data** — a stored
  inventory result is treated as guidance, never as the authority for what to
  move (files may have changed since the inventory ran).
- It runs on the same NAS-side job manager and persistence model as Phase 1, as
  a new job `type` of `archive_move`.
- **Mutual exclusion:** at most one heavyweight job (inventory *or* move) runs
  per NAS at a time; a second request returns `409 Conflict`.

### Staged workflow

Five strictly-ordered stages, each persisted and individually observable, plus
two out-of-band operations. **Execution never auto-follows planning** — the
operator (or an MCP caller) advances explicitly across every destructive
boundary.

1. **Plan (dry-run, read-only)** — enumerate the exact files that would move,
   write a manifest, produce a summary. No changes to user data.
2. **Preflight** — safety gates that must all pass before anything is created
   (subvolume/device verification, test-rename, collision rescan, symlink/open-
   file checks, snapshot readiness, capacity sanity).
3. **Snapshot** — take a read-only Btrfs snapshot of the share subvolume as a
   whole-run safety net, record its id/path.
4. **Execute** — per-file atomic rename + immediate verify, with rollback-on-
   mismatch; resumable; cancellable.
5. **Verify & finalize** — re-confirm every entry landed with matching identity
   and the source path is gone; emit the completion report; apply the `Archive/`
   sync exclusion; optionally prune source dirs emptied by the move.

Out of band: **Cancel** (stop an in-progress stage cleanly, leaving a consistent
resumable state) and **Rollback** (reverse a completed or partial move using the
manifest).

### Scope selection (folder-level)

- The operator chooses **NAS → share → optional sub-folder roots** within the
  share. Scoping is folder-level, not whole-share-only, and supports per-run
  include/exclude path globs.
- The archive root for a share is `/<share>/Archive`. Files keep their relative
  path beneath it:
  `/<share>/clients/acme/logo.ai` → `/<share>/Archive/clients/acme/logo.ai`.
- The Plan UI must render a **preview of the exact file set** (and totals) before
  any directory is created. Nothing is hidden behind a single "archive" button.

### Move job runtime

- New job `type: "archive_move"`, persisted under
  `/app/data/jobs/archive-move/<job_id>/` (same atomic-write model as Phase 1).
- Statuses: `planning`, `planned`, `preflight`, `preflight_failed`,
  `snapshotting`, `executing`, `verifying`, `complete`, `failed`, `cancelled`,
  `rolled_back`, `interrupted`.
- A move job records: NAS, share, scope (roots + globs), the applied rules
  (cutoff, protect date, overlay flag), the chosen snapshot id, and the manifest
  path.
- **Startup recovery:** a job left in `executing` when the container restarts is
  marked `interrupted`. Because per-file status is in the manifest, an
  interrupted job is **resumable** (continue from the first not-yet-moved file)
  or can be rolled back — it is never silently abandoned.

### The manifest (single source of truth)

JSONL (one JSON object per line), written at Plan and updated through Execute /
Verify / Rollback. It is the input to Execute and to Rollback and is downloadable
in the UI and fetchable (bounded/paginated) via MCP. Per-file fields:

```text
rel_path        relative path within the share
source_abs      absolute source path
dest_abs        absolute destination path under /<share>/Archive/
size            bytes
inode           inode number (identity check)
dev_id          st_dev of the file
subvol_id       Btrfs subvolume id of the source tree
mtime           RFC3339 (ns) — must be preserved
ctime           RFC3339 (ns) — recorded; expected to change on rename
btime           RFC3339 (ns) — must be preserved (statx; fallback noted)
planned_reason  e.g. "older_than_2021"
status          planned | moved | verified | skipped | failed | rolled_back
detail          skip/error reason, or verification result
```

### Plan (dry-run) details

- Walk the scoped paths with the Phase 1 scanner core (skip symlinks, skip the
  default-excluded dirs **including the existing `Archive/`**).
- Classify each file with the same rules as inventory; for each candidate compute
  `dest_abs` and capture `size`, `inode`, `dev_id`, `subvol_id`, and all three
  timestamps.
- **Collision detection:** if `dest_abs` already exists, mark the row `skipped`
  with reason `collision` — the move never overwrites an existing file.
- Emit the manifest plus a summary (counts/bytes by share/year, with
  protected/skipped breakdown). Fully read-only and safe to re-run.

### Preflight gates (all must pass, else `preflight_failed`)

- **Same-subvolume check:** the source tree and `/<share>/Archive` must resolve
  to the same Btrfs subvolume id, not merely the same `/volume1`. Record source
  and destination `dev_id` + subvolume id.
- **Test-rename:** create a throwaway file under the source tree, rename it into
  `Archive/`, stat-verify identity is preserved, rename it back, delete it. If
  this reveals cross-device / cross-subvolume behavior → **abort** (never fall
  back to copy-and-delete).
- **Collision rescan (fresh):** re-confirm no `dest_abs` exists.
- **Symlink / open-file checks:** re-confirm no candidate is a symlink;
  best-effort check that candidates are not currently open (`lsof`/`fuser`) and
  either warn or skip open files per the run option.
- **Snapshot readiness:** confirm a Btrfs snapshot of the subvolume can be
  created.
- **Capacity:** rename needs no extra data space, but creating `Archive/`
  directories consumes metadata — sanity-check free space and inodes.

### Snapshot

Before the first rename, take a read-only Btrfs snapshot of the share subvolume
and record its id/path in the job. This is the last-resort whole-run recovery if
per-file rollback is ever insufficient. Document retention: the snapshot is kept
until the operator confirms the move is good, then may be dropped.

### Execute details

- Set idle I/O priority (reuse the Phase 1 priority helper).
- For each `planned` (non-`skipped`) file, in a stable order:
  1. Create destination parent directories, matching source ownership/permissions.
  2. Atomic `rename(source_abs, dest_abs)`.
  3. Re-`stat` the destination and compare **inode, size, mtime, btime** to the
     manifest. `ctime` is expected to change on rename, so it is recorded and
     reported but not required to match.
  4. On full match → mark `moved`. On any mismatch → **rename the file back to
     `source_abs`** (per-file rollback), mark `failed`, and abort the run.
- Persist progress and per-file status atomically every N files. Cancellable
  between files. **Resumable:** on resume, files already `moved`/`verified` are
  skipped.
- The move is **rename-only — nothing is ever deleted.** The source name
  disappears as part of the atomic rename; there is no separate unlink step.

### Move integrity: verify-and-rollback (hard requirement)

The move is *self-checking*. The system never trusts that a move preserved
identity — it proves it, per file, and undoes anything that does not match.

- **Rename path (the only allowed move path).** `rename(2)` is atomic and
  preserves inode, size, `mtime`, and `btime` within a subvolume; `ctime`
  changes because the inode changed. After each rename the destination is
  re-`stat`ed and compared to the manifest: `inode`, `size`, `mtime`, `btime`
  must be **identical**; a `ctime` change is expected. Any mismatch →
  immediate rename-back (rollback) of that file and abort of the run.
- **Copy-and-delete path is forbidden by default.** A cross-subvolume boundary
  is caught at preflight and the run aborts rather than silently copying. If a
  copy-based mode is ever explicitly enabled later, it must obey
  **verify-before-delete**: copy preserving timestamps → re-`stat` and compare
  `size`, `mtime`, `btime`, **and a content checksum** to the manifest → only if
  every check passes, delete the source → on any failure, delete the
  *destination copy* (never the source) and abort. The source is never removed
  on a mismatch.
- Every per-file outcome (`moved`/`verified`/`failed`/`rolled_back`) is written
  back to the manifest, producing a complete, auditable record of exactly what
  happened to every file.

### Verify & finalize

- Re-walk the manifest: for each `moved` file confirm `dest_abs` exists with
  matching identity and `source_abs` no longer exists; mark `verified`.
- Emit the completion report (counts/bytes moved/verified/skipped/failed).
- Apply the `Archive/` sync exclusion (next section).
- Optionally prune source directories **emptied by the move** — never delete a
  directory that still holds non-candidate files; record exactly which dirs were
  removed.

### Sync exclusion for `Archive/`

The point of the move is to stop sync tools from traversing `Archive/`. After a
verified move, ensure each sync tool covering the share excludes
`<share>/Archive`:

- **Resilio:** add the `Archive` subtree to the job's IgnoreList / selective-sync
  exclusion. Where a file-based ignore list exists (`.sync/IgnoreList`), the
  system appends the entry directly; otherwise it emits the exact operator steps.
- **Synology Drive ShareSync:** document and emit the selective-sync exclusion
  step; automate only where a supported config path exists.
- Record what exclusion was applied automatically versus what the operator must
  do manually. Phase 1 inventory already skips `Archive/`, so relocated data also
  stays out of future scans.

### Rollback (whole-run)

- Using the manifest, reverse the move: for each `moved`/`verified` entry, rename
  `dest_abs` → `source_abs`, verify identity, mark `rolled_back`; remove any
  `Archive/` directories emptied by the rollback.
- If rename-based rollback is impossible for any entry, fall back to restoring
  from the pre-execute Btrfs snapshot, with the manual snapshot-restore procedure
  documented.
- Rollback is a destructive/reversing operation: tier 3, approval + explicit
  confirmation required.

### Operations (NAS API endpoints + MCP tools)

Mirror Phase 1 under `/jobs/archive-move/*`:

```text
plan_archive_move          tier 2  — heavy read; writes a manifest; preview + approval
get_archive_move_status    tier 1
fetch_archive_move_manifest tier 1 — bounded/paginated
execute_archive_move       tier 3  — destructive; needs a planned job/manifest id + confirmed
cancel_archive_move        tier 2
rollback_archive_move      tier 3  — reversing; confirmed
verify_archive_move        tier 1  — re-verify a completed move
```

Tier 2/3 reuse the existing HMAC approval-token mechanism; the canonical
operation string includes NAS, share, scope, a hash of the applied rules, and the
manifest/job id so a tampered request fails verification.

### Web UI (full parity, folder-level, gated)

On the `/archive-inventory` page (or a sibling `/archive-move`), a staged panel:

- **Scope:** NAS → share → folder picker (tree and/or include/exclude path
  globs).
- **Rules:** cutoff, protect-newer-than, overlay toggle — prefilled from the most
  recent inventory.
- **Plan move (dry-run):** shows the manifest summary plus a browsable and
  downloadable file-list preview. Nothing destructive happens.
- **Review gate:** an explicit "I reviewed N files / X TB" confirmation.
- **Execute:** strong confirmation modal (operator types the share name), shows
  the snapshot id, then live per-file progress with a Cancel control.
- **Verify:** status plus a downloadable completion report.
- **Rollback:** its own confirmation modal.
- Every operation and option is reachable in the GUI (parity); folder-level scope
  selection is required.

### Result / report formats

```text
manifest.jsonl     per-file (schema above)
move-report.csv    nas,share,planned,moved,verified,skipped,failed,bytes_moved
preflight.json     per-gate pass/fail with details
verify-report.csv  nas,share,verified,missing,identity_mismatch
```

### Tiering summary

- Read (tier 1): status, manifest fetch, verify.
- State-changing, non-destructive (tier 2): plan, cancel.
- Destructive (tier 3): execute, rollback.

### Phase 2 verification plan

Unit tests on temp trees where Btrfs is not required; integration tests on a real
share for the subvolume/snapshot/identity behavior.

1. Plan produces a correct manifest for a known tree (paths, dest mapping, and
   all three timestamps captured).
2. Protected / overlay-active / cutoff rules correctly exclude files at plan time.
3. Collision detection marks a pre-existing destination `skipped`; never
   overwrites.
4. Same-subvolume check passes within a share; a cross-subvolume scope aborts at
   preflight.
5. Test-rename round-trips and preserves identity.
6. Execute renames preserve `inode` + `mtime` + `btime` + `size` (assert via
   `stat`); a `ctime` change is tolerated.
7. An injected identity mismatch triggers per-file rollback and aborts the run.
8. Cancel mid-run leaves a consistent, resumable state; resume completes the rest.
9. Interrupted (simulated container restart) → marked `interrupted`; both resume
   and rollback work.
10. Whole-run rollback restores every file to its exact original path and
    identity.
11. The snapshot is taken before execute and recorded; the documented restore
    works.
12. After finalize, `Archive/` is excluded from sync and from future inventory
    scans.
13. Empty source dirs are pruned only when emptied by the move; non-empty dirs
    are untouched.
14. **End-to-end on a small real share (e.g. `Coldlion`): plan → execute →
    verify → confirm sync no longer traverses `Archive/` → rollback → confirm the
    original state is fully restored.** This is the end-to-end test that
    validates the whole system.

### Phase 2 PR scope

- `archive_move` job type in the job manager
  (plan / preflight / snapshot / execute / verify / cancel / rollback).
- Manifest read/write plus resume.
- Seven NAS API endpoints and seven MCP operations, correctly tiered.
- Web UI staged move flow with folder-level scope, previews, and confirmations.
- Sync-exclusion application/instructions.
- Tests and docs.
