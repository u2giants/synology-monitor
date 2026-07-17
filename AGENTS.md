# Synology Monitor — Agent and Developer Operating Guide

This is the canonical operating guide and documentation router for
`u2giants/synology-monitor`. Read it before changing the repository. Load deeper
documentation only for the task at hand.

## Project summary

Synology Monitor helps POP Creations operate two production Synology NAS units.
A Go agent on each NAS sends telemetry to Supabase; a Next.js dashboard at
`mon.designflow.app` turns that data into issues and runs a three-stage AI
diagnostic pipeline; a NAS API and MCP server expose guarded diagnostics and
operator-approved repairs. The important outcome is trustworthy detection and
safe remediation of storage, Synology Drive/ShareSync, backup, and file-access
problems without disrupting SMB users.

Repository: `https://github.com/u2giants/synology-monitor`. Branch: `main` only.

## Multi-model AI note

There is no universal ignore-file standard across AI coding tools.

`.claudeignore` works for Claude Code.

When using any other AI tool, paste this file as your first message and follow the instructions in the "What to ignore" section.

## Documentation map: what to read for each task

Always start with:

- `AGENTS.md`

Then load additional docs only when relevant:

| Task / question | Read these docs | Usually do not need |
|---|---|---|
| Quick repo orientation | `README.md`, `AGENTS.md` | Deep docs under `docs/` |
| Modify app behavior or project-owned code | Relevant folder README; `docs/architecture.md` if design changes | Deployment docs unless rollout changes |
| Add or change a NAS MCP capability | `apps/nas-mcp/README.md`, `docs/architecture.md`, `docs/development.md` | Web deployment details |
| Change agent or NAS API behavior | `docs/architecture.md`, `docs/development.md`, `deploy/synology/README.md` if mounts/env change | Unrelated web docs |
| Add or change configuration, env vars, feature flags, secrets, or runtime settings | `docs/configuration.md`; `docs/deployment.md` for production | Incident histories |
| Change local setup, scripts, tests, lint, or package tooling | `docs/development.md`, relevant package files | Production deployment docs |
| Change deployment, Docker, CI/CD, hosting, rollback, or runtime environment | `docs/deployment.md`, `docs/configuration.md`, relevant workflow/compose files | Local debugging sections |
| Change database schema, migrations, models, auth/RLS, or data flow | `docs/architecture.md`, `docs/configuration.md`, relevant migration, `docs/telemetry-retention.md` when applicable | Unrelated NAS docs |
| Continue unfinished work | `HANDOFF.md` plus only the docs it names | Completed historical plans |
| Investigate an incident | Relevant file under `docs/*incident*`, `HANDOFF.md` if active, topic doc | Other incident files |
| Archive inventory or move | `docs/synology-archive.md`, `docs/synology-archive-implementation.md`, `docs/archive-move-runbook.md` | AI pipeline details |
| Seafile/inotify work | `docs/seafile-sync-inotify.md` | Archive and web docs |
| Telemetry retention or pg_partman | `docs/telemetry-retention.md`, `docs/supabase-virginia-migration-2026-06.md` | NAS filesystem docs |
| Relay behavior or recovery | `apps/relay/README.md`, `apps/relay/OPERATIONS.md`, `docs/architecture.md` relay section | Unrelated NAS MCP internals |
| Work in a folder with its own README | That README and only the broader docs it links | Other folder READMEs |
| Claude Code session | `CLAUDE.md`, then this file | All docs by default |
| Documentation-only cleanup | This file, `README.md`, affected topic docs | Source except what verifies facts |

`PLAN.md` is historical context for the completed issue-agent rebuild. It is not
current implementation guidance.

## Repository structure

| Path | Ownership / role |
|---|---|
| `apps/agent/` | Project-owned Go telemetry agent; runs on each NAS |
| `apps/nas-api/` | Project-owned Go command validator/executor and native archive jobs; runs on each NAS |
| `apps/nas-mcp/` | Project-owned FastMCP server; runs in Coolify |
| `apps/web/` | Project-owned Next.js dashboard and AI pipeline; runs in Coolify |
| `apps/relay/` | Project-owned narrow named-action relay; exceptional/manual deployment |
| `packages/shared/src/` | Shared TypeScript types, AI capabilities, archive contracts, and 132 NAS tool definitions |
| `supabase/migrations/` | Append-only database migrations, currently `00000` through `00043` |
| `supabase/functions/` | Project-owned Supabase Edge Functions |
| `deploy/synology/` | Canonical NAS compose and environment examples |
| `.github/workflows/` | Image build/publish and deploy triggers |
| `scripts/` | Operational checks and telemetry-retention runner |
| `docs/` | Topic-specific durable documentation and incident records |
| `evals/` | Agent evaluation fixtures; load only for evaluation work |

