# NAS nas-api privilege & device hardening — plan

**Status:** DRAFT — proceed only after the open questions below are closed. Nothing here has been
applied. edgesynology1 is fully working today and must not be de-privileged on a theory.

**Goal:** converge both NASes' `nas-api` container on a **non-privileged** configuration that keeps
disk-health monitoring (`smartctl`, incl. NVMe) and the btrfs/archive surface fully working, with the
smallest capability and device footprint. Fix the latent bug that **SMART is already silently broken on
edgesynology2**, and correct the repo so it is true for the first time.

## Why this exists (evidence, all measured live 2026-07-17)

| | edgesynology1 | edgesynology2 |
|---|---|---|
| `privileged` | **true** | false |
| `cap_add` | `[SYS_ADMIN]` (no PTRACE) | `[SYS_ADMIN, SYS_PTRACE]` |
| block devices | `- /dev:/dev` (whole tree, rw) | individual `:ro` under **`volumes:`** |
| device cgroup | `a *:* rwm` (all) | `b/c *:* m` (**mknod only**) |
| `smartctl -a /dev/sda` | **works** (identity) | **`open ... Operation not permitted`** |
| NVMe SMART (`/dev/nvme0`) | **works** (privileged) | n/a (no NVMe seen) |
| restart policy | `on-failure:10` | `unless-stopped` |
| disks present | sda–sdf, nvme0/1, md0–md9 | sda–sde, md0–md7 |

Root cause of edge2's failure: a device node bind-mounted via compose **`volumes:`** does *not* create a
device-cgroup allow rule — only the compose **`devices:`** key (or `privileged`) does. So edge2 can see
the node but the cgroup denies `open()`. edge1 "works" only because `privileged` grants `a *:* rwm` plus
every capability.

Two dead ends found on the way, both to be corrected in the repo:
- **`hdparm` is not in the image** (`apps/nas-api/Dockerfile` installs `smartmontools`, not `hdparm`).
  `hdparm_device_info` is an enabled tool that can never work, and the repo comment claiming the 12
  device mounts are "required for hdparm" is false. Same failure class as the removed `setfacl` tool
  (§12). Remove or fix the tool; correct the comment.
- The repo's device list (`sda–sdh`, `md0–md3`) is wrong for **both** boxes: edge2 has no `sdf–sdh`
  (so `compose up` would fail on a missing bind source), and both boxes have `md` devices above `md3`.
  There is no single correct list — it is per-NAS.

## Confirmed design decisions (from the Kimi K3 review, where it was right)

1. **Keep `SYS_PTRACE`, and add it to edge1.** edge1 currently lacks it, so `strace_process` is
   presumably broken there today. The unified cap set includes it.
2. **Do not narrow edge1 to "match edge2."** edge2's config is the broken one. The target is a *third*
   config that both converge on: non-privileged + `devices:` + the right caps.
3. **Include the disk-access capability from the start, not via two production recreates.** Each
   `compose up -d nas-api` is a brief control-plane outage; discover the cap set on paper / on edge2,
   then apply once per box. (Which cap — see OPEN QUESTION 1.)
4. **Add `/dev/nvme*` to the device list.** edge1 has working NVMe SMART (Seagate IronWolf 1TB) that
   survives today only because it is privileged; a `devices:` list of just `sd`/`md` would silently
   blind NVMe health when edge1 goes non-privileged. *(New finding, post-Kimi — Kimi wrongly assumed
   there were no NVMe devices.)*
5. **Verify more than SMART after each change.** The unified config must not regress btrfs
   (`btrfs subvolume list`, snapshot list, scrub status) or the archive-inventory endpoints, or
   `strace_process` (ptrace). Test matrix below.
6. **Pre-capture `docker inspect` JSON** of the running nas-api on each box before touching it — not
   just the compose file — so exact runtime state can be restored even if compose semantics bite.
7. **Live-first, per-box, not repo-first.** Device lists differ per box; the repo file can't even
   `compose up` on edge2 as written; and Watchtower never applies compose changes anyway. The repo
   gets the canonical *shape* (the `devices:` key, the cap set, a comment to regenerate the list from
   `ls /dev/sd? /dev/md* /dev/nvme*` on the NAS), applied by hand per box.

## Rollout (edge2 first — its SMART is already broken, so it is the safe place to prove the config)

Ordering principle: **the working box (edge1) changes only after the replacement config is proven on the
already-broken box (edge2).**

**Step 0 — capture baseline (both boxes, read-only).**
- Save `docker inspect synology-monitor-nas-api` JSON and the current `compose.yaml` to a dated backup.
- Record the current SMART/btrfs/archive tool results as the "before" (edge2 SMART fails; that is the
  signal we expect to flip).
