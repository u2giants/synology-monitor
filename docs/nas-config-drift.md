# NAS compose drift — investigation and plan

Last verified: 2026-07-16 UTC (live on `edgesynology1` / `192.168.3.100` via the NAS MCP).

Scope: why the compose file that runs on each NAS is not the repo's file, what has
drifted today, and the plan to make drift *visible* before making it *automatic*.

## 1. How we got here

There is **no sync mechanism at all**. Not a broken one — none.

- No workflow copies compose to a NAS. The four workflows (`.github/workflows/agent-image.yml`,
  `nas-api-image.yml`, `nas-mcp-image.yml`, `web-image.yml`) build and push images to GHCR.
  None reference the NAS, SSH, Tailscale, or `deploy/`.
- No agent or nas-api code fetches or writes compose. `MONITOR_STACK_PATH` appears exactly
  **once** in the entire repo — `deploy/synology/docker-compose.agent.yml:113`, the mount
  declaration itself. No Go file reads it.
- The only "mechanism" is a sentence. `deploy/synology/README.md:22` says the NAS copy
  *"should be kept in sync with"* the repo file. That is aspiration, not automation.

The archive-jobs rollout shows the failure mode exactly. Commit `945d42f` (2026-06-07)
added the mount and wrote in its own message: *"Requires a one-time docker compose up -d
per NAS."* That instruction has now gone **5+ weeks unapplied**. The rollout mechanism was
a commit message, and commit messages do not execute.

This is not undocumented. `AI_OPERATING_RULES.md:41-44`, `AGENTS.md:526-534`,
`AGENTS.md:349-351`, and `docs/deployment.md:136-140` all state it plainly. The gap is not
knowledge — it is that **every path depends on a human remembering, and nothing detects
when he doesn't.**

## 2. What has actually drifted (verified live, 2026-07-16)

Live NAS file: `/volume1/docker/synology-monitor-agent/compose.yaml`, 5601 bytes,
mtime 21:53:39 UTC *(size/mtime vary — they changed twice during this investigation)*.
Beside it sit **12 hand-made `.bak*` files** dating back to 2026-03-31.

### Drift is bidirectional — this is the key finding

The NAS is not simply "behind" the repo. Each side has things the other lacks.

**Repo has, NAS lacks** (NAS is behind):

| Item | Repo | Live NAS | Consequence |
|---|---|---|---|
| `/app/data/jobs` mount | `docker-compose.agent.yml:121` | absent from file **and** container | `/jobs/*` returns 503 |
| `NAS_API_NAME` env | `docker-compose.agent.yml:72` | absent | jobs cannot identify the box |

**NAS has, repo lacks** (repo is behind — a naive repo→NAS copy would *delete* these):

| Item | Live NAS | Repo | Consequence if overwritten |
|---|---|---|---|
| `stop_grace_period: 90s` (agent) | present | absent | agent gets 10s to flush its SQLite WAL → **telemetry loss on every restart** |
| `/usr/syno:/host/usr/syno:ro` (agent) | present | absent | agent loses Synology binaries |
| `restart:` policy | `on-failure:10` (all 3) | `unless-stopped` | different reboot behaviour (see below) |
| watchtower `/btrfs/volume1:rw` | present | absent | (NAS-only; appears unnecessary) |

**Security regression — the NAS is running the configuration the repo explicitly rejected:**

| Item | Repo | Live NAS |
|---|---|---|
| `/dev` | 12 individual `:ro` mounts, `docker-compose.agent.yml:127-138` | **`/dev:/dev` — full tree, read-write** |

`AGENTS.md:524-525` documents the deliberate decision: *"mounting the full `/dev` tree
read-only would still expose `/dev/mem`, `/dev/kmem`, and other sensitive kernel
interfaces."* The NAS runs the full tree **read-write** — strictly worse than the option
the repo rejected on security grounds. Verified live:
`docker inspect synology-monitor-nas-api` reports `/dev=>/dev(rw)`.

Also note `restart: on-failure:10` (NAS) vs `unless-stopped` (repo): after 10 consecutive
failures the container **stays down and never retries**. This is a plausible contributor to
edgesynology2's nas-api being down since 2026-07-08 and is worth checking when it returns.

### Why "just copy the repo file to the NAS" is the wrong instinct

It would remove `stop_grace_period: 90s` and `/usr/syno` from the agent and flip the
restart policy — a regression shipped in the name of consistency. **The repo file is not
currently a safe source of truth.** It must be reconciled with reality *before* any sync
mechanism is built. That ordering is the whole plan.

## 3. Drift detection — the cheapest high-value win

### The decisive constraint: only nas-api can do this today

| | Docker socket | Compose file | Writes to Supabase |
|---|---|---|---|
| **agent** | ✗ | ✗ | ✓ |
| **nas-api** | ✓ (live) | ✓ (live) | ✗ |

