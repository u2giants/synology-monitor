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

Expose four operations:

```text
start_file_inventory
get_file_inventory_status
fetch_file_inventory_result
cancel_file_inventory
```

Recommended safety labels:

- `start_file_inventory`: read-only, expensive read
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
running
complete
failed
cancelled
```

Default behavior:

- Allow only one inventory job per NAS at a time.
- Persist status and partial progress so a restarted request path can still report what happened.
- Write results only under `/app/data/jobs/file-inventory/`.
- Do not write into the shared folders.
- On startup, detect jobs that were `running` before a container restart and mark them `interrupted` unless resume support has been explicitly implemented.
- Write progress to disk atomically every N files so status polling and crash recovery are never stale by more than that interval.

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
  "max_files_per_second": 0,
  "use_idle_io_priority": true,
  "sleep_every_files": 5000,
  "sleep_ms": 25
}
```

The `max_files_per_second` field can be `0` for unlimited.

## Result Format

Primary CSV:

```text
nas,share,year,file_count,total_bytes,total_gib
edgesynology1,files,2020,24584,982589180666,915.11
```

Cutoff summary CSV:

```text
nas,share,cutoff,file_count,total_bytes,total_gib
edgesynology1,files,older_than_2021,65755,1499000000000,1395.90
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
get_file_inventory_status
fetch_file_inventory_result
cancel_file_inventory
```

The operations should call the NAS API rather than running long shell commands. MCP should only receive compact JSON/CSV results.

Tiering:

- `start_file_inventory`: tier 2. It is read-only, but it can impose hours of metadata I/O on a NAS with millions of files, so it should require preview and approval.
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

## Web UI Optional Follow-Up

After the MCP-first version works, add a small operator page in the web app:

```text
/archive-inventory
```

Expected controls:

- Target NAS selector
- Share checkboxes
- Start job
- Progress/status
- Download CSV
- View yearly chart/table
- View cutoff summary

This is optional. The first useful version can be MCP-only.

## Verification Plan

1. Unit-test scanner aggregation with fake directory trees.
2. Unit-test exclusion behavior for `#snapshot`, `@eaDir`, `Archive`, and `@tmp`.
3. Unit-test cancellation.
4. Unit-test startup recovery for a job left in `running` state.
5. Unit-test atomic progress writes.
6. Unit-test symlink skipping.
7. Unit-test empty directory counting.
8. Run scanner against a tiny mounted test folder.
9. Run one real small share, such as `Coldlion`.
10. Run one medium share with low I/O priority and throttling enabled.
11. Confirm MCP timeout no longer matters because status polling returns immediately.
12. Compare one completed share report against a manual `find` spot check.
13. Confirm no writes occur outside `/app/data/jobs/file-inventory/`.
14. Confirm the durable NAS API jobs mount survives a container recreate.
15. Confirm Drive/ShareSync overlay errors are recorded without failing the inventory.
16. Confirm `fetch_file_inventory_result` enforces pagination or response-size limits.

## First PR Scope

Build the smallest useful version:

- Durable NAS API jobs mount in `deploy/synology/docker-compose.agent.yml`
- NAS API local file inventory job manager
- Mtime-year scanner
- Status/result/cancel endpoints
- MCP operations wired to those endpoints
- Documentation and safety notes

Defer:

- Web UI
- Supabase persistence
- Archive move execution
- Atime/remount changes
- Per-file candidate manifests

## Archive Move Follow-Up

Once inventory is complete and archive rules are chosen, implement archive moves separately.

Rules for that later phase:

- Create `Archive` inside the same shared folder/subvolume.
- Dry-run first.
- Generate a manifest before any move.
- Move files with same-subvolume rename semantics.
- Before any real move, record source root device ID, source file device ID, destination archive root device ID, and Btrfs subvolume path/id where available.
- Verify the archive destination is on the same Btrfs subvolume as the source tree, not merely the same `/volume1`.
- Run a harmless same-tree test rename before moving user files. If rename behavior indicates a cross-device or cross-subvolume boundary, abort instead of falling back to copy-and-delete.
- Preserve directory structure exactly under `Archive`.
- Exclude `Archive` from future Resilio scans.
- Take a Btrfs snapshot before executing.