- Check `nas_logs` / schedule-result rows for edge2's nightly disk-health commands to size the blast
  radius of the silent SMART outage (how long it has been failing).

**Step 1 — edge2 to the target config.**
- Back up `compose.yaml` (dated).
- Replace the nas-api block-device declaration: move the disks from `volumes:` to a compose **`devices:`**
  key for the devices that actually exist on edge2 (`sda–sde`, `md0–md7`; add `nvme*` if present),
  read-only.
- Set caps to the agreed set (see OPEN QUESTION 1) — at minimum `[SYS_ADMIN, SYS_PTRACE]`, plus the
  disk-access cap if required.
- `docker compose up -d nas-api` only. Confirm agent/seaf-cli/watchtower did NOT restart.
- Run the **verification matrix** (below). The decisive pass: `smartctl -a /dev/sda` returns a real
  serial instead of EPERM.

**Step 2 — edge1 to the same config, dropping privileged (only if Step 1 fully passes).**
- Back up compose + inspect JSON.
- Apply the same shape with edge1's real device list (`sda–sdf`, `nvme0/1`, `md0–md9`); add
  `SYS_PTRACE`; **remove `privileged: true` and the `- /dev:/dev` mount.**
- `docker compose up -d nas-api`. Run the full verification matrix — SMART (SATA + NVMe), btrfs,
  archive, strace. If anything regresses, one-command rollback to the backup.

**Step 3 — repo.**
- Rewrite `deploy/synology/docker-compose.agent.yml` nas-api to the canonical shape: `devices:` key,
  agreed caps, no privileged, no whole-`/dev`. Comment that the device list is per-NAS and how to
  regenerate it. Remove/fix the dead `hdparm` tool and its false "required for hdparm" comment.
- Update AGENTS.md §12 (the `/dev` quirk rationale is now the cgroup explanation, not hdparm) and §15
  if the SMART outage warrants an incident note.
- Never auto-apply; the operator runs `docker compose up -d` per NAS by hand.

## Verification matrix (run after each box's change)

| Surface | Command (inside nas-api) | Pass = |
|---|---|---|
| SATA SMART | `smartctl -a /dev/sda` | real serial/identity, not EPERM |
| SATA SMART, all disks | `smartctl -a` on each `sd*` | identity on every disk |
| NVMe SMART | `smartctl -H -i /dev/nvme0` (edge1) | model/serial/health |
| SMART self-test (write tool) | `smartctl -l selftest /dev/sda` (and, if acceptable, `-t short`) | no EPERM — see OPEN QUESTION 1 re `:r` vs `:rw` |
| btrfs | `btrfs subvolume list`, snapshot list, scrub status | unchanged from before |
| archive | `/jobs/inventory` endpoint health | unchanged |
| ptrace | `strace_process` on a live pid | works (esp. edge1, newly gains PTRACE) |
| cgroup proof | `docker inspect -f '{{.HostConfig.Devices}}'` | populated (was `[]`) |

## APPLIED & VERIFIED LIVE — both NASes, 2026-07-17

Both boxes now run `privileged: false`, no `/dev:/dev`, `cap_add: [SYS_ADMIN,
SYS_PTRACE, SYS_RAWIO]`, and an explicit read-only `devices:` key. Only nas-api was
recreated on each; agent/seaf-cli/watchtower untouched. Restart policy left as-is
(operator decision, still open — edge1 `on-failure:10`, edge2 `unless-stopped`).

Proven with zero-restart disposable containers FIRST, then applied and re-verified via
the MCP:
- **edge2** (was `privileged:false` but devices under `volumes:` → no cgroup access →
  SMART was silently broken): `check_smart_detail /dev/sda` went from `Operation not
  permitted` → full device identity (Serial TEG4TX4Z, 26TB). Fixed.
- **edge1** (was `privileged:true`): de-privileged. `check_smart_detail /dev/nvme0`
  returns full NVMe health — overall-health **PASSED**, 31°C, 13% used, 0 media errors.
  SCSI `/dev/sda` reads Serial T5G870JD. Both work with the 3 caps, no privileged.
- Cap empirical result (DSM 4.4 kernel, disposable-container test): `SYS_RAWIO` **is**
  required for the SCSI `smartctl -a -d scsi` path (LOG SENSE hits SG_IO EPERM without
  it) — Kimi's conclusion, reached via Codex's test method. `SYS_ADMIN` alone is NOT
  sufficient for SCSI SMART, but IS what the NVMe admin ioctl needs. NVMe nodes are
  char-major-250 and had to be listed explicitly.

Backups on each NAS: `compose.yaml.bak-devrawio-*` (edge2),
`compose.yaml.bak-deprivilege-*` (edge1). Rollback = restore backup + `docker compose
up -d nas-api`.

