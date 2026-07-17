# Claude Code Instructions

Read [AGENTS.md](AGENTS.md) first. It is the canonical guide for every developer
and AI tool; this file contains Claude Code-specific notes only.

## Context and ignore behavior

- Claude Code honors `.claudeignore`. Do not load generated output, dependencies,
  caches, lockfiles, backups, or `evals/` unless the task requires them.
- The working copy is normally `/worksp/monitor/app`, repository
  `u2giants/synology-monitor`, branch `main`.
- `HANDOFF.md` is required reading only when continuing unfinished work.

## MCP discovery

- The NAS MCP server is named `synology-monitor`, not `nas-mcp`; confirm with
  `claude mcp list` before declaring it unavailable.
- A project `.mcp.json` must not exist: it previously shadowed the working global
  definition with a rotated token. The path is ignored by Git.
- MCP `tools/list` intentionally shows seven tools. Use `tool_search`,
  `get_capability_details`, and `invoke_tool` to reach the 132-definition registry.

## Claude-specific working preferences

- Run local build, lint, type-check, and Go tests as needed.
- Commit only when the user asks or the requested workflow explicitly requires it.
- Commit subjects use `area: short imperative`, matching recent history.
- Do not add a Claude co-author trailer to commits made by another model/tool.
- SSH is diagnostic/recovery-only, never the normal deployment path. Follow the
  deployment and NAS safety rules in `AGENTS.md`.
