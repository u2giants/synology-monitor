## Archive `___OLD` Directory Mtime Repair

Status:
partial

Done:
- Repaired source directory mtimes under `/volume1/mac/Decor/Character Licensed/___OLD` on `edgesynology1` from `/tmp/edges2_dir_current_authority_20260615.csv`.
- Verified `source_authority_mismatches_after_repair 0` for the affected `___OLD` source subtree.
- Verified `source_dirs_today_count=0` and `source_files_today_count=0` under the source `___OLD` tree.
- Code commit `eb253f25fc6d8e1bdab1f76133b290017e9a0d8a` restores mtimes on source directories that survive a partial archive move.

Next action:
- Repair nine Archive directory mtimes under `/volume1/mac/Archive/Decor/Character Licensed/___OLD` on `edgesynology1`. The SSH user cannot apply these without sudo: `os.utime` returned `PermissionError(1, 'Operation not permitted')`.
- Confirm `GET http://100.107.131.35:7734/health` and `GET http://100.107.131.36:7734/health` report build `eb253f25fc6d8e1bdab1f76133b290017e9a0d8a` or newer after Watchtower updates the NAS API containers.

Risks / watchouts:
- Use `edgesynology2` authority data as evidence, but write repairs only to `edgesynology1` unless the user explicitly asks otherwise.
- The remaining Archive mismatches found on 2026-06-16 were:
  - `Decor/Character Licensed/___OLD`: `2023-02-24 15:38:42 -0500 <- 2026-06-16 10:33:20 -0400`
  - `Decor/Character Licensed/___OLD/Blinds - Paper Shades/Redi Order 1/Raw/Revised 36x78in`: `2024-12-06 08:10:42 -0500 <- 2024-12-06 08:10:36 -0500`
  - `Decor/Character Licensed/___OLD/CNV012 Nick 10x13.5 no LED`: `2026-04-05 12:51:27 -0400 <- 2026-03-25 00:51:05 -0400`
  - `Decor/Character Licensed/___OLD/Collage/Marvel AGE001/Cap`: `2026-04-05 12:51:25 -0400 <- 2026-03-25 00:51:05 -0400`
  - `Decor/Character Licensed/___OLD/Collage/Marvel AGE001/Iron Man`: `2026-04-05 12:51:32 -0400 <- 2026-03-25 00:51:05 -0400`
  - `Decor/Character Licensed/___OLD/Collage/Marvel AGE001/Old/Hulk`: `2026-04-05 12:51:45 -0400 <- 2026-03-25 00:51:05 -0400`
  - `Decor/Character Licensed/___OLD/Collage/Marvel AGE001/SpiderMan`: `2026-04-05 12:51:33 -0400 <- 2026-03-25 00:51:05 -0400`
  - `Decor/Character Licensed/___OLD/Embossed PVC/WonderWoman`: `2026-04-05 12:51:21 -0400 <- 2026-03-25 00:51:05 -0400`
  - `Decor/Character Licensed/___OLD/Jojo Siwa/HIRES (1)`: `2026-04-05 12:51:31 -0400 <- 2026-03-25 00:51:05 -0400`

## Seafile (`seaf-cli`) inotify watch exhaustion — capabilities + remediation

Status:
partial (code complete + tested; not committed/pushed/deployed; NAS not yet remediated)

Done:
- Diagnosed root cause: `seaf-cli` falsely reports "synchronized" because
  `fs.inotify.max_user_watches=8192` is exhausted by the ~541k-dir worktree (82%
  `@eaDir`). Full writeup: `docs/seafile-sync-inotify.md`.
- Added two MCP capabilities (verified: `go test ./internal/validator/...` ok; turbo
  `pnpm type-check` clean):
  - `set_inotify_watches` (tier 2) — `packages/shared/src/nas-tools.ts` + TOOL_GROUPS,
    enabled in `apps/nas-mcp/tools-config.json`.
  - `write_seafile_ignore` (tier 3) — same files.
  - Validator: one `(>>?)\s*['"]?/(btrfs/)?volume\d+/` pattern added to writePatterns
    + filePatterns in `apps/nas-api/internal/validator/validator.go`, with
    `TestInotifyAndSeafileIgnoreClassification` in `validator_test.go`.

