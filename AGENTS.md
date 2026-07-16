# Synology Monitor — Agent & Developer Operating Guide

Canonical guide for AI sessions and new engineers. Read this first. Deeper
references: [docs/architecture.md](docs/architecture.md),
[docs/development.md](docs/development.md),
[docs/configuration.md](docs/configuration.md),
[docs/deployment.md](docs/deployment.md). The 3-stage issue-agent rebuild is
complete (2026-05-30); current behavior and durable rationale live in
[docs/architecture.md](docs/architecture.md). [PLAN.md](PLAN.md) is historical.

## Multi-model AI note

There is no universal ignore-file standard across AI coding tools.

`.claudeignore` works for Claude Code.

When using any other AI tool, paste this file as your first message and follow the instructions in the "What to ignore" section.

## 1. Project summary

AI-assisted monitoring + remediation for two production Synology NAS boxes
(`edgesynology1`, `edgesynology2`). A Go agent on each NAS collects telemetry into
Supabase; a Next.js dashboard (live at **mon.designflow.app**) fingerprints alerts
and logs into "issues" and runs a 3-stage LLM issue-agent that diagnoses problems
and proposes fixes behind an operator approval gate. A separate MCP server exposes
NAS diagnostic/remediation tools to AI chat clients (claude.ai, Claude Desktop).
Product focus: Synology Drive / ShareSync reliability, file-operation visibility,
sync/replication failures, storage and I/O attribution, and silent task/backup
failures. The owner is a non-developer; favor changes that keep `main` the single
source of truth and are easy to audit.

