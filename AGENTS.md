# Synology Monitor — Agent and Developer Operating Guide

The complete document index is [`docs/INDEX.md`](docs/INDEX.md), generated from document headers. Search it for your topic's keywords (or read it) before opening or searching any other document. Open a document only when its summary matches your task.

This file is the canonical operating guide and a router for `u2giants/synology-monitor`: it routes, it does not contain. Quirks, incidents, pending work, NAS maintenance safety and credential detail live under `docs/` (pointers below). Every new Markdown file opens with the four-key header (`summary`, `kind`, `status`, `read-when`); then run `ai-doc-health --repo . --fix-index` and never hand-edit the index.

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
| NAS container privilege, capabilities, block-device mounts, or SMART/disk health | `docs/nas-privilege-hardening.md`, `deploy/synology/README.md` | Web/AI docs |
| Repo↔NAS compose drift, or reconciling the compose files | `docs/nas-config-drift.md` | AI pipeline details |
| Add or change configuration, env vars, feature flags, secrets, or runtime settings | `docs/configuration.md`; `docs/deployment.md` for production | Incident histories |
| Change local setup, scripts, tests, lint, or package tooling | `docs/development.md`, relevant package files | Production deployment docs |
| Change deployment, Docker, CI/CD, hosting, rollback, or runtime environment | `docs/deployment.md`, `docs/configuration.md`, relevant workflow/compose files | Local debugging sections |
| Change database schema, migrations, models, auth/RLS, or data flow | `docs/architecture.md`, `docs/configuration.md`, relevant migration, `docs/telemetry-retention.md` when applicable | Unrelated NAS docs |
| Continue unfinished work | `HANDOFF.md` (static pointer) → open files in `HANDOFF.d/` newest first, `docs/pending-work.md`, plus only the docs they name | Completed historical plans |
| Investigate an incident | `docs/incident-log.md`, then the relevant dated incident file, open `HANDOFF.d/` files if active, topic doc | Other incident files |
| Continue the MCP v2 foundations or protocol migration | `plan_mcp-v2-foundations-and-migration.md`, then `apps/nas-mcp/README.md`, `docs/architecture.md`, `docs/development.md`, `docs/deployment.md`, and `docs/mcp-incident-2026-05.md` | Unrelated NAS incident and archive docs |
| Archive inventory or move | `docs/synology-archive.md`, `docs/synology-archive-implementation.md`, `docs/archive-move-runbook.md` | AI pipeline details |
| Merge/move files in a share, or clean up `*_Conflict` artifacts | `scripts/synology/README.md`, `docs/synology-fileserver-audit.md`, `docs/nas-maintenance-safety.md` | Web/AI docs |
| Re-file item folders into Concept Approved Designs (size/licensor/status rule) | `docs/concept-approved-refile-runbook.md` | Web/AI docs |
| Seafile/inotify work | `docs/seafile-sync-inotify.md` | Archive and web docs |
| Telemetry retention or pg_partman | `docs/telemetry-retention.md`, `docs/supabase-virginia-migration-2026-06.md` | NAS filesystem docs |
| Relay behavior or recovery | `apps/relay/README.md`, `apps/relay/OPERATIONS.md`, `docs/architecture.md` relay section | Unrelated NAS MCP internals |
| Direct NAS SSH maintenance | `docs/nas-maintenance-safety.md`, `docs/deployment.md` | Web/AI docs |
| Something looks wrong or odd on purpose | `docs/idiosyncrasies.md` | Incident histories |
| Work in a folder with its own README | That README and only the broader docs it links | Other folder READMEs |
| Claude Code session | `CLAUDE.md`, then this file | All docs by default |
| Documentation-only cleanup | This file, `README.md`, affected topic docs | Source except what verifies facts |

`PLAN.md` is historical context for the completed issue-agent rebuild. It is not
current implementation guidance. It stays at the repository root because code
comments and applied migrations cite it by that name.

## Repository structure

| Path | Ownership / role |
|---|---|
| `apps/agent/` | Project-owned Go telemetry agent; runs on each NAS |
| `apps/nas-api/` | Project-owned Go command validator/executor and native archive jobs; runs on each NAS |
| `apps/nas-mcp/` | Project-owned FastMCP server; runs in Coolify |
| `apps/web/` | Project-owned Next.js dashboard and AI pipeline; runs in Coolify |
| `apps/relay/` | Project-owned narrow named-action relay; exceptional/manual deployment |
| `packages/shared/src/` | Shared TypeScript types, AI capabilities, archive contracts, and 132 NAS tool definitions |
| `supabase/migrations/` | Append-only database migrations, currently `00000` through `00047` |
| `supabase/functions/` | Project-owned Supabase Edge Functions |
| `deploy/synology/` | Canonical NAS compose and environment examples |
| `.github/workflows/` | Image build/publish and deploy triggers |
| `scripts/` | Operational checks and telemetry-retention runner |
| `scripts/synology/` | Case-safe file-server tools that run **on the NAS** (merge, conflict resolver, collision scanner) + 55 tests needing no NAS |
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
| Add a migration | New `supabase/migrations/000NN_*.sql`; next number after `00047` | Any existing migration that may have run |
| Change archive jobs | `apps/nas-api/internal/jobs/`, NAS routes, shared archive contract, MCP/web clients | Generic shell `/exec` path for native jobs |
| Change CI/deploy | Matching `.github/workflows/*.yml`, Dockerfile/compose, `docs/deployment.md` | Direct production host edits |