Next action:
- Commit + push to `main` (changes are in apps/nas-api, apps/nas-mcp, packages/shared
  → nas-api updates via Watchtower ~5 min; nas-mcp redeploys via Coolify). No compose
  change needed (`/host/etc` already mounted, per `persist_vm_overcommit_memory`).
- Then run the runbook in `docs/seafile-sync-inotify.md` §6 on edgesynology1:
  `set_inotify_watches` (default `1048576 1024`) → `write_seafile_ignore` per library
  root → restart seaf-cli daemon → verify 0 `No space left on device` errors after
  restart.

Risks / watchouts:
- Do NOT remediate by restarting the daemon alone (masks, does not fix).
- Do NOT lower `max_user_watches` "to save memory" — it is a ceiling, not an
  allocation; lowering only removes headroom.
- Unverified: whether seaf-cli's monitor watches dirs listed in `seafile-ignore.txt`.
  Verify per `docs/seafile-sync-inotify.md` §5b after deploy. The ceiling raise is the
  guaranteed fix regardless.
- seaf-cli daemon/container restart is NOT a sanctioned capability (docker allowlist
  blocks it from `run_command`); restart via the seaf-cli stack / DSM Container Manager.


## Supabase telemetry retention and database-size cleanup

Status:
not started on the live database. The code is written and committed; **none of it is
installed anywhere.** An earlier session installed and ran it against the wrong
project — see "Correction" below before trusting any older account of this work.

### Correction — the 2026-06-22 run targeted a project that no longer exists

A prior session installed the retention migration and ran a large foreground purge
(~27.8M rows) against `qnjimovrsaacneqkggsn` ("SynoMon.old"), reasoning that it
"matches the hardcoded app URL and the 29GB baseline", and dismissed the checkout's
`supabase/.temp/linked-project.json` link to `aaxtrlfpnoutziwhshlt` as stale.

That reasoning was inverted:
- `aaxtrlfpnoutziwhshlt` (Virginia) has been the live backend since the 2026-06-21
  Ohio→Virginia migration. The `.temp` link was correct.
- The hardcoded URLs were the stale thing. The repo-wide ref-swap was sitting
  unapplied in a `git stash` ("ref-swap-wip"), so 13 files still named the old
  project and misled the session into picking it. That stash is now landed.
- `AGENTS.md` already said, in as many words, do NOT point new work at the old project.

Verified 2026-07-16:
- `supabase projects list` no longer lists `qnjimovrsaacneqkggsn` at all. The old
  project has been deleted. **Every live change from that session went with it** —
  the purge, the retention functions, and the hourly `telemetry-retention-cleanup`
  cron. Nothing needs undoing; nothing was banked.
- On live `aaxtrlfpnoutziwhshlt`: `telemetry_retention_policies` → `PGRST205` (no such
  table); `telemetry_retention_estimates` → `PGRST202` (no such function). No retention
  exists.
- Live `process_snapshots` still returns rows dated `2026-06-06` — ~40 days old against
  an intended 3-day policy. The database-size problem is untouched on the DB that matters.

Guard added so this cannot recur: `scripts/run-telemetry-retention-cleanup.mjs` no
longer has a default URL (it previously defaulted to the old project silently), refuses
to run if `SUPABASE_URL` is unset, hard-refuses any URL naming `qnjimovrsaacneqkggsn`,
and logs its target project before acting.

### Background (still valid)

- The app does not need most raw telemetry history. Current readers use short windows:
  issue agent reads 30 min–48 h depending on source; Copilot reads ~15 min of resource
  attribution; metrics UI reads recent metrics and the latest process-snapshot group.
- Durable/high-signal data must be kept longer: `issues`, `issue_*`, `facts`, `alerts`,
  `security_events`, DSM warning/error rows, and Drive/ShareSync/security logs.
