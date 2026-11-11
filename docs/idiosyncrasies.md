---
summary: Things in this repo that look wrong but are deliberate: MCP lazy tools, validator tiers, mounts, SMART devices, restart policy, WAL sender.
kind: living
status: current
read-when: Something looks wrong, duplicated or over-complicated and you are about to change it.
---

# Intentional quirks and non-obvious decisions

Moved verbatim from `AGENTS.md` on 2026-11-11 so the router stays small. Add each new quirk here, never in `AGENTS.md`.

### Seven MCP tools expose a 132-definition registry

Looks like:
Most NAS tools are missing because MCP `tools/list` shows only seven.

Actually:
`tool_search`, `get_capability_details`, and `invoke_tool` lazy-load enabled
definitions from `packages/shared/src/nas-tools.ts`.

Why:
Eagerly loading every schema consumed roughly 50k tokens per client session.

Do not change because:
Registering every definition eagerly recreates the context and reliability problem.

### A NAS command refusal is not MCP session degradation

Looks like:
A command works early in a session but a later blocked command means NAS MCP has
degraded or reached a 10-to-15-call limit.

Actually:
The two historical 10-to-15-call failures were fixed by the seven-tool lazy
surface and `Connection: close`. The NAS validator is stateless. A command it
blocks is permanently refused because of that command pattern, regardless of
call count or session.

Why:
The safety validator deliberately blocks dangerous or overly broad commands and
returns an actionable explanation. Retrying the same text or starting a new
session cannot change its classification.

Do not change because:
Do not weaken the validator, raise timeouts, or retry the same command. Preserve
the NAS API summary and choose the bounded alternative it recommends. For active
MCP foundation work, start at the STATUS table in
`plan_mcp-v2-foundations-and-migration.md`.

### Write approval and NAS API classification are separate gates

Looks like:
`write: true` completely enforces write safety.

Actually:
NAS MCP uses it to require preview/confirmation. NAS API independently classifies
the generated shell string into tiers; `run_command` depends on that classifier.

Why:
The two entry paths have different trust boundaries. A 2026-07-16 audit found
mutating commands that classified as read-only.

Do not change because:
Removing either layer reopens unattended write paths. Every new write command needs
builder tests plus real validator tests.

### Tier comes from the declared minimum, not from what the regex can see