Any shared Supabase schema, RLS, RPC, trigger, or cross-app data-contract change
must also be authored/mirrored in `u2giants/shared-db` under its branch-and-PR
workflow.

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

Full text: [`docs/idiosyncrasies.md`](docs/idiosyncrasies.md). Read it before "fixing" any of these:

- Seven MCP tools expose a 132-definition registry (lazy loading is deliberate).
- A NAS command refusal is permanent for that command; it is not session degradation.
- `write: true` and the NAS API tier classifier are two separate gates.
- Tier is `max(classifier, declared minimum)`; unknown tool names fail closed.
- Per-share mounts are read-only; writes go through `/btrfs/volumeN`.
- There is no ACL-write tool; DSM uses `synoacltool`, not `setfacl`.
- Domain users resolve through DSM winbind, never container-local `id`.
- Block devices go under `devices:`; SCSI SMART needs `SYS_RAWIO`.
- Validator hard-blocks match a tool's own error prose (`passwd`, the compose command).
- `strace`/`hdparm` need their binaries; `hdparm -t` still needs `IPC_LOCK`.
- Watchtower ships images only; compose changes are manual and the two NAS files differ.
- The two monitor services use `restart: always`.
- The agent WAL sender bisects and quarantines bad rows.

## Credentials and environment

Never commit secret values. Production runtime values live in Coolify or each NAS's
untracked `.env`; CI values live in GitHub Secrets; human-accessible secrets live in
1Password vault `vibe_coding`. NAS `.env` plaintext is an accepted owner decision
(2026-10-01): do not flag it and do not rotate NAS passwords over it.

The variable summary table and the full plaintext ruling are in
[`docs/agents-reference.md`](docs/agents-reference.md); the exhaustive
variable-by-service reference is `docs/configuration.md`; secret retrieval is in
`docs/1password.md`.

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

Read [`docs/nas-maintenance-safety.md`](docs/nas-maintenance-safety.md) before any SSH
session on a NAS or any move, merge or permission change inside a share. In short:
use the SSH aliases `edgesynology1`/`edgesynology2`; sudo needs the service-account
password through 1Password; change one service at a time, backup first; the
filesystem is case-sensitive but its clients are not; `chmod --reference` destroys
permissions on DSM; snapshot the share, not the volume; a `*_Conflict` folder may
hold the only copy of real content.

## Critical incidents

Full records: [`docs/incident-log.md`](docs/incident-log.md).

- 2026-07-16/17 — a folder merge created 63 sync conflicts and 66 unreadable directories.
- 2026-07-16 — anonymous SQL execution exposed the AI key.
- 2026-07-16 — agent ingestion fell roughly 80 minutes behind.
- 2026-06-22 — retention work targeted the deleted Ohio project.
- 2026-05-29 — ingestion freeze and pg_partman failure.
- 2026-05 — secrets committed and MCP/NAS diagnostics overloaded production.

## Pending work

The board is [`docs/pending-work.md`](docs/pending-work.md). Open handoffs are the
files in `HANDOFF.d/` (`HANDOFF.md` is only a static pointer); treat them as current
over older plan or incident prose.

## Non-negotiable rules

1. **The operator is not a programmer.** Any step handed to him must be a literal,
   tested, copy-pasteable command with the real host and path, the expected output
   (marking what varies), or named clicks. Full rule and its history:
   [`docs/agents-reference.md`](docs/agents-reference.md).
2. GitHub `main` is code truth. Check for concurrent work before pull/commit/push.
3. Root-cause fixes only; loud failures instead of silent fallback.
4. Add tests for code created and visually verify UI work.
5. Do not hard-code configurable settings or model choices.
6. Applied migrations are immutable; new database work gets a new migration and
   the shared-db mirror/PR where applicable.
7. Never store secret values in code, docs, commits, or generated examples.
8. Host/OS configuration belongs in `u2giants/ansible`; routine server SSH deploys
   are forbidden.
9. Report completion with commit SHA, workflow outcome, and live SHA/health evidence.