Verified live — `docker inspect synology-monitor-nas-api` shows both already mounted:
- `/var/run/docker.sock=>/var/run/docker.sock(rw)`
- `/volume1/docker/synology-monitor-agent=>/volume1/docker/synology-monitor-agent(ro)`

Putting the check in the **agent** requires adding a Docker socket mount to the agent
service — *which requires exactly the manual `docker compose up -d` whose absence we are
trying to detect.* A drift detector that needs a manual deploy to detect missed manual
deploys is a chicken-and-egg trap.

Putting it in **nas-api** requires **zero compose change, zero migration, zero new table** —
the mounts are already there. This is the answer.

### Two checks, and precisely what each catches

**Check A — NAS file vs running container.** Parse `compose.yaml`, compare declared mount
destinations and env keys against `docker inspect`. Catches *"someone edited the file and
never applied it."* This is the `/etc/group` class.

**Check B — repo expectation vs NAS file.** Bake the repo's expected **mount-destination
list and env-key list** into the nas-api image at build time. Compare against the NAS file.
Catches *"the repo moved and the NAS never did."*

This needs no new machinery: nas-api **already** bakes build-time constants via
`-ldflags -X` (`apps/nas-api/Dockerfile:11` sets `main.BuildSHA` / `main.BuildTime`, declared
`cmd/server/main.go:29-32` and served on `/health`). The expected-mount list is the same
pattern with a longer string. Confirmed live — `curl http://localhost:7734/health` on
edgesynology1 returns `build_sha ff05281…`, so the mechanism demonstrably survives the
GHCR + Watchtower path onto the box.

> **Only Check B would have caught the missing jobs mount.** The jobs mount is absent from
> the NAS file *and* the container — they agree with each other, so Check A sees nothing
> wrong. Both checks are needed; they detect different failures.

Do **not** compare whole-file hashes. The NAS file legitimately differs per box (paths,
bays). Compare the normalized semantic set — mount destinations and env keys — which
tolerates per-NAS differences and still catches a missing mount exactly.

Do **not** rely on `com.docker.compose.config-hash` or container `Created` timestamps.
Recomputing the hash needs the compose binary, and `docker compose` is hard-blocked by
the validator (`AGENTS.md:249-252`). Worse, **Watchtower resets `Created` on every image
pull**, rebaking the old config into a fresh-looking container — so timestamps
systematically make stale config look new. That is the real sense in which Watchtower
masks drift.

### Smallest change

`GET /drift` on nas-api — read-only, tier 1, no approval token. Returns per service:
declared vs actual mounts, declared vs expected mounts, and the missing set. Surface it on
the existing web dashboard via `apps/web/lib/server/nas-api-client.ts` (the same path
`/jobs/*` already uses). No agent change, no compose change, no Supabase table.

If it should also land in Supabase later, the agent can poll nas-api's `/drift` and queue
a `nas_config_drift` current-state row (upsert on `(nas_id, service)` — remember
`upsertTables` **and** `upsertConflictTargets`, `sender.go:185-193`, plus a
`telemetry_retention_policies` row). But that is a phase-2 nicety; the dashboard read is
what turns an incident into a glance.

## 4. Watchtower — keep it, but narrow its story

Keep it. It does its one job (image updates) correctly, and the alternative — a
config-aware auto-updater — is precisely the blast radius we should not accept.

But it should be **deliberately** image-only, not accidentally so. Image updates and config
updates have completely different risk profiles: a bad image is reverted by `git revert` +
a 5-minute poll, with no hands on the box. A bad compose file can leave a container that
never starts on a NAS you may not be able to reach — as edgesynology2 demonstrates *right
now*. Fusing them into one auto-apply mechanism means the safe operation inherits the
dangerous one's blast radius. **They should stay separate. That is a feature.**

The honest indictment of Watchtower is narrower than "it masks drift": it makes containers
*look* freshly deployed while carrying config from an arbitrarily old generation. Fixing
that is Check A's job, not Watchtower's.

## 5. Options considered

| Option | Verdict | Why |
|---|---|---|
| **(a) Pull-agent fetches compose + applies** | **Reject** | Highest blast radius. An auto-`compose up -d` on a box with no remote hands can take down the agent *and* the nas-api used to diagnose it. edgesynology2 is the live proof this is not hypothetical. |
| **(b) GitHub Actions over Tailscale SSH** | **Reject** | `AI_OPERATING_RULES.md:63` forbids SSH as a normal deployment path and `:69` forbids creating "a second deployment system". Note the VPS rule is *not* what kills this — the NAS is a different box and the operator does have SSH (`AGENTS.md:204-207` permits it as **exceptional, operator-requested, not a deployment path**). It is the second-deployment-system rule that binds. Also requires a durable CI credential to a box holding all company data. |
| **(c) DSM Task Scheduler git pull + compose up** | **Reject** | Same auto-apply blast radius as (a), plus unattended and invisible, plus it is durable host config with no Ansible coverage (NAS is out of Ansible scope — `AGENTS.md:1000-1011` scopes Ansible to `hetz` only). |
| **(d) Bake config into the image** | **Reject** | A container cannot mount its own compose file; mounts are decided by the daemon before the image runs. Physically cannot work for the exact fields that drift. |
| **(e) Accept manual apply + add a checksum/drift gate** | **Adopt** | Keeps blast radius at zero, makes the gap visible, and preserves the operator's decision to apply. Detection is the 90% win; auto-apply is the 10% that carries all the risk. |

