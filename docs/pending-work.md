---
summary: Board of operational work from the legacy handoff: archive mtimes, Seafile, pg_partman, AI key, nas_logs, NAS compose, ownership repair, Drive conflict cleanup.
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
| done | NAS compose reconciliation (legacy §3.D, §6 step 5) | 2026-11-11 5:29 PM EST: added `NAS_API_NAME` and the durable `/app/data/jobs` mount on both NASes (backup `compose.yaml.bak-20261111T1728*`), recreated nas-api only. Authenticated `GET /jobs/inventory` returns 200 `{"jobs":[]}` on both (was 503); jobs dir persists on the host. |
| done | Compose drift generator (nas-config-drift §8) | 2026-11-11 ~6:00 PM EST: `deploy/synology/generate-compose.py` builds `docker-compose.nas-1.yml` / `nas-2.yml` from `compose/base.yml` + per-box fragments; CI check `nas-compose-generated`. `docker compose config` of generated vs live was identical on both NASes, then the generated files were installed: live `md5sum` equals the repo files on both. Old drifted `docker-compose.agent.yml` removed. |
| done | Functional `/drift` endpoint | Added `GET /drift` to nas-api (caps, not-privileged, every block device openable, jobs/group/btrfs/docker mounts). The probe code run inside both live nas-api containers 2026-11-11 passed every check (29 on edge1, 18 on edge2). The endpoint itself goes live when CI builds the image and Watchtower pulls it. |
| done | `repair_path_ownership` review items (legacy §3.F) | Symlinked parents refused (canonical path must equal the request), hard-linked files refused, Synology-ACL paths fail closed, device:inode re-checked after `chown -h`, read-only preflight shown before approval, MCP approval bound to a command hash. Live on real NAS paths 2026-11-11: edge1 `/volume1/mac` no-op chown VERIFIED, symlinked parent and hard link refused; ACL paths refused on both NASes. Live DSM quirk found and handled: `synoacltool` exits 255 on Linux-mode paths. |
| done | Live shell-injection probe (legacy §6 step 10) | 2026-11-11: 60 hostile filter values (`$()`, backticks, quote breaks) across all 15 filter-taking read tools, run inside edge1 nas-api: zero files created. |
| done | Does `mac` replicate to edgesynology2? (legacy §3.H item 4, audit §9) | Yes: edgesynology2 is a ShareSync client of edgesynology1 (192.168.3.100) for mac, mgmt, Coldlion, files, styleguides, users (plus three disabled), all read-only download-only. Cleaning edge1 cleans edge2; edge2 needs no separate pass. |
| in progress | Share-wide `*_Conflict` cleanup, Character Licensed (legacy §3.H item 1) | Dry run 2026-11-11 5:35 PM EST over 591 conflict entries: 401 safe deletions (identical or older copies), 87 unique files to move home, 40 only-copies left alone, 10 newer copies kept for review. Apply held: 107 files open over SMB in that share at 5:35 PM EST. Recovery point: DSM snapshot `GMT-05-2026.11.11-14.15.01` (verified holds files). |
| owner | 10 conflict copies newer than the live file | A designer must choose which version wins. In Shoppers World SS26 `AA126DYMM01`, Burlington Harvest/Christmas Frames 26 `HSR6XDYMM02/old`, and Dollar General FW2026 `.merged` phone stands (`SNMH7DYLS01`, `SNMH7MVSP01`, `SNMH7DYNX01`). The cleanup leaves them untouched. |
| owner | 4 live case-collision pairs in Dollar General Kids Summer 2027 | A designer must pick the surviving name (audit §2). |
| owner | 21 `@archive_move_snapshots/mv_*` rollback points on edge1 | Each is the only undo for an archive move; deleting is irreversible. Keep until the owner confirms those moves are final. |
| closed | Why the nine archive directory mtimes changed (legacy §9) | Unknowable now: no audit log retained from June 2026. The repair itself is done (row above). |

Handoff files are write-once: do not edit another session's file. Delete a handoff only when every
continuation item in it is truly complete.

