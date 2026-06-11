# Archive Move — First Live Validation Runbook

Last updated: 2026-06-07

This is the **operator runbook for the first real-data test** of the archive-move
feature (Phase 2). The move logic is fully unit-tested on temporary files, but the
real Btrfs snapshot + same-subvolume rename path can only be proven on an actual
Synology share. Do this once, on a small low-risk share, before trusting it on
anything important.

The whole flow is driven from the **Archive Move** page in the dashboard
(`mon.designflow.app` → sidebar → *Archive Move*). Every step that writes to your
files requires an explicit confirmation, and the move is reversible.

---

## 0. Before you start (one-time prerequisites)

1. **The jobs mount is applied.** On each NAS you should already have run
   `cd /volume1/docker/synology-monitor-agent && docker compose up -d` once (the
   Phase 1 step). If the Archive Inventory page works without a "mount not present"
   banner, you're good.
2. **`NAS_API_NAME` is set** in each NAS `.env` (`edgesynology1` / `edgesynology2`).
   Confirm: the Archive Inventory page can start a scan without a 403.
3. **The new images are live.** After the Phase 2 push, Watchtower needs ~5 min to
   pull the new `nas-api` image on each NAS. Confirm `GET /health` responds and the
   Archive Move page loads.

No new mount or env is needed for Phase 2 — moves use the existing read-write
`/btrfs/volume1` mount.

---

## 1. The archive targets (this project)

The only data the owner wants archived is:

| # | Share (UI dropdown) | Scope ("Limit to sub-folders") |
|---|---|---|
| 1 | `styleguides` | whole share (leave the box empty) |
| 2 | `mac` | select `Decor/character licensed` and `Decor/generic decor` in the folder browser |

**Do not archive any other share** (Coldlion in particular is out of scope).

There is **no throwaway share to practice on**, so validate carefully on these real
targets. This is safe because **Plan is always read-only**, and the first real
**Execute is proven with a Rollback before any keep-move** (sections 3–6). Suggested
order for the very first run: do the smaller target (the two `mac/Decor`
sub-folders, or even just one of them) end-to-end including the rollback, then —
once proven — run the real keep-moves.

Notes / gotchas:
- **Folder names are case- and space-sensitive on the NAS.** If a Plan returns
  **0 files**, the path or capitalization is wrong — check the exact names on the
  NAS (is the share `mac` or `Mac`? is the folder `Decor`? are the sub-folders
  lowercase `character licensed` / `generic decor`?). Fix the scope and re-plan.
- Use **Browse `<share>`** under "Limit to sub-folders" to expand the directory
  tree and tick the exact folders. The text box is still editable for paste/manual
  fallback; spaces inside folder names are fine.
- For **move** mode, pick a **cutoff year** that matches what "old enough to
  archive" means for these folders. The cutoff is exclusive: `2022` means files
  modified before 2022. Run an **Archive Inventory** on the share first to see the
  per-year file counts before choosing.
- If file modified dates are known to be wrong, tick **Force archive selected
  sub-folders despite file dates**. This requires a selected sub-folder scope and
  ignores the cutoff year only; the optional "never archive files newer than"
  safety date still applies.

---

## 2. Plan (dry-run — nothing is moved)

