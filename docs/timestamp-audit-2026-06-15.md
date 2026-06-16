# Timestamp Audit: edgesynology2 Evidence for Later edgesynology1 Repair

Date: 2026-06-15

Scope: `/volume1/mac`

Evidence source: `edgesynology2`

Reference snapshot: `/volume1/mac/#snapshot/GMT-05-2026.01.30-20.00.01`

This audit was read-only on `edgesynology2`. It did not touch `edgesynology1`.

## Why this audit exists

We found two classes of timestamp damage:

- Files whose content appears old, but whose filesystem modified time had been bumped to February/March 2026.
- Directories on `edgesynology1` whose modified times were bumped to June 2026, while `edgesynology2` still had older, plausible directory mtimes.

Because `edgesynology1` was busy and SMB users reported lag/disconnects, this audit records findings from `edgesynology2` only. The intent is to act on `edgesynology1` later during a quiet window.

Operational rule: use `edgesynology2` as the evidence/authority source, but
write timestamp repairs to `edgesynology1` only unless explicitly directed
otherwise. Do not repair both NASes by default; doing so can create competing
ShareSync metadata events and may replace file entries on `edgesynology1`.

## Generated Artifacts on edgesynology2

Directory:

```text
/tmp/synology_timestamp_audit_20260615
```

Files:

```text
/tmp/synology_timestamp_audit_20260615/summary.txt
/tmp/synology_timestamp_audit_20260615/edges2_dir_current_authority.csv
/tmp/synology_timestamp_audit_20260615/edges2_dir_delta_vs_20260130.csv
/tmp/synology_timestamp_audit_20260615/edges2_file_false_fresh_vs_20260130.csv
```

Earlier file-repair evidence CSV:

```text
/tmp/suspicious_mtime_edges2_20260130.csv
```

## Current Audit Summary

Generated: `2026-06-15 13:22:07 -0400`

Elapsed: `50.8s`

Directory audit:

```text
directories_scanned:                     79,022
directories_missing_snapshot:            47,354
directories_newer_than_snapshot:          1,099
directories_june2026_newer_than_snapshot:   102
directory_errors:                             0
```

File audit:

```text
files_scanned:                  610,637
files_too_new_since_2024:       166,963
files_missing_snapshot:         100,581
files_same_size_old_snapshot:         0
files_suspicious_same_inode:          0
file_errors:                          0
```

Interpretation: after the earlier 181-file repair, the Jan 30 snapshot comparison no longer finds file false-fresh candidates on `edgesynology2`. The useful artifact for files is the earlier repair CSV, not the empty current file audit CSV.

## Earlier File Repair Batch

The earlier file evidence CSV contains 181 rows:

```text
/tmp/suspicious_mtime_edges2_20260130.csv
```

Pattern:

```text
current years: 2026-02: 130, 2026-03: 51
snapshot years: 2020: 66, 2018: 25, 2021: 22, 2019: 19, 2023: 16,
                2017: 10, 2022: 9, 2015: 7, 2014: 3, 2010: 2, 2016: 2
```

Top affected areas:

```text
75  Decor/Character Licensed/____New Structure
65  Decor/Character Licensed/___OLD
18  Decor/Character Licensed/Puzzle
16  Decor/Character Licensed/Color-your-hero
 3  Decor/Generic Decor/Unused
 2  Decor/Generic Decor/_New structure
```

Sample rows:

```text
2020-05-13 18:00:56 -0400 <- 2026-02-27 10:41:43 -0500 | Decor/Character Licensed/Color-your-hero/walmart CYOH_pres_051320.ai
2020-04-20 13:27:46 -0400 <- 2026-02-19 16:08:04 -0500 | Decor/Character Licensed/Color-your-hero/pp_env.psb
2020-04-08 15:29:12 -0400 <- 2026-02-19 16:20:50 -0500 | Decor/Character Licensed/Color-your-hero/Color your hero 040220/SP_SHRINKBLISTER.psb
2020-06-01 10:34:11 -0400 <- 2026-02-27 11:28:50 -0500 | Decor/Character Licensed/Puzzle/DC/BFY84_DCJG-01_720pc_puzzle_art.psb
2020-07-17 12:10:14 -0400 <- 2026-02-19 16:38:46 -0500 | Decor/Character Licensed/Puzzle/DC/BFY84DCJGV01_insert_071720_print.ai
```