### Two more "enabled tool, missing binary" bugs found while verifying (like setfacl, § 12)
`strace_process` and `hdparm_device_info` are both **enabled** but their binaries
(`strace`, `hdparm`) are **not in `apps/nas-api/Dockerfile`**. `hdparm_device_info`
never worked on either box; `strace_process` returns `strace: No such file or
directory` even now that `SYS_PTRACE` is present. SYS_PTRACE is kept regardless — it is
declared by design for `strace_process`; the fix is adding `strace` to the image (plus
`hdparm`, or dropping/​disabling the tool), not removing the cap. Filed as a follow-up.

### Repo drift NOT yet reconciled
`deploy/synology/docker-compose.agent.yml` still declares devices under `volumes:` and
lists `/dev/sdf–sdh` (nonexistent on edge2) — it would break BOTH boxes if applied. The
proven config above must be back-ported to the repo (per-box device lists) before any
repo→NAS sync. Separate step; not done here.

## Resolved design (Kimi K3 + Codex/GPT-5.6 reviews, adjudicated against live evidence)

**Target unified nas-api config, both boxes:** `privileged: false`, no `- /dev:/dev`,
`cap_add: [SYS_ADMIN, SYS_PTRACE]` (+`SYS_RAWIO` only if the test below demands it), block/char devices
via an explicit read-only `devices:` key enumerating the disks that actually exist on that box.

1. **CAP_SYS_RAWIO — probably NOT needed; settle it with a zero-restart test before deciding.**
   Kimi assumed RAWIO on an ATA-pass-through premise, but the disks run the **`-d scsi`** path, whose
   opcodes (INQUIRY, LOG SENSE, MODE SENSE, READ CAPACITY, …) are on Linux 4.4's *unprivileged* SCSI
   safe-list — so once the device-cgroup lets `open()` succeed, `smartctl -a -d scsi` should work with no
   RAWIO. DSM may carry kernel patches, so **test empirically with a disposable container — zero
   production restarts, does not touch the running nas-api:**
   ```sh
   # on the NAS, as root. Reads a real disk via a throwaway container.
   docker run --rm --device /dev/sda:/dev/sda:r \
     ghcr.io/u2giants/synology-monitor-nas-api:latest \
     smartctl -r ioctl,2 -a -d scsi /dev/sda
   # if that returns ioctl-level EPERM, re-run adding: --cap-add SYS_RAWIO
   ```
   First succeeds → cgroup was the only gap, omit RAWIO. First EPERM, second OK → DSM needs RAWIO, add
   it. Both fail → not a RAWIO issue, inspect the opcode/errno. Decide the cap set from the result; do
   NOT grant RAWIO blindly.
2. **NVMe — keep it working when edge1 de-privileges.** NVMe SMART works on edge1 today only via
   privileged. The admin ioctl is gated by `SYS_ADMIN` (already present), NOT RAWIO. But the nodes are
   **character devices, major 250** (verified: `stat /dev/nvme0` → `major=fa`), so a block-major rule
   would miss them entirely — they must be listed explicitly: `/dev/nvme0:/dev/nvme0:r`,
   `/dev/nvme1:/dev/nvme1:r` in edge1's `devices:`.
3. **SYS_PTRACE — KEEP, and add to edge1.** (Codex suggested dropping it; that was wrong — it hedged
   "unless a feature needs it," and `strace_process` is an *enabled* tool whose description states
   "Requires CAP_SYS_PTRACE.") edge1 lacks it today, so `strace_process` is broken there; the unified
   config fixes that.
4. **Device set — explicit enumeration, read-only. No major-number rules, no sg nodes.** Both reviewers
   (and the char-major-250 NVMe finding) reject `device_cgroup_rules` by major: it over-grants, doesn't
   materialize the node, and misses NVMe. `devices:` creates the node AND the cgroup rule. sg nodes are
   not needed — edge1's working smartctl uses `/dev/sdX -d scsi`, and mdadm doesn't need `/dev/sgN`.
   Enumerate the *actual* `sd*`/`md*`(/`nvme*` on edge1) present on each box, not a range.
   - edge1: `sda–sdf`, `md0–md9`, `nvme0`, `nvme1`
   - edge2: `sda–sde`, `md0–md7`
5. **Restart policy — DECISION FOR THE OPERATOR (flagged, not bundled).** Codex recommends converging
   both to **`always`** so the remediation control-plane returns after a NAS/Docker restart even if it
   was previously recorded as stopped (`unless-stopped` preserves a stopped state across a daemon
   restart; `on-failure:10` doesn't cover daemon restarts and gives up after 10). Trade-off: with
   `always`, a deliberate `docker stop` won't survive the next daemon restart. The repo currently uses
   `unless-stopped`. **This diverges from the repo default — Albert picks; I do not change it silently.**
