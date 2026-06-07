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

Suggested local state path:

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
- Call `DirEntry.Info()` only for files.
- Aggregate by `mtime.Year()`.
- Track total file count and total bytes per share/year.
- Track progress every N files.
- Check cancellation between directories and every N files.
- Throttle periodically to reduce NAS impact.

Suggested scanner options:

```json
{
  "shares": ["files", "styleguides"],
  "exclude_default_dirs": true,
  "archive_dir_name": "Archive",
  "cutoff_years": [2021, 2022],
  "max_files_per_second": 0,
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

The operation descriptions should make the I/O cost explicit:

- This is read-only but may perform a long metadata walk.
- It should be run during quiet hours for very large shares.
- It does not move, delete, or modify files.

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
4. Run scanner against a tiny mounted test folder.
5. Run one real small share, such as `Coldlion`.
6. Run one medium share with throttling enabled.
7. Confirm MCP timeout no longer matters because status polling returns immediately.
8. Compare one completed share report against a manual `find` spot check.
9. Confirm no writes occur outside `/app/data/jobs/file-inventory/`.

## First PR Scope

Build the smallest useful version:

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
- Preserve directory structure exactly under `Archive`.
- Exclude `Archive` from future Resilio scans.
- Take a Btrfs snapshot before executing.
