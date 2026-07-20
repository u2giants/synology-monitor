# Synology file-server audit — find these problems everywhere

**Status:** OPEN. Scoped 2026-07-16/17 from a single folder; never run share-wide.
**Audience:** a fresh AI session with the `synology-monitor` MCP and SSH to the NAS.
**Tooling:** [`scripts/synology/`](../scripts/synology/) — read its README first; it
documents the traps. Tests: `bash scripts/synology/tests/run-tests.sh` (55 assertions,
no NAS required).
**Prerequisite reading:** AGENTS.md → "Moving or merging files inside a share" and the
2026-07-16/17 critical incident.

---

## 0. TL;DR for whoever picks this up

One folder out of one share has been cleaned. The tools are written, tested, and
proven on live data. What remains is running the same procedure over **~470
remaining conflict artifacts** in `Character Licensed`, then over **every other
share**, then over **edgesynology2, which has never been examined at all**.

The single most important thing to understand before you start: **a `*_Conflict`
folder is not junk.** On 2026-07-17, resolving 21 artifacts *recovered 81 files*,
including a product photo shoot that existed nowhere else. If you bulk-delete
conflict folders you will destroy irreplaceable design assets silently.

Start here:

```bash
# 1. Check the recovery point you ALREADY have — DSM snapshots mac every ~4h.
#    Verify one contains real data before trusting it (see §7).
ls /volume1/mac/#snapshot | grep -v desktop.ini | sort | tail
find "/volume1/mac/#snapshot/<stamp>/Decor/Character Licensed" -maxdepth 1 | head
#    Only if you need a fresh point, snapshot the SHARE SUBVOLUME, never the
#    volume root (trap 3) — and record it in HANDOFF.md so nobody deletes it:
#    sudo btrfs subvolume snapshot -r /btrfs/volume1/mac /btrfs/volume1/mac/@prechange_$(date +%Y%m%d_%H%M%S)
# 2. Report-only pass
ROOT="/volume1/mac/Decor/Character Licensed" DRY_RUN=1 sudo -E bash resolve-drive-conflicts.sh
```

---

## 1. What happened, in full (why this document exists)

On 2026-07-16 two sibling folders on `edgesynology1` were merged:

```
/volume1/mac/Decor/Character Licensed/____New Structure/In Development/Customer Adopted/Dollar General/
    Dollar General Fall Winter 2026          <- live, current  (3,359 files)
    Dollar General Fall Winter 2026.wrong    <- category-grouped reorg, frozen 2026-02-13 (2,592 files)
```

`.wrong` was not a redundant copy. It held 995 files the live folder lacked,
including the only artwork for **25 SKU folders that existed in the live tree as
empty skeletons** (`AAQ66*`, `NHN44*`, `NHP88*`, `NUN10*`, `HSR57MVSX01`,
`HSR57SESR01`, `NHP80SESR01`, `NHP8ADYLS01`), plus entirely new SKU families
(`AA114*`, `AA926*`, `FAM6XDYLS01`, `PCFTFMVSP02`) and 116 `_Working Files`.

The merge policy chosen by the operator: **flatten** `.wrong`'s category folders
(`WALL CLOCK/`, `PLAIN CANVAS/` …) so SKUs land at top level; **re-anchor** SKUs
that the live folder already keeps under a category (`NUN4V*` under
`Nonwoven Collapsible Toy Chest`); **newest-wins** on conflicts; keep `.wrong`
afterwards, renamed `.merged`.

The merge moved all 995 files with no data loss — but shipped two defects to live
data, and later exposed a third class of problem. Full detail in sections 2–3.

**Final state of that folder (verified 2026-07-17):** 4,295 files, 0 conflict
artifacts, 0 mode-000 directories, 0 root-owned directories, 0 files lost.

*Bookkeeping note, recorded for honesty:* the running arithmetic predicted 4,296
(4,314 before the conflict pass, minus 18 deletions). The tree reports 4,295,
stable across repeated counts with no file modified in the surrounding 90 minutes.
No content is missing — per-SKU gains reconcile exactly to the 81 moved files, and
all 18 deletions were verified to have surviving counterparts. The one-file variance
against the earlier total was never explained. If you re-derive these numbers, do
not treat the mismatch as evidence of loss.