Host/OS changes on `hetz` are owned by the canonical Ansible repo at
`/worksp/ansible` / [`u2giants/ansible`](https://github.com/u2giants/ansible),
not this app repo. That includes packages, users, firewall, SSH/sudo, Docker
engine or daemon config, systemd units/timers, cron, `/etc`, `/usr/local/bin`,
`/usr/local/sbin`, Cloudflare Tunnel 1, Coolify host glue, and backup/DNS
watchdogs. Do not SSH, sudo, or edit the host directly for durable infra changes;
make an Ansible PR and let GitHub Actions apply it. App code/config still changes
here and deploys through this repo's normal pipeline/Coolify. Break-glass direct
host repair must be explicitly called out and followed by an Ansible PR that
captures or reconciles the drift.

## 2. Documentation map: what to read for each task

Always start with:

- `AGENTS.md`

Then load additional docs only when relevant:

| Task / question | Read these docs | Usually do not need |
|---|---|---|
| Quick repo orientation | `README.md`, `AGENTS.md` | Deep docs under `docs/` unless task requires them |
| Modify app behavior or project-owned code | `AGENTS.md`, relevant folder-level `README.md`, `docs/architecture.md` if system design is affected | `docs/deployment.md` unless deploy behavior changes |
| Add or change NAS MCP capabilities | `AGENTS.md`, `apps/nas-mcp/README.md`, `docs/architecture.md`, `packages/shared/src/nas-tools.ts`, `apps/nas-mcp/tools-config.json` | Web deployment docs unless deploy behavior changes |
| Change agent or NAS API behavior | `AGENTS.md`, `docs/architecture.md`, `docs/development.md`, `deploy/synology/README.md` if compose/env is involved | Unrelated web/NAS MCP README files |
| Add or change configuration, env vars, feature flags, secrets, or runtime settings | `AGENTS.md`, `docs/configuration.md`, `docs/deployment.md` if prod/runtime env is affected | Unrelated architecture docs |
| Change local setup, dev scripts, test/lint/debug workflow, package scripts, or tooling | `AGENTS.md`, `docs/development.md`, relevant package/config files | `docs/deployment.md` unless CI/CD changes |
| Change deployment, Docker, CI/CD, hosting, release flow, rollback, or runtime environment | `AGENTS.md`, `docs/deployment.md`, `docs/configuration.md`, relevant workflow/deployment files | Local-only development docs unless needed |
| Change database schema, migrations, models, external IDs, or data flow | `AGENTS.md`, `docs/architecture.md`, `docs/configuration.md` if env/config is affected, relevant migration/model files | Deployment docs unless rollout/deploy behavior changes |
| Database size/growth, telemetry retention, purging old rows, pg_partman, or migration `00042` | `AGENTS.md`, `docs/telemetry-retention.md` (status, known defects, live install procedure), `docs/supabase-virginia-migration-2026-06.md` (which project is real) | Unrelated subsystem docs |
| Investigate bugs or incidents | `AGENTS.md`, relevant docs based on affected area, `HANDOFF.md` if present, Critical incidents section in `AGENTS.md`, relevant incident docs under `docs/` | Unrelated folder-level READMEs |
| Continue unfinished work | `AGENTS.md`, `HANDOFF.md`, relevant docs named inside `HANDOFF.md` | Docs unrelated to the handoff scope |
| Work on the archive feature (file inventory or archive move) | `AGENTS.md`, `docs/synology-archive.md` (design/behavior), `docs/synology-archive-implementation.md` (build guide), `docs/archive-move-runbook.md` (live-move operator steps), `docs/architecture.md` (nas-api job API), `docs/deployment.md` (on-NAS job state + snapshots) | Unrelated subsystem docs |
| Seafile (`seaf-cli`) sync drift, false-"synchronized", inotify watch exhaustion, `set_inotify_watches` / `write_seafile_ignore` capabilities | `AGENTS.md`, `docs/seafile-sync-inotify.md`, `packages/shared/src/nas-tools.ts`, `apps/nas-api/internal/validator/validator.go` | Web/pipeline docs |
| Work in a subfolder with its own README | `AGENTS.md`, that folder-level `README.md`, and only broader docs referenced there | Other folder-level READMEs |
| Claude Code session | `CLAUDE.md`, then `AGENTS.md` | Other docs unless task requires them |
| Documentation-only cleanup | `AGENTS.md`, `README.md`, affected docs under `docs/`, folder-level READMEs only where relevant | Source files except as needed to verify accuracy |

This map is intentionally task-based. Do not load every Markdown file by default.

## 3. Quick orientation — five components

| Component | Language | Where it runs | Purpose |
|---|---|---|---|
| `apps/agent` | Go | each NAS (Docker) | Collects telemetry, buffers in SQLite WAL, flushes to Supabase |
| `apps/nas-api` | Go | each NAS (Docker, :7734) | Three-tier approved-shell-command executor for the issue agent + MCP |
| `apps/nas-mcp` | Node/TS | VPS (Coolify) | FastMCP server — exposes a 133-definition NAS tool registry to AI chat clients over Streamable HTTP |
| `apps/web` | Next.js | VPS (Coolify) | Dashboard, issue detector, 3-stage issue-agent loop, operator UI |
| `apps/relay` | Node (.mjs) | VPS | Narrow named-action HTTP proxy for an external (Lovable) frontend |

`packages/shared` holds shared TypeScript types and the NAS tool definitions
(built with Turbo). `ALL_TOOL_DEFS` currently contains 133 registry definitions,
including `restart_nas_api`; `apps/nas-mcp/src/index.ts` eagerly registers that
tool alongside `check_disk_space`. **One branch: `main`.** Push to `main` → GitHub Actions builds
per-app images → web/nas-mcp auto-redeploy via Coolify webhook; agent/nas-api are
picked up by Watchtower on each NAS within ~5 min. **Supabase** (project
`aaxtrlfpnoutziwhshlt`, us-east-1 / Virginia) is the shared data layer between
agent (writes) and web (reads). NAS API does not touch Supabase. **The backend
was migrated Ohio→Virginia on 2026-06-21. The old project `qnjimovrsaacneqkggsn`
was the rollback and has since been deleted — it no longer exists (verified
2026-07-16). Any doc, script, or env default still naming it is stale: `aaxtrlfpnoutziwhshlt`
is the only Supabase project for this app. Full details + cutover surface + gotchas
in [docs/supabase-virginia-migration-2026-06.md](docs/supabase-virginia-migration-2026-06.md).**

## 4. Repository structure

```
apps/
  agent/        Go — collectors + DSM client + SQLite WAL sender   (we own)
  nas-api/      Go — validator (allowlist/hard-blocks) + executor  (we own)
  nas-mcp/      Node/TS — MCP server + 133-definition tool registry           (we own; dist/ generated)
  web/          Next.js — dashboard + issue agent                  (we own src/; .next/ generated)
  relay/        Node .mjs — named-action proxy                     (we own)
packages/shared/ shared TS types + NAS tool definitions            (we own src/; dist/ generated)
supabase/migrations/  DB schema (00001..00041) — applied history   (we own; do not rewrite applied files)
supabase/functions/send-push/  Deno edge function                  (we own)
deploy/synology/      NAS compose + per-NAS env examples           (we own)
.github/workflows/    4 image-build workflows                      (we own)
docs/                 architecture / development / configuration / deployment / mcp-incident
scripts/              backfill-synobackup.mjs, check-dashboard-data.mjs
PLAN.md               historical design doc for the completed 3-stage issue-agent rebuild
```

Generated / not-source: `apps/web/.next/`, `apps/*/dist/`, `apps/nas-mcp/dist/`,
`packages/shared/dist/`, `.turbo/`, `node_modules/`. Vendored/framework: the
Next.js runtime surface under `apps/web/.next/`. Build artifacts: image layers (in
GHCR, not the repo).

## 5. Prime Directive: custom-code boundary

Our custom code lives here:

- `apps/agent/`, `apps/nas-api/`, `apps/nas-mcp/src/`, `apps/web/src/`, `apps/relay/`
- `packages/shared/src/`
- `supabase/migrations/`, `supabase/functions/`
- `deploy/synology/`, `.github/workflows/`, `docs/`, top-level `*.md`, `scripts/`

Everything else (`node_modules/`, `.next/`, `dist/`, `.turbo/`, lockfiles, the
Next.js framework surface) requires explicit justification before touching. Do not
scatter project logic into generated or framework files.

## 6. Core modification inventory

No files outside the project-owned areas (above) have been patched — there is no
forked vendor/framework code in this repo. All code is first-party; third-party
code is consumed only as dependencies (`node_modules`, Go modules) and base Docker
images. If you ever patch a vendored file, record it here.

| File | Change made | Why it was necessary | Risk during upgrades |
|---|---|---|---|
| — | — | — | — |

## 7. Task-to-file navigation: what to edit for common changes

| Task | Files to touch | Files NOT to touch |
|---|---|---|
| Add a NAS MCP tool | `packages/shared/src/nas-tools.ts` (def + `TOOL_GROUPS`), `apps/nas-mcp/tools-config.json` (enable) | `apps/nas-mcp/src/index.ts` (registry-driven; no registration needed) |
| Add an agent collector | `apps/agent/internal/collector/<name>.go`, wire in `apps/agent/cmd/agent/main.go` with the `wg.Add(1)` pattern | existing collectors |
| Send a new agent field to Supabase | `apps/agent/internal/sender/types.go` + a `Queue*` method, **and** a matching column via a new `supabase/migrations/*.sql` | applied migration files |
| Allow a new NAS command tier | `apps/nas-api/internal/validator/validator.go` (+ `validator_test.go`; Go/RE2 regex only, no lookaround/backrefs) | `executor.go` |
| Add a write capability that shells out to a **new binary** | `writePatterns` in `apps/nas-api/internal/validator/validator.go` — without an entry the command is tier 1 and auto-executes via `run_command`, whatever `write: true` says in `nas-tools.ts` (see §12 quirks) | assuming `write: true` alone gates execution |
| Change an AI pipeline stage | `apps/web/src/lib/server/ai/stage{1,2,3}-*.ts`, `pipeline-v2.ts` | `issue-detector.ts` fingerprinting |
| Change AI model per stage | Settings UI (live dropdowns) → `ai_settings` table; fallback chain in `apps/web/src/lib/server/ai-settings.ts` | hardcoded defaults |
| Add a selectable model / fix its capabilities | nothing — dropdowns are live from connected providers (`provider-models.ts` → `/api/ai-models`). To **tune** a model's effort/tool-use precisely, add a row to `MODEL_CATALOG` in `packages/shared/src/ai-capabilities.ts` (overrides the heuristic) | the live-fetch list logic unless adding a provider |
| Add a new log source to the agent | `apps/agent/internal/logwatcher/watcher.go` (`defaultLogFiles`) | No source whitelist to update (migration 00035 dropped it) |
| Add an env var | `apps/web/.env.example` and `apps/web/src/app/api/settings/route.ts` if it's an AI setting, `docs/configuration.md` | production env (lives in Coolify or NAS `.env`) |
| Add a DB migration | `supabase/migrations/000NN_description.sql` — next number after current max (00041) | applied migrations |
| Add a dashboard page | `apps/web/src/app/(dashboard)/<page>/page.tsx`, hook in `src/hooks/` | — |
| Add a nightly custom command | Insert into `custom_metric_schedules` DB table with `collection_command`, `interval_minutes`, `nas_id` | — |
| Change archive inventory (Phase 1) or archive move (Phase 2) | nas-api `internal/jobs/*` (Phase 1: scanner/manager/overlay; Phase 2: `move.go`/`dirs.go`/`manifest.go`/`btrfs.go`) + `cmd/server/main.go` routes; MCP tools in `packages/shared/src/nas-tools.ts` + `apps/nas-mcp/src/job-client.ts`; web `app/(dashboard)/archive-{inventory,move}/` + `app/api/archive/*` + `lib/server/nas-api-client.ts`. Share allowlist mirrored in Go `jobs.AllowedShares`, `packages/shared/src/archive.ts`, and the compose mounts. Move ops write via the `:rw` `/btrfs/volume1/<share>` mount; execute/rollback are tier 3 | `/exec` validator path (jobs are native REST, not shell); the `:ro` per-share `/volume1/<share>` mounts for writes |

## 8. Data model and external identifiers

Do not casually rename or regenerate these.

| Entity / System | Identifier | Where defined | Notes |
|---|---|---|---|
| Supabase project | `aaxtrlfpnoutziwhshlt` | Supabase | Postgres; 53 tables total |
| NAS 1 (`edgesynology1`) | id `4f1d7e2a-7d5d-4d5f-8b55-0f8efb0d1001`, Tailscale `100.107.131.35` | `deploy/synology/nas-1.env.example` | `nas_units.id` must match agent `NAS_ID` |
| NAS 2 (`edgesynology2`) | id `9dbd4646-5f4e-4fa0-8f44-1d0dbe6f1002`, Tailscale `100.107.131.36` | `deploy/synology/nas-2.env.example` | |
| NAS API port | `7734` | NAS `.env` (`NAS_API_PORT`) | HTTP over Tailscale |
| Coolify nas-mcp app | `efl17f5iocnz94840pexre9d` | **hardcoded** in `.github/workflows/nas-mcp-image.yml` | redeploy webhook target |
| Coolify web app | `${COOLIFY_WEBHOOK_UUID}` | GitHub secret (not in repo) | redeploy webhook target |
| Coolify API host | `http://178.156.180.212:8000` | both deploy workflows | VPS Coolify control plane |
| GHCR images | `ghcr.io/u2giants/synology-monitor-{agent,nas-api,nas-mcp,web}` | workflows | tags: `latest`, `sha-<sha>`, `main` |
| Public endpoints | `mon.designflow.app` (web), `nas-mcp.designflow.app/mcp` | Coolify/Traefik | |

## 9. Container and service inventory

| Container / service | Purpose | Managed by | App ID | Image / source |
|---|---|---|---|---|
| `synology-monitor-web` | Dashboard + issue agent | Coolify | `${COOLIFY_WEBHOOK_UUID}` (secret) | `ghcr.io/u2giants/synology-monitor-web:latest` |
| `synology-monitor-nas-mcp` | MCP server for AI chat clients | Coolify | `efl17f5iocnz94840pexre9d` | `ghcr.io/u2giants/synology-monitor-nas-mcp:latest` |
| `synology-monitor-relay` | External-client named-action proxy | Coolify (manual — see below) | — | `ghcr.io/u2giants/synology-monitor-relay` |
| `synology-monitor-agent` | Telemetry collector (per NAS) | Watchtower on NAS | — | `ghcr.io/u2giants/synology-monitor-agent:latest` |
| `synology-monitor-nas-api` | Approved-command executor (per NAS, :7734) | Watchtower on NAS | — | `ghcr.io/u2giants/synology-monitor-nas-api:latest` |
| `synology-monitor-watchtower` | Auto-updates agent + nas-api from GHCR (300s poll) | NAS compose | — | `containrrr/watchtower` |
| Supabase `aaxtrlfpnoutziwhshlt` | Telemetry + issue tables | Supabase | — | managed Postgres |

**Relay has no CI workflow** — there is no `.github/workflows/relay-*.yml`. The
relay image is not produced by the standard pipeline; it is built/deployed manually
on the VPS. Treat its deploy path as exceptional, not routine.

## 10. What to ignore

Not relevant to active development; do not read or index (already in
`.claudeignore` / `.cursorignore` / `.copilotignore`): `node_modules/`, `apps/*/node_modules/`,
`.next/`, `dist/`, `apps/*/dist/`, `.turbo/`, `.cache/`, `coverage/`,
`*.tsbuildinfo`, `pnpm-lock.yaml`, `package-lock.json`, `**/*.bak`, `evals/` (unless working on
agent evaluation), and the vestigial scratch file `ersahazan2Desktopsynology-monitor`.

## 11. Direct NAS maintenance safety

Direct SSH work on the production NASes is exceptional. It is acceptable only for
operator-requested diagnostics/maintenance, not as a deployment path. Avoid large
NAS crawls, timestamp repairs, archive moves, or other metadata-heavy operations
while SMB users are active.

Both NASes currently have Entware `ionice` installed at `/opt/bin/ionice`
(`edgesynology1` and `edgesynology2`, installed 2026-06-15). For any read-only
audit, snapshot comparison, timestamp repair, or other file-tree crawl on a NAS,
prefer the lowest-impact wrapper:

```sh
/opt/bin/ionice -c3 nice -n 19 <command>
```

Example:

```sh
/opt/bin/ionice -c3 nice -n 19 python3 /tmp/edges2_timestamp_audit.py
```

`ionice -c3` means idle I/O class. It reduces interference with normal NAS work,
but it does not make millions of metadata reads free. Schedule full audits and
repairs for quiet windows and verify Synology Drive/ShareSync has settled before
running archive moves.

Cross-NAS timestamp repair rule: use `edgesynology2` as evidence/authority only
unless the operator explicitly says otherwise. Apply timestamp repairs to
`edgesynology1` only, then let Synology Drive/ShareSync propagate or settle. Do
not "repair both sides" by default; touching both NASes can create competing
metadata events and may cause inode churn on `edgesynology1`.

Inspecting inside a container when `docker exec` is blocked: the validator blocks
all `docker` read/write from `run_command`. To read a containerized process's
files/logs from the host, go through its mount namespace at `/proc/<pid>/root/...`
and find its bind sources in `/proc/<pid>/mountinfo`. This is how the seaf-cli
inotify incident was diagnosed (see `docs/seafile-sync-inotify.md`). Scope `find`
per subtree — a whole-volume crawl times out the 25 s `run_command` budget.

`run_command` validator false-blocks (diagnostic gotchas, hit repeatedly 2026-06-21):
- The validator detects docker invocations by word boundary, so a literal path
  containing `/volume1/docker/...` is misread as a docker command and the whole call
  is rejected ("docker read command is not in the allowlist") **whenever a real
  `docker` command is also in the same call**. Run filesystem commands (`ls`/`cat`)
  and `docker` commands in **separate** `run_command` calls.
- A multi-line `--format` template — or one containing the string `com.docker.compose`
  — also trips it. Keep `docker inspect --format` single-line.
- Allowed read docker verbs are only `ps | inspect | logs | stats --no-stream | port |
  diff | top`. `docker image inspect`, `docker exec`, and `docker compose` are blocked.
- Reading a credential-style file (path containing `.env`) is hard-blocked.
- Mentioning the word `setfacl` anywhere in a command — even `which setfacl` — matches
  writePatterns and rejects the whole call. Same shape as the docker gotcha above.
- `synoacltool` classifies on the token right after the binary name, so assigning it to
  a shell variable (`B=/host/usr/syno/bin/synoacltool; $B -get ...`) reads as a
  verbless — therefore mutating — invocation and is refused. Call the binary directly
  with its verb. This fails closed by design (unknown verb ⇒ write); do not "fix" it by
  loosening the match. Verified on edgesynology1 2026-07-16: direct `-get`/`-stat` run
  at tier 1, the variable form does not.
- Unverified observation: `run_command`/nas-api did not see a newly-created subdir
  under `/volume1/docker` that the operator's own shell saw — verify fresh filesystem
  changes from the operator shell, not `run_command`.

## 12. Intentional quirks and non-obvious decisions

### seaf-cli reports "synchronized" while diverging (inotify watch exhaustion)
Looks like: a stale/corrupt Seafile index, "fixed" by restarting the daemon.
Actually: `fs.inotify.max_user_watches=8192` (default) is exhausted by the ~541k-dir
worktree (82% `@eaDir` thumbnails). The worktree monitor can't watch most dirs, so
edits there never fire change events and the daemon honestly reports synchronized
while blind. A restart only masks it (its one-time full scan resets the symptom; the
ceiling is still exhausted).
Future sessions should: NOT remediate by restarting the daemon. Raise the ceiling
(capability `set_inotify_watches`, default 1,048,576) — it is a ceiling, not an
allocation (~1 KiB pinned per watch *held*), so do NOT lower it "to save memory."
Full detail + runbook + the unresolved "does the monitor watch ignored dirs?"
question: `docs/seafile-sync-inotify.md`.

### Validator: redirect into `/btrfs/volumeN` is a tier-3 write
Looks like: a redundant filePattern next to the `/volume` ones.
Actually: nas-api writes user data via the writable `/btrfs/volume1` mount (per-share
`/volume1/<share>` mounts are `:ro`), and `stripQuotedStrings` hides quoted, spaced
redirect targets from `hasRealOutputRedirect`. Without the
`(>>?)\s*['"]?/(btrfs/)?volume\d+/` pattern (in BOTH writePatterns and filePatterns),
a content write like `printf ... > '/btrfs/volume1/x/seafile-ignore.txt'` would
classify below tier 3.
Do not remove: it only ever elevates classification (added for `write_seafile_ignore`).

### "The NAS is unreachable" is almost always a service, not the box
Looks like: a NAS is down — every probe fails, from the workstation and from the VPS.
Actually: **every** route this project has to a NAS goes over Tailscale — your workstation,
the VPS, and therefore `nas-mcp`/`run_command`. When a NAS's Tailscale client drops, all of
them fail at once, which reads as overwhelming evidence for "the host is down" while actually
being one fault counted several times. On 2026-07-08 `edgesynology2`'s Tailscale went offline;
a session concluded *"10s curl timeout from this workstation, and a 45s MCP timeout from the
VPS, so it is the host — not the network path"*, wrote it into `HANDOFF.md`, and the wrong
diagnosis stuck for over a week. The box was healthy the whole time.
Do this instead, before calling a NAS down:
- **Read the failure mode.** `timeout` = packets never arrived (network or host). `ECONNREFUSED`
  (`curl exit=7`) = they arrived and nothing is listening — that is a **stopped service**, and
  it proves the host is up.
- **Probe DSM from the other NAS over the LAN**, which does not involve Tailscale:
  `run_command target=edgesynology1 → curl -s -o /dev/null -m 6 -w '%{http_code}' http://192.168.3.101:5000/`
  (`edgesynology1` = 192.168.3.100, `edgesynology2` = 192.168.3.101, both behind 74.80.230.82).
  A 200 from DSM means the NAS is fine and you are chasing a service.
- **Ask Supabase.** `select name, status, last_seen, agent_version from nas_units` is an
  independent path that does not touch Tailscale at all: the agent pushes out to Supabase. If
  `last_seen` is current, the box, its Docker stack and Watchtower are all working.
- Watchtower cannot start a container that is not running. "Watchtower will pick it up" is only
  true once something is running to be updated. (Once it *is* running, Watchtower is quick: es2's
  nas-api went from a 2026-06-20 image to current within minutes of being started.)
- **SSH to a NAS is on a per-host port.** `ssh edgesynology1` = ahazan@100.107.131.35 **port 22**;
  `ssh edgesynology2` = ahazan@100.107.131.36 **port 1904**. Use the `~/.ssh/config` aliases.
  Probing port 22 on es2 gives connection-refused, which is **not** evidence SSH is disabled — a
  session concluded exactly that on 2026-07-16 and was wrong. The `192.168.3.x` LAN addresses are
  reachable only *from the other NAS*, never from a workstation. (SSH remains exceptional per
  § 11 — operator-requested diagnostics/maintenance only, never a deployment path.)
- **`sudo docker` on a NAS needs the absolute path.** `ahazan` has NOPASSWD for the literal path
  only, and `docker` is not on the non-interactive PATH:
  `sudo /var/packages/ContainerManager/target/usr/bin/docker ps -a`. Plain `sudo docker ps -a`
  answers *"a password is required"*, which reads as a hard wall and is not one. `/usr/local/bin/docker`
  is a symlink to the same binary but does not match the sudoers rule. Related trap: piping a
  failing sudo call into `grep x || echo "absent"` prints **absent** when the real failure was
  sudo — a session reported a container missing that was running fine. Check exit codes; do not
  trust an `||` fallback to distinguish "not found" from "did not run".

### `restart: unless-stopped` will not bring a container back after a reboot
Looks like: a reboot broke the container, or it crashed.
Actually: `edgesynology2`'s nas-api sat down from 2026-07-08 to 2026-07-16 and the cause was
mundane. It exited **143 (SIGTERM)** ~3 minutes before the reboot — clean stop, `RestartCount=0`,
no crash, two lines in its whole log. `unless-stopped` then did exactly what its name says:
unlike `always`, it deliberately does **not** restart a container that was explicitly stopped,
and that flag survives the daemon restart. So one container can stay down indefinitely while
every other container on the box returns, and nothing looks broken. Fixed with a single
`docker start` — no compose, no rebuild.
Do this: after any NAS reboot, `docker ps -a` and look for `Exited (143)` before theorising about
crashes, images, or networking. Why nas-api alone was stopped when agent/watchtower/popdam-bridge
all came back is **unknown** — DSM does not retain the attribution.

### The two NASes do not agree on the ACL model
Looks like: `edgesynology1` and `edgesynology2` are interchangeable Drive/ShareSync peers.
Actually: the same share can carry a Synology ACL on one and not the other. Verified 2026-07-16,
identical command on each — `synoacltool -get /volume1/mac` answers `It's Linux mode` on
**edgesynology1** but `ACL version: 1 / Archive: has_ACL,is_support_ACL` on **edgesynology2**.
That changes which lever actually governs access: POSIX ownership/mode on a Linux-mode path, an
ACE on an ACL path (where a `chown` may appear to succeed and change nothing observable).
Do this: check the path's mode before proposing a permissions remediation, and **verify
permission work on both NASes** — a result proven on es1 does not carry to es2. Most of the
2026-07-16 ACL/ownership verification ran on es1 only because es2's nas-api was down; do not
inherit that blind spot.

### There is no ACL-write tool, and `repair_path_ownership` can't write `/volume1`
Looks like: an oversight — `repair_path_acl` was removed and its neighbour survived.
Actually: a write tool can be approved, previewed, and audited and still be incapable
of writing anything, because the *container* decides that, not `nas-tools.ts`. Two
separate causes, both found 2026-07-16 by checking the tool against the image and the
mounts rather than against the validator:
- **Binary missing.** `repair_path_acl` shelled out to `setfacl`/`getfacl`, which the
  nas-api image never installed (no `acl` package in `apps/nas-api/Dockerfile`) and
  DSM does not ship. It could only ever print `command not found` under a tier-3
  approval. Installing `acl` would not have fixed it either: `/volume1` is mounted
  `synoacl`, *not* `acl` (verified on edgesynology1 2026-07-16 —
  `rw,ssd,synoacl,space_cache=v2,...`), so POSIX ACL calls are not what this
  filesystem enforces and `setfacl` would have failed on the mount even if present.
  DSM's own `synoacltool` is the native surface. Reading ACLs was never broken:
  `inspect_path_acl` / `inspect_effective_permissions` use `synoacltool -get`, and
  the image is Debian precisely so DSM's glibc binaries run. Note a share can still
  be in POSIX ("Linux") mode on a synoacl volume — `synoacltool -get /volume1/mac`
  answers `It's Linux mode` — so per-path ACL state is worth checking before
  assuming either model. A replacement write tool is a new capability, not a port:
  see the note in `nas-tools.ts` before adding one back.
- **Path read-only.** `repair_path_ownership` and `repair_drive_db_permissions` both
  target `/volumeN`, but the per-share `/volumeN` mounts are `:ro`, so they return
  `Read-only file system`. Only `/btrfs/volume1/<share>` is writable (mapping
  precedent: `write_seafile_ignore`).
- **Name unresolvable.** The same two also chown *named* accounts (`mac:users`,
  `SynologyDrive:SynologyDrive`). The container's `/etc/passwd` is Debian's own (18
  lines); the NAS's (55) is at `/host/etc/passwd`, and `/etc/group` is not mounted from
  the host at all. So NAS names do not resolve and `chown` fails `invalid user` —
  `stat` on `/volume1/mac` prints `UNKNOWN:users` for uid 1024. Only numeric `uid:gid`
  works today. Fixing this needs `/etc/group` added to the compose mounts plus a
  one-time `docker compose up -d` per NAS.

Both were **disabled in `tools-config.json` on 2026-07-16** rather than left
advertising a capability they do not have. They fail safely (no data change), but a
tier-3 preview that says a write is about to happen, from a tool that cannot write,
teaches the operator to click through approvals that mean nothing — that is the real
damage, and it is why "it only ever errors" is not a reason to leave one enabled.

**Checklist before trusting or adding any write tool** — the tier gates check none of
these, and `write: true` checks none of them either:
1. Is the binary actually in `apps/nas-api/Dockerfile`? (`setfacl` was not.)
2. Is the target path on a `:rw` mount? (`/volumeN` is `:ro`; `/btrfs/volumeN` is not.)
3. Do the identifiers resolve *inside the container*? (NAS users/groups do not.)
4. Has it been run once, for real, on a scratch path? If not, it is unproven.

### A new write capability needs a validator pattern, or it auto-executes
Looks like: `write: true` in `nas-tools.ts` is what makes a tool require approval.
Actually: `write: true` only makes `apps/nas-mcp` preview it. Whether the command is
allowed to run unattended is decided separately by `ClassifyTier` pattern-matching the
command *string* in `apps/nas-api/internal/validator/validator.go`. A command no
`writePatterns` entry describes is tier 1 — read-only, auto-execute. Nothing warns you.
This is also the only thing standing behind `run_command`, which takes no `confirmed`
argument and runs anything scoring tier 1.
Do not repeat this mistake: in July 2026 an audit of all 40 shell write tools against
the real classifier found btrfs missing **entirely** (so `create_prechange_snapshot`,
`start_btrfs_scrub`, and even a hand-written `btrfs subvolume delete` were tier 1),
plus `smartctl -t`/`-X` and `setfacl`. Fixed in `8e0971b`. When adding a capability
that shells out to a binary not already in `writePatterns`, add a pattern for its
mutating verbs and a `validator_test.go` case both ways (mutating elevates, read-only
stays tier 1 — these binaries serve both). Match verbs, not the binary name: `btrfs
subvolume list`, `smartctl -a`, and `getfacl` are diagnostics and must stay tier 1.

The gap is not closed by auditing *tools* alone — `run_command` takes any string, so
a binary no tool builds still needs a pattern. `setfacl` was gated in `8e0971b`, but
DSM's `synoacltool` — the ACL binary that actually works on these volumes, and the one
already in the agent's vocabulary via `inspect_path_acl` — was still unmatched, so a
hand-written `synoacltool -add /volume1/...` classified tier 1 and auto-executed.
Gated on 2026-07-16 by `synoacltoolMutates` in `validator.go`, which default-denies:
anything that is not exactly `-get` is a write. Prefer that shape over a verb
allowlist for binaries whose verb set can grow — an enumerated list fails *open* on a
verb DSM adds later, and failing open here means unattended execution.

### `confirmed: false` previews on the tool's write flag, not on tier
Looks like: `executePredefinedToolOnNas` should skip the preview for tier-1 commands
since nas-api considers them read-only.
Actually: the gate reads `!input.confirmed` for every `write: true` tool, deliberately
ignoring `preview.tier`. Tier only selects whether an HMAC approval token is built.
Why: the gate used to read `preview.tier >= 2 && !input.confirmed`, which handed the
safety decision to a classifier that had gaps (above). `create_prechange_snapshot` with
`confirmed: false` therefore executed a real snapshot instead of previewing, which made
"preview" untrustworthy across the whole write surface. Reported and fixed 2026-07-16
(`f4c8c7a`); detail in `docs/architecture.md`.
Do not "optimize" the preview away for tier-1 writes: `write: true` is a fact about the
tool, while the tier is an inference about a string. Both layers are kept because
neither covers the other — this gate cannot reach `run_command`, and the classifier can
have gaps.

### NAS MCP is fully stateless (FastMCP HTTP Stream)
Looks like: a bug — the server refuses to rely on persistent MCP session state.
Actually: deliberate. `apps/nas-mcp` uses TypeScript FastMCP with
`transportType: "httpStream"` and `stateless: true`.
Why: Coolify restarts wipe in-memory sessions; statelessness eliminates stale
session problems after redeploys, and avoids the claude.ai proxy's old 4-minute
hang class (see incidents).
Do not change because: stateful mode brings back session-resume bugs and forces
dynamic tool registration that Claude clients ignore.

### NAS MCP exposes 7 small tools but has a 133-definition registry
Looks like: most tools are broken/unregistered.
Actually: deliberate lazy-load. `tools/list` returns only `list_capabilities`,
`get_capability_details`, `tool_search`, `invoke_tool`, `run_command`,
`check_disk_space`, and `restart_nas_api`. Clients browse/search/detail on demand
and execute via `invoke_tool({name,target,args})`.
Why: pre-loading 133 schemas put ~50k tokens into every session and degraded it
after ~10–15 calls; lazy-load keeps the always-on surface compact.
Do not change because: it brings back session degradation. New always-on tools go
in `EAGER_TOOLS` in `index.ts`, accepting the context cost.

`tools-config.json` enables a subset of the 133 shared definitions. Always-on does
not mean separate from the registry: `check_disk_space` and `restart_nas_api` are
shared definitions that `apps/nas-mcp/src/index.ts` registers eagerly.

### `Connection: close` on every nas-api request (from nas-mcp/web)
Looks like: throws away HTTP keep-alive.
Actually: required — timed-out requests don't return their socket to undici's pool,
so after ~10–15 calls the pool exhausts and calls hang. NAS API is local over
Tailscale (sub-ms RTT), so re-handshake cost is negligible.

### Sender isolates one bad row instead of failing the whole batch
Looks like: extra complexity in `apps/agent/internal/sender/sender.go` (`postRows`).
Actually: required. PostgREST inserts a batch as one statement; one bad row rejects
all rows, and after 5 retries the WAL drops them. On a 4xx the sender re-sends each
row individually so good rows land and only the bad row is dropped.
Why: this exact failure silently froze log/alert ingestion for ~19h/23d (see
incidents). Do not revert to all-or-nothing batches.

### No source whitelist on `nas_logs` / `alerts`
Looks like: missing validation.
Actually: the `*_source_check` CHECK constraints were dropped (migration 00035).
They had to be hand-expanded every time a collector added a source and caused the
ingestion outage. The agent governs what it writes; the sender isolates bad rows.
Do not re-add a source whitelist.

### `check_backup_status` enumerates ~7 candidate log paths
Deliberate. On one NAS the canonical `synobackup.log` was stale (2024) while the
live log was in a per-task target dir. The tool lists every candidate with
mtime+size, tails the freshest, shows a staleness banner. A single-path bet returns
false-positive stale data.

### NAS API package restarts use the DSM WebAPI, not `synoservice`
`synoservice` was removed in DSM 7; restarts go through `SYNO.Core.Package`
stop+start, requiring `DSM_USERNAME`/`DSM_PASSWORD` in the NAS `.env`.

### Recursive grep on `@synologydrive` / `@SynologyDriveShareSync` is hard-blocked
A `grep -R` against Synology's internal stores ran 4d11h on production before
discovery. Blocked at the validator regardless of tier (see incidents).

### Executor kills the process group, not just bash
`Setpgid: true` + `syscall.Kill(-pid, SIGKILL)` + `WaitDelay: 2s`.
`exec.CommandContext` only kills the direct bash child, so `grep ... | head`
orphans `grep` on timeout. Combined with the hard-block, prevents the runaway.

### Collector goroutines must use the WaitGroup pattern
`wg.Add(1)` + `defer wg.Done()`. Without it, graceful shutdown returns before the
collector finishes, dropping in-flight WAL writes (the ShareSync collector had this
bug, commit `268b9c9`).

### `package_status` is the only merge-duplicates upsert
It's current-state (one row per NAS+package). All other telemetry tables are
append-only inserts.

### DB tables are unprefixed; two functions still carry `smon_`
Migration 00031 renamed all `smon_*` tables. Migration 00034 renamed 4 standalone
functions. Two helper functions (`smon_create_alert`, `smon_get_openai_key`) are
intentionally still `smon_`-prefixed because other functions call them by name.
Historical migrations (00002–00030) still contain `smon_` — do not rewrite them.

### HMAC approval tokens are never persisted
Stage 2 persists the action intent (command, tier, target, summary) but **never
the HMAC token**. The token is minted fresh at execution time in
`pipeline-v2.ts::executeApprovedAction`. Persisting tokens would cause 403s after
the 15-min expiry — the operator's approval window is often hours.

### NAS API requires `apparmor=unconfined` + `SYS_ADMIN`
Looks like: insecure container config.
Actually: required by DSM. Synology's container runtime rejects the default
AppArmor profile during init; `SYS_ADMIN` is required for `btrfs subvolume list`,
scrub, and snapshot operations. DSM constraint, not a choice.

### NAS API has `SYS_PTRACE` but `gdb` and `lldb` are hard-blocked
Looks like: contradictory — why grant ptrace and then block it?
Actually: `strace` and `/proc/PID/stack` (already readable with `SYS_ADMIN`) are the
safe ptrace operations. `gdb`/`lldb` are blocked because they can call arbitrary
functions in a traced process via `call system(...)` — a code-injection vector.
`strace_process` uses `-c` count mode only (syscall summary, no argument printing)
so no sensitive data is printed.
Do not change because: removing the `gdb`/`lldb` hard-blocks would allow an
AI-generated command to inject arbitrary code into live DSM processes.

### `/dev/sd*` and `/dev/md*` are individually named mounts, not the full `/dev` tree
Looks like: there should just be `- /dev:/dev:ro`.
Actually: individual named mounts (`/dev/sda:/dev/sda:ro`, ..., `/dev/md3:/dev/md3:ro`).
Why: Docker bind-mounts the source device at container start. If a source device
doesn't exist (empty drive bay), the compose `up` fails for the whole service.
Individual mounts let you comment out non-existent bays.
Do not change because: mounting the full `/dev` tree read-only would still expose
`/dev/mem`, `/dev/kmem`, and other sensitive kernel interfaces.

### The rename tools repeat the literal path on the `mv` line on purpose
Looks like: `rename_file_to_old` and `remove_invalid_chars` in
`packages/shared/src/nas-tools.ts` assign `src=<quoted path>` and then pointlessly
re-inline the same quoted literal on the `mv` line instead of using `mv "$src"`.
Obvious cleanup.
Actually: that duplication is the only reason these classify as tier 3. nas-api's
`ClassifyTier` (`apps/nas-api/internal/validator/validator.go`, `filePatterns`
~line 262) matches per line, and Go regexes do not cross newlines — it needs a
literal `/volumeN` path on the **same line** as the write verb. Measured:
`mv '/btrfs/volume1/mac/a.txt' …` → tier 3; `mv "$src" "$dest"` → **tier 2**.
Tier 2 still previews and still requires `confirmed:true` (`apps/nas-mcp/src/index.ts:170`),
but loses the approval token (`buildApprovalToken` fires on tier >= 2) — so the
"cleanup" silently weakens the approval on a root/`CAP_SYS_ADMIN` write with no
error and no failing build.
Do not assume because: the guard is not the comment. `apps/nas-api/internal/validator/nas_write_tools_contract_test.go`
feeds the real builder's output (via the golden `packages/shared/src/__fixtures__/nas-write-commands.golden.json`,
kept current by `nas-tools.golden.test.ts`) to the real classifier and fails on the
downgrade. Delete the duplication only once nas-api enforces a declared minimum tier
per tool, which removes the dependency on what the regex can see.
See the 2026-07-16 injection fix (`nas-tools: stop the rename tools executing injected
shell from filter paths`) — the same commit fixed a proven root RCE where a filter of
`/volume1/x$(touch /tmp/INJECTED).txt` executed the payload at word expansion, invisible
to `ClassifyTier`, under an approval that read "rename a file". Paths there go through
`quote()`; a raw path in a *double-quoted error message* is still an injection, because
the `||` branch runs precisely when the path is hostile.

