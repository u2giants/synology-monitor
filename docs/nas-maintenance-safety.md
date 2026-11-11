---
summary: Rules for direct NAS maintenance over SSH, and the four traps when moving or merging files inside a share.
kind: ops
status: current
read-when: Before any SSH session on a NAS, or any move, merge or permission change inside a share.
---

# Direct NAS maintenance safety

Moved verbatim from `AGENTS.md` on 2026-11-11 so the router stays small. 

- Use SSH aliases `edgesynology1` and `edgesynology2` (user `ahazan`; edge2 SSH is on
  port **1904**, in `~/.ssh/config`); do not hand-build addresses.
- **As of 2026-11-08, sudo on edge2 (and edge1) asks for a password** — the SSH alias logs in as `ai`; feed the `edgesynologyN NAS - ai service account` 1Password login to `sudo -S` via 1Password `op_run`, never on the command line. Historical note: `ahazan` had passwordless sudo for `/usr/bin/python3` ONLY (`(ALL) NOPASSWD:
  /usr/bin/python3` on both NASes — effectively passwordless root). Plain `sudo docker`,
  `sudo sed`, `sudo cp` HANG on a password prompt with no answer available. Do every
  privileged action as `sudo -n /usr/bin/python3 -c '...'` — edit files with Python I/O,
  run docker via `subprocess`. `docker` is at `/usr/local/bin/docker` (also
  `/var/packages/ContainerManager/target/usr/bin/docker`), not on `ahazan`'s PATH.
- Change compose/containers backup-first and one service at a time
  (`docker compose up -d nas-api`, never a bare `up -d` which recreates everything).
  Restart policy can be changed live with `docker update --restart=...` (no recreate).
- `scp`/sftp is disabled on the NASes; move file contents with `base64` over `ssh`.
- Note edge1's compose is LF and edge2's is CRLF — a `sed` tuned for one silently
  matches nothing on the other. Re-measure before editing either.
- For metadata-heavy reads use `/opt/bin/ionice -c3 nice -n 19 <command>`.
- Avoid large crawls, recursive ownership changes, archive moves, or timestamp work
  while SMB users are active.
- For cross-NAS timestamp repair, use `edgesynology2` as evidence and write only
  `edgesynology1` unless the operator explicitly authorizes both.
- Timeout means the route/host may be unreachable; connection refused means the
  host answered but no service listens. Check DSM and `docker ps -a` before calling
  a NAS down.

### Moving or merging files inside a share — four traps that have already caused damage

Tooling: [`scripts/synology/`](../scripts/synology/) (merge, conflict resolver, collision
scanner, 55 tests that run without a NAS). Read its README before reusing any of it.
Work order for the unfinished share-wide pass: [`docs/synology-fileserver-audit.md`](synology-fileserver-audit.md).

1. **The filesystem is case-sensitive; every client syncing it is not.** Btrfs holds
   `PPS photos` and `PPS Photos` in one folder; macOS/Windows cannot. Synology Drive
   resolves it by renaming one side to `*_Conflict` and pushing that to everyone.
   Never build a destination path from a string — resolve each component against
   what already exists (`nas_resolve_path`). A merge that compared paths
   case-sensitively created 63 conflict artifacts in a single run.
2. **`chmod --reference` silently destroys permissions on DSM.** DSM's `chmod` does
   not support the flag; it parses `--reference=/path` as a *symbolic mode* whose
   leading `-` removes bits, then **exits 0**. It made 66 directories `d---------`
   while reporting success. Read the mode with `stat -c %a` and apply it literally.
   Generalise: on DSM an unsupported flag may not fail — it may do something else
   and claim success.
3. **Btrfs snapshots do not recurse into nested subvolumes.** Each share is its own
   subvolume and `/btrfs/volume1` is already `@syno`. `btrfs subvolume snapshot -r
   /btrfs/volume1 …` produces a recovery point containing **none of your shares**.
   Snapshot the share: `/btrfs/volume1/mac`. Always verify by counting files inside
   the snapshot before trusting it. Delete with `btrfs subvolume delete`, never `rm -rf`.
4. **A `*_Conflict` artifact is not necessarily junk.** It can be a divergent copy
   holding the ONLY instance of real content. Resolving 21 artifacts in one folder
   on 2026-07-17 *recovered* 81 files, including an October 2025 product photo shoot
   whose live SKU folders were empty. Merge conflict directories; never bulk-delete them.

Also: `/volume1/mac/Decor/Character Licensed` and `/volume1/mac/Art Library` are
**seaf-cli worktree roots** — writes there sync to the Seafile server on Linode.
Compare content before rewriting a file; an mtime-only merge would have rewritten
284 byte-identical files (29.6 GB) for nothing. Never "hide" an already-synced folder
via `seafile-ignore.txt` — ignoring a synced path can read as a deletion server-side.