## Directory Findings

The current directory-authority CSV has 79,022 directory rows from `edgesynology2`:

```text
/tmp/synology_timestamp_audit_20260615/edges2_dir_current_authority.csv
```

This is the best source to use later for repairing `edgesynology1` directory mtimes. It records the current `edgesynology2` mtime for every directory found under `/volume1/mac`.

The Jan 30 delta CSV has 1,099 rows where current `edgesynology2` directory mtime is newer than the Jan 30 snapshot:

```text
/tmp/synology_timestamp_audit_20260615/edges2_dir_delta_vs_20260130.csv
```

Of those, 102 have current mtimes in June 2026.

Top June-2026 directory areas:

```text
50  Decor/Character Licensed/____New Structure
42  Decor/Generic Decor/_New structure
 5  Decor/Generic Decor/Freelance by Art Theme
 1  Decor
 1  Decor/unused
 1  Decor/Generic Decor/Unused
 1  Decor/Generic Decor/UPC Stickers
```

Sample June-2026 directory deltas:

```text
2026-01-22 18:05:23 -0500 <- 2026-06-15 12:52:41 -0400 | Decor/Character Licensed/____New Structure/In Development/Customer Adopted/Burlington
2025-08-14 18:17:50 -0400 <- 2026-06-08 10:28:18 -0400 | Decor/Character Licensed/____New Structure/In Development/Customer Adopted/Burlington/Burlington Wall FW 25/AAQ13DYPN03
2025-09-15 10:35:17 -0400 <- 2026-06-08 10:28:14 -0400 | Decor/Character Licensed/____New Structure/In Development/Customer Adopted/Burlington/Burlington Wall FW 25/AAQ13DYPN02
2025-12-18 09:52:56 -0500 <- 2026-06-15 13:17:35 -0400 | Decor/Character Licensed/____New Structure/In Development/Customer Adopted/Burlington/Burlington FH Refresh Nicole 2026/SET 2/NCX8RDYCP01
2025-12-18 09:53:55 -0500 <- 2026-06-15 13:17:48 -0400 | Decor/Character Licensed/____New Structure/In Development/Customer Adopted/Burlington/Burlington FH Refresh Nicole 2026/SET 2/NCX8RDYCP01/TECHPACK
```

## Suggested Evening Action

Do not run this while SMB users are active.

Recommended repair source for `edgesynology1` directories:

```text
/tmp/synology_timestamp_audit_20260615/edges2_dir_current_authority.csv
```

Recommended approach:

1. Copy `edges2_dir_current_authority.csv` to `edgesynology1`.
2. On `edgesynology1`, compare each matching `/volume1/mac/<rel-dir>` mtime to the CSV value.
3. Repair only directories whose `edgesynology1` mtime is newer than the `edgesynology2` value and falls in the suspicious June 2026 window.
4. Apply deepest-first so parent directory mtimes are restored after children.
5. Run a verification pass after Synology Drive/ShareSync settles.

For files, use `/tmp/suspicious_mtime_edges2_20260130.csv` as the already-vetted 181-row evidence list. Before touching a file on `edgesynology1`, verify at least same relative path and same size. Hash only if extra certainty is needed.

## Caveats

- This was a bounded full current-tree audit against the Jan 30 snapshot, not a 73-snapshot exhaustive history walk.
- The current Jan 30 file false-fresh audit is clean because the earlier 181 suspicious files were already repaired.
- Many directories are missing from the Jan 30 snapshot comparison because they did not exist in that snapshot, or their path did not match.
- Directory mtimes can be re-bumped by live Synology Drive, indexing, SMB, or application activity. Repairs should be done during a quiet window and verified after the sync/index queue drains.
