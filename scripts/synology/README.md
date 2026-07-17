# Synology file-server scripts

Small, dependency-free bash tools for repairing and maintaining the NAS shares.
They run **on the NAS** (DSM shell, as root via `sudo`), not inside the nas-api
container — the container mounts `/volume1/<share>` read-only.

Written after the Dollar General FW2026 merge incident on 2026-07-16
(see [`docs/synology-fileserver-audit.md`](../../docs/synology-fileserver-audit.md)).

| Script | Writes? | What it does |
| --- | --- | --- |
| `scan-case-collisions.sh` | no | Reports entries in the same folder differing only by case — each one is a Synology Drive conflict that has not happened yet. |
| `resolve-drive-conflicts.sh` | yes | Resolves `*_Conflict` / `*_CaseConflict` artifacts against the file they collided with, and repairs mode-000 dirs. |
| `merge-folders.sh` | yes | Merges one folder into another, case-safely, newest-wins. |
| `lib-nas-safe.sh` | — | Shared helpers. Source it; don't run it. |
| `tests/run-tests.sh` | — | 38 assertions against synthetic trees. No NAS needed. |

Every writing script defaults to `DRY_RUN=1` and reports what it *would* do.
Set `DRY_RUN=0` to apply.

```bash
# 1. report
ROOT="/volume1/mac/Decor/Character Licensed" DRY_RUN=1 sudo -E bash resolve-drive-conflicts.sh
# 2. apply
ROOT="/volume1/mac/Decor/Character Licensed" DRY_RUN=0 sudo -E bash resolve-drive-conflicts.sh
```

Note `sudo -E`, which preserves the environment. Plain `sudo VAR=x bash …` also
works; `VAR=x sudo bash …` does **not** — sudo resets the environment and the
variable is silently dropped (you get a dry run while believing you applied).

## Before running anything that writes

Take a recovery point of the **share subvolume**:

```bash
btrfs subvolume snapshot -r /btrfs/volume1/mac /btrfs/volume1/mac/@prechange_$(date +%Y%m%d_%H%M%S)
```

Not the volume root. See "Snapshots are not recursive" below.

---

## The four traps this NAS sets

These are not hypothetical. Each one caused real damage on 2026-07-16.

### 1. The filesystem is case-sensitive; every client is not

Btrfs happily holds `PPS photos` and `PPS Photos` in one folder. macOS and
Windows cannot. Synology Drive resolves the impossibility by renaming one side to
`<base>_<device>_<date>_Conflict` and pushing it to every client. As of
2026-07-16 the `Character Licensed` share carried ~492 such artifacts accrued
since Aug 2025, at roughly 10–15/month.

**Never create a path from a string.** Resolve each component against what
already exists (`nas_resolve_path`). A merge that compared paths case-sensitively
copied 39 files that were already present under a different case and generated 63
new conflict artifacts in one run.

### 2. `chmod --reference` silently destroys permissions

DSM's `chmod` does not support `--reference`. It parses `--reference=/path` as a
*symbolic mode* — the leading `-` means "remove these bits" — and **exits 0**.

```bash
chmod --reference="$src" "$dst"   # => dst becomes d---------, exit code 0
```

66 directories were made unreadable this way while the script reported success.
Read the mode with `stat -c %a` and apply it literally (`nas_mkdir_like`).
The general lesson: on DSM, an unsupported flag may not fail — it may do
something else and claim success.

### 3. Btrfs snapshots are not recursive into nested subvolumes

Each DSM share is its own subvolume. `/btrfs/volume1` is already the `@syno`
subvolume, and `mac`, `files`, `homes` … are nested inside it.

```bash
btrfs subvolume snapshot -r /btrfs/volume1 /btrfs/volume1/@prechange_x   # EMPTY
btrfs subvolume snapshot -r /btrfs/volume1/mac /btrfs/volume1/mac/@snap  # correct
```

A "prechange snapshot" of the volume root contains **none of your shares** and
protects nothing — while looking like a successful recovery point. Always verify
a snapshot by counting files inside it before trusting it.

Delete snapshots with `btrfs subvolume delete`, never `rm -rf`.

### 4. `du` and `df` will disagree, and `df` is right

A snapshot shares every extent with its source, so `du` reports its full logical
size (e.g. 15 TB) while it consumes essentially nothing. Check `df` before and
after: if free space did not move, the snapshot cost nothing. Snapshots only
accrue real cost as the original diverges.

## Related, if you are moving data in these shares

`/volume1/mac/Decor/Character Licensed` is a **seaf-cli worktree root**
(`repo_id 177cf9de-3066-482e-956a-7ae8d8786c6d`); `/volume1/mac/Art Library` is
another. Files written there sync to the Seafile server. Copying content that
already exists elsewhere *in the same library* is cheap — Seafile dedups by
content hash, so the blocks are already server-side — but rewriting files
needlessly is not. This is why `merge-folders.sh` compares content before it
writes: an earlier mtime-only version would have rewritten 284 byte-identical
files (29.6 GB) for nothing.

Do not "hide" an already-synced folder by adding it to `seafile-ignore.txt` —
ignoring a synced path can read as a deletion server-side.
