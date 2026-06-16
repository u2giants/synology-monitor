# Layered Timestamp Audit: edgesynology2

Date: 2026-06-15

Scope: `/volume1/mac`

NAS: `edgesynology2`

Mode: read-only audit

Command priority: `ionice -c2 -n4` after an initial slower `ionice -c3 nice -n 19` attempt was stopped.

Operational rule for repairs from this evidence: `edgesynology2` is the evidence
source. Apply timestamp repairs to `edgesynology1` only unless the operator
explicitly requests writes to both NASes.

## Purpose

Look for false-fresh file modified times using layered evidence, so repaired
mtimes can later be applied before running the archive move normally.

Evidence tiers:

- Tier 1: same path, same size, old snapshot mtime, and matching SHA-256 hash.
- Tier 2: same path, same size, old snapshot mtime, and same inode.
- Tier 3: embedded metadata dates older than the filesystem mtime.

## Generated Artifacts on edgesynology2

```text
/tmp/synology_layered_timestamp_audit_20260615/summary.txt
/tmp/synology_layered_timestamp_audit_20260615/tier1_hash_match_snapshot.csv
/tmp/synology_layered_timestamp_audit_20260615/tier2_same_inode_snapshot.csv
/tmp/synology_layered_timestamp_audit_20260615/tier3_embedded_metadata.csv
/tmp/synology_layered_timestamp_audit_20260615/hash_pending_snapshot.csv
/tmp/synology_layered_timestamp_audit_20260615/hash_mismatch_snapshot.csv
```

Script used:

```text
/tmp/edges2_layered_timestamp_audit.py
```

## Summary

Generated: `2026-06-15 23:22:44 -0400`

Elapsed: `5,872.9s` (`~1h 38m`)

Snapshots checked: `73`

Current-file trigger: filesystem mtime on or after `2024-01-01 00:00:00 -0500`

Old-snapshot trigger: snapshot mtime before `2024-01-01 00:00:00 -0500`

Minimum jump: `30 days`

```text
files_seen:           610,765
too_new_since_2024:   167,091
tier1_hash_match:           1
tier2_same_inode:         463
tier3_xmp_old:              0
hash_pending:               0
hash_mismatch:              0
```

## Actionable Result

Only one row was safe to auto-repair from this layered audit:

```text
2023-06-08 13:06:01 -0400 <- 2026-03-24 23:13:57 -0400
Decor/Generic Decor/_New structure/VSZ_/40x30/VSZ34TMSC04.jpg
snapshot: GMT-04-2025.06.30-20.00.01
size: 959,368
evidence: same path + same size + SHA-256 hash match + old snapshot mtime
```

Applied on 2026-06-16:

```text
edgesynology1: repaired to 2023-06-08 13:06:01 -0400; inode was 65589556 immediately after touch,
               then ShareSync replaced/recreated the file entry as inode 69868151 while preserving
               the repaired mtime and matching SHA-256
edgesynology2: repaired to 2023-06-08 13:06:01 -0400; inode stayed 96767449
```

Lesson from this repair: repairing both sides created metadata events on both
NASes and likely caused the `edgesynology1` inode replacement. Future repairs
from cross-NAS evidence should write only to `edgesynology1` by default.

Use:

```text
/tmp/synology_layered_timestamp_audit_20260615/tier1_hash_match_snapshot.csv
```

This CSV is now historical evidence for the completed repair. Before any future
repair from similar evidence, verify same relative path and same size on the
target NAS; hash again if maximum certainty is wanted.

## Tier 2 Anomaly

The audit produced 463 Tier 2 rows, but every one has this snapshot mtime:

```text
1969-12-31 19:00:00 -0500
```

Those rows should **not** be auto-repaired. They are likely files whose snapshot
mtime is invalid/zeroed, not proof that the current mtime should become 1969.

All 463 are under:

```text
Decor/Character Licensed/____New Structure
```

Sample:

```text
1969-12-31 19:00:00 -0500 <- 2024-03-19 10:49:58 -0400
Decor/Character Licensed/____New Structure/In Development/Customer Adopted/_FINISHED/Homegoods_finished/HomeGoods Desktop SS24/_prelim files/.BridgeSort

1969-12-31 19:00:00 -0500 <- 2024-02-02 11:55:17 -0500
Decor/Character Licensed/____New Structure/In Development/Customer Adopted/_FINISHED/Homegoods_finished/HomeGoods Desktop SS24/_prelim files/_MDF BOXES_011024/5x7 MDF Box Plain/MBZ57CBCC_art_WIP 1.psd
```

Interpretation: keep `/tmp/synology_layered_timestamp_audit_20260615/tier2_same_inode_snapshot.csv`
as an anomaly/review file only. Do not use it as a repair source unless a later
check finds a non-1969 authoritative mtime for the same paths.

## Tier 3 Result

No embedded metadata candidates were found:

```text
tier3_embedded_metadata.csv rows: 0
```

This does not mean no design files have embedded metadata; it means no file in
this audit matched the current-newer + embedded-old criteria using the audit's
limited XMP parser and first-3MiB read.

## Current Mtime Distribution

The current-newer population spans many months, which means most new-looking
files are probably legitimately active or outside the known false-fresh pattern:

```text
2025-09: 8,552
2024-07: 7,974
2025-12: 7,876
2025-04: 7,260
2024-05: 7,086
2024-03: 7,065
2024-01: 6,991
2024-06: 6,455
2025-03: 6,443
2025-10: 6,145
2026-03: 4,285
2026-06: 2,854
2026-02: 2,413
```

## Relationship to Earlier Repair Batch

The earlier targeted Jan 30 snapshot audit found and repaired 181 files with
strong same-inode evidence. This broader layered audit ran after that repair.
That is why it does not rediscover the earlier `SP_SHRINKBLISTER.psb` style
February 2026 cases as actionable rows.

Earlier evidence file:

```text
/tmp/suspicious_mtime_edges2_20260130.csv
```

## Recommendation

For automatic repair before the next normal archive move:

1. Use the earlier 181-row file repair CSV if any of those still need applying.
2. The one Tier 1 row from this layered audit has already been repaired on both NASes.
3. Do not use the 463 Tier 2 rows with 1969 snapshot mtimes as repair targets.
4. Continue to run the archive move normally, without Force Archive.
