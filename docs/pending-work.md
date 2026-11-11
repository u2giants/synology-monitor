---
summary: Board of unfinished operational work: archive mtimes, Seafile inotify, pg_partman, AI key rotation, nas_logs review.
kind: living
status: current
read-when: Asking what is still open, or finishing an item and needing to update the board.
---

# Pending work

Moved from `AGENTS.md` on 2026-11-11 so the router stays small. Keep this board current; remove or mark done what is finished.

The open handoff [`HANDOFF.d/2026-11-11T1929Z-edge-dev3-claude-legacy-migrated-handoff.md`](../HANDOFF.d/2026-11-11T1929Z-edge-dev3-claude-legacy-migrated-handoff.md) (the former root `HANDOFF.md`, moved verbatim 2026-11-11) is required reading because work remains unfinished. Treat it as current over
older plan/incident prose.

Every row below was re-verified read-only on 2026-11-11 (about 3:10 PM EST; issue #31).

| Status | Item | Evidence (2026-11-11) / next action |
|---|---|---|
| done | Repair pg_partman (and drain its DEFAULT partitions) | Fixed 2026-11-11 (4:38 PM EST): all four DEFAULT partitions drained to empty (row counts matched exactly: logs 63.3M, metrics 51.5M, container_status 4.6M, storage_snapshots 0.26M moved; 35.1M metrics + ~0.18M storage rows older than the 84-day retention were not moved), weekly partitions created through 2026-11-28, `CALL run_maintenance_proc()` ran and dropped expired partitions. Cron now `CALL`s it (job 9, migration `00047`), test run succeeded. Database 72 GB → 56 GB. |
| done | Drain expired row-policy telemetry | Hourly cron job 8 (`CALL cleanup_high_volume_telemetry_proc`) succeeded today at 2:17 PM EST. |
| done | Cron jobs 4 and 5 failing | Fixed 2026-11-11 by migration `00046` (renamed tables/columns; sync alerts use an allowed severity and de-duplicate hourly). Job 4 succeeded 4:39 PM EST, job 5 4:30 PM EST. |
| done | Exposed AI key no longer usable | The OpenAI key stored in `vault.secrets` (`smon_openai_api_key`, unchanged since 2026-06-21) returns HTTP 401 from OpenAI today, so it is revoked. No public `SECURITY DEFINER` function is executable by `anon`. Housekeeping only: that stale vault entry can be deleted or replaced. |
| done | Review `nas_logs` size | Reviewed today: `nas_logs` data lives in `smon_logs_default` (30 GB, 63M rows) because partman is dead. Its fix is the pg_partman row above. |
| done | Repair archive directory mtimes (write NAS 1 only) | 2026-11-11 3:25 PM EST: rechecked authority on `edgesynology2` (`/volume1/mac/Decor/Character Licensed/___OLD`), which still matches the legacy handoff section 3A values; the June 2026 changes on the four Marvel AGE001 folders on NAS 1 held no newer content. Set the eight directory mtimes as root on `edgesynology1` only; `stat` now shows all nine under `/volume1/mac/Archive/Decor/Character Licensed/___OLD` match. |
| done | Seafile inotify remediation | NAS 1: limits 1048576 / 1024; `seafile-ignore.txt` present in all four library roots; `seaf-cli` container restarted (log begins 2026-10-26) and has logged zero "No space left on device" since (45 "No such file" watch misses only, benign). NAS 2 runs no `seaf-cli`, so its default limits are fine. |

Handoff files are write-once: do not edit another session's file. Delete a handoff only when every
continuation item in it is truly complete.

