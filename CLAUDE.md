# CLAUDE.md

**Read [AGENTS.md](AGENTS.md) first.** It is the canonical operating guide for this repo and applies to all AI sessions. The notes below are Claude Code-specific only.

## Allowed operations

- Edit source under `apps/`, `docs/`, `deploy/`, `supabase/migrations/`, `.github/workflows/`, top-level `*.md`.
- Run `pnpm build`, `pnpm lint`, `pnpm type-check`, `go build`, `go test` locally.
- Commit and push to `main` when explicitly asked. Default behavior: do not commit unprompted.

## Not allowed

- Direct SSH to the VPS or NAS is **not** a normal deployment path. The VPS has public SSH disabled by design. Do not propose SSH-based deploys, manual `docker build` on the VPS, or runtime container manipulation.
- Runtime env changes belong in Coolify — apply them directly through the Coolify API or UI. Do not route them through GitHub Actions shell commands or SSH. See `AI_OPERATING_RULES.md`.
- Do not create feature branches. This repo uses one branch: `main`.
- Do not "fix" the items listed under [AGENTS.md § 10 — Intentional quirks](AGENTS.md) without reading the linked incident/commit first.

## Commit style

- Subject line: `area: short imperative` (e.g. `nas-mcp: …`, `agent: …`, `docs: …`). Match prior history (`git log --oneline`) for the project area.
- Body: one short paragraph on *why*, not what. Reference incident, prior commit, or user request when relevant.
- Co-author trailer: `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>` (match the model in use).

## Ignore files

`.claudeignore` at the repo root is honored by Claude Code. It excludes build artifacts (`node_modules/`, `.next/`, `dist/`, `.turbo/`), lockfiles, `evals/`, and the vestigial scratch file `ersahazan2Desktopsynology-monitor`. Update it when adding new generated directories.

For other AI tools, paste `AGENTS.md` as your first message and follow the *§ 9 — What to ignore* list.

## Memory / context notes

- Local workspace path: `/worksp/monitor/app`. Working copy of `github.com/u2giants/synology-monitor` on `main`.
- The NAS MCP server has 119 shared tools in `ALL_TOOL_DEFS` but exposes only 7 small tools per session (`list_capabilities`, `get_capability_details`, `tool_search`, `invoke_tool`, `run_command`, `check_disk_space`, `restart_nas_api`). `check_disk_space` and `restart_nas_api` are registry tools registered eagerly by `apps/nas-mcp/src/index.ts`. When debugging tool availability, check catalog/search/detail results, `tools-config.json` enablement, and `EAGER_TOOLS`.
- The 3-stage AI pipeline (`stage1-structurer.ts`, `stage2-reasoning.ts`, `stage3-explainer.ts`) is the only active issue-agent pipeline as of 2026-05-30. The legacy 7-stage pipeline and OpenRouter inference path have been removed.
- `issue_evidence_items` and `issue_evidence` are different tables with different purposes — do not confuse them.
- `second_opinion_model` and `cluster_model` exist in `ai-settings.ts` but are not yet wired to any pipeline stage.
- `drive_team_folders_partitioned`: schema exists, no child partitions, no writes — future scaling infrastructure; do not drop.
- HANDOFF.md is created only when work is genuinely incomplete at session end. Delete it as part of the commit that resolves the work it describes.
- nas-api now has a native **file-inventory job system** (`apps/nas-api/internal/jobs/`) behind `/jobs/inventory/*` REST endpoints, persisting to a durable `/app/data/jobs` bind mount (Phase 1 of the archive work — design in `docs/synology-archive.md`, build guide in `docs/synology-archive-implementation.md`). It uses `NAS_API_NAME` (the logical `edgesynology1/2` name), which is **deliberately separate** from the agent's `NAS_NAME`. Adding the mount/env needs a one-time `docker compose up -d` per NAS; until then those endpoints return 503. Phase 2 (archive move) is specified in the same docs but not yet built.