Generated or third-party content includes `node_modules/`, `.next/`, `dist/`,
`.turbo/`, `coverage/`, `*.tsbuildinfo`, Go build outputs, and lockfiles. Do not
put product logic there.

## Prime Directive: custom-code boundary

Our custom code lives here:

- `apps/agent/`
- `apps/nas-api/`
- `apps/nas-mcp/src/` and `apps/nas-mcp/tools-config.json`
- `apps/web/src/` and `apps/web/scripts/`
- `apps/relay/src/`
- `packages/shared/src/`
- `supabase/migrations/` and `supabase/functions/`
- `deploy/synology/`
- `.github/workflows/`
- `scripts/`, `docs/`, and top-level maintained Markdown

Everything else requires justification before touching. Never patch generated,
vendored, framework, or dependency files to implement product behavior.

## Core modification inventory

No project behavior is intentionally patched outside the project-owned areas
listed above.

| File | Change made | Why it was necessary | Risk during upgrades |
|---|---|---|---|
| N/A | No vendor/framework modifications | All behavior is first-party | Recheck this table if a future exception is introduced |

## Task-to-file navigation: what to edit for common changes

| Task | Files to touch | Files not to touch |
|---|---|---|
| Add a NAS MCP tool | `packages/shared/src/nas-tools.ts`, `TOOL_GROUPS`, `apps/nas-mcp/tools-config.json`, safety/golden tests | Generated `dist/`; eager registry unless the tool truly must be always-on |
| Add a shell write capability | Above plus `apps/nas-api/internal/validator/validator.go` and tests | Assuming `write: true` alone enforces the NAS API tier |
| Add an agent collector | `apps/agent/internal/collector/`, wire in `apps/agent/cmd/agent/main.go` | Existing collectors unrelated to the metric |
| Add telemetry fields | Agent sender/types, a new migration, web readers/types as needed | Applied migrations |
| Change AI stages | `apps/web/src/lib/server/ai/stage{1,2,3}-*.ts`, `pipeline-v2.ts`, guard tests | Historical `PLAN.md` as implementation source |
| Tune model capabilities | `packages/shared/src/ai-capabilities.ts` | Hard-coded dropdown lists; provider models are fetched live |
| Add a config value | Relevant `.env.example`, code reader, `docs/configuration.md`; deployment doc if runtime changes | Production secrets in repository files |
| Add a migration | New `supabase/migrations/000NN_*.sql`; next number after `00043` | Any existing migration that may have run |
| Change archive jobs | `apps/nas-api/internal/jobs/`, NAS routes, shared archive contract, MCP/web clients | Generic shell `/exec` path for native jobs |
| Change CI/deploy | Matching `.github/workflows/*.yml`, Dockerfile/compose, `docs/deployment.md` | Direct production host edits |

Any shared Supabase schema, RLS, RPC, trigger, or cross-app data-contract change
must also be authored/mirrored in `u2giants/shared-db` under its branch-and-PR
workflow. This documentation-only overhaul makes no database change.

## Data model and external identifiers

Do not casually rename or regenerate these identifiers.

| Entity/System | Identifier | Where defined | Notes |
|---|---|---|---|
| Supabase project | `aaxtrlfpnoutziwhshlt` | Supabase / env | Virginia (`us-east-1`); only live project |
| Deleted Supabase project | `qnjimovrsaacneqkggsn` | Historical docs only | Ohio rollback project; must never be used |
| NAS 1 | `edgesynology1`; id `4f1d7e2a-7d5d-4d5f-8b55-0f8efb0d1001`; Tailscale `100.107.131.35` | `deploy/synology/nas-1.env.example` | SSH alias uses port 22 |
| NAS 2 | `edgesynology2`; id `9dbd4646-5f4e-4fa0-8f44-1d0dbe6f1002`; Tailscale `100.107.131.36` | `deploy/synology/nas-2.env.example` | SSH alias uses port 1904 |
| NAS API | port `7734` | NAS env / compose | Health endpoint returns `build_sha` |
| Web | `mon.designflow.app` | Coolify | Production dashboard |
| NAS MCP | `nas-mcp.designflow.app/mcp` | Coolify / client config | MCP server name is `synology-monitor` |
| Relay | `mon.designflow.app/relay` | `apps/relay/README.md` | `/health` verified 2026-07-17; protected catalog returns 401 without auth |
| NAS MCP Coolify app | `efl17f5iocnz94840pexre9d` | `nas-mcp-image.yml` | Current deploy target |
| GHCR images | `synology-monitor-{agent,nas-api,nas-mcp,web}` | Workflows | Tags include `latest`, branch, and SHA |
| Issue evidence | `issue_evidence` vs `issue_evidence_items` | Migrations / AI pipeline | Distinct tables; do not merge conceptually |