### Watchtower updates images but NOT compose configuration
Looks like: after pushing `docker-compose.agent.yml` changes to `main`, the NAS
containers will pick them up like code changes.
Actually: Watchtower pulls the new image and restarts with the **existing compose
state** — it reads the current in-memory config, not the file on disk. New
capabilities (`cap_add`), volume mounts, env keys, etc. do not take effect until
`docker compose up -d` is run manually on the NAS with the updated compose file.
Do not assume because: this is how Docker Compose restart semantics work — container
recreation from a new image uses the last-applied compose spec, not the repo copy.

### AI-stage model dropdowns are live; `MODEL_CATALOG` is an override, not the menu
Looks like: `MODEL_CATALOG` in `packages/shared/src/ai-capabilities.ts` is the list
of selectable models, so a model missing from it (e.g. a new DeepSeek release)
can't be picked.
Actually: since 2026-06-02 the dropdowns are populated **live** from every connected
provider's list-models endpoint (`apps/web/src/lib/server/ai/provider-models.ts`,
served by `/api/ai-models`). `MODEL_CATALOG` is now a precise-metadata override +
offline/no-keys fallback. Catalog-miss ids get a *derived* descriptor (provider by
id prefix, cache style by provider, effort/tool-use by conservative id heuristics);
`callModel` resolves `catalog → derived → live-map` and only fails when no connected
provider offers the id.
Why: the curated list silently excluded any model not hand-added; the operator asked
for every connected provider's models to be selectable.
Do not change because: deleting `MODEL_CATALOG` or re-gating the dropdown to it
breaks precise effort/cache/tool-use metadata for the curated models and the
offline fallback. A selected model whose capabilities are derived is flagged with an
amber "inferred model" warning in the UI; to tune it exactly, add a catalog row.

