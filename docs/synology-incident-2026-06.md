# Synology Incident Notes — June 2026

This document consolidates the Synology file-visibility, sync, and snapshot findings established during live MCP investigation in late April through early June 2026.

It is intended as an incident handoff and reference note, not as a complete postmortem for every NAS issue ever seen.

## Scope

This note covers:

- folders that appeared missing but still existed on disk
- local permission/ownership corruption on `edgesynology1`
- comparison against healthy copies on `edgesynology2`
- snapshot evidence on `edgesynology2`
- broader Decor-tree discrepancy evidence from a local comparison report
- existing ShareSync triage guidance already in circulation

## Related Existing Material

Before this note, the relevant documentation was fragmented:

- a ShareSync triage note for stuck queue / DB issues
- a Synology Monitor infrastructure reference
- a local Decor tree comparison report showing old-vs-current discrepancies

This document is the first repo-local summary that combines those lines of evidence into one incident record.

## High-Level Findings

### 1. Some “missing files” incidents were not deletions

For the investigated example path:

`/volume1/mac/Decor/Character Licensed/____New Structure/In Development/Customer Adopted/Hobby Lobby/Hobby Lobby Group 27 (Feb 2026)/Kyle/BR042SESR01/PPS Photos`

the folder still existed on disk on `edgesynology1` and contained:

- `BR042SESR01.jpg`
- `BR042SESR01 (2).jpg`
- `BR042SESR01 (3).jpg`

That means the operator-visible symptom was “missing/inaccessible,” not “physically absent from disk.”

### 2. `edgesynology1` showed local metadata corruption

For that same path on `edgesynology1`, live MCP inspection showed:

- mode `0000` on `PPS Photos`
- unresolved numeric UID/GID instead of readable ownership
- the same pattern on sibling directories such as `_old`
- additional broken directories elsewhere in the surrounding `Kyle` subtree

This is consistent with local permission / ownership drift, not a normal delete event.

### 3. `edgesynology2` had the same content in a healthy state

The same path on `edgesynology2` was healthy:

- mode `0777`
- readable `users` group mapping
- same expected files present

That gives a strong reference point:

- the content update itself propagated
- the broken metadata state on `edgesynology1` did not identically propagate
- the problem is therefore not explained by a universal delete or missing-sync event

### 4. `edgesynology1` later logged Synology Drive permission failures

On `edgesynology1`, Synology Drive logged repeated permission failures later the same day:

- `CreateFileAlias failed`
- `reason = 'no permission' (-507)`

Those errors are consistent with the inaccessible directory metadata seen on disk.

### 5. Broader Decor discrepancies exist outside the single-folder example

A separate local comparison report for `Generic Decor.old` vs current `Generic Decor` found:

- 70 files missing by same relative path
- 45 directories missing by same relative path
- those 70 files were not found elsewhere in the base tree by content hash

So the total problem set is broader than one `PPS Photos` folder.

## Incident Chronology

This chronology only includes dates that can be supported by snapshots, MCP metadata, or existing reports.

### November 28, 2025

- Monthly `mac` snapshot exists on `edgesynology2`:
  - `GMT-05-2025.11.28-20.00.01`
- The investigated `BR042SESR01` path did not yet exist in that snapshot.

### December 31, 2025

- Monthly `mac` snapshot exists on `edgesynology2`:
  - `GMT-05-2025.12.31-20.00.01`
- By this point the parent `BR042SESR01` path existed in snapshots.

### January 22, 2026

- `PPS Photos` on `edgesynology2` snapshots was healthy with:
  - mode `777`
  - owner `1024:users`
  - contents including only `BR042SESR01 (3).jpg`

This proves the folder existed well before the April 2026 incident window and was healthy at that time.

### February 27, 2026

- Monthly `mac` snapshot exists on `edgesynology2`:
  - `GMT-05-2026.02.27-20.00.01`
- `PPS Photos` was still healthy there and still showed the older single-file state.

### April 15, 2026

- `edgesynology1` metadata in the `BR042SESR01` subtree points to activity in this tree on April 15.
- A sibling folder `_old` later appeared in the same broken pattern:
  - unresolved numeric owner
  - inaccessible mode
  - timestamps pointing back to April 15

This suggests metadata anomalies on `edgesynology1` predate the final April 27 photo update.

### April 17, 2026