Resolved 2026-08-26 (PR #7). This entry used to say the opposite — that `mv`/`chown`
lines must repeat a literal `/btrfs/volumeN/...` path so `ClassifyTier` would rate them
tier 3, and must not be "cleaned up" into a shell variable. That constraint is gone.

Now:
`EffectiveTier(command, toolName)` returns `max(ClassifyTier, declared minimum)`, with
the minimum owned by `apps/nas-api/internal/validator/nas_tool_minimum_tiers.json`
(embedded at build time, generated from the shared registry by
`packages/shared/src/nas-tool-tiers.golden.test.ts`). Both `/preview` and `/exec` use it,
so the rename tools request tier 3 regardless of what the line looks like, and the
tier-2 user-data rejection in `validator.go` cannot fire for them.

Still true:
- An **unknown** tool name fails closed — a new write tool that forgets to declare a
  minimum errors instead of auto-executing at tier 1.
- Free-form `run_command` passes an empty tool name and keeps pure lexical
  classification, deliberately.
- The tier is signed into the v2 exec token along with the tool name, so a caller
  cannot weaken enforcement by editing or omitting either. Old-format tokens are
  rejected, so a mixed nas-api/nas-mcp deployment fails closed for writes — deploy
  both together.

### Per-share mounts are read-only; writes use `/btrfs/volumeN`

Looks like:
A tool receiving `/volume1/share/file` should write that exact path.

Actually:
Per-share NAS API binds are read-only. Guarded writers validate the logical path
and map it to `/btrfs/volume1/share/file`.

Why:
The full Btrfs bind is the explicit writable route for approved operations.

Do not change because:
Writing `/volumeN` fails; widening every share mount to read-write broadens risk.

### There is no ACL-write tool

Looks like:
The removed `repair_path_acl` should be restored with `setfacl`.

Actually:
DSM uses `synoacltool`; `setfacl` is absent and does not model Synology ACLs.
`repair_path_ownership` changes one exact path, resolves NAS principals numerically,
refuses recursion/symlinks, reports ACL mode, and verifies the result.

Why:
The two NASes can expose different ACL modes for equivalent paths.

Do not change because:
An ACL writer is a new, separately designed capability—not a command substitution.

### Domain users must be resolved through DSM, not container-local `id`

Looks like:
`id 'DOMAIN\user'` inside nas-api should prove whether a DSM domain account exists.

Actually:
The nas-api container has its own NSS database. It cannot see DSM's live domain
users, so the old `inspect_effective_permissions` implementation falsely reported
active accounts such as `IML\mzabo` as missing on both NASes.

Why:
DSM's SMBService/winbind daemon is the authoritative identity source. The nas-api
entrypoint exposes its host socket through the existing read-only `/host/proc`
bind. The tool uses `wbinfo` for the UID and complete group list, then `setpriv`
plus `synoacltool -check` to measure actual path permissions under those numeric
credentials. Local DSM accounts retain a read-only `/host/etc/pass??` and
`/host/etc/group` fallback.

Do not change because:
Returning to container-local `id`, `getent`, or name-based `synoacltool -get-perm`
recreates the false “user not found” result. If winbind is unavailable, report an
identity-service failure loudly; never infer that the DSM account does not exist.
Regression coverage is in
`packages/shared/src/inspect-effective-permissions.test.ts`.

### Block devices need `devices:`, not `volumes:` — and SMART needs `SYS_RAWIO`

Looks like:
`- /dev/sda:/dev/sda:ro` under `volumes:` gives the container access to the disk,
and `privileged: true` (edge1 until 2026-07-17) is a gratuitous over-grant to remove.

Actually:
A device under `volumes:` mounts the node WITHOUT a device-cgroup allow rule, so
`smartctl`/`hdparm` get EPERM and SMART monitoring silently fails — the repo file and
edge2 both shipped this bug, and edge2's SMART was dead without anyone noticing. Block
devices must be under a `devices:` key (which grants node + cgroup). And on the DSM 4.4
kernel `smartctl -a -d scsi` needs `CAP_SYS_ADMIN` **plus** `CAP_SYS_RAWIO` (LOG SENSE
hits SG_IO EPERM without RAWIO — proven with a zero-restart disposable-container test);
`SYS_ADMIN` alone is not enough for SCSI SMART but IS what the NVMe admin ioctl needs.
NVMe nodes are **character-major 250** — a block-major cgroup rule would miss them, so
they must be listed explicitly (`/dev/nvme0`, `/dev/nvme1`, + namespaces on edge1).

Why:
Both NASes now run `privileged: false` with `cap_add: [SYS_ADMIN, SYS_PTRACE, SYS_RAWIO]`
and an explicit read-only `devices:` list (verified live 2026-07-17). `privileged: true`
had been masking the whole thing on edge1. Full record: `docs/nas-privilege-hardening.md`.

Do not change because:
Reverting to `volumes:`-mounted devices silently kills SMART; dropping `SYS_RAWIO`
silently kills SCSI SMART; a correct `devices:` list also couples a dead/pulled disk to
container start-up (loud by design — remove the line for a removed bay). Prove any change
against `check_smart_detail` on a real `/dev/sdX` and `/dev/nvme0`, not a container that
merely starts.

### Validator hard-blocks match a tool's own error prose

Looks like:
Quoting a path in a built command is enough to keep it clear of the validator.

Actually:
Two permanent, every-tier blocks in `validator.go` match the raw command STRING with no
quote-stripping, so a write tool's own echoed error/remediation text can get that tool's
command rejected: `\bpasswd\s+\S` (meant for `passwd <user>`) matches any mention of the
account FILE followed by whitespace — and since `buildCommand` joins lines with `\n`, a
bare trailing `... /host/etc/passwd` matches via the next line; and
`strings.Contains(cmd, "docker compose")` blocks any command whose text names the compose
command, including inside an echoed hint. `repair_path_ownership` dodges the first by
globbing (`/host/etc/pass??`); remediation prose must say "recreate via DSM Container
Manager", never name the compose command.

Why:
Both fired while building the ownership tools. Pinned by
`TestPasswdBlockDoesNotCatchAccountFileReads` and `TestRemediationProseIsNotSelfBlocking`.

Do not change because:
A tool that type-checks can still be dead-on-arrival at the NAS. Run any new built
command through `IsHardBlocked`/`ClassifyTier` before trusting it.

### `strace`/`hdparm` needed the binary, not the cap — and `-t` still needs `IPC_LOCK`

Looks like:
`hdparm_device_info` and `strace_process` are enabled, so they work; or (the previous
note here) both are equally fixed by adding the apt package.

Actually:
Both were enabled but dead because `strace` and `hdparm` were absent from
`apps/nas-api/Dockerfile` — the same class as the removed `setfacl` tool. Both binaries
are now installed and BOTH TOOLS ARE ENABLED. Proven on edgesynology1 2026-07-17 with
disposable containers using the LIVE cap set (`SYS_ADMIN`, `SYS_PTRACE`, `SYS_RAWIO`,
`privileged: false`): `strace -c` returns a real syscall-count summary, and `hdparm -I`
returns full ATA identity (model/serial/firmware/transport). One partial limitation:
`hdparm -t` (buffered-read throughput) prints `mlock() failed on timing buf` and NO
number, because it needs `IPC_LOCK`, which is not granted. `hdparm -I` is unaffected.

Why:
`SYS_RAWIO` is what makes `hdparm -I` work, and it is ALREADY granted live (added by the
privilege hardening). Do not reason about caps from
`deploy/synology/docker-compose.nas-{1,2}.yml` — that file is DRIFTED and still lists only
`SYS_ADMIN`/`SYS_PTRACE`, so it understates the live grant and led one session to wrongly
conclude hdparm was unfixable and disable it. Read the live set with
`docker inspect -f '{{.HostConfig.CapAdd}}' synology-monitor-nas-api`.

Do not change because:
Dropping either binary re-breaks a tool that is advertised as enabled. The `/dev` device
mounts are for `smartctl` (smartmontools) FIRST — it is the consumer that would silently
lose SMART if they regress — and hdparm second. To make `hdparm -t` produce a number, add
`IPC_LOCK` to `cap_add`; that is a compose change (Watchtower ships images, not caps) and
belongs to the drift-reconciliation task in `docs/nas-config-drift.md`, not to an image
rebuild. Apply the four-point check before trusting any tool: binary in the Dockerfile?
path/device on an accessible mount? caps and identifiers resolve in the container? proven
by one real run? `write: true` and "enabled" check none of these.

### Watchtower cannot apply compose changes

Looks like:
Pushing a compose edit updates the NAS automatically.

Actually:
Watchtower replaces images only. The live NAS file is
`/volume1/docker/synology-monitor-agent/compose.yaml` and is a manual copy of
`deploy/synology/docker-compose.nas-{1,2}.yml`.

Why:
No workflow distributes NAS compose files.

Do not change because:
New mounts, capabilities, and env keys require a deliberate one-time compose
recreation on each NAS. Preserve each NAS's `.env` and local compose differences.
There is no sync mechanism and the two NAS files have genuinely diverged (line
endings, restart policy, device lists); reconciliation is designed in
`docs/nas-config-drift.md` (a generator emitting two byte-exact per-box files) but
not yet built. Do NOT copy `deploy/synology/docker-compose.nas-{1,2}.yml` onto a NAS as-is
— it still lists `/dev/sdf–sdh` absent on edge2 and would fail `compose up`.

### The two monitor services now use `restart: always`

Looks like:
`unless-stopped` (the repo default) is the policy for every service.

Actually:
As of 2026-07-17 `synology-monitor-agent` and `synology-monitor-nas-api` are
`restart: always` on BOTH NASes — set live via `docker update` (no recreate) and
persisted in each NAS compose. `always` returns the monitoring control-plane after a
NAS/Docker restart even if it was previously recorded as stopped; `unless-stopped`
preserves a stopped state across a daemon restart, and edge1's prior `on-failure:10`
gave up after 10 failures and did not cover daemon restarts. (seaf-cli/watchtower keep
their existing policies.)

Why:
A control-plane that stays down after a reboot is worse than one that resurrects. Note
a related reachability trap: `192.168.3.101` (edge2's LAN IP) is NOT reachable from the
`hetz` VPS — a refused connection there is not evidence a NAS is down. Reach the NASes
by Tailscale (`100.107.131.35` / `100.107.131.36`) or the MCP.

Do not change because:
Reverting the two monitors to a policy that can stay stopped reintroduces the
silent-outage risk. A deliberate `docker stop` will not survive a daemon restart under
`always` — that trade-off is accepted for the monitors.

### Agent WAL sender isolates bad rows

Looks like:
One Supabase insert failure should fail the whole batch.

Actually:
The sender bisects a rejected batch and quarantines the bad row so good telemetry
continues draining.

Why:
A single schema/type mismatch previously froze ingestion silently.

Do not change because:
Whole-batch retry recreates an unbounded backlog.

More component-level constraints are in `docs/architecture.md`; operational traps
are in the relevant incident or subsystem document.