---

## 2. Problem 1 — case-collisions (the root cause)

**The mechanism.** Btrfs is case-sensitive. macOS and Windows are not. Two entries
in one folder differing only by case cannot both exist on a client, so Synology
Drive renames one to `<base>_<device>_<date>_Conflict` and pushes it everywhere.

**Measured 2026-07-16/17, `Character Licensed` share only:**

| Measure | Count |
| --- | --- |
| `*_Conflict` artifacts share-wide | ~492 |
| `*_CaseConflict` artifacts share-wide | 49 |
| Accrual rate | ~10–15/month since Aug 2025 |
| Live case-collision pairs not yet forked by Drive | 4 |
| Artifacts resolved so far (one folder) | 21 |

**Never measured:** every other share — `files`, `styleguides`, `users`, `homes`,
`Coldlion`, `Photography`, `freelancers`, `mgmt`, `oldStyleguides` — and
`edgesynology2` entirely.

**The 4 live pairs** (conflicts that have not happened yet) are all in
`Dollar General Kids Summer 2027`:

- `NHP88DYLS01/TECHPACK/NHP88DYLS01_art.ai` vs `…_ART.ai`
- `AA014DYFZ01/TECHPACK/AA014DYFZ01_art.ai` vs `…_ART.ai`
- `NHP88DYCR01/TECHPACK/NHP88DYCR01_art.ai` vs `…_ART.ai`
- `AAE26DYCR01/_old/AAE26DYCR01_mockup_LED on.png` vs `…_LED ON.png`

These need a **human** to choose the surviving name — the scanner deliberately
never writes, because picking the survivor is a judgement about content.

**Measure:**
```bash
ROOT=/volume1/<share> bash scripts/synology/scan-case-collisions.sh
find /volume1/<share> -name '*Conflict*' -not -path '*@eaDir*' | wc -l
```

**Fix:** `resolve-drive-conflicts.sh`, dry-run first. Policy below in §5.

**Done means:** every share scanned; artifact counts recorded in this file; live
collision pairs consolidated to one canonical name each.

### Prevention is UNSOLVED — do not claim otherwise

The resolver is a mop, not a tap. The structural cause persists and generates
10–15 new conflicts a month regardless of cleanup. Open questions nobody has
answered:

- Can Synology Drive be configured to reject case-variant names at write time?
  **Unverified — do not assert either way without testing.**
- Should `scan-case-collisions.sh` run as a scheduled task that alerts on new pairs?
- Would a naming convention (e.g. all-lowercase folders) be accepted by the design team?

---

## 3. Problem 2 — `*_Conflict` artifacts can hold the ONLY copy of real content

**This is the finding that most changes how you must work.**

Resolving the 21 artifacts in `Dollar General Fall Winter 2026` did not delete 21
things. It **recovered 81 files**:

| SKU | files in the `_Conflict` fork | files in the live folder | outcome |
| --- | --- | --- | --- |
| `NCX04SESC01` | 31 (incl. 29 photos) | 7, `PPS photos/` **empty** | +31 moved in |
| `NCX04SSSS01` | 27 | 7, `PPS photos/` **empty** | +27 moved in |
| `NCX04MVSX01` | 20 | 11, `PPS photos/` **empty** | +20 moved in |
| `HSR57DYLS05` | 3 | 7 | +3 moved in |
| `HSR57DYNX01` | 3 | 31 | 3 deleted (dupes) |
| `HSR57SSSS01` | 3 | 26 | 3 deleted (dupes) |
| `MWB10DYLS01` | 0 | 11 | empty fork removed |
| `HSR57MVSP01` | 0 | 8 | empty fork removed |

The three `NCX04*` forks held an **October 2025 product photo shoot** — 20–27
photos each — while the live SKU's `PPS photos/` folder was completely empty. Those
photos existed nowhere else. They are the same SKUs the `.wrong` merge filled with
design files; `.wrong` never had the photography.

**Implication:** treat every conflict directory as a divergent copy to be *merged*.
Never bulk-delete. The resolver's PASS 2 recurses and reconciles per file.

---

## 4. Problem 3 — directories with mode 000

