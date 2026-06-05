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

---

# Additional Incidents — Catalogue (Past 2 Months)

The sections above focus on a single investigation cluster: "missing files" that turned out
to be local metadata corruption plus broader Decor tree discrepancies. For completeness, this
catalogue records the **other distinct problems** seen on either NAS in the April–June 2026
window that are not covered above. Each is a separate root cause and is listed with its own
symptom / cause / fix / status. Source of record for the May entries is the
`u2giants/albert-standards` issue history; the two June entries were verified by live
`synology-monitor` MCP inspection.

Quick index:

| # | Incident | Unit(s) | Class | Status |
|---|----------|---------|-------|--------|
| A | Aquantia AQC107 `eth0` driver instability → bond migrated to `eth1`+`eth2` | both | Network / NIC | Resolved (bond on Intel i210 ports) |
| B | `eth2` acquired unexpected DHCP IP `192.168.0.115` | edgesynology2 | Network config | Resolved |
| C | BTRFS `corruption_errs 25` (cumulative counter) | edgesynology2 | Storage / BTRFS | Resolved (not a current concern) |
| D | `/volume1/mac` share root mode `0000` → ShareSync `SynoEAStream` errors | edgesynology1 | Permissions / ShareSync | Resolved |
| E | `IML\eperestrelo` denied access to `styleguides` (Disney/Mickey) | edgesynology1 | Sharing / Drive Team Folder | **Open** |
| F | ShareSync repeated-download / re-index loop on a 204 MB Decor `.tif` | edgesynology1 (peer: edgesynology2) | Sync convergence | **Open** |

---

## Incident A — Aquantia AQC107 `eth0` driver instability; bond migrated off `eth0`

**Units affected:** both (root cause identical on each)
**Date:** identified 2026-05-14
**Status:** Resolved — bond rebuilt on `eth1`+`eth2`; `eth0` excluded

### Symptom
`edgesynology2` `eth1` intermittently showed `NO-CARRIER`; `edgesynology1` `eth0` accumulated a
rising Link Failure Count in `/proc/net/bonding/bond0`. ShareSync `bio error` entries (codes
-1, -2, -3) appeared in `/volume1/@synologydrive/log/syncfolder.log` clustered around the
network-instability events.

### Root cause
The DS1621xs+ has three NICs: one Aquantia AQC107 (`eth0`, 10GbE, `atlantic` driver) and two
Intel i210 (`eth1`/`eth2`, 1GbE, `igb` driver). The `atlantic` driver spontaneously drops link
on `eth0` on **both** units. `dmesg` confirmed repeated `atlantic: link change old 1000 new 0`
cycles. Four brand-new cables were tried and ruled out a physical-cable fault — the link-failure
count kept incrementing during the swaps. The Aquantia chip/driver combination is inherently
unstable on this DSM version.

### Fix applied
`eth0` removed from the bond on both units; bond rebuilt using `eth1`+`eth2` only (both Intel
i210, which are reliable). Done via DSM Control Panel → Network → Bond edit.

### Outcome / notes
The ShareSync `bio errors` correlate directly with the bond link drops, so they should stop once
the bond is stable on the Intel ports. DSM's bond UI hides individual slave failures (it shows
"Connected" as long as one slave is up) — always read `/proc/net/bonding/bond0` directly rather
than trusting the UI.

---

## Incident B — `eth2` acquired an unexpected DHCP IP (`192.168.0.115`)

**Units affected:** edgesynology2
**Date:** 2026-05-14
**Status:** Resolved

### Symptom
`ip addr show eth2` on `edgesynology2` showed `192.168.0.115/22` on a standalone, non-bonded
interface.

### Root cause
`eth2` was configured for DHCP in DSM and had been left uncabled. When a cable was plugged into
it during the bond-migration work (Incident A), it pulled a DHCP lease.

### Fix applied
`eth2` added to the bond — DSM automatically strips the standalone DHCP IP once an interface
becomes a bond slave.

### Outcome / notes
Harmless side effect of the bond work, but worth clearing whenever `eth2` is cabled before it is
enslaved to the bond.

---

## Incident C — BTRFS `corruption_errs 25` on `edgesynology2`

**Units affected:** edgesynology2
**Date:** 2026-05-14
**Status:** Resolved — not a current concern

### Symptom
`btrfs device stats /volume1` reported `corruption_errs 25` on `edgesynology2`.

### Root cause
Old, already-repaired errors. The BTRFS `corruption_errs` counter is **cumulative and never
resets**, even after a scrub repairs the affected blocks. A scrub had completed ~12 hours earlier
with a clean result (no errors found).

### Fix applied
None needed.

### Outcome / notes
The authoritative health signal is the **scrub result**, not the cumulative counter. A non-zero
`corruption_errs` value after a clean scrub is expected and benign. (For reference, the baseline
is `edgesynology1` = 0, `edgesynology2` = 25.)

---

## Incident D — `/volume1/mac` share root at mode `0000` → ShareSync `SynoEAStream` errors

**Units affected:** edgesynology1
**Date:** 2026-05-14
**Status:** Resolved

### Symptom
ShareSync logs showed `mac@SynoEAStream` errors; `/volume1/mac` on `edgesynology1` was
inaccessible.

### Root cause
`/volume1/mac` (the share root) had permissions `0000` and incorrect ownership, which prevented
ShareSync from reading the extended attributes it needs.

### Fix applied
Permissions set to `0777` and ownership set to `1024:users` (matching the healthy state on
`edgesynology2`).

### Outcome / notes
`mac@SynoEAStream` errors cleared. **Related:** this share-root `0000` corruption is very likely
the same failure mechanism as the subfolder `0000` / unresolved-numeric-owner corruption
documented in the "missing files" cluster above (e.g. `PPS Photos`, `_old`) — same unit, same
mode, same `mac` share — just at a different scope and date. The open question of *what process
rewrites this metadata to `0000`* (see Open Questions above) applies to this incident too.

