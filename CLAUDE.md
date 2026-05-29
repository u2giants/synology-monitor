# CLAUDE.md

**Read [AGENTS.md](AGENTS.md) first.** It is the canonical operating guide for this repo and applies to all AI sessions. The notes below are Claude Code-specific only.

## Allowed operations

- Edit source under `apps/`, `docs/`, `deploy/`, `supabase/migrations/`, `.github/workflows/`, top-level `*.md`.
- Run `pnpm build`, `pnpm lint`, `pnpm typecheck`, `go build`, `go test` locally.
- Commit and push to `main` when explicitly asked. Default behavior: do not commit unprompted.

## Not allowed

- Direct SSH to the VPS or NAS is **not** a normal deployment path. The VPS has public SSH disabled by design. Do not propose SSH-based deploys, manual `docker build` on the VPS, or runtime container manipulation.
- Do not modify Coolify environment variables from this side — Coolify is the source of truth for runtime env per `AI_OPERATING_RULES.md`.
- Do not create feature branches. This repo uses one branch: `main`.
- Do not "fix" the items listed under [AGENTS.md § 10 — Intentional quirks](AGENTS.md) without reading the linked incident/commit first.

## Commit style

- Subject line: `area: short imperative` (e.g. `nas-mcp: …`, `agent: …`, `docs: …`). Match prior history (`git log --oneline`) for the project area.
- Body: one short paragraph on *why*, not what. Reference incident, prior commit, or user request when relevant.
- Co-author trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` (match the model in use).

## Ignore files

`.claudeignore` at the repo root is honored by Claude Code. It excludes build artifacts, dependencies, lockfiles, and the `evals/` and vestigial scratch files from context. Update it when adding new generated directories.

For other AI tools without an analogous ignore mechanism, paste `AGENTS.md` as your first message and follow the *§ 7 — What to ignore* list.

## Memory / context notes

- The NAS MCP server has 108 tools in `ALL_TOOL_DEFS` but only 5 are exposed to clients per session. When debugging tool availability, check `tool_search` results and `tools-config.json` enablement, not just the count of definitions.
- Local workspace path on the dev machine: `/worksp/monitor/app`. This is a working copy of `github.com/u2giants/synology-monitor` on `main`.
- HANDOFF.md is created only when work is genuinely incomplete at session end. Delete it as part of the commit that resolves the work it describes.
