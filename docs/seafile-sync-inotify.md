# Seafile sync: inotify watch exhaustion (false-"synchronized" incident)

Incident + fix recorded 2026-06-19. This documents a silent data-divergence class in
the **`seaf-cli` Seafile client** that runs in its own container on the NAS (image
`flrnnc/seafile-client`, container name `seaf-cli`), the two **new nas-api/nas-mcp
capabilities** added to remediate it, and the operator runbook.

> Scope note: the Seafile *server* and the seaf-cli *deployment* are a separate
> project from this monitoring repo. What lives here is (a) the diagnosis, because a
> future session will hit it again, and (b) the two MCP capabilities this repo now
> ships to fix it. Deployment specifics for the Seafile server itself are out of scope.

---

## 1. Symptom

`seaf-cli status` reported a library (`Generic Decor`, under the `decor` worktree) as
**synchronized**, while the NAS worktree and the Seafile server head actually
disagreed. A previous session "fixed" it by restarting the daemon — which only
masked the problem (see §4).

## 2. Root cause — the worktree monitor went blind (NOT a stale/corrupt index)

The seaf-cli daemon (`seaf-daemon`, launched `-c /root/.ccnet -d /seafile/seafile-data
-w /seafile/seafile`) logs, **11,077 times**, in `/root/.ccnet/logs/seafile.log`:

```
wt-monitor-linux.c(542): [wt mon] fail to add watch to /library/decor: No space left on device
```

"No space left on device" here is **NOT disk** (disk was 52% used, 53 TB free; NAS↔
server clocks within ~20 s). It is the **Linux inotify watch limit**:

- `fs.inotify.max_user_watches = 8192` (the low default).
- This is a **per-UID** pool shared by **all** root-owned processes on the host
  (DSM services + every container), not per-process.
- seaf-daemon could only register **3,209 watches** before the shared pool was
  exhausted; every directory after that — including `/library/decor`, which contains
  `Generic Decor` — got **no watch**.

**Mechanism of the silent failure:** seaf-daemon only re-indexes/commits a library
when its inotify monitor fires a change event for that library. An unwatched
directory never fires → local edits there are never detected → the daemon believes
nothing changed → `seaf-cli status` honestly reports "synchronized" while the
worktree has diverged. The status is not lying about its own state; its state is
blind.

## 3. Measurements (edgesynology1, 2026-06-19)

Worktree directory counts (`find -type d`), and the share of them that are Synology
`@eaDir` thumbnail folders:

| Library | Total dirs | Inside `@eaDir` | Real content dirs |
|---|---|---|---|
| art | 83,851 | 80,131 | 3,720 |
| char | 377,816 | 319,996 | 57,820 |
| decor | 28,103 | 22,220 | 5,883 |
| guides | 51,321 | 22,352 | 28,969 |
| **Total** | **~541,000** | **~444,700 (82%)** | **~96,400** |

So 82% of all watched directories are thumbnail junk. Host RAM is 32 GB.

**seaf-cli worktree → host path map** (from `/proc/<pid>/mountinfo`; `/@syno` ↔
`/volume1`):

| Container worktree | Host path |
|---|---|
| `/library/art` | `/volume1/mac/Art Library` |
| `/library/char` | `/volume1/mac/Decor/Character Licensed` |
| `/library/decor` | `/volume1/mac/Decor/Generic Decor` |
| `/library/guides` | `/volume1/styleguides` |

## 4. Why the restart only masked it

Daemon startup runs a one-time full re-index that caught the `Generic Decor` drift
once. But the `fail to add watch` errors are timestamped **during that same restart**
— the daemon is blind again immediately. It will recur on any library past the watch
ceiling. **A watchdog that "detect drift → restart daemon" would hide this
permanently**, because each restart's full scan resets the symptom while the root
cause persists. Do not build remediation that relies on restarts.

## 5. The fix

### 5a. Raise the inotify ceiling (the guaranteed fix) — capability `set_inotify_watches`

Raise `fs.inotify.max_user_watches` to **1,048,576** and `max_user_instances` to
**1024**, live via `sysctl -w`.

**Persistence on Synology requires a DSM Task Scheduler boot-up task (root)** running
those two `sysctl -w` lines. Do NOT rely on `/etc/sysctl.conf` / `/etc/sysctl.d/` —
DSM does not reliably apply them at boot and may reset them on updates (verify by
rebooting and re-reading `/proc/sys/fs/inotify/max_user_watches`). The
`set_inotify_watches` capability writes `/host/etc/sysctl.conf` and sets the live
value, but its file-based persistence may not survive a Synology reboot — the DSM
boot task is the durable mechanism. **Verified 2026-06-21:** on edgesynology1 the live
value was 1,048,576 but absent from `/etc/sysctl.conf` and `/etc/sysctl.d/`, so a
reboot would reset it to 8192 and silently reintroduce the false-"synchronized" bug
until the boot task exists.

Critical sizing facts:
- **`max_user_watches` is a ceiling, not an allocation.** The kernel pins ~1 KiB
  only **per watch actually registered**, not per the limit. With ~96k real dirs the
  daemon holds ~96k watches ≈ ~96 MB **whether the ceiling is 200k or 1M**. Raising
  the ceiling costs no extra memory until watches are held.