---

## Incident E — `IML\eperestrelo` denied access to `styleguides` (Disney/Mickey)

**Units affected:** edgesynology1
**Date:** investigated 2026-06 (live)
**Status:** OPEN — action proposed but not executed; root cause not fully confirmed

### Symptom
User `eperestrelo` cannot reach content under the `styleguides` Team Folder (specifically
`Disney/Mickey/` and other brand folders). The user is real and Synology Drive did log activity
for them — `eperestrelo` appears in `/volume1/@synologydrive/log/cloud-workerd.log`.

### Investigation findings (live MCP)
- `/volume1/styleguides` is a **Windows-ACL-mode share**. `ls` shows the share root as
  `d---------` (000) and the brand folders as `drwx------` — this is the normal *cosmetic*
  display for an AD-joined ACL-mode share; the **real** permissions live in the Windows ACLs
  (synoacl), not in the POSIX bits.
- Therefore the earlier diagnosis's central inference — "POSIX shows owner-only, so the block must
  be at the Drive Team Folder layer, not the filesystem" — **does not hold**. On an ACL-mode
  share the POSIX bits are not authoritative, so a deny could equally live at the share/ACL layer.
- The earlier diagnosis's specific internals (`styleguides = ViewId 18`; `eperestrelo` has
  `view_id = 51`; ViewId 18 membership = only the `@styleguides` service account) **could not be
  verified**: there is no `psql`/sqlite client on the NAS to read the Drive membership DB, and the
  MCP session degraded before deeper log inspection completed.

### Proposed (unverified) fix
Add `IML\eperestrelo` as a member of the `styleguides` Team Folder in Drive Admin Console →
Team Folder → styleguides → Members (Read-Only or Read & Write per role). This is a reasonable,
low-risk action and matches how Drive Team Folder access works — but because this is an ACL-mode
share, the **actual Windows ACL on the folder should also be checked**, since if the block is at
the ACL layer, adding a Drive member alone will not fix it.

### Open items
- Verify real ACL (synoacl) on `Disney/Mickey` and the `styleguides` root.
- Confirm/deny the ViewId/membership claims via the Drive DB once a tool is available.
- This is an access-control change → must be performed by Albert in the admin console, not by
  the assistant.

---

## Incident F — ShareSync repeated-download / re-index loop on a 204 MB Decor `.tif`

**Units affected:** edgesynology1 (active loop); peer `edgesynology2` (192.168.3.101) and client
`10.0.5.5` are the repeat requesters
**Date:** files created 2026-06-01 ~20:28; loop still active 2026-06-02 21:40 at time of review
**Status:** OPEN — real and active; root cause not yet pinned; earlier proposed fix would NOT
have resolved it

### Symptom
A single file loops endlessly through ShareSync:
`/volume1/mac/Decor/Generic Decor/_New structure/AA1/16x16/AA166MSFSH06/ART/AA166MSFSH06_16x16x1_Printed Canvas w Foil_Chanel Perfume Bottle Gold Heart_ART.tif`
(204 MB, `node 1224283`, `sync_id 1909890`). The file has 7 zero-byte `*_Conflict.tif` siblings
created simultaneously on 2026-06-01 ~20:28 from 7 client machines (DESKTOP-FFV7J81,
DESKTOP-R78HRI5, JESS-ASUS, MSI, PEREGRINE, SANGEL, ZAR-LAPTOP) — a 7-way simultaneous-save
collision.

### Investigation findings (live MCP) — corrects the earlier diagnosis
- The loop is a **download / re-index loop**, not an upload-failure loop. The log shows
  `download-handler` running `PrepareWholeFile ... success` and `Download Done`, immediately
  followed by `<RepeatedDownloadReq> ... re-index it`, repeating roughly every few seconds.
- The earlier diagnosis described an **upload** mechanism (NativeUpload worker, reverse-delta
  failure, whole-file upload failure, "File not modified … fake event"). **None of those strings
  appear in the log for this file** ("fake event", "NativeUpload", "reverse delta", "upload" =
  zero matches). That mechanism is not what is happening.
- The repeat requesters are the **peer NAS** `192.168.3.101` (= edgesynology2) and a client at
  `10.0.5.5`, under user `ahazan (1033)`, `view 'mac' (20)`, `serversync(DiskStation)` — i.e. a
  server-to-server ShareSync convergence problem between the two units plus one client, that never
  settles.
- **The 7 conflict files are referenced ZERO times in the entire log.** They are a *symptom* of
  the same original 7-way save collision, but they are not driving the loop.
- Volume: ~1,178 `RepeatedDownloadReq` events on this one file in a two-hour window (445 in the
  20:00 hour, 733 in the 21:00 hour), still firing at review time.

### Why the earlier proposed fix was rejected
The earlier proposal was "delete the 7 zero-byte `*_Conflict.tif` files and the queue jam will
clear." Since the conflict files are never referenced in the loop and the loop is on the main
`.tif`, deleting the conflict files is reasonable hygiene but has **no evidentiary basis for
stopping the loop**. No deletion was performed.

### Open items / recommended next steps
- Trace `sync_id 1909890` / `node 1224283` to find why this file never converges between the two
  units and the `10.0.5.5` client (index/hash mismatch, or a two-NAS sync ping-pong).
- Note this lives in the same `Generic Decor` tree as the static "70 files missing" comparison
  documented in the June 2026 entry above, but it is a **distinct** problem (a live sync loop on
  one file, not a static old-vs-current diff).
- Any file deletion here must be performed by Albert, not the assistant.