**Cause.** DSM's `chmod` does not support `--reference`. It parses
`--reference=/path` as a symbolic mode whose leading `-` **removes** bits, and
exits 0. Root ignores the result, so a script appears to work while users are
locked out.

**Known scope:** 66 directories in the Dollar General tree. **Repaired.**

**Never measured:** everywhere else. Any script or tool that ever used
`chmod --reference` on this NAS may have left these behind.

**Measure (as root — a 000 dir hides its children from an unprivileged `find`):**
```bash
find /volume1/<share> -type d -perm 000 -not -path '*@eaDir*'
```

**Fix:** `resolve-drive-conflicts.sh` PASS 0 repairs these, looping until a pass
finds nothing (each pass unlocks the next level). Mode `777` is the universal mode
in this tree — verified: all 919 dirs in `.wrong` and all 772 pre-merge dirs in the
live folder were `777`.

**Also grep** the repo and any on-NAS scripts for `--reference`; it is unsafe on
DSM in both `chmod` and (differently) `chown`.

---

## 5. The resolution policy (what the tools actually do)

Encoded in `resolve-drive-conflicts.sh` and covered by tests. **Nothing is ever
deleted unless a surviving copy is proven to exist.**

For a conflict **file** `<base>_<device>_<date>_Conflict[.ext]`, find the entry it
collided with (same name minus the suffix, matched case-insensitively):

| Situation | Action |
| --- | --- |
| identical content | DELETE the conflict copy |
| conflict copy OLDER | DELETE (newest-wins) |
| conflict copy NEWER | **KEEP + report** — a human decides |
| no counterpart at all | **KEEP + report** — it is the only copy |

For a conflict **directory**, every file *anywhere beneath it* is reconciled
against the target case-aware:

| Situation | Action |
| --- | --- |
| target has no such path | **MOVE it in** (unique content; would otherwise stay stranded) |
| identical content | DELETE |
| conflict copy NEWER | **KEEP + report** — target is authoritative; never auto-overwrite from an old fork |
| otherwise (older/same) | DELETE (stale) |

Empty subdirectories are then removed bottom-up; the conflict dir itself only if it
ends up completely empty, otherwise retained and flagged.

`KEPT for review: 0` in the summary is the signal that a run needed no human
judgement. **If it is non-zero, stop and look at those files before applying.**

---

## 6. Conflict-name formats (all observed on this NAS)

The matcher must handle all of these. Two of them broke earlier versions:

```
<base>_<device>_<Mon-DD-HHMMSS-YYYY>_Conflict[.ext]
<base>_<device>_<Mon-DD-HHMMSS-YYYY>_CaseConflict[.ext]
<base>_<device>_<Mon-DD-HHMM-YYYY>_DownloadCaseConflict[.ext]     (Seafile; 4-digit time)
```

Real examples, each of which broke something:

- `HSR57DYLS05_Elizabeths-MacBook-Pro.local_Jan-19-140821-2026_Conflict` — a
  **directory**, and the device contains dots. A `${name%.*}` "strip the extension"
  step lopped it at `.local` and silently skipped 8 real conflict directories.
  **Match the full name; make the extension optional in the pattern.**
- `UP00ADYLS12_MOCKUP_DESKTOP-HKGCSV3_Jan-15-123319-2026_Conflict.psd` — the BASE
  itself contains underscores. A greedy `_*_Conflict` strip yields `UP00ADYLS12`
  and loses `_MOCKUP`. **Anchor on the device+timestamp shape.**
- `NUN10DYNX01_art_DiskStation_Nov-18-1047-2025_DownloadCaseConflict.ai` — 4-digit
  time and a `Download` prefix; an `HHMMSS`-only pattern misses it entirely.

All three have named regression tests in `tests/run-tests.sh`.

---

## 7. Problem 4 — Btrfs snapshots that protect nothing

Snapshots are **not recursive into nested subvolumes**. Each DSM share is its own
subvolume; `/btrfs/volume1` is already `@syno` with `mac`, `files`, `homes` … nested
inside.

```bash
btrfs subvolume snapshot -r /btrfs/volume1     …   # EMPTY — protects nothing
btrfs subvolume snapshot -r /btrfs/volume1/mac …   # correct
```

