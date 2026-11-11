---
summary: Board of unfinished operational work: archive mtimes, Seafile inotify, pg_partman, AI key rotation, nas_logs review.
kind: living
status: current
read-when: Asking what is still open, or finishing an item and needing to update the board.
---

# Pending work

Moved verbatim from `AGENTS.md` on 2026-11-11 so the router stays small. Keep this board current; remove or mark done what is finished.

The open handoff [`HANDOFF.d/2026-11-11T1929Z-edge-dev3-claude-legacy-migrated-handoff.md`](../HANDOFF.d/2026-11-11T1929Z-edge-dev3-claude-legacy-migrated-handoff.md) (the former root `HANDOFF.md`, moved verbatim 2026-11-11) is required reading because work remains unfinished. Treat it as current over
older plan/incident prose.

| Status | Item | Owner / next action |
|---|---|---|
| partial | Repair nine archive directory mtimes | Follow the exact authority-only procedure in that handoff; write only NAS 1 |
| partial | Complete Seafile inotify remediation | Run and verify `docs/seafile-sync-inotify.md` on the live worktree |
| partial | Drain expired telemetry and repair pg_partman | Owner decision plus watched procedures in `docs/telemetry-retention.md` |
| open | Rotate the AI key exposed by the former anonymous SQL path | Owner-approved rotation through 1Password/Coolify |
| scheduled | Review `nas_logs` database share | Run the documented check on 2026-08-17 or four weeks after retention goes live |

Handoff files are write-once: do not edit another session's file. Delete a handoff only when every
continuation item in it is truly complete.

