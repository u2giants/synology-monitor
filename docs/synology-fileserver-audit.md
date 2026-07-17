# Synology file-server audit — find these problems everywhere

**Status:** open. Scoped 2026-07-16/17 from a single incident; never run share-wide.
**Audience:** a fresh AI session with the `synology-monitor` MCP and SSH access to the NAS.
**Tools:** [`scripts/synology/`](../scripts/synology/) — read its README first; it documents the traps.

---

## Why this exists

On 2026-07-16 we merged two folders on `edgesynology1`:

```
/volume1/mac/Decor/Character Licensed/____New Structure/In Development/Customer Adopted/Dollar General/
    Dollar General Fall Winter 2026          <- live, current
    Dollar General Fall Winter 2026.wrong    <- a category-grouped reorg, frozen 2026-02-13
```

The merge succeeded (3,359 → 4,314 files, no data lost) but exposed **five
distinct problems**, four of which are almost certainly present elsewhere on the
NAS and none of which have been checked outside that one folder.

This document is the work order for checking. Each section below states what to
look for, how to measure it, and what "done" means.

---

## 1. Case-collisions between a case-sensitive NAS and case-insensitive clients

**The problem.** Btrfs holds `PPS photos` and `PPS Photos` in one folder; macOS
and Windows cannot. Synology Drive renames one side to
`<base>_<device>_<date>_Conflict` and pushes it to every client.

**Known scope (2026-07-16), `Character Licensed` share only:**

| Measure | Count |
| --- | --- |
| `*_Conflict` artifacts | ~492 |
| `*_CaseConflict` artifacts | 49 |
| Live case-collision pairs (not yet resolved by Drive) | 4 |
| Accrual rate | ~10–15/month since Aug 2025 |

**Never measured:** every other share — `files`, `styleguides`, `users`, `homes`,
`Coldlion`, `Photography`, `freelancers`, `mgmt`, `oldStyleguides` — and
`edgesynology2` entirely.

**How to measure:**
```bash
ROOT=/volume1/<share> bash scripts/synology/scan-case-collisions.sh
find /volume1/<share> -name '*Conflict*' -not -path '*@eaDir*' | wc -l
```

**How to fix:** `scripts/synology/resolve-drive-conflicts.sh` (dry-run first).
It deletes a conflict copy only when a surviving copy is proven identical or
newer; anything newer or orphaned is kept and reported for a human.

**Done means:** every share scanned; artifact counts recorded here; live collision
pairs consolidated to one canonical name each.

**Prevention is unsolved.** The resolver is a mop, not a tap. Open questions:
- Can Synology Drive be configured to reject case-variant names at write time?
- Should `scan-case-collisions.sh` run as a scheduled task that alerts on new pairs?
- Is there a naming convention (all-lowercase folders?) the design team could adopt?
Nobody has answered these. The 4 live pairs found in
`Dollar General Kids Summer 2027` (`_art.ai` vs `_ART.ai`,
`_mockup_LED on.png` vs `_mockup_LED ON.png`) are still there as of 2026-07-17.

---

## 2. Directories with mode 000

**The problem.** `chmod --reference` on DSM does not fail — it parses
`--reference=/path` as a symbolic mode (leading `-` = remove bits), strips every
permission, and exits 0. Root ignores the result, so scripts appear to work while
users are locked out.

**Known scope:** 66 directories in the Dollar General FW2026 tree. Repaired.

**Never measured:** everywhere else. Any script or tool that has ever used
`chmod --reference` on this NAS may have left these behind.

**How to measure:**
```bash
find /volume1/<share> -type d -perm 000 -not -path '*@eaDir*'
```
Run as root — a mode-000 directory hides its own children from an unprivileged
`find`, so an unprivileged scan under-reports.

**How to fix:** `resolve-drive-conflicts.sh` repairs these as its Pass 0, looping
until a pass finds nothing (each pass unlocks the next level).

**Done means:** count is 0 on both NASes, across all shares.

**Also worth grepping:** the repo and any on-NAS scripts for `--reference`, which
is unsafe on DSM in both `chmod` and (differently) `chown`.

---

## 3. Btrfs snapshots that protect nothing

**The problem.** Snapshots are not recursive into nested subvolumes. Each DSM
share is its own subvolume; `/btrfs/volume1` is already `@syno` with `mac`,
`files`, `homes` … nested inside. A snapshot of the volume root therefore
contains **no share data at all** while looking like a valid recovery point.

**Known instance:** `/btrfs/volume1/@prechange_20260716_154207` — created by the
MCP's `create_prechange_snapshot` against `/volume1`, empty, **still present**.
Should be removed with `btrfs subvolume delete` (not `rm -rf`).