A "prechange snapshot" of the volume root looks like a successful recovery point
and contains none of your shares. **Always verify by counting files inside it.**

Also: `du` reports a snapshot's full logical size (e.g. 15 TB) while it consumes
almost nothing — snapshots share extents and only accrue cost as the original
diverges. Check `df` before/after; if free space did not move, it cost nothing.
Delete with `btrfs subvolume delete`, never `rm -rf`.

### Prefer DSM's own share snapshots over a hand-rolled `@prechange_*`

`mac` already has **44 automatic share snapshots** under `/volume1/mac/#snapshot/`
(range 2026-05-29 → 2026-07-20, roughly every 4 hours), created by Snapshot
Replication. Check these **first**; you may not need to create anything.

```bash
ls /volume1/mac/#snapshot | grep -v desktop.ini | sort | tail
# verify one holds what you expect before trusting it:
find "/volume1/mac/#snapshot/<stamp>/Decor/…/<folder>" -type f \
     -not -path '*@eaDir*' -not -name '.DS_Store' | wc -l
```

**Lesson learned the hard way (2026-07-17):** the manual
`mac/@prechange_20260716_154247` created as the Dollar General recovery point was
deleted by a *different* session that classified both stray `@prechange_*`
subvolumes as accidental clutter. It was not wrong to delete — but a hand-made
recovery point is an unlabelled artifact that another session may garbage-collect
without knowing why it exists. If you do create one, record it in `HANDOFF.md`
immediately, and prefer verifying an automatic share snapshot over minting a new
subvolume. (No data was at risk here: the pre-merge state survives in the share
snapshots above.)

**Outstanding audit question:** how many other `@prechange_*` snapshots exist, and
are any of them empty (i.e. someone else was protected by nothing)?

```bash
btrfs subvolume list /btrfs/volume1 | grep -i prechange
find /btrfs/volume1/<path>/@prechange_X -maxdepth 3 | head    # must show real data
```

The MCP tool `create_prechange_snapshot` still accepts a volume root and will
cheerfully produce a useless snapshot. Filed as a chip on 2026-07-16 alongside the
preview bug; verify before relying on it.

---

## 8. Problem 5 — parked duplicate folders

`…2026.wrong` was a full reorganised duplicate parked beside the live folder,
holding the only copies of artwork for 25 SKUs. Nobody knew.

**Measured 2026-07-17 (`Character Licensed` only):** zero other `.wrong` folders.
47 `_OLD`/`_old` folders, which look like normal per-SKU version parking, not the
same pattern.

**Never measured:** other shares. Look for reorganised duplicates under any suffix
(`.wrong`, `.old`, `.bak`, `copy`, `-new`, ` 2`), especially any that are *large*
and *sibling to a live folder of a similar name*.

```bash
find /volume1/<share> -maxdepth 6 -type d \
  \( -iname '*.wrong' -o -iname '*.bak' -o -iname '*copy*' -o -iname '* 2' \) \
  -not -path '*@eaDir*' -printf '%TY-%Tm-%Td  %p\n' | sort
```

**Related signal — empty SKU skeletons.** A folder tree with subfolders but zero
files means its content lives somewhere else:

```bash
find /volume1/<share> -type d -not -path '*@eaDir*' | while IFS= read -r d; do
  n=$(find "$d" -type f -not -path '*/@eaDir/*' -not -name '.DS_Store' 2>/dev/null | wc -l)
  [ "$n" -eq 0 ] && echo "EMPTY: $d"
done
```

Merge such a duplicate with `merge-folders.sh` (case-safe, newest-wins,
`FLATTEN`/`REANCHOR` options documented in its header).

---

## 9. Problem 6 — edgesynology2 is completely unexamined

Everything above was measured on **edgesynology1 only**. edgesynology2 was
unreachable for part of 2026-07-16 (later reported restored; SSH on port **1904**).

Repeat every check there and compare. **First question, never answered:** does the
`mac` share replicate to edgesynology2, by what mechanism (Snapshot Replication?
ShareSync? seaf-cli?), and in which direction? The container has no `synopkg` and
cannot see host processes, so this must be answered over SSH. If it does replicate,
a problem on one is a problem on both, and a fix on one may be undone by the other.

