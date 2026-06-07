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

## First PR Scope

Build the smallest useful version:

- Durable NAS API jobs mount in `deploy/synology/docker-compose.agent.yml`
- NAS API local file inventory job manager
- Mtime-year scanner
- Status/result/cancel/schedule endpoints
- MCP operations wired to those endpoints
- Web UI at `/archive-inventory` covering all five operations
- Documentation and safety notes

Defer:

- Supabase persistence
- Archive move execution
- Atime/remount changes
- Per-file candidate manifests

## Archive Move Follow-Up

Once inventory is complete and archive rules are chosen, implement archive moves separately.

Rules for that later phase:

- Create `Archive` inside the same shared folder/subvolume.
- Dry-run first.
- Generate a manifest before any move. The manifest records, **per file before
  the move**: full path, size, inode number, and `mtime`, `ctime`, `btime`.
- Move files with same-subvolume rename semantics.
- Before any real move, record source root device ID, source file device ID, destination archive root device ID, and Btrfs subvolume path/id where available.
- Verify the archive destination is on the same Btrfs subvolume as the source tree, not merely the same `/volume1`.
- Run a harmless same-tree test rename before moving user files. If rename behavior indicates a cross-device or cross-subvolume boundary, abort instead of falling back to copy-and-delete.
- Preserve directory structure exactly under `Archive`.
- Exclude `Archive` from future Resilio scans.
- Take a Btrfs snapshot before executing.

### Move integrity: verify-and-rollback (hard requirement)

The move must be *self-checking*. The system never trusts that a move preserved
identity — it proves it, per file, and undoes anything that does not match.

**Same-subvolume rename path (the only allowed move path).** `rename(2)` is
atomic and preserves the inode, all three timestamps, and size; there is no
separate "delete" step (the source name simply ceases to exist). Even so, after
each rename the system **re-stats the destination** and compares
inode number, size, `mtime`, `ctime`, and `btime` against the values recorded in
the manifest. `mtime`, `btime`, and size must be **identical**; `ctime` is
expected to change on rename, so it is *recorded and reported* but not required
to match. If `mtime`, `btime`, the inode, or the size differs from the manifest,
the system **immediately renames the file back to its original path** (rollback)
and aborts the batch. Nothing else proceeds until the operator reviews it.

**Copy-and-delete path: forbidden by default, and never deletes before
verifying.** A cross-subvolume boundary is detected up front (device/subvolume
check + test rename) and the run aborts rather than silently copying. If a
copy-based mode is ever explicitly enabled in the future, it must obey
**verify-before-delete**:

1. Copy source → destination preserving timestamps.
2. Re-stat the destination and compare size, `mtime`, and `btime` (and a content
   checksum) against the manifest.
3. **Only if every check passes** delete the source.
4. If any check fails, delete the *destination copy* (not the source), leave the
   source untouched, and abort. The source is never removed on a mismatch.

In both paths the per-file verification result is written back to the manifest
(verified / rolled-back / aborted) so there is a complete, auditable record of
exactly what happened to every file.