Database relationships and data flow belong in `docs/architecture.md`. The live
backend migration and retention state belong in the two dedicated Supabase docs.

## Container and service inventory

| Container/service | Purpose | Managed by | App/project ID | Image/source |
|---|---|---|---|---|
| `synology-monitor-web` | Dashboard and AI issue agent | Coolify | Secret `COOLIFY_WEBHOOK_UUID` | `ghcr.io/u2giants/synology-monitor-web` |
| `synology-monitor-nas-mcp` | Lazy-loaded NAS tool server | Coolify | `efl17f5iocnz94840pexre9d` | `ghcr.io/u2giants/synology-monitor-nas-mcp` |
| `synology-monitor-agent` | Telemetry collection, one per NAS | NAS compose + Watchtower | N/A | `ghcr.io/u2giants/synology-monitor-agent` |
| `synology-monitor-nas-api` | Guarded NAS operations and archive jobs, one per NAS | NAS compose + Watchtower | N/A | `ghcr.io/u2giants/synology-monitor-nas-api` |
| `synology-monitor-watchtower` | Polls agent/API images every five minutes | NAS compose | N/A | `containrrr/watchtower` |
| `synology-monitor-relay` | Narrow external-client action proxy | Exceptional/manual Coolify path | Unknown; verify in Coolify | `apps/relay/` |
| Supabase | Telemetry, issues, AI state, configuration | Supabase | `aaxtrlfpnoutziwhshlt` | Managed Postgres |

## What to ignore

Do not load or index these unless the task explicitly needs them:

- `node_modules/`, `apps/*/node_modules/`
- `.next/`, `dist/`, `apps/*/dist/`, `out/`
- `.turbo/`, `.cache/`, `coverage/`, `*.tsbuildinfo`, `next-env.d.ts`
- `pnpm-lock.yaml`, `package-lock.json` except dependency-resolution work
- `supabase/.temp/`, `apps/agent/data/`
- `.claude/worktrees/`, editor/OS files
- `evals/` except evaluation work
- `*.bak` and the vestigial `ersahazan2Desktopsynology-monitor` if regenerated

`.claudeignore`, `.cursorignore`, and `.copilotignore` mirror this list.

## Intentional quirks and non-obvious decisions

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

### Literal paths repeat on tier-3 write lines

Looks like:
`mv`/`chown` commands should use only a previously assigned shell variable.

Actually:
The validator matches each command line and needs a literal `/btrfs/volumeN/...`
beside the write verb to classify user-data writes as tier 3.

Why:
Go regexes do not cross newlines; the shared golden fixture locks this contract.

Do not change because:
Hoisting the path entirely into a variable silently downgrades approval strength.

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

### Watchtower cannot apply compose changes

Looks like:
Pushing a compose edit updates the NAS automatically.

Actually:
Watchtower replaces images only. The live NAS file is
`/volume1/docker/synology-monitor-agent/compose.yaml` and is a manual copy of
`deploy/synology/docker-compose.agent.yml`.

Why:
No workflow distributes NAS compose files.

Do not change because:
New mounts, capabilities, and env keys require a deliberate one-time compose
recreation on each NAS. Preserve each NAS's `.env` and local compose differences.

### `restart: unless-stopped` preserves an explicit stop across reboot

Looks like:
A NAS reboot should restart every configured service.

Actually:
An explicitly stopped container remains stopped; `edgesynology2` demonstrated this
with nas-api in July 2026.

Why:
That is Docker's intended `unless-stopped` behavior.

Do not change because:
Diagnose `Exited (143)` and operator intent before changing restart policy.

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

## Credentials and environment