Note the `edgesynology2` device name already appears in conflict artifacts
(`SNMH7DYLS01_ART_edgesynology2_…_CaseConflict.ai`), which is itself evidence of
cross-NAS sync activity.

---

## 10. Ground rules — read before touching anything

1. **Dry-run everything.** All writing scripts default to `DRY_RUN=1`. The counts in
   the report must match your own independent measurement; if they do not, find out
   why before applying. This caught three separate bugs.
2. **Snapshot the share subvolume first, and verify it contains files.** See §7.
3. **`sudo` resets the environment.** `VAR=x sudo bash …` silently drops the
   variable — you get a dry run while believing you applied. Use `sudo VAR=x bash …`
   or `sudo -E`. DSM Task Scheduler user-defined scripts already run as root.
4. **`run_command` in the MCP is read-only**, and its validator greps the command
   *text* — the words `mkdir`/`chmod` inside an `echo` string are enough to get the
   whole command blocked, and `-o` in a `find` has tripped it too. Write work happens
   over SSH as root.
5. **Do not trust a "preview".** On 2026-07-16 the MCP executed
   `create_prechange_snapshot` despite `confirmed: false`. A fix was reported by a
   parallel session; verify before relying on it.
6. **Quote everything.** These paths contain spaces. An unquoted `$(find …)` in a
   `for` loop word-splits and silently produced a wrong "0 files" reading mid-incident,
   which nearly led to the wrong conclusion.
7. **This share is synced.** `Character Licensed` and `Art Library` are seaf-cli
   worktree roots (`repo_id 177cf9de-3066-482e-956a-7ae8d8786c6d`); writes propagate
   to SeaDrive clients and the Seafile server on Linode. Moves *within* a library are
   cheap (renames, no re-upload). Rewriting unchanged files is not — compare content
   first. Work when someone can watch.
8. **Verify the tree, not the summary.** Every bug in this effort was caught by
   checking the filesystem after a run, never by reading the script's own totals.

## 11. Transferring scripts to the NAS

`scp`/sftp is disabled on the NASes. The terminal also truncates long heredoc
pastes at roughly **6 KB** — a truncated script that still parses is the dangerous
failure mode. The reliable path is base64 in chunks with a checksum gate:

```bash
# locally
base64 -w 76 script.sh > s.b64 && split -l 54 -d s.b64 chunk_
md5sum script.sh chunk_*
# on the NAS: paste each chunk into `cat > ~/cN.b64 <<'EOF' … EOF`, verify each md5,
cat ~/c1.b64 ~/c2.b64 > ~/s.b64 && base64 -d ~/s.b64 > ~/script.sh
md5sum ~/script.sh     # MUST match the local md5 before running
```

Never run a transferred script whose checksum does not match.

---

## 12. Reference

| Item | Value |
| --- | --- |
| Recovery point for the Dollar General work | **DSM share snapshots**: `/volume1/mac/#snapshot/GMT-04-2026.07.16-10.15.01` and `-14.15.01` — both verified to hold the exact pre-merge state (live 3,359 files, `.wrong` 2,592) |
| Merged-from folder, retained pending sign-off | `…/Dollar General Fall Winter 2026.merged` (~71 GB, 2,592 files) |
| Seafile library containing this share | `repo_id 177cf9de-3066-482e-956a-7ae8d8786c6d` |
| Scripts + trap documentation | [`scripts/synology/README.md`](../scripts/synology/README.md) |
| Tests | `bash scripts/synology/tests/run-tests.sh` — 55 assertions, no NAS needed |
| Incident record | AGENTS.md → Critical incidents → 2026-07-16/17 |

A one-time Claude scheduled task (`ask-team-delete-dg-merged`, fires **Monday
2026-07-20 15:00 America/New_York**) surfaces the question of whether `.merged` can
be deleted, so it is not tracked only in an ephemeral place. Scheduled tasks fire
only while the app is open; a missed one runs at next launch. Deleting it should *reduce* Seafile/
Linode storage (blocks unique to it get GC'd); blocks shared with the live folder
stay referenced. Do **not** add `.merged` to `seafile-ignore.txt` as a shortcut —
ignoring an already-synced path can read as a deletion server-side.