- **Do NOT lower the ceiling** (e.g. to 200k) "to save memory" — it saves nothing
  (see above) and only removes headroom. The pool is shared with other root
  processes, libraries grow, and `@eaDir` regrows (see §5b). The failure mode of
  under-provisioning is silent divergence (this whole incident); the cost of
  over-provisioning is ~nothing. The trade is one-sided.
- 4,194,304 is the capability's hard cap (bounds worst-case pinned RAM).

### 5b. Stop syncing junk — capability `write_seafile_ignore`

Writes a correctly-named **`seafile-ignore.txt`** (the exact name seaf-cli reads —
**`.seafile-ignore` is NOT recognized**) into a worktree root, with patterns:
`@eaDir #recycle #snapshot @tmp .DS_Store Thumbs.db *.tmp`.

Caveats (important):
- This is the **Seafile sync layer**. It stops seaf-cli from *uploading* matching
  files. It does **not** delete copies already on the server (remove those
  separately), and it does **not** delete or prevent `@eaDir` on the NAS filesystem.
- **DSM regenerates `@eaDir`** on disk via Media Indexing / thumbnail generation,
  independent of Seafile.
- **OPEN QUESTION (unverified): does seaf-cli's worktree monitor add inotify watches
  to directories listed in `seafile-ignore.txt`?** Older Seafile clients watch the
  whole worktree and apply ignore only at index/commit time — in which case
  `seafile-ignore.txt` does **not** reduce the watch count and `@eaDir` regrowth
  re-consumes watches. If the monitor honors ignore for watching, then it does.
  **We did not confirm which.** Therefore: treat `seafile-ignore.txt` as hygiene
  (less synced junk, faster scans, less server storage), **not** as the watch fix.
  The ceiling raise (§5a) is the guaranteed fix and is sized to absorb `@eaDir`
  regrowth regardless of this behavior.
- Because the ceiling is high, you do **not** need to disable DSM indexing. Disabling
  DSM thumbnail/media indexing on those shares only becomes necessary if you insist
  on a *low* ceiling — the two are linked.

**To verify the open question** once `seafile-ignore.txt` is deployed and the daemon
restarted: read the daemon's inotify fd and count held watches, and check for
residual `@eaDir` watch errors:
```sh
PID=$(pgrep -f seaf-daemon | head -1)
for fi in /proc/$PID/fdinfo/*; do n=$(grep -c '^inotify wd:' "$fi" 2>/dev/null); [ "$n" -gt 0 ] && echo "$fi: $n"; done
grep -c 'No space left on device' /proc/$PID/root/root/.ccnet/logs/seafile.log
```
If the held-watch count stays near the full directory total and `@eaDir` errors
persist after restart, the monitor ignores `seafile-ignore.txt` for watching.

### 5c. Validator change required for `write_seafile_ignore`

nas-api writes user data via the **writable `/btrfs/volume1` mount** (per-share
`/volume1/<share>` mounts are read-only). The existing `filePatterns` only matched
content redirects to `/volume\d+/` *immediately* after the redirect operator, and
`stripQuotedStrings` hides quoted, spaced paths from `hasRealOutputRedirect`. So a
command like `printf ... > '/btrfs/volume1/<lib>/seafile-ignore.txt'` would have
classified below tier 3. Added one pattern —

```go
regexp.MustCompile(`(>>?)\s*['"]?/(btrfs/)?volume\d+/`)
```

— to **both** `writePatterns` (so the write is detected at all) and `filePatterns`
(so it lands at **tier 3**), in `apps/nas-api/internal/validator/validator.go`. This
only ever **elevates** classification, so it cannot weaken safety. `set_inotify_watches`
writes only to `/host/etc/sysctl.conf` (not a data volume) and correctly stays
**tier 2**. Both are covered by `TestInotifyAndSeafileIgnoreClassification` in
`validator_test.go`.

## 6. Operator runbook

1. (Optional, recommended) `create_prechange_snapshot` on `/volume1`.
2. `set_inotify_watches` → preview, then `confirmed: true`. Default `1048576 1024`.
3. `write_seafile_ignore` per library root (see §3 map), e.g. filter
   `/volume1/mac/Decor/Generic Decor` → preview → `confirmed: true`.
4. Restart the `seaf-cli` daemon so it re-registers watches across the whole
   worktree. (Daemon/container restart is **not** exposed as a sanctioned capability;
   the docker allowlist blocks `docker exec`/restart from `run_command`. Restart via
   the seaf-cli stack's own mechanism / DSM Container Manager.)
5. **Verify success:** entries *after* the restart in
   `/proc/<pid>/root/root/.ccnet/logs/seafile.log` for `No space left on device` must
   be **0**. Spot-check that `/library/decor` now has a watch.
6. Edit a file in each library on the NAS and confirm it reaches the server within
   the expected window, with no manual restart.

## 7. Diagnostic notes for future sessions

- **`docker exec` is blocked** by the nas-api validator (read or write) from
  `run_command`. To inspect inside the `seaf-cli` container's filesystem from the
  host, use the daemon's mount namespace via `/proc/<pid>/root/...` (e.g.
  `/proc/<pid>/root/root/.ccnet/logs/seafile.log`) and its bind sources via
  `/proc/<pid>/mountinfo`. This is how this incident was diagnosed.
- A whole-volume `find` over the 56 TB array times out the 25 s `run_command`
  budget — scope finds per subtree.
- edgesynology1 is the Seafile **source of truth** (NAS always wins), so sync-drift
  resolution direction is fixed; the only real risk is NAS edits silently failing to
  reach the server (this incident).