### `issue_evidence` and `issue_evidence_items` are different tables
Looks like: `issue_evidence_items` is just the renamed `issue_evidence`.
Actually: entirely different purposes.
- `issue_evidence` (created 00022): curated human-readable notes (title/detail)
  written by the copilot, resolution API, and `seedIssueFromOrigin`.
- `issue_evidence_items` (created 00038): the lossless telemetry store for the
  3-stage pipeline. Written by Stage 1 and Stage 2 tool calls.
Do not query the wrong one for a given context.

### Drive client logs are at `/host/shares/@synologydrive/log/`
Looks like: the logwatcher's `WATCH_PATHS` default (`/host/volume1`) should cover
Drive logs.
Actually: the agent compose mounts `@synologydrive` at `/host/shares/@synologydrive`
(not under `/host/volume1`). `inferDriveLogFiles` prepends `/host/shares` first so
the glob resolves. The old watch-path attempt is kept as a harmless fallback.

### `drive_team_folders_partitioned` has no child partitions and receives no writes
Looks like: dead schema artifact.
Actually: forward infrastructure for pg_partman partition management when
`drive_team_folders` grows large enough. No child partitions created yet.
Do not drop it.

### `analyzeRecentLogs` (log-analyzer.ts) has no callers
Looks like: dead function.
Actually: orphaned when `/api/analysis` was rewritten to use `runIssueDetection`.
The `analysis_runs` and `analyzed_problems` tables remain for a potential future
AI clustering layer. The three former readers were migrated to `issues` (2026-05-31).