On the Container Manager rule (`AGENTS.md:989-992`): it binds *monitor features* managing
containers via ad-hoc Docker CLI, and it does not bind here — the stack was not created
through Container Manager (`deploy/synology/README.md` states DSM Container Manager cannot
perform the recreate for this project). `/drift` is read-only inspection regardless, which
the rule does not reach.

## 6. Recommendation

**Detect first. Never auto-apply. Reconcile the repo before trusting it.**

- **Phase 0 — make the repo file true.** Adopt the NAS's `stop_grace_period: 90s` and
  `/usr/syno` agent mount into the repo. Decide `/dev` explicitly (recommend: restore the
  individual `:ro` mounts, but *verify each bay exists first* — `AGENTS.md:519-522` warns a
  missing device fails the whole `up`, which is the likely reason someone widened it to
  `/dev:/dev` in the first place). This is repo-only, zero NAS risk, and it is a
  prerequisite: **no sync mechanism is safe while the source of truth is wrong.**
- **Phase 1 — `GET /drift` on nas-api.** Ships via the normal GHCR + Watchtower path, no
  NAS step required (the mounts are already live). Surface on the dashboard. Zero blast
  radius.
- **Phase 2 — one reconciling `docker compose up -d` per NAS,** operator-run, from a
  runbook, once `/drift` shows a clean expected diff. Only after edgesynology2 is back.
- **Phase 3 — optional:** agent polls `/drift` into Supabase for history/alerting.

### What I would not automate, and why

**Applying compose to the NAS.** Both NASes hold the company's data and neither has remote
hands. `edgesynology2` has been unreachable since 2026-07-08 — an auto-apply that landed
there would have been unrecoverable without a site visit. The operator applying a file he
can see, when he chooses, with a rollback command in front of him, is not a process
failure to be engineered away. It is the last safety interlock on a box with no console.

Automate the *knowing*. Keep the *doing* manual.

## 7. Commands

Every command below is literal and copy-pasteable. Parts that **vary** are marked.

### 7.1 First step — confirm the `/dev` finding yourself (read-only, safe)

Run on your own machine. This changes nothing; it only prints what is running.

```sh
ssh ahazan@192.168.3.100 'sudo docker inspect synology-monitor-nas-api --format "{{range .Mounts}}{{.Source}}=>{{.Destination}}({{.Mode}})
{{end}}" | grep /dev'
```

Correct output — exactly one line, and this is the problem:

```text
/dev=>/dev(rw)
```

`(rw)` and the bare `/dev` are what this doc calls the security regression. If instead you
see twelve lines like `/dev/sda=>/dev/sda(ro)`, the NAS was already fixed and section 2 of
this doc is stale — say so and stop.

### 7.2 See the whole gap at a glance (read-only, safe)

```sh
ssh ahazan@192.168.3.100 'grep -c "app/data/jobs" /volume1/docker/synology-monitor-agent/compose.yaml'
```

Correct output right now — this is why `/jobs/*` returns 503:

```text
0
```

After the Phase 2 apply, this same command must print `1`.

### 7.3 Rollback path — read this BEFORE any apply

Nothing in Phase 0 or Phase 1 touches the NAS, so nothing there needs a rollback. This is
for Phase 2 only, and it must be read first, not after something breaks.

**Before** changing `compose.yaml`, make a restore point:

```sh
ssh ahazan@192.168.3.100 'sudo cp -a /volume1/docker/synology-monitor-agent/compose.yaml /volume1/docker/synology-monitor-agent/compose.yaml.bak-before-jobs-mount'
```

Correct output: **no output at all.** `cp` prints nothing on success.

**If the apply goes wrong** — containers will not start, or the dashboard goes dark — this
single command puts the old file back and restarts with it:

```sh
ssh ahazan@192.168.3.100 'sudo sh -c "cd /volume1/docker/synology-monitor-agent && cp -a compose.yaml.bak-before-jobs-mount compose.yaml && docker compose up -d"'
```

Correct output ends with lines like these *(container names are fixed; the words after them
vary — `Started`, `Running`, or `Recreated` are all fine)*:

