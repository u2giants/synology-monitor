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
| open, urgent | Repair pg_partman (and drain its DEFAULT partitions) | Cron job 1 still runs `select public.run_maintenance_proc()` and failed today at 2:00 AM EST ("is a procedure"). DEFAULT partitions have grown from ~8.4 GB (July) to ~52 GB: `smon_logs_default` 30 GB / 63M rows, `smon_metrics_default` 20 GB / 81M, `smon_container_status_default` 1.7 GB, `smon_storage_snapshots_default` 0.6 GB. Database is 72 GB. Next: the drain-first procedure in `docs/telemetry-retention.md`, then switch cron to `CALL`. |
| done | Drain expired row-policy telemetry | Hourly cron job 8 (`CALL cleanup_high_volume_telemetry_proc`) succeeded today at 2:17 PM EST. |
| open | Two more cron jobs fail every run (found during this check) | Job 4 `process_ai_responses()` fails with "column r.body does not exist" (every minute, last 3:06 PM EST); job 5 `detect_sync_anomalies()` fails with "relation smon_nas_units does not exist" (last 3:00 PM EST). Next: diagnose and fix by migration. |
| done | Exposed AI key no longer usable | The OpenAI key stored in `vault.secrets` (`smon_openai_api_key`, unchanged since 2026-06-21) returns HTTP 401 from OpenAI today, so it is revoked. No public `SECURITY DEFINER` function is executable by `anon`. Housekeeping only: that stale vault entry can be deleted or replaced. |
| done | Review `nas_logs` size | Reviewed today: `nas_logs` data lives in `smon_logs_default` (30 GB, 63M rows) because partman is dead. Its fix is the pg_partman row above. |
| open | Repair archive directory mtimes (write NAS 1 only) | `stat` on `edgesynology1` under `/volume1/mac/Archive/Decor/Character Licensed/___OLD`: the root (2023-02-24 15:38:42) is now correct; 8 of 9 are still wrong. `Revised 36x78in`, `CNV012…`, `WonderWoman`, `HIRES (1)` still hold the June values; `Marvel AGE001/Cap` (2026-06-17), `Iron Man`, `Old/Hulk`, `SpiderMan` (2026-06-18) changed again after June. Next: the root-capable procedure in the legacy handoff, section 3A. |
| done | Seafile inotify remediation | NAS 1: limits 1048576 / 1024; `seafile-ignore.txt` present in all four library roots; `seaf-cli` container restarted (log begins 2026-10-26) and has logged zero "No space left on device" since (45 "No such file" watch misses only, benign). NAS 2 runs no `seaf-cli`, so its default limits are fine. |

Handoff files are write-once: do not edit another session's file. Delete a handoff only when every
continuation item in it is truly complete.