### `getSecondOpinionModel` and `getClusterModel` are exported but have no callers
Looks like: dead exports.
Actually: planned features. `getSecondOpinionModel` is for a second AI model
cross-checking Stage 2 diagnoses; it is explicitly deferred.
`getClusterModel` is the intended abstraction for `log-analyzer.ts`. Keep both.

### `/host/*` paths in agent container
Looks like: wrong paths.
Actually: the agent runs in Docker. The NAS host `/proc`, `/sys`, `/var/log` are
mounted read-only at `/host/proc`, `/host/sys`, `/host/log`. Shared folders are
at `/host/shares/<name>`. The `/host/` prefix keeps host and container namespaces
distinct. See `deploy/synology/docker-compose.agent.yml`.

### NAS API mount layout is not the same as the agent mount layout
Looks like: a read-only diagnostic should find DSM package files at
`/host/var/packages` or snapshots under `/volume1`.

Actually: the NAS API compose mounts host `/var/packages` at `/host/packages`, not
`/host/var/packages`. Full Btrfs data volumes are mounted at `/btrfs/volumeN` for
subvolume/snapshot commands; individual shared folders are mounted separately
under `/volume1/<share>` and may not expose system snapshot directories.

Why: Synology Container Manager rejects some top-level volume binds during
compose/UI recreates. The compose file uses narrower named mounts for shares,
package state, host libraries, and Btrfs volumes.