1. On **Archive Move**, set NAS → share → mode **"Move old files into Archive"**.
   For a limited scope, click **Browse `<share>`**, expand the folder tree, tick
   the sub-folders, then set the cutoff year (and optionally a "never archive
   newer than" date).
2. Click **Plan (dry-run)**. The job goes `planning → planned`.
3. **Review the plan:**
   - Check the **planned / skipped** counts look sane and small.
   - Check the planned folder-cleanup line. Artifact files/folders are known
     metadata (`.DS_Store`, `Thumbs.db`, `@eaDir`, `.SynologyWorkingDirectory`)
     that will be removed only when their parent folder is otherwise empty.
   - Read the **manifest preview** (and click **report** to download it). Each
     `[file]` row shows `rel_path → Archive/rel_path`. Confirm the destination
     paths are under `<share>/Archive/` and the file list is what you expect.
   - Any row marked `skipped(collision)` means a file already exists at the
     destination — those are never overwritten.

✅ **Checkpoint:** Plan is read-only. If anything looks wrong, just change the
rules and re-plan. Nothing has been touched.

---

## 3. Execute (this writes to your files)

1. Tick **"I reviewed the plan."**
2. **Type the share name** (e.g. `Coldlion`) in the confirmation box.
3. Click **Execute move**. Watch the live status:
   - `preflight` → safety gates (same-subvolume test-rename, collision rescan,
     symlink check, snapshot readiness). A failure here stops everything and shows
     a `preflight:` note — read it, fix the cause, re-plan. **No files were moved.**
   - `snapshotting` → a read-only Btrfs snapshot is taken; note the **snapshot id**.
   - `executing` → per-file atomic rename + identity verify, with live progress.
   - `verifying` → confirms each file landed and prunes emptied folders.
   - `complete`.
4. **Confirm the counts:** `moved == verified == planned` and **`failed == 0`**.
   - If `failed > 0`: the run auto-aborts and rolls back the offending file. Read
     the `error`, inspect the manifest, and do **not** proceed until understood.

✅ **Checkpoint — verify on the NAS** (SMB/File Station):
- Files now live under `<share>/Archive/<same folder structure>`.
- Original paths are gone.
- Folders emptied by the move are removed; folders that still hold other files are
  left intact.

---

## 4. Confirm sync tools skip `Archive/`

The point of the move is to stop sync tools from traversing archived data.

- Read the job's **sync exclusion** note.
- **Resilio:** if a `.sync/IgnoreList` exists on the share, `Archive` was appended
  automatically — confirm it. Otherwise add `Archive` to the job's IgnoreList /
  selective-sync exclusion manually.
- **Synology Drive ShareSync:** apply the selective-sync exclusion for `Archive`
  in the Drive Admin Console for this team folder (this one is manual).
- Confirm your sync tool is no longer scanning the `Archive` subtree.

---

## 5. Re-verify

Click **Re-verify** (read-only) and download the **verify report**. It should show
`verified` = your moved count and **`missing = 0`, `identity_mismatch = 0`**.

---

## 6. Roll back (prove reversibility)

For this first validation, **roll the move back** to confirm the safety net works:

1. Type the share name again.
2. Click **Roll back this move**. Wait for `rolled_back`.
3. **Confirm on the NAS:** every file is back at its original path, the `Archive`
   folders are emptied/removed, and any folders the move pruned have been recreated.

✅ If rollback restores the original state exactly, the system is proven on real
data.

---

## 7. For a real (kept) move

Once you trust it, run a real move the same way (steps 2–5) and **do not roll
back**. Then:

- **Drop the snapshot** to reclaim space once you're confident the move is good.
  The snapshot lives at `/volume1/@archive_move_snapshots/<job_id>`. Remove it via
  the Synology Container Manager terminal / DSM SSH:
  ```sh
  sudo btrfs subvolume delete /volume1/@archive_move_snapshots/<job_id>
  ```
  (Snapshots are the last-resort recovery; keep one until you're sure, then delete
  it so they don't accumulate.)

---

## Inspecting job state directly (optional)

All job state is on the NAS under the durable jobs mount:

```
/volume1/docker/synology-monitor-agent/nas-api-jobs/archive-move/<job_id>/
  status.json        # the job record (status, counts, snapshot id)
  manifest.jsonl     # every file move + directory removal, with per-row status
  move-report.csv    # nas,share,planned,moved,verified,skipped,failed,bytes_moved,dirs_pruned
  verify-report.csv  # nas,share,verified,missing,identity_mismatch
  preflight.json     # per-gate pass/fail
```

These are read-only inventory/audit data and safe to inspect or copy.

---

## Abort / recovery quick reference

| Symptom | What it means | What to do |
|---|---|---|
| `preflight_failed` | A safety gate failed **before any move** | Read `preflight:` note; fix cause; re-plan. Nothing moved. |
| `failed`, `failed > 0` | A file's identity didn't match after rename | That file was auto-rolled-back and the run aborted. Inspect manifest/error; do not retry blindly. |
| Run `interrupted` (NAS restarted mid-move) | Container recreated during execute | Re-run **Execute** to resume (already-moved files are skipped), or **Roll back**. |
| Move looks wrong after completion | — | **Roll back** (restores original state from the manifest). The Btrfs snapshot is the last-resort fallback. |

**Golden rule:** always Plan and review first; never skip the manifest review; keep
the first run tiny; roll back the first run to prove it before trusting a real move.
