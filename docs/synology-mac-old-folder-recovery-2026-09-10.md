# Synology `mac` deleted-folder recovery — 2026-09-10

## Outcome

Two folders missing from `edgesynology1` were restored from the read-only
`mac` snapshot `GMT-04-2026.05.29-18.15.01`:

- `/volume1/mac/Decor/Character Licensed/___OLD`
- `/volume1/mac/Decor/Character Licensed/Color-your-hero`

The restored `___OLD` tree contains 10,153 substantive files totaling
426,409,478,832 bytes. `Color-your-hero` contains 420 substantive files
totaling 17,970,452,927 bytes. The reported
`Splatter Canvas/CVPTW01 WB/CPNT01BM Batman` folder is included.

## Diagnosis and deletion boundary

Universal Search on `edgesynology1` retained an index entry for the Batman
folder after its live path disappeared, so “Open in File Station” correctly
reported that the indexed destination no longer existed.

The folders existed in the May 29 snapshot and were absent from the next
retained snapshot on June 19. Comparing immediate children of
`Decor/Character Licensed` across those snapshots showed exactly two deleted
folders: `___OLD` and `Color-your-hero`. A marker file was renamed and a
Seafile ignore file was added; those changes were preserved.

`edgesynology2` independently retained the same substantive content. Its only
additional item in `___OLD` was a temporary working file, which was not copied
into the recovery.

## Recovery and verification

Each restore used a staged Btrfs copy with `--reflink=always`. File-relative
paths and byte sizes were compared with the source snapshot before the staged
folder was renamed into place. No live destination was overwritten.

Final verification on `edgesynology1` confirmed:

- `___OLD`: source and live manifests match.
- `Color-your-hero`: source and live manifests match.
- The Batman folder exists with its preserved metadata.
- Temporary staging paths are absent.
- The restore commands completed with exit code 0 and empty error output.

Durable operation evidence is under
`/volume1/docker/synology-monitor-agent/manual-scans/` in the dated
`restore-*20260910*` and `old-tree-inventory-20260910-*` directories.

## Operational note

ShareSync on `edgesynology2` was connected and processing new events during
the investigation, but it had retained this historical content rather than
reconciling the deletion from `edgesynology1`. No ShareSync database rows,
settings, services, or indexes were changed during recovery.