Do not change because: tools that only check `/volume1` or `/host/var/packages`
will miss Snapshot Replication state and scheduler/package artifacts on one NAS.
Read-only tools should check `/host/packages` and `/btrfs/volumeN`, and may use
DSM WebAPI read methods as a fallback when SQLite/config paths are not mounted.

## 13. Credentials and environment

Full reference: [docs/configuration.md](docs/configuration.md). No secret values
live in the repo (example files use placeholders; real values live in Coolify and
each NAS `.env`).

| Variable | Purpose | Stored where | Dev | Prod |
|---|---|---|---|---|
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Agent → Supabase | NAS `.env` | yes | yes |
| `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` | Web client (build-time bake) | GitHub secrets (build args) | yes | yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Web server-side writes | Coolify | yes | yes |
| `DSM_URL` / `DSM_USERNAME` / `DSM_PASSWORD` | Agent DSM API + nas-api WebAPI restarts | NAS `.env` | yes | yes |
| `NAS_API_SECRET` / `NAS_API_APPROVAL_SIGNING_KEY` | Nas-api auth + HMAC | NAS `.env` | yes | yes |
| `NAS_EDGE{1,2}_API_URL/_SECRET/_SIGNING_KEY` | Web + nas-mcp → nas-api | Coolify | yes | yes |
| `NAS_API_NAME` | Logical NAS name (`edgesynology1`/`edgesynology2`) stamped into inventory result CSVs + the signed canonical op string. **Distinct from the agent's `NAS_NAME`** (a heartbeat display name); reusing that would break tier-2 approval signatures | NAS `.env` | yes | yes |
| `NAS_API_JOBS_PATH` / `NAS_API_JOBS_DIR` | Host bind path / in-container dir for durable inventory job state (`/app/data/jobs`) | NAS `.env` (optional) | yes | yes |
| `MCP_BEARER_TOKEN` | Nas-mcp client auth | Coolify | yes | yes |
| `ANTHROPIC_API_KEY` | Stage 2 reasoning (Anthropic/Claude) | Coolify | yes | yes |
| `OPENAI_API_KEY` | Stage 1/3 + copilot fallback | Coolify | yes | yes |
| `GEMINI_API_KEY` | Gemini provider — **seeded default for Stage 1 & 3**; selectable for any stage; key also lists Gemini models in the live dropdowns (`GOOGLE_API_KEY` accepted) | Coolify | yes (for seeded defaults) | yes (for seeded defaults) |
| `DEEPSEEK_API_KEY` | DeepSeek provider — selectable for any stage; key lists DeepSeek models in the live dropdowns | Coolify | optional | optional |
| `DASHSCOPE_API_KEY` | Qwen/DashScope provider — selectable for any stage; key lists Qwen (and DashScope-hosted) models in the live dropdowns | Coolify | optional | optional |
| `OPENROUTER_API_KEY` | Copilot chat + the copilot model-picker (`/api/models`). NOT the 3-stage AI-stage dropdowns, which fetch each connected provider directly | Coolify | yes | yes |
| `ISSUE_WORKER_MODE` / `RUN_ISSUE_WORKER` / `ISSUE_WORKER_TOKEN` | Issue worker mode/auth | Coolify | no | depends |
| `COOLIFY_TOKEN` / `COOLIFY_WEBHOOK_UUID` | CI → Coolify redeploy | GitHub secrets | n/a | n/a |

NAS API URLs are Tailscale IPs; Tailscale must be connected for live NAS calls.

## 14. Deployment

Push to `main` → `.github/workflows/{agent,nas-api,nas-mcp,web}-image.yml` build
and push to GHCR (each has a `paths:` filter; tags `latest`, `sha-<sha>`, `main`):

- **web** and **nas-mcp**: workflow's final step calls the Coolify redeploy webhook
  (`GET http://178.156.180.212:8000/api/v1/deploy?uuid=...` with `COOLIFY_TOKEN`).
  nas-mcp UUID is hardcoded (`efl17f5iocnz94840pexre9d`); web's is `$COOLIFY_WEBHOOK_UUID`.
- **agent** and **nas-api**: no webhook. Watchtower polls GHCR every 300s and
  recreates. `NEXT_PUBLIC_SUPABASE_*` is baked at image build — changing it in
  Coolify after build has no effect; requires a new push to `main`.
- **relay**: no workflow; built/deployed manually on the VPS (exceptional).

**Compose-change caveat (archive inventory, 2026-06):** the Phase 1 file-inventory
job system added a durable `/app/data/jobs` bind mount and a `NAS_API_NAME` env to
the nas-api service in `docker-compose.agent.yml`. Watchtower applies new *images*,
not compose changes, so after that image ships the operator must run
`cd /volume1/docker/synology-monitor-agent && docker compose up -d` **once on each
NAS** to materialize the mount/env. Until then the `/jobs/inventory/*` endpoints
return `503` by design.

Runtime env lives in **Coolify** (VPS) and each NAS `.env` (agent/nas-api).
Rollback: redeploy a previous tag in Coolify, or pin `AGENT_IMAGE_TAG` to a SHA
on the NAS, or `git revert` + push. **SSH is not a routine deploy path** — public
SSH on the VPS is disabled by design; manual container rebuilds create drift.

## 15. Critical incidents

### 2026-05-29 — Log/alert ingestion silently frozen + pg_partman broken

What happened:
`nas_logs` stopped ingesting for about 19 hours; `alerts` stopped for about 23 days.

Impact:
Telemetry-derived issue detection and alert visibility were stale or incomplete.

Root cause:
Source-check whitelists rejected newer log sources; one bad row failed
the whole PostgREST batch → dropped after 5 retries. partman config pointed at
pre-rename `smon_*` parent names.

Recovery:
Dropped whitelists in migration 00035; sender now isolates bad rows;
corrected partman, reclaimed 3.34 GB.

Rule added to prevent recurrence:
No source whitelists; sender must isolate bad rows; empty tables are bugs.

### 2026-07-16 — `anon` could run arbitrary SQL and steal the AI key (SECURITY DEFINER + default grants)

What happened:
Seven `SECURITY DEFINER` functions in `public` were EXECUTE-able by `anon`. Verified
exploitable against production with nothing but the **public anon key** (it is baked into
the browser bundle at mon.designflow.app — anyone with devtools has it):
- `POST /rest/v1/rpc/exec_sql {"sql":"SELECT 1"}` → **HTTP 204, arbitrary SQL executed**
- `POST /rest/v1/rpc/smon_get_openai_key {}` → **HTTP 200, returned the live `sk-or-v1-…` key**

`exec_sql` is `SECURITY DEFINER` owned by `postgres`: that is arbitrary SQL as a
superuser-equivalent — `DROP TABLE`, read `auth.users`, exfiltrate anything — against a
database with **no rollback project**.

Root cause — **a `GRANT` does not restrict anything here**:
1. Postgres makes new functions EXECUTE-able by `PUBLIC` by default.
2. This project *also* has `ALTER DEFAULT PRIVILEGES` granting EXECUTE on new `public`
   functions to `anon` and `authenticated`.
3. PostgREST publishes every `public` function as an RPC endpoint.

So `00010`'s `grant execute on function exec_sql(text) to service_role` looked like a
restriction and was not — it added a role while `anon` kept the default grant. Only an
explicit `REVOKE` restricts. Migration `00042` reproduced the same mistake on day one.

**Rule — every `CREATE FUNCTION` in this repo must be followed by:**
```sql
REVOKE ALL ON FUNCTION <signature> FROM PUBLIC, anon, authenticated;
-- and only then GRANT to the roles that genuinely need it
```
`00043_revoke_anon_execute_on_security_definer.sql` closes the existing set and ends with
a guard that raises if any `SECURITY DEFINER` function in `public` is still anon-callable.
Keep that guard passing. Audit with:
```sql
SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege('anon',p.oid,'EXECUTE');
```
**The leaked `sk-or-v1-…` AI key must be rotated by the owner** — it was retrievable by
anyone with the anon key for as long as the function has existed.

### 2026-07-16 — the monitoring agent silently fell 80 minutes behind

What happened:
`process_snapshots` on edge1 was **~80 minutes stale and drifting ~8% further behind** —
measured by sampling `max(captured_at)` 180s apart. Every other table was current, and the
agent logged a steady `[sender] flushed 100 entries` with no errors, so it looked healthy.

Root cause — arithmetic, not a failure:
`flush()` called `flushTable()` **once** per table per 30s tick, and `flushTable` selected a
single `LIMIT batchSize` (100). That is **200 rows/min**. The process collector emits up to
`3×topN` = 60 rows / 15s = **240/min**. The deficit was structural, so *any* backlog was
permanent. `enforceWALLimit` deletes the oldest unsent entries past 200k rows — ~1 week out.

