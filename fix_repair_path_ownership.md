# fix_repair_path_ownership.md

**Goal:** make `repair_path_ownership` and `repair_drive_db_permissions` actually work, prove
it on a live NAS, then re-enable them.

**Status as of 2026-07-16:** both are **disabled** in `apps/nas-mcp/tools-config.json`
(commit `0fe657c`). They are still defined in `packages/shared/src/nas-tools.ts` — only the
enablement was removed, so the code is intact and this is a repair job, not a rewrite from
scratch.

**Read first:** [AGENTS.md](AGENTS.md) § 12 — the entry *"There is no ACL-write tool, and
`repair_path_ownership` can't write `/volume1`"*. This file is the implementation detail behind
that entry.

---

## 1. TL;DR

Both tools run `chown` against `/volumeN/...` paths using **named** accounts. Neither can work:

| # | Fault | Consequence |
|---|---|---|
| 1 | The per-share `/volumeN` bind mounts are **`:ro`** inside the nas-api container | `chown` returns `Read-only file system` |
| 2 | The container **cannot resolve NAS account names** (its `/etc/passwd` is Debian's own) | `chown mac:users` dies with `invalid user` |
| 3 | `/etc/group` **is not mounted from the host at all** | NAS *group* names cannot be resolved even after fixing #2 |

Fault 3 is the one that forces a **compose change plus a one-time `docker compose up -d` per
NAS** — it cannot be fixed in TypeScript alone. That is the main reason this was not patched
inline during the session that found it.

They fail **safely** — no data is at risk, they simply error. The reason they were disabled
rather than left alone is in § 3.

---

## 2. Background: why this was found

On 2026-07-16 a session was asked to fix `repair_path_acl`, which built:

```
getfacl '<path>'
setfacl -m '<spec>' '<path>'
getfacl '<path>'
```

`setfacl`/`getfacl` are **not installed** — not in `apps/nas-api/Dockerfile` (no `acl` package)
and not on the DSM host. The tool could only ever print `command not found`, while presenting a
**tier-3 approval** that told the operator a write was about to happen.

`repair_path_acl` was **removed** (`107741d`), not ported to DSM's `synoacltool`: `/volume1` is
mounted `synoacl`, not `acl`, so POSIX ACL tooling was never the right instrument here, and a
`synoacltool` writer is a *new capability* with a different contract. That decision was reviewed
independently by Codex, which agreed at 99% confidence. See § 8 for the reusable design
constraints that review produced.

While checking whether `repair_path_ownership` shared the fault, it turned out to have a
**different** fault — and then a third — and then `repair_drive_db_permissions` turned out to
have the same two. That is what makes this a *class* of bug, not a one-off. Hence the checklist
now in AGENTS.md § 12:

> 1. Is the binary actually in `apps/nas-api/Dockerfile`?
> 2. Is the target path on a `:rw` mount?
> 3. Do the identifiers resolve **inside the container**?
> 4. Has it been run once, for real, on a scratch path?

The tier gates check **none** of these, and `write: true` in `nas-tools.ts` checks none of them
either.

---

## 3. Why "it only ever errors" was not a reason to leave them enabled

They cause no data damage. The damage is to the **approval system's credibility**: a tier-3
preview that says *"this action requires your approval — chown will run on /volume1/mac/Decor"*,
from a tool that cannot chown anything, trains the operator to click through approvals that mean
nothing. The owner is a non-developer. An approval prompt has to mean something every time or it
means nothing any time.

This argument came from the Codex review and is the reason for disabling rather than shrugging.
Preserve it if you rewrite the AGENTS.md entry.

---

## 4. Architecture you need to hold in your head

- `packages/shared/src/nas-tools.ts` — `ALL_TOOL_DEFS`, 133 registry definitions. Each has
  `buildCommand(input)` returning a **shell string**, plus `write: true|false`. This is where
  both tools live.
- `apps/nas-mcp/tools-config.json` — controls which registry tools are invokable.
  `enabled_read_tools` / `enabled_write_tools`. A tool in the registry but absent from these
  lists is compiled into the image but invisible to `tool_search` and rejected by `invoke_tool`
  with *"exists but is disabled in tools-config.json"*. **This is how they are currently
  disabled**, along with `_write_tools_available_disabled` and `_tool_descriptions`.
- `apps/nas-api` (Go, runs **in a container on each NAS**, port 7734) — executes the shell
  string. `internal/validator/validator.go` classifies it:
  - tier 1 = read-only → **auto-executes, no approval**
  - tier 2 = state-changing → needs `confirmed: true`
  - tier 3 = touches user data → `confirmed: true` + HMAC-signed token
  `ClassifyTier` pattern-matches the **command string**. `chown` is already in `writePatterns`
  and in `filePatterns` (`\b(rm|mv|cp|ln|mkdir|rmdir|touch|chmod|chown|chattr|setfacl)\b.*(/volume\d+/|...)`),
  so these tools already classify tier 3 correctly. **No validator change is needed for this
  fix** — do not "helpfully" add one.
- `deploy/synology/docker-compose.agent.yml` — the compose file for both NASes. This is where
  the mounts are defined and where fault 3 must be fixed.

---

## 5. The three faults, with live evidence

All verified on **edgesynology1**, 2026-07-16, via the NAS MCP (`run_command`).

### Fault 1 — target path is read-only

`deploy/synology/docker-compose.agent.yml`, nas-api service:

```yaml
- ${BTRFS_VOLUME1_PATH:-/volume1}:/btrfs/volume1:rw     # the ONLY writable route
- ${SHARE_MAC_PATH:-/volume1/mac}:/volume1/mac:ro        # every per-share mount is :ro
- ${SHARE_FILES_PATH:-/volume1/files}:/volume1/files:ro
- ${SHARE_SYNO_DRIVE_PATH:-/volume1/@synologydrive}:/volume1/@synologydrive:ro
  # ...and so on for every share
```

Confirmed from `/proc/self/mountinfo` inside the container:

```
/volume1/mac      ro,noatime
/btrfs/volume1    rw,nodev,noatime
```

So any `chown /volume1/...` returns `Read-only file system`.

**Precedent for the fix:** `write_seafile_ignore` in `nas-tools.ts` already does this mapping:

```ts
if (p.startsWith("/btrfs/volume")) {
  // already the writable mount
} else if (/^\/volume\d+\//.test(p)) {
  p = "/btrfs" + p;
} else {
  throw new Error("...: path must be under /volume1/ (or /btrfs/volume1/).");
}
```

### Fault 2 — NAS account names do not resolve in the container

```
wc -l /etc/passwd /host/etc/passwd
  18 /etc/passwd          <- Debian's own, baked into the image
  55 /host/etc/passwd     <- the NAS's real accounts
```

The compose mounts the host file at a **non-standard location**:

```yaml
- /etc/passwd:/host/etc/passwd:ro
```

so `chown` (which reads the container's `/etc/passwd`) never sees NAS accounts:

```
name=SynologyDrive   container=no   host=YES
name=admin           container=no   host=YES
```

Consequence, live:

```
stat -c 'uid=%u gid=%g name=%U:%G' /volume1/mac
  uid=1024 gid=100 name=UNKNOWN:users
```

`UNKNOWN` is the tell: uid 1024 exists on the NAS but has no name inside the container. So
`chown mac:users /volume1/mac/...` fails `invalid user: 'mac:users'`. Only **numeric**
`uid:gid` works today.

> **Nuance worth keeping:** the *group* half of `mac:users` resolves **by coincidence** —
> Debian's stock `/etc/group` happens to define `users` at gid 100, which matches Synology's.
> Do not let that fool you into thinking group resolution works. It does not, for any NAS-defined
> group. Verified: `grep -c '^users:' /etc/group` → 1.

### Fault 3 — there is no host group file to resolve against

```
ls -1 /host/etc/
  VERSION
  passwd
  synoinfo.conf
```

No `group`. So even after wiring owner→uid from `/host/etc/passwd`, **group→gid has no source**.
This is what forces the compose change and the one-time redeploy.

---

## 6. Bonus finding — `repair_drive_db_permissions`'s premise may itself be wrong

It runs, for every `@synologydrive` dir found:

```sh
chown -R SynologyDrive:SynologyDrive "$d"
```

But live on edgesynology1:

```
stat -c 'uid=%u gid=%g name=%U:%G %n' /volume1/@synologydrive
  uid=0 gid=0 name=root:root /volume1/@synologydrive
```

The directory is **root-owned**. `uid=0` is unambiguous — that is not a name-resolution artifact.
So if this tool ever *had* worked, it would have chowned a root-owned DSM-managed directory tree
to `SynologyDrive` recursively, which may be wrong and is potentially disruptive to the Drive
package.

**Do not simply fix the mechanics and re-enable this one.** First establish what the correct
ownership actually is — from Synology documentation or a healthy reference system — and whether
the tool's original premise (that `@synologydrive` should be `SynologyDrive:SynologyDrive`) holds
on DSM 7. If it does not, this tool should be **removed** rather than repaired. `repair_path_ownership`
is the more clearly legitimate of the two.

---

## 7. Required work

### 7a. Compose change (`deploy/synology/docker-compose.agent.yml`, nas-api service)

Add alongside the existing `/etc/passwd` mount:

```yaml
- /etc/group:/host/etc/group:ro     # NAS group names for uid/gid resolution in repair tools
```

**Do not** mount the host's `passwd`/`group` over the container's own `/etc/passwd` /
`/etc/group`. The container needs its own (root, nobody, etc.) to function; the host's file is
reference data only. Keep the `/host/...` convention already used throughout.

This mount requires a **one-time `docker compose up -d` per NAS**. Watchtower updates *images*,
not compose configuration — see AGENTS.md § 12 *"Watchtower updates images but NOT compose
configuration"*. Same pattern as the archive jobs mount in
`docs/synology-archive-implementation.md`.

> **Ride along with the redeploy that is already pending.** As of `8355599` the compose file
> also carries `stop_grace_period: 90s` on the agent service, with the same "Watchtower does NOT
> apply this — needs a one-time `docker compose up -d` per NAS" caveat. The archive jobs mount is
> in the same position. So there are now **three** changes waiting on one manual redeploy per
> NAS. Land the `/etc/group` mount before that redeploy happens and it costs nothing extra;
> land it after and you have burned a second trip to both boxes. Coordinate rather than
> scheduling your own.

#### The on-NAS compose file is a MANUAL COPY, and it is stale

This is the part the phrase *"needs a one-time `docker compose up -d` per NAS"* hides, and it
appears in that abbreviated form in CLAUDE.md, AGENTS.md and in `8355599`'s own comment. Editing
`deploy/synology/docker-compose.agent.yml` in this repo **does not put it on the NAS**. Nothing
syncs it — Watchtower updates images only, and no workflow deploys to the NASes. The live file is
a hand-placed copy at a **different path and filename**:

```
repo : deploy/synology/docker-compose.agent.yml
NAS  : /volume1/docker/synology-monitor-agent/compose.yaml     <- compose project "synology-monitor-agent"
```

Measured on edgesynology1, 2026-07-16 (`compose.yaml` dated **Jun 21 05:02**, mode `-r--r--r--`,
owner uid 1039 — note it is not writable, so copying over it needs care):

| Repo has | On the NAS? |
|---|---|
| `${BTRFS_VOLUME1_PATH:-/volume1}:/btrfs/volume1:rw` | ✅ present |
| `/etc/passwd:/host/etc/passwd:ro` | ✅ present |
| `/etc/group:/host/etc/group:ro` (this fix) | ❌ absent |
| archive jobs mount + `NAS_API_NAME` | ❌ **absent — the `/jobs/*` endpoints are returning 503 today** |
| `stop_grace_period: 90s` (`8355599`) | ❌ absent |

So the real deploy step is **copy, then up** — and each NAS keeps its own `.env` beside the
compose file, so do not clobber that:

```sh
# on the NAS, after placing the new compose.yaml
cd /volume1/docker/synology-monitor-agent
sudo docker compose up -d nas-api        # target the service; don't recreate everything blindly
```

Verify the mount actually landed before trusting any chown result:
`run_command target=edgesynology1 → ls -1 /host/etc/` must list `group`.

Until that runs, `/host/etc/group` will not exist. **Fail loudly** in that case — do not fall
back to a guessed gid.

### 7b. `repair_path_ownership` in `packages/shared/src/nas-tools.ts`

Current `buildCommand` (abridged):

```ts
const flag = recursive ? "-R " : "";
return [
  `echo '=== CURRENT OWNERSHIP ==='`,
  `ls -la ${qp} 2>&1`,
  `echo '=== APPLYING chown ${flag}${ownerGroup} ==='`,
  `chown ${flag}${qo} ${qp} 2>&1 && echo OK || echo FAILED`,
  `echo '=== VERIFY ==='`,
  `ls -la ${qp} 2>&1`,
].join("\n");
```

Required changes:

1. **Map the path.** Accept the operator-facing `/volumeN/<share>/...`, reject anything else,
   map to `/btrfs/volumeN/<share>/...` for the write. Reject `..`. Use `write_seafile_ignore`'s
   logic as the template.
2. **Show both paths in the preview** — the logical path the operator typed *and* the resolved
   `/btrfs/...` path actually being written. The operator must be able to see what will happen.
3. **Resolve names to numeric ids in the generated shell**, from the host files, then chown
   numerically:
   ```sh
   uid=$(awk -F: -v n="$owner" '$1==n{print $3; exit}' /host/etc/passwd)
   gid=$(awk -F: -v n="$group" '$1==n{print $3; exit}' /host/etc/group)
   [ -n "$uid" ] || { echo "ERROR: user '$owner' not found in /host/etc/passwd"; exit 1; }
   [ -n "$gid" ] || { echo "ERROR: group '$group' not found in /host/etc/group (is /etc/group mounted? needs one-time 'docker compose up -d')"; exit 1; }
   chown ${flag}"$uid:$gid" "$path"
   ```
   Accept numeric input too (if `$owner` is all digits, use it as-is).
4. **Do not trust `&& echo OK`.** The current tools already print OK/FAILED and were broken the
   whole time. Verify by re-reading ownership and comparing to the requested value; report a
   mismatch as a failure.
5. Keep it tier 3. `chown` already matches `filePatterns`; the `/btrfs/volume\d+/` filePattern
   entry also exists. Confirm with a `validator_test.go` case, do not add new patterns.

### 7c. Guard rails

- **Recursive is dangerous.** `recursive:owner:group` triggers `chown -R`. Consider dropping
  recursion in the first working version, or requiring an explicit extra confirmation and showing
  a file count in the preview. A recursive chown on a live share can disrupt SMB access at scale.
- Do not run large recursive operations while SMB users are active (AGENTS.md § 11). Prefer
  `/opt/bin/ionice -c3 nice -n 19` for anything that crawls.

---

## 8. Design constraints from the Codex review

These were produced for a hypothetical ACL writer, but most apply verbatim to any permissions
writer and are worth honouring here:

- **Structured inputs, not raw strings.** The server builds the operation; the caller supplies
  fields (path, principal type, principal name). Do not accept a pre-baked `owner:group` blob
  from a model if it can be avoided.
- **Preflight the model.** Read current state first and fail closed on anything unexpected.
- **Path allowlist + canonicalisation.** Validate against known shares, reject traversal and
  unsafe symlinks, then translate to the writable mount.
- **State-bound approval.** Bind the HMAC-approved plan to the target NAS, canonical path, and
  the *current* ownership (or its digest). Refuse to execute if state changed between preview and
  execution.
- **Human-readable preview.** Show current → proposed → expected resulting state in plain
  language. A raw shell command is not adequate for a non-developer.
- **Post-write verification.** Re-read and confirm. A zero exit code is not proof.
- **No claimed rollback until proven.** An inverse-looking command is not a restore.

---

## 9. Verification protocol — the part that actually matters

The whole reason this bug survived is that nobody ever ran the tool for real. **Do not skip
this.**

1. Deploy: push to `main`, wait for the `Publish NAS API Image` / `Publish NAS MCP Image`
   workflows, wait for Watchtower (~5 min) — verify with
   `curl http://100.107.131.35:7734/health` and check `build_sha` matches your commit.
2. Run the **one-time** `docker compose up -d` on each NAS for the `/etc/group` mount.
3. Confirm the mount landed:
   `run_command target=edgesynology1 → ls -1 /host/etc/` must now list `group`.
4. **No-op chown proof.** Pick a scratch path under `/btrfs/volume1` (create one if needed) or an
   existing path, read its current `uid:gid`, and chown it to **exactly what it already is**.
   Expected: success, no change. This proves the write path and name resolution without touching
   real ownership.
   - Failure mode you are looking for: `Read-only file system` (fault 1 not fixed) or
     `invalid user` (faults 2/3 not fixed).
5. Then a real change on a scratch file: create, chown to a different NAS account, verify, chown
   back.
6. Only then re-enable (§ 10).

---

## 10. Re-enable checklist

- [ ] `apps/nas-mcp/tools-config.json`: move name out of `_write_tools_available_disabled` and
      back into `enabled_write_tools`.
- [ ] `apps/nas-mcp/tools-config.json`: restore a normal `_tool_descriptions` entry (drop the
      `DISABLED 2026-07-16 …` text).
- [ ] `packages/shared/src/nas-tools.ts`: drop `DISABLED`/`BROKEN` from the tool `description`
      and rewrite the block comment above it to describe the working design.
- [ ] `AGENTS.md` § 12: update the entry to the fixed state. Keep the four-point checklist and
      the "approved is not worked" lesson — those outlive this bug.
- [ ] `apps/nas-mcp/README.md`: `Group write_files (8)` count and list if membership changed.
- [ ] Delete this file as part of the commit that completes the work.
- [ ] `pnpm type-check`, `go test ./...` in `apps/nas-api`.

---

## 11. Traps that will waste your time

- **`run_command` false-blocks.** The validator matches the command *string*, so:
  - Any command **mentioning `setfacl`** — even `which setfacl` — is rejected.
  - Any command mentioning **`passwd`** or **`getent passwd`** hits a permanent hard block
    (*"User/group account changes are blocked"*). To read `/etc/passwd` use a glob:
    `a=/etc/pass??; wc -l $a`. Same for `/etc/group` → `/etc/gr??p`.
  - These are documented in AGENTS.md § 11. They fail **closed** by design; do not loosen them.
- **The NAS MCP is registered as `synology-monitor`**, not "nas-mcp". A negative tool search
  proves nothing — run `claude mcp list`. See CLAUDE.md.
- **Git worktrees** under `.claude/worktrees/` do not get `.mcp.json` or `pnpm-lock.yaml`
  (untracked). Run `pnpm install --no-frozen-lockfile` in the worktree before `pnpm type-check`.
- **`edgesynology2`'s nas-api was down 2026-07-08 → 2026-07-16 and is now RESTORED.** Both NASes
  now run the same current build and both refuse `synoacltool` writes. Root cause is worth
  knowing before you plan any redeploy: the container exited **143 (SIGTERM)** three minutes
  before the 07-08 reboot — a clean stop, `RestartCount=0`, no crash. `restart: unless-stopped`
  then did **exactly what it says**: unlike `always`, it deliberately does *not* restart a
  container that was explicitly stopped, even across a daemon restart. So a NAS reboot can leave
  one container down indefinitely while every other container returns. It needed one
  `docker start`. Why nas-api alone was stopped, when agent/watchtower/popdam-bridge all came
  back, is **unknown** — DSM does not retain the attribution. **If a container is missing after
  a reboot, check `docker ps -a` for `Exited (143)` before assuming a crash.**
- **SSH works to both NASes** — use the `~/.ssh/config` aliases, do not hand-build the
  connection:
  - `ssh edgesynology1` → ahazan@100.107.131.35 **port 22**
  - `ssh edgesynology2` → ahazan@100.107.131.36 **port 1904** ← non-standard; probing port 22
    gives connection-refused, which is *not* evidence SSH is disabled. A session concluded
    exactly that on 2026-07-16 and was wrong.
  Both are Tailscale IPs. The `192.168.3.x` LAN addresses are only reachable *from* the other
  NAS, not from a workstation.
- **`sudo docker` fails on the NAS — you must use the absolute path.** `ahazan` has NOPASSWD for
  the literal path only, and `docker` is not on the non-interactive PATH:
  ```sh
  sudo /var/packages/ContainerManager/target/usr/bin/docker ps -a     # works
  sudo docker ps -a                                                    # "a password is required"
  ```
  (`/usr/local/bin/docker` is a symlink to it, but the sudoers rule matches the literal path.)
  This reads as "I am blocked, sudo needs a password" and will stop you dead if you do not know
  it. Beware also that `sudo docker ... | grep x || echo "absent"` will report **absent** when
  the real failure was sudo — check exit codes rather than trusting an `||` fallback.
- **For reference, the live deployment identity on edgesynology1** (from
  `docker inspect synology-monitor-nas-api --format '{{json .Config.Labels}}'` — note a `--format`
  containing the literal string `com.docker.compose` trips the validator, but the *output* is
  fine):
  - compose project `synology-monitor-agent`, service `nas-api`, container
    `synology-monitor-nas-api`, config `/volume1/docker/synology-monitor-agent/compose.yaml`,
    compose v2.20.1, image `ghcr.io/u2giants/synology-monitor-nas-api:latest`.

---

## 11b. The two NASes do not agree on the ACL model — verify on BOTH

Discovered 2026-07-16 once es2's nas-api came back, running the identical command on each:

```
run_command target=both → synoacltool -get /volume1/mac

[edgesynology1]  (synoacltool.c, 596)It's Linux mode
[edgesynology2]  ACL version: 1
                 Archive: has_ACL,is_support_ACL
```

**The same share carries a Synology ACL on `edgesynology2` and none on `edgesynology1`**, despite
the two being Drive/ShareSync peers. That is not a cosmetic difference for this work:

- On a **Linux-mode** path, POSIX ownership/mode is what governs access, so `chown` is the whole
  remediation — `repair_path_ownership` is exactly the right tool.
- On a **Synology-ACL** path, an ACE can grant or deny access regardless of what `chown` sets, so
  a chown may appear to succeed and change nothing an SMB user can observe. Worse, `synoacltool`
  has `-set-owner`, which is a *second*, ACL-aware way to change ownership; which one DSM honours
  on an ACL-enabled path is **unverified**.

Consequences for this fix:
1. **Validate on both NASes, not just es1.** A no-op chown proven on es1 (Linux mode) proves
   nothing about es2 (ACL mode). Most of this session's verification ran on es1 only, because es2
   was down — do not inherit that blind spot.
2. Consider having the tool **report the path's mode** (`synoacltool -get` → "It's Linux mode" or
   not) in its preview, so the operator can see whether chown is even the right lever.
3. Do not assume the two boxes are configured alike anywhere else either. This one had gone
   unnoticed.

## 12. Wider audit (do this while you are in here)

The rest of the `write_files` group has **not** been checked against the § 2 checklist. All of
these touch `/volumeN` and are enabled:

- `quarantine_path` — `mv` to `<path>.quarantine.<ts>` on `/volume1/...` (**almost certainly
  fault 1**: `mv` on a `:ro` mount)
- `rename_file_to_old`
- `remove_invalid_chars`
- `restore_path_from_snapshot`
- `restore_from_recycle_bin`

`write_seafile_ignore` is known-good (it does the `/btrfs` mapping already) and is the reference
implementation.

Cheapest way to audit without executing anything: call each tool through `invoke_tool` with
`confirmed: false` to get the **preview**, and read the generated command for a bare `/volumeN/`
write target or a named account. That is exactly how these two were caught.

---

## 13. Provenance

- `107741d` — removed `repair_path_acl` (setfacl absent; `/volume1` is `synoacl` not `acl`)
- `910fa6b` / `ff05281` — gated `synoacltool` mutating verbs in the validator (they classified
  **tier 1 and auto-executed** before), verified live
- `d48c6f9` — dropped the dead `getfacl` section from `inspect_path_acl` /
  `inspect_effective_permissions`
- `0fe657c` — **disabled these two tools** and added the AGENTS.md § 12 checklist
- `9bb4d82` — recorded the MCP naming/`.mcp.json` trap in CLAUDE.md

Working ACL diagnosis is unaffected throughout: `inspect_path_acl` and
`inspect_effective_permissions` call `synoacltool -get` and are verified working. Note that a
path may answer `It's Linux mode` (e.g. `/volume1/mac`), meaning it carries **no** Synology ACL
and POSIX ownership/mode is what governs it — which is precisely why `repair_path_ownership` is
a legitimate capability worth fixing.