- `edgesynology2` snapshots show `BR042SESR01` healthy by this point:
  - mode `777`
  - owner `1034:users`

### April 24, 2026

- Hourly `mac` snapshots exist on `edgesynology2`.
- `PPS Photos` remained healthy and still contained only the earlier single-file state.

### April 27, 2026, 12:00 PM to 1:00 PM EDT

This is the key transition window.

- Snapshot `GMT-04-2026.04.27-12.00.02`
  - `PPS Photos` healthy
  - contents only `BR042SESR01 (3).jpg`
- Snapshot `GMT-04-2026.04.27-13.00.02`
  - `PPS Photos` still healthy
  - contents now:
    - `BR042SESR01.jpg`
    - `BR042SESR01 (2).jpg`
    - `BR042SESR01 (3).jpg`

Live mtimes on `edgesynology2` place the actual file update at roughly:

- `12:51:50 PM EDT`
- `12:51:56 PM EDT`

### April 27, 2026, later that day on `edgesynology1`

- The same path still existed on disk on `edgesynology1`.
- But directory metadata was broken:
  - mode `0000`
  - unresolved numeric UID/GID
- Similar breakage existed on `_old` and other nearby directories.
- Synology Drive later logged repeated `no permission (-507)` failures.

### May 2026

- Existing ShareSync triage guidance documented a different known failure class:
  - connection/disconnect loops
  - `failed to get daemon status`
  - `open domain socket fail`
  - repeated `RedoEvent` / `PullEvent`
  - `PrepareDownloadFile` basis-file mismatch
  - empty-file basis hash `31d6cfe0d16ae931b73c59d7e0c089c0`

This is relevant because ShareSync operational failures are part of the overall Synology problem landscape, even though the investigated `PPS Photos` case looked more like local metadata corruption than a pure queue jam.

### June 2026

- A local Decor old-vs-current comparison report documented broader discrepancies:
  - `Generic Decor.old` had 70 files missing by same relative path
  - 45 directories missing by same relative path
  - the 70 missing files were not found elsewhere in the base tree by content hash

## Working Interpretation

The Synology incidents are not one single failure mode. At least three distinct classes are represented:

1. Real tree-to-tree Decor discrepancies
2. Local permission/ownership corruption on `edgesynology1` that makes folders appear missing
3. Synology Drive / ShareSync operational failures that require log and database triage

For the `PPS Photos` case specifically:

- the files were not deleted
- `edgesynology2` proves the healthy synced state
- `edgesynology1` suffered a local metadata problem
- the key reference snapshots are:
  - pre-change: `GMT-04-2026.04.27-12.00.02`
  - post-change: `GMT-04-2026.04.27-13.00.02`

## Best Evidence

### Strong evidence

- `edgesynology1` path existed on disk during investigation
- `edgesynology1` path had broken permissions/ownership
- `edgesynology2` copy of the same path was healthy
- `edgesynology2` snapshots show the before/after transition on April 27, 2026
- `edgesynology1` Drive logs showed permission failures

### Supporting evidence

- the local Decor comparison report shows broader missing-path discrepancies
- the ShareSync triage note shows that a separate class of sync failures was already known and recurring

## Open Questions

- What exact process on `edgesynology1` rewrote directory metadata into unresolved numeric ownership and `0000` mode?
- How broad is the affected scope on `edgesynology1` beyond the investigated `Kyle` subtree?
- Which “reverted file” complaints are snapshot-related versus sync-related versus comparison artifacts?
- Which incidents are true deletions versus visibility/permission failures versus ShareSync queue failures?

## Recommended Read-Only Next Steps

1. Map every `0000` directory under the affected share on `edgesynology1`
2. Compare that map against the same tree on `edgesynology2`
3. Correlate broken-directory timestamps with sync windows and snapshots
4. Pull ShareSync DB/log evidence for any stuck or replaying paths
5. Expand old-vs-current comparison beyond the current Decor sample
6. Build a dated ledger of reported reverted-file incidents and match them to snapshot and sync timelines

## Bottom Line

The incident evidence supports this working conclusion:

- `edgesynology2` provides a healthy reference copy and useful snapshot timeline
- the investigated April 27 update itself was normal on `edgesynology2`
- `edgesynology1` later presented the same content through broken local directory metadata
- broader Decor discrepancies also exist and should not be collapsed into the same root cause without further evidence