The trap for anyone fixing something like this:
`queue()` — which every collector calls — shares `s.mu` with `flush()`, and `flush()` held it
across every HTTP POST. So simply draining harder would have **stalled collection to fix
sending**. The lock must cover only short SQLite work, never network I/O.

Also found while fixing it: `enforceWALLimit` evicted oldest-first **before** deleting
exhausted (`attempts>=5`) rows, so exhausted rows inflated the count and healthy telemetry was
destroyed to make room for rows about to be deleted anyway.

Fixed in `8355599` (bounded round-robin drain, lock off the network path, eviction ordering,
backlog reporting). Verified: lag drained 4950s → 17s after rollout.

Rule added to prevent recurrence:
**A monitoring system that cannot see itself is the thing most likely to fail silently.** The
sender now reports pending/exhausted/evicted counts and **oldest-pending age per table** —
age, not just row count, because 20k rows was 80 minutes. Same lesson as the partman cron
below: steady, cheerful log lines are not evidence of health.

### 2026-07-16 — pg_partman silently dead for 48 days (`select` on a procedure)

What happened:
The pg_cron job `smon-partition-maintenance` runs `select public.run_maintenance_proc()`.
In pg_partman 5.x that is a **procedure**, not a function, so Postgres rejects it every
time: *"To call a procedure, use CALL."* **25 of 25 runs failed** — daily, since the cron
jobs were hand-recreated after the 2026-06-21 migration. `cron.job.active` was `true`, so
the dashboard looked healthy while nothing ran.

Impact:
No bounded partition has been created since `metrics_p20260606` (ends 2026-06-13). Every
`metrics` / `nas_logs` / `container_status` / `storage_snapshots` row since then lands in
the **DEFAULT** partition — and **partman retention never drops a DEFAULT partition**.
~8.4 GB / ~27M rows are immortal and growing, plus ~1.36 GB of expired bounded partitions
never dropped. The DB is 42 GB.

Root cause:
pg_partman v4 exposed `run_maintenance()` as a function; v5 added the
`run_maintenance_proc()` **procedure**. The job was recreated from memory with `select`.
A failing cron job is invisible unless you read `cron.job_run_details` — `active = true`
means "scheduled", not "working".

Rule added to prevent recurrence:
**A scheduled job is not a working job.** After recreating any pg_cron job, verify with
`SELECT status, return_message FROM cron.job_run_details WHERE jobid = <id> ORDER BY
start_time DESC LIMIT 3` — and for partman specifically, check that
`part_config.maintenance_last_run` actually advances. Both are cheap; neither was done.
Fix + backfill procedure: [docs/telemetry-retention.md](docs/telemetry-retention.md).

### 2026-06-22 — A day of DB work installed on the wrong Supabase project

What happened:
The telemetry-retention migration was installed, and a ~27.8M-row foreground purge
run, against `qnjimovrsaacneqkggsn` — the **retired Ohio project** — one day after the
Ohio→Virginia migration. The session reasoned that the old ref "matches the hardcoded
app URL and the 29GB baseline", and explicitly dismissed the checkout's
`supabase/.temp/linked-project.json` link to the live project as stale.

Impact:
All of it was lost when the old project was later deleted — the purge, the retention
functions, the hourly cron. The live database got nothing and still has no retention.
No data loss (the old project was already a rollback copy), but a full session wasted
and the size problem left unsolved for a month.

Root cause:
The repo lied. The ref-swap correcting 13 files was sitting **unapplied in a `git
stash`**, so every hardcoded URL still named the retired project and supplied
convincing false evidence. `scripts/run-telemetry-retention-cleanup.mjs` also had a
silent `DEFAULT_SUPABASE_URL` fallback pointing at the old project, so an unset
`SUPABASE_URL` aimed a bulk-delete job at it with no error. This section already said
not to point new work at the old project; the stale strings outvoted the doc.

Recovery:
Stash landed, default URL removed, guards added (2026-07-16, commit `46f9f65`).

Rule added to prevent recurrence:
**Trust `supabase projects list` and `supabase/.temp/linked-project.json` over any URL
committed in a doc, script default, or `.env.example`.** The connected tool knows
which project is real; a committed string only knows what was true when written. Never
give a destructive script a default target — make it fail loudly instead.

### 2026-05-29 — Live secrets found committed in example/recovery files

What happened:
Real NAS API secrets, relay tokens, Supabase service-role key, and a
NAS SSH password committed in example and recovery files.

Impact:
Those values must be treated as compromised even after redaction.

Root cause:
Example/recovery files contained live values instead of placeholders.

Recovery:
Values were redacted and `.env.runtime` was gitignored.

Rule added to prevent recurrence:
Never commit real secrets. **Leaked values remain in git history and MUST still be
rotated by the owner.**

### 2026-05 — 4-day runaway `grep -R` on production NAS

What happened:
A recursive `grep -R` against Synology internal stores ran for 4 days 11 hours on
production.

Impact:
The NAS spent excessive CPU/I/O on an AI-generated diagnostic command.

Root cause:
The validator allowed broad recursive grep and the executor killed only direct
children, not process groups.

Recovery:
Added validator hard-blocks and process-group kill in `executor.go`.

Rule added to prevent recurrence:
Recursive grep on Synology internal stores is hard-blocked; subprocess timeouts
kill process groups.

### 2026-05 — Claude MCP sessions hanging / failing

What happened:
Claude MCP sessions hung or failed around NAS MCP tool calls.

Impact:
AI clients waited until client-side timeouts instead of getting clear tool results.

Root cause:
Stateful transport/session behavior and stale HTTP connection reuse interacted
badly with client proxies and timed-out NAS API calls.

Recovery:
Stateless transport, `Connection: close`, bounded NAS API calls, and a 45s MCP tool
deadline.

Rule added to prevent recurrence:
Keep NAS MCP stateless and keep every NAS API/tool call bounded.

Full writeup: [docs/mcp-incident-2026-05.md](docs/mcp-incident-2026-05.md).

### 2026-06 — NAS API crash-loop from invalid Go regexp

What happened:
`nas-api` crash-looped after Watchtower pulled an image.

Impact:
MCP calls returned `ECONNREFUSED` to both NAS `:7734` endpoints.

Root cause:
The validator used PCRE-style negative lookahead `(?!...)` inside
`regexp.MustCompile`; Go RE2 does not support lookaround, so `nas-api` panicked
at startup.

Recovery:
Use RE2-safe positive regexes or Go helper code, add validator tests for both match
and exception cases, then verify `/health` on both NASes after `nas-api-image.yml`
publishes.

Rule added to prevent recurrence:
Do not use lookaround/backrefs in Go validator regexes; test validator patterns.

### 2026-06 — Read-only MCP probes missed DSM 7/NAS API paths

What happened:
`check_scheduled_tasks`, `list_snapshot_candidates`, and
`inspect_snapshot_replication` were safe to run but reported missing data because
they only checked legacy or agent-style paths.

Impact:
AI sessions could not confirm DSM scheduled tasks or Snapshot Replication
schedule/retention rules even though the package/runtime existed.

Root cause:
NAS API mount layout differs from the telemetry agent: package state is
under `/host/packages`, and the full Btrfs volume is under `/btrfs/volumeN`.

Recovery:
Widened read-only path discovery, opened SQLite with `-readonly`, added
DSM WebAPI read fallbacks for task and Snapshot/Replication API discovery, and
kept writes/start/cancel operations separate.

Rule added to prevent recurrence:
Read-only NAS tools must be narrow and
allowlisted, but they must cover the actual compose mounts before assuming DSM data
is absent.

### 2026-06 — Snapshot Replication probe exceeded NAS API command limit

What happened:
`inspect_snapshot_replication` was read-only, but it bundled too
much DSM WebAPI/config/SQLite discovery into one generated shell probe. The NAS
API rejects commands over 4096 bytes, so the MCP tool failed before reaching
either NAS.

Impact:
The tool failed before running on either NAS.

Root cause:
One generated shell command exceeded the NAS API `maxCommandLength`.

Recovery:
Keep `inspect_snapshot_replication` as a compact first-pass probe and
push deeper follow-up into separate read-only tools such as
`summarize_snapshots_by_share`, `check_scheduled_tasks`, and `fetch_package_db`.

Rule added to prevent recurrence:
Every generated NAS MCP command must stay under
the NAS API `maxCommandLength`; split broad diagnostics into smaller named tools
instead of raising the limit or packing everything into one shell command.

### 2026-05 — `check_backup_status` returning stale 2024 data

What happened:
`check_backup_status` returned stale 2024 data from a canonical log path.

Impact:
AI sessions could falsely conclude backup state from stale logs.

Root cause:
The live log existed in a per-task target directory rather than the canonical
`synobackup.log` path.

Recovery:
Added multi-path freshest-by-mtime discovery plus a staleness banner.

Rule added to prevent recurrence:
Backup diagnostics must enumerate candidate paths and surface freshness metadata.

## 16. Pending work