```text
 Container synology-monitor-agent  Started
 Container synology-monitor-nas-api  Started
 Container synology-monitor-watchtower  Running
```

Then confirm the NAS API is answering again *(both `build_sha` and `build_time` vary — any
values are fine; you are checking that it answers at all and says `"status":"ok"`)*:

```sh
curl -s http://100.107.131.35:7734/health
```

Correct output — one line of JSON, verified live 2026-07-16:

```text
{"build_sha":"ff05281944d3353cdeba50c0253f105e324fa145","build_time":"2026-07-16T16:00:06-04:00","status":"ok"}
```

If that `curl` returns nothing and the rollback did not help, the box needs DSM:
**DSM → Container Manager → Container → `synology-monitor-nas-api` → Start**.

### 7.4 Housekeeping — the 12 `.bak` files

`/volume1/docker/synology-monitor-agent/` holds 12 hand-made backups going back to
2026-03-31 (`compose.yaml.bak-codex`, `.pre_drive`, `.bak-stopgrace`, …). They are the
fossil record of exactly the manual editing this doc is trying to end. Leave them until
Phase 2 succeeds — one of them may be needed. Prune them afterwards, keeping only
`compose.yaml.bak-before-jobs-mount`.
</content>

## 8. Reconciliation design — how the repo becomes true again (agreed Claude + Kimi K3, 2026-07-17)

Debated because a single `docker-compose.agent.yml` cannot be byte-exact deployable to
two boxes with different hardware (edge1: sda–sdf, md0–9, nvme0/1+namespaces; edge2:
sda–sde, md0–7, no NVMe), and Compose has **no** single-file mechanism for count/presence
variance — env substitution only substitutes values, merge keys don't touch sequences,
`profiles` gate services not device lines, and multi-file `-f` merge moves discipline to
every invocation (forget `-f` → base applied with no devices → SMART silently gone, the
exact EPERM failure we just escaped). So variance must live somewhere explicit.

**Rejected — one template with "delete the absent bays" comments (Claude's first take).**
That is comment-mediated human discipline, which has already failed three times in this
repo (README "should be kept in sync"; a mount change that sat in a commit message for
5+ weeks). "Delete lines for absent bays" is a *verb*, violating AGENTS.md §17 (hand the
operator runnable commands, never verbs). A committed file that is wrong-by-design for
half the fleet also trains every reader — including future AI sessions — to distrust
committed files.

**Rejected — two hand-maintained per-box files + a CI "structural-diff" guard.** Kimi's
first position; Claude pushed back and Kimi conceded. The guard must encode *which lines
may differ* — an exclusion spec that is itself a third, implicit copy of the
device-variance knowledge, living in CI YAML, drifting silently the day someone adds a
per-box-varying mount. That is the same comment-mediated failure in CI clothing.

**AGREED — a tiny generator emits two byte-exact committed per-box files.** One shared
base + two per-box device *fragments (data, not logic)* → `docker-compose.nas-1.yml` /
`docker-compose.nas-2.yml` (matching the existing `nas-1.env.example` / `nas-2.env.example`
convention). Each is deployable as-is (`curl raw → docker compose up -d`, no interpretation
step — §17-clean). Single source of structural truth; divergence impossible by
construction. Conditions, all required:
1. **Fragments are pure data** — the generator does dumb string splicing, zero
   conditionals. A clever generator rots worse than duplicate files.
2. **CI runs the generator and `git diff --exit-code`s the output** — regeneration is
   verified, never trusted to have happened locally. This also kills the "someone
   hand-edited the generated file" hazard for free.
3. Generated files carry a `DO NOT EDIT — regenerate with <exact command>` header, and
   document the dead-disk coupling there: with a correct `devices:` list, a pulled/dead
   disk blocks container start after a reboot until its line is removed (loud, by design;
   the old `volumes:` hack failed silently by mkdir-ing an empty source).

**Structural correctness is universal and lands regardless of the above:** `devices:` not
`volumes:` for block devices, `cap_add: [SYS_ADMIN, SYS_PTRACE, SYS_RAWIO]`, no
`privileged`, no `/dev:/dev` — the config already proven live on both boxes (see
`docs/nas-privilege-hardening.md`).

**Drift detection must be FUNCTIONAL, not textual** (refines §3): a text/hash compare of
compose files would have *passed* the very bug that started this — devices under
`volumes:` look fine textually but grant no cgroup access. The `/drift` check must probe
behaviour: each expected block device openable read-only from inside the container, caps
present, `privileged` absent, mounts as expected. Textual drift is a proxy; functional
drift is the disease.

**Scaling exit:** at N≥3 boxes or frequent hardware churn this is already the right shape;
nothing changes. The generator was over-engineering only at N=2 *until* we accepted that
the hand-maintained alternative needs equal CI machinery — at which point the generator is
strictly better.

Not yet implemented — this section is the agreed spec for that follow-up.