The correct one, `/btrfs/volume1/mac/@prechange_20260716_154247`, is the Dollar
General recovery point and should be kept until the team signs off on deleting
`Dollar General Fall Winter 2026.merged`.

**Audit questions nobody has answered:**
- How many other `@prechange_*` snapshots exist, and are any of them empty
  (i.e. someone else was also protected by nothing)?
- The MCP tool `create_prechange_snapshot` still accepts a volume root and will
  cheerfully produce a useless snapshot. It should snapshot each nested share
  subvolume, or refuse. Tracked in the chip filed 2026-07-16 alongside the
  preview bug.

**How to measure:**
```bash
btrfs subvolume list /btrfs/volume1 | grep -i prechange
# for each, verify it actually contains data:
find /btrfs/volume1/<path>/@prechange_X -maxdepth 3 | head
```

---

## 4. Parked duplicate folders

**The problem.** `…2026.wrong` was a full reorganised duplicate parked beside the
live folder. It held 995 files the live folder did not — including the only
copies of artwork for 25 SKUs whose folders in the live tree were empty
skeletons. Nobody knew.

**Measured 2026-07-17 (`Character Licensed` only):** zero other `.wrong` folders.
47 `_OLD`/`_old` folders, which appear to be normal per-SKU version parking, not
the same pattern.

**Never measured:** other shares. Look for reorganised duplicates parked under any
suffix (`.wrong`, `.old`, `.bak`, `copy`, `-new`, ` 2`), especially any that are
*large* and *sibling to a live folder of a similar name*.

**How to measure:**
```bash
find /volume1/<share> -maxdepth 6 -type d \
  \( -iname '*.wrong' -o -iname '*.bak' -o -iname '*copy*' -o -iname '* 2' \) \
  -not -path '*@eaDir*' -printf '%TY-%Tm-%Td  %p\n' | sort
```

**Done means:** each one triaged — is it a duplicate holding unique content, or
disposable? `merge-folders.sh` handles the merge case.

**Also worth checking:** empty SKU skeleton folders generally — a folder tree with
subfolders but zero files is a signal that its content lives somewhere else.
```bash
find /volume1/<share> -type d -not -path '*@eaDir*' | while IFS= read -r d; do
  n=$(find "$d" -type f -not -path '*/@eaDir/*' -not -name '.DS_Store' 2>/dev/null | wc -l)
  [ "$n" -eq 0 ] && echo "EMPTY: $d"
done
```

---

## 5. edgesynology2 — completely unexamined

Everything above was measured on **edgesynology1 only**. edgesynology2 was
unreachable for part of 2026-07-16 (later reported restored; SSH on port 1904).

Every check in this document should be repeated against `edgesynology2`, and the
two compared — if the `mac` share replicates between them, a problem on one is a
problem on both, and a fix on one may be undone by the other.

**First questions:** does `mac` replicate to edgesynology2, by what mechanism
(Snapshot Replication? ShareSync? seaf-cli?), and in which direction?
This was never established — the container has no `synopkg` and could not see
host processes, so the question was left open.

---

## Ground rules for whoever picks this up

1. **Dry-run everything.** Every script here defaults to `DRY_RUN=1`. Read the
   report before applying. The counts should match your own independent
   measurement; if they do not, find out why before writing.
2. **Snapshot the share subvolume first**, and verify the snapshot contains files.
   See trap 3.
3. **`run_command` in the MCP is read-only** and its validator greps the command
   text — the words `mkdir`/`chmod` inside an `echo` string are enough to get the
   whole command blocked. Write work happens over SSH as root.
4. **Do not trust a "preview".** As of 2026-07-16 the MCP executed
   `create_prechange_snapshot` despite `confirmed: false`. A fix was reported;
   verify it before relying on it.
5. **Quote everything.** These paths contain spaces, and an unquoted `$(find …)`
   in a `for` loop silently word-splits — it produced a wrong "0 files" reading
   mid-incident and nearly led to the wrong conclusion.
6. **This share is synced.** `Character Licensed` and `Art Library` are seaf-cli
   worktree roots; writes propagate to users' SeaDrive clients and to the Seafile
   server on Linode. Prefer to work when someone can watch, and prefer not to
   rewrite files whose content has not changed.

## Reference

- Recovery point for the Dollar General merge: `/btrfs/volume1/mac/@prechange_20260716_154247`
- The merged-from folder, retained pending team sign-off: `…/Dollar General Fall Winter 2026.merged`
- Scripts + traps: [`scripts/synology/README.md`](../scripts/synology/README.md)
- Tests: `bash scripts/synology/tests/run-tests.sh` (38 assertions, no NAS required)