| Status | Item | Owner / next action |
|---|---|---|
| **open** | **Rotate leaked credentials** (NAS API secrets, relay tokens, Supabase service-role key, NAS SSH password) | Owner — values remain in git history |
| open | `analyzeRecentLogs` caller: decide whether to keep AI log clustering as a background job | Owner decision — readers already migrated to `issues` (2026-05-31) |
| open | `second_opinion_model`: wire a second AI model cross-check into Stage 2 | Future session — see `getSecondOpinionModel()` in `ai-settings.ts` |
| open | `drive_team_folders` reader: web app never queries team folder data | Future session |
| **open** | **ROTATE the AI provider key** (`sk-or-v1-…` in vault secret `smon_openai_api_key`) — it was returnable to anyone holding the public anon key via `smon_get_openai_key` until 2026-07-16. Access is closed (`00043`), but the key itself is compromised | **Owner** — rotate at OpenRouter, update the vault secret |
| open | `issue_resolutions` / `resolution_steps` / `resolution_log` / `resolution_messages`: confirmed superseded, not yet dropped | Owner confirm → **migration 00044** (00042 = telemetry retention, 00043 = anon REVOKE security fix) |
| done | **Agent ingestion deficit fixed** (`8355599`, deployed + verified 2026-07-16). `flushTable` took one `BATCH_SIZE` (100) batch per `FLUSH_TIMEOUT` (30s) per table and never drained → 200 rows/min vs the process collector's ~240/min, so `process_snapshots` was **~80 min stale and drifting**. Now a bounded round-robin drain (`MAX_FLUSH_DURATION`, `MAX_BATCHES_PER_FLUSH`) with `s.mu` off the network path, fixed `enforceWALLimit` ordering, and backlog reporting | Verified live: lag drained 4950s → **17s** monotonically after Watchtower rollout. **`stop_grace_period: 90s` still needs a one-time `docker compose up -d` per NAS** — Watchtower does not apply compose changes |
| **open** | **pg_partman dead since 2026-05-29** — cron `select`s a procedure (25/25 failures); ~8.4 GB stranded in DEFAULT partitions that retention can never drop, and growing. This is the **largest** DB-size driver | Owner/next session — one-word fix (`CALL`), but run `run_maintenance_proc()` **manually and watched** first (48d backlog, ~27M default rows to relocate). **Do NOT set `ignore_default_data=true`** — it makes partition creation fail, not skip. See `docs/telemetry-retention.md` |
| **open** | **Telemetry retention: installed, deletes paused.** `00042` + both indexes are live on `aaxtrlfpnoutziwhshlt`; 61k rows deleted to prove the path; **56.4M expired `process_snapshots` rows remain** (97% of a 16 GB table). Hourly cron deliberately **unscheduled** | Owner — approve the drain, but **check autovacuum/WAL first** and treat "~10 min" as a floor (see `docs/telemetry-retention.md`). **No rollback project exists — deletes are final** |
| **open** | **`cleanup_high_volume_telemetry` cannot commit between batches** — it is a *function*, so its batch loop is one transaction: up to **3.25M rows (13 policies × 10 × 25k) in a single txn** per hourly run. Do **not** schedule the cron as written | Future session — convert to a procedure that `COMMIT`s per batch (cron then uses `CALL`), or schedule one bounded batch more often. Capacity is ample (~22k rows/hr produced vs 250k/hr) |
| open | **Metrics page 30d disk I/O chart is broken independently of retention** — `useDiskIO` orders `ascending` with `.limit(2000)`, so it renders the *oldest* 2,000 rows (a few hours from 30 days ago), not 30 days. `disk_io_stats` is held at 35d purely for compatibility | Future session — downsample to hourly buckets via aggregate/RPC for long ranges; then `disk_io_stats` can drop to ~14d and reclaim more |
| **open** | `metrics` / `nas_logs` / `storage_snapshots` / `container_status` currently have **no retention from either mechanism** — they were left to partman, and partman is broken (row above) | Resolves itself once partman is fixed; until then, treat as unbounded growth |
| done | `00042` reader audit + fixes: `disk_io_stats` → 35d (protects the metrics page's 30d range); `CREATE INDEX` now `to_regclass`-guarded (previously hard-failed a rebuild); `metrics`/`nas_logs`/`storage_snapshots`/`container_status` left to pg_partman and all `part_config` writes removed, so the deliberate 180d `container_status` decision stands | 2026-07-16 — verified on throwaway PG17; rationale in `docs/telemetry-retention.md` |
| open | Relay has no CI build workflow | Decide: add workflow or document manual path as canonical |
| low | 2 DB functions still `smon_`-prefixed (`smon_create_alert`, `smon_get_openai_key`) | Low value; rename with caller updates |
| **open** | **Manual `docker compose up -d` on each NAS** — `SYS_PTRACE` + `/dev/sd*` mounts in `docker-compose.agent.yml` require a manual compose recreate; Watchtower will not apply these | Owner — run on each NAS after pulling new compose file |
| **open** | **First live archive-move validation** — the Btrfs snapshot + same-subvolume rename path is unit-tested via an injectable stub only; validate on a small real share (e.g. `Coldlion`) per `docs/archive-move-runbook.md` before trusting a real move. Also run the one-time jobs-mount `docker compose up -d` if not already done | Owner — follow the runbook |
| done | Archive feature: Phase 1 file inventory + Phase 2 staged reversible archive move (`/jobs/inventory/*`, `/jobs/archive-move/*`, 12 MCP tools, `/archive-inventory` + `/archive-move` pages) | 2026-06-07 — design/build/runbook in `docs/synology-archive*.md` + `docs/archive-move-runbook.md` |
| done | 3-stage issue-agent rebuild (structurer → reasoning core → explainer/memory) | Completed 2026-05-30 |
| done | `disk_inflight_ios` metric, Drive client log fix, Stage 2 `run_command` tool, nightly disk health schedules | 2026-05-31 |
| done | `backend-findings.ts` + `buildProblemPrompt` + `resolution/create` migrated from `analyzed_problems` to `issues` | 2026-05-31 |
| done | Ingestion fix + partman repair + smon cleanup + secret redaction | Migrations 00034/00035 |
| done | Deep iowait diagnostics: 9 new MCP tools (PSI, I/O scheduler, NFS client, strace, per-process IO detail, hdparm, set_io_scheduler, set_vm_dirty_ratios, set_ionice), Stage 1 evidence body fix, Stage 2 NAS taxonomy expansion, Metrics page Device Saturation + Container I/O + D-state + per-CPU iowait sections, `SYS_PTRACE` + individual `/dev` mounts in NAS API compose | 2026-06-01 |
| done | Safe read-only MCP expansion: unblocked diagnostics, hardened validator regexes, restored NAS API containers, widened DSM 7 scheduler/snapshot discovery, and added Snapshot Replication read-only WebAPI/config discovery | Commits `ff73e58`, `a2ce0bd`, `2ad8f52`, `93b82b2` |
| done | Compact `inspect_snapshot_replication` so the generated NAS API command stays under the 4096-byte `maxCommandLength`; split deeper work into separate read-only tools | Commit `d65047a` |
| done | De-curate AI-stage model dropdowns: live per-provider model lists (`provider-models.ts` → `/api/ai-models`), `MODEL_CATALOG` demoted to metadata override + fallback, runtime resolves `catalog → derived → live-map`, "inferred model" UI warning | Commits `4f8ee0e`, `4ea43f3` (2026-06-02) |

## 17. Non-negotiable rules

- Commit only to `main`; never create feature branches.
- Do not build Docker images manually on the VPS/NAS. Container restarts or
  `docker compose up -d` are exceptional recovery/config-application steps only
  (for example, applying compose mount/capability changes or recovering a crashed
  NAS API) and must be reflected in the repo/docs.
- Do not manage DSM Container Manager containers through ad hoc Docker CLI
  lifecycle commands from monitor features. Use backend-owned DSM WebAPI
  (`SYNO.Docker.Container`) status/start/stop paths instead. CLI/compose
  mutations can make the DSM Container Manager GUI report stale or wrong state.
- Do not hotfix the live NAS/VPS and commit after the fact.
- Runtime env changes belong in Coolify — apply them directly through the Coolify API or UI. Do not route them through GitHub Actions shell commands, SSH, or server-side scripts (see `AI_OPERATING_RULES.md`).
- Do not add a sender payload field without a matching Supabase column/migration.
- Do not interpret an empty Supabase table as a healthy subsystem — a collector may
  be hitting an unsupported DSM API. Check `nas_logs` for API-unavailable warnings.
- Do not commit real secrets, even to `*.env.example`.
- Do not undo the §12 intentional quirks without reading the linked incident first.
<!-- ansible-host-policy: managed rollout from u2giants/ansible -->
## Host / server changes — do NOT make them here

The `hetz` server's host/OS layer is managed by **Ansible** in **[`u2giants/ansible`](https://github.com/u2giants/ansible)**.
To change the server (packages, users, firewall, DNS, Docker *engine* config, system cron,
systemd units, Cloudflare Tunnel 1, the backup watchdog), **open a PR there** and let CI apply
it — **never** SSH into the box and hand-edit it. Manual changes are drift and get reverted by
the next apply. See [`u2giants/ansible/AGENTS.md`](https://github.com/u2giants/ansible/blob/main/AGENTS.md).

This repo is **not** the host layer. Its own changes belong here and deploy through their normal
pipeline (e.g. Coolify). Don't put host-level changes here, and don't manage this service's
container with Ansible. Scope boundary: **Ansible owns the host; Coolify owns the apps.**