- Postgres behavior worth knowing: deleting rows does not immediately shrink the
  Supabase dashboard's reported size. It frees space for reuse inside the tables.
  Returning space to the OS needs `VACUUM FULL`/repack — not to be done casually on
  production.

### What is in the repo

- `supabase/migrations/00042_telemetry_retention_cleanup.sql` — `telemetry_retention_policies`,
  `cleanup_table_by_age(...)` (bounded batch deletes), `cleanup_high_volume_telemetry(...)`,
  `telemetry_retention_estimates()` (cheap `pg_stat_user_tables` estimates, no huge scans),
  the retention policies (`process_snapshots` 3d, `net_connections`/`disk_io_stats`/
  `service_health`/`sync_task_snapshots`/`custom_metric_data` 14d, `container_io` 7d,
  `scheduled_tasks`/`backup_tasks`/`snapshot_replicas`/`container_status`/`drive_team_folders`
  30d, `metrics`/`storage_snapshots` 90d, `drive_activities`/`dsm_errors` 180d, `nas_logs`
  routine-`info`-only after 30d), defensive pg_partman alignment under both old and new
  parent names, and an hourly pg_cron job `telemetry-retention-cleanup`.
- `scripts/run-telemetry-retention-cleanup.mjs` — `--install`, `--dry-run`, `--cleanup`;
  loads URL/service key from env or local env files; never prints the key.
- `package.json` — `cleanup:telemetry`.

Note: the migration has never been applied to any surviving database, so it is unproven
against live data. The revisions the old run needed (estimates via `pg_stat_user_tables`
rather than `min/max` scans, and a per-batch local `statement_timeout` of 120s) are
already folded into the file.

### Next action — install on live `aaxtrlfpnoutziwhshlt`

Do the indexes first; the old run's purge bogged down precisely because the retention
columns were unindexed.

1. **Do not** apply the migration's plain `CREATE INDEX` statements (lines ~175–197) as
   written to the big live tables — a plain `CREATE INDEX` blocks writes while it builds.
   Use `CONCURRENTLY` for `process_snapshots` and `disk_io_stats`:
   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_disk_io_stats_retention
     ON public.disk_io_stats (captured_at);
   ```
   `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block. The REST `exec_sql`
   RPC is not a valid path for it — use a direct DB SQL console.
2. Confirm the cleanup predicate uses the index before any large delete:
   ```sql
   EXPLAIN SELECT tableoid, ctid FROM public.disk_io_stats
   WHERE captured_at < now() - interval '14 days' LIMIT 1000;
   ```
   Good: `Index Scan` / `Bitmap Index Scan`. Bad: `Seq Scan`.
3. Tiny delete batch first: `SELECT public.cleanup_table_by_age('disk_io_stats',
   'captured_at', interval '14 days', NULL, 1000);` — expect a fast return of 0–1000 and
   no app write failures.
4. Scale gradually: 10k, then 50k. Stop on lock waits, API timeouts, or agent ingest errors.
5. Repeat for `process_snapshots` (the largest table, ~43.6M rows at migration time).
6. `ANALYZE` both tables afterward via a path with enough timeout, or let autovacuum catch up.
7. Only then install the rest of the migration and let the hourly cron take over.

### Operational cautions

- Useful context: `exec_sql` on this project is void-returning (HTTP 204, no rows). Reads
  must go through a `RETURNS TABLE` function or PostgREST directly.
- Live Supabase creds: the local Supabase CLI is authenticated; the service key can be
  retrieved with `supabase projects api-keys --project-ref aaxtrlfpnoutziwhshlt -o env`.
  There is no local `.env` with it. Do not print it.
- The Virginia project was resized to 36GB after a bulk-load filled its disk and crashed
  the DB read-only. AWS gp3 allows a resize only once per 4h — do not assume headroom.
- Do not `VACUUM FULL` live tables without a maintenance window (strong locks).
- Do not build all large indexes at once. One, verify, proceed.
- Do not trust row estimates right after large deletes unless `ANALYZE` has run.