Never commit secret values. Production runtime values live in Coolify or each NAS's
untracked `.env`; CI values live in GitHub Secrets; human-accessible secrets live in
1Password vault `vibe_coding`.

| Variable/group | Purpose | Stored where | Required in dev | Required in prod |
|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser Supabase access | Local web env / Coolify; also GitHub build secrets | yes for web | yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Privileged web/server DB access | Local web env / Coolify | yes for full web | yes |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Agent/scripts DB writes | NAS `.env` / 1Password-backed command env | for agent/scripts | yes on NAS |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`/`GEMINI_API_KEY`, optional provider keys/base URLs | AI providers | Local web env / Coolify | at least one for AI | as configured |
| `NAS_EDGE{1,2}_API_URL`, `_SECRET`, `_SIGNING_KEY` | Web/MCP/relay access and tier-3 approval | Local env / Coolify | yes for live NAS calls | yes |
| `NAS_API_SECRET`, `NAS_API_APPROVAL_SIGNING_KEY`, `NAS_API_NAME`, `NAS_API_PORT` | Per-NAS API auth and identity | NAS `.env` | no | yes |
| `NAS_ID`, `NAS_NAME`, `DSM_*`, `AGENT_IMAGE_TAG`, `TZ` | Agent identity, DSM access, image/runtime | NAS `.env` | agent only | yes |
| `MCP_BEARER_TOKEN`, `MCP_PORT` | Public NAS MCP auth/listen port | Coolify and client secret config | MCP only | yes |
| `ISSUE_WORKER_*`, `RUN_ISSUE_WORKER` | Background issue processing | Local web env / Coolify | optional | deployment-specific |
| `COPILOT_ACTION_SIGNING_KEY`, `COPILOT_ADMIN_EMAILS` | Dashboard copilot action authorization | Local web env / Coolify | optional | when feature enabled |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Browser push subscription | Local web env / Coolify/build | optional | when push enabled |
| `RELAY_*`, relay `NAS_EDGE*` values | Relay auth, origins, upstreams | Relay runtime env | relay only | relay only |
| `COOLIFY_TOKEN`, `COOLIFY_WEBHOOK_UUID`, GitHub `GITHUB_TOKEN` | CI publish/redeploy | GitHub Secrets | no | CI only |

The exhaustive variable-by-service reference is `docs/configuration.md`. Secret
retrieval procedures are in `docs/1password.md`.

## Deployment

Normal path: commit to `main` → a path-filtered GitHub Actions workflow tests and
publishes GHCR images → runtime owner updates the service.

| Workflow | Image | Verification gate | Runtime trigger |
|---|---|---|---|
| `Publish Agent Image` | `synology-monitor-agent` | `go vet`, `go test` | Watchtower on both NASes |
| `Publish NAS API Image` | `synology-monitor-nas-api` | `go vet`, `go test`, cross-language tier golden | Watchtower on both NASes |
| `Publish NAS MCP Image` | `synology-monitor-nas-mcp` | shared tool-catalog tests | workflow calls current Coolify deploy API |
| `Publish Web Image` | `synology-monitor-web` | AI cache guards + image build | workflow calls current Coolify deploy API |

Tags are `latest`, branch, and `sha-*`. Web public Supabase values are Docker
build arguments; runtime secrets remain in Coolify. Roll back Coolify services to
a known SHA image; pin `AGENT_IMAGE_TAG` for NAS rollback and recreate deliberately.

Routine SSH deployment is forbidden. NAS SSH is allowed only for explicitly
requested diagnostics, safe maintenance, compose materialization, or recovery.
Durable VPS/host changes belong in `u2giants/ansible`, not this repo. Full commands,
rollback, health checks, and compose exceptions are in `docs/deployment.md`.

## Direct NAS maintenance safety

- Use SSH aliases `edgesynology1` and `edgesynology2`; do not hand-build addresses.
- Non-interactive Docker requires
  `/var/packages/ContainerManager/target/usr/bin/docker` under `sudo`.
- For metadata-heavy reads use `/opt/bin/ionice -c3 nice -n 19 <command>`.
- Avoid large crawls, recursive ownership changes, archive moves, or timestamp work
  while SMB users are active.
- For cross-NAS timestamp repair, use `edgesynology2` as evidence and write only
  `edgesynology1` unless the operator explicitly authorizes both.
- Timeout means the route/host may be unreachable; connection refused means the
  host answered but no service listens. Check DSM and `docker ps -a` before calling
  a NAS down.

## Critical incidents

### 2026-07-16 — anonymous SQL execution exposed the AI key

What happened:
A `SECURITY DEFINER` SQL executor retained default execute grants.

Impact:
The anonymous role could run arbitrary SQL and read stored AI credentials.

Root cause:
Function ownership was hardened without revoking default grants.

Recovery:
Live grants were revoked and migration `00043` records the fix.

Rule added to prevent recurrence:
Every privileged function needs explicit role tests and revoked `PUBLIC`/`anon`
execute grants. Rotation follow-up remains in `HANDOFF.md`.

### 2026-07-16 — agent ingestion fell roughly 80 minutes behind

What happened:
Large mixed inserts repeatedly retried one bad row and shutdown truncated flushing.

Impact:
Telemetry looked current enough to trust while lag kept growing.

Root cause:
Whole-batch retry and a ten-second container stop window.

Recovery:
Batch isolation shipped and `stop_grace_period: 90s` was materialized on both NASes.

Rule added to prevent recurrence:
Alert on ingestion age, isolate rejected rows, and verify compose-only changes live.

### 2026-06-22 — retention work targeted the deleted Ohio project

What happened:
Stale repository references pointed database work at the rollback project.

Impact:
The live Virginia backend received none of the intended retention work.

Root cause:
Stashed stale project references and an unsafe script fallback.

Recovery:
All active references now use `aaxtrlfpnoutziwhshlt`; the runner requires an
explicit URL and rejects the retired ref.

Rule added to prevent recurrence:
Log and verify the project ref before database work. See the migration and retention docs.

### 2026-05-29 — ingestion freeze and pg_partman failure

What happened:
One invalid log row stalled a batch, while pg_partman cron called a procedure with
`SELECT` and failed repeatedly.

Impact:
Logs/alerts froze and partition defaults accumulated millions of rows.

Root cause:
Silent batch retry and an invalid maintenance invocation.

Recovery:
Sender isolation fixed ingestion; pg_partman recovery remains active work.

Rule added to prevent recurrence:
No silent fallback, monitor freshness/cron results, and run maintenance manually
under observation before re-enabling cron. See `docs/telemetry-retention.md`.

### 2026-05 — secrets committed and MCP/NAS diagnostics overloaded production

What happened:
Recovery/example files contained live credentials; separate recursive diagnostics
ran for days and MCP sessions hung.

Impact:
Credential rotation and production NAS load were required.

Root cause:
Inadequate ignore/secret discipline and unbounded recursive commands.

Recovery:
Secrets were rotated, `.mcp.json` is ignored, recursive internal-store scans are
hard-blocked, and MCP became stateless/lazy-loaded.

Rule added to prevent recurrence:
Use 1Password references, never commit runtime env, and bound NAS diagnostics.
Detailed evidence is in `docs/mcp-incident-2026-05.md` and the Synology incident docs.

## Pending work

`HANDOFF.md` is required because work remains unfinished. Treat it as current over
older plan/incident prose.

| Status | Item | Owner / next action |
|---|---|---|
| partial | Repair nine archive directory mtimes | Follow the exact authority-only procedure in `HANDOFF.md`; write only NAS 1 |
| partial | Complete Seafile inotify remediation | Run and verify `docs/seafile-sync-inotify.md` on the live worktree |
| partial | Drain expired telemetry and repair pg_partman | Owner decision plus watched procedures in `docs/telemetry-retention.md` |
| open | Rotate the AI key exposed by the former anonymous SQL path | Owner-approved rotation through 1Password/Coolify |
| scheduled | Review `nas_logs` database share | Run the documented check on 2026-08-17 or four weeks after retention goes live |

Remove completed items from `HANDOFF.md`; delete the file only when every remaining
continuation item is truly complete.

## Non-negotiable rules

1. GitHub `main` is code truth. Check for concurrent work before pull/commit/push.
2. Root-cause fixes only; loud failures instead of silent fallback.
3. Add tests for code created and visually verify UI work.
4. Do not hard-code configurable settings or model choices.
5. Applied migrations are immutable; new database work gets a new migration and
   the shared-db mirror/PR where applicable.
6. Never store secret values in code, docs, commits, or generated examples.
7. Host/OS configuration belongs in `u2giants/ansible`; routine server SSH deploys
   are forbidden.
8. Report completion with commit SHA, workflow outcome, and live SHA/health evidence.
