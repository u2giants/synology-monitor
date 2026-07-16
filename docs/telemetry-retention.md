# Telemetry retention and database size

## Status

**Designed and committed; installed nowhere.** `supabase/migrations/00042_telemetry_retention_cleanup.sql`
has never been applied to any surviving database. The live project
`aaxtrlfpnoutziwhshlt` has **no retention** — verified 2026-07-16:

- `telemetry_retention_policies` → `PGRST205` (table not found)
- `telemetry_retention_estimates` → `PGRST202` (function not found)
- `process_snapshots` still returns rows dated `2026-06-06` (~40 days old) against
  an intended 3-day policy

Before installing, read "Known defects" below — the migration is **not** safe to
apply as written.

## Why this exists

The database reached ~32 GB. The row-count drivers are high-frequency collector
streams, none of which the app reads for long:

| Table | Scale at migration time | Longest read window in code |
|---|---|---|
| `process_snapshots` | ~43.6M rows | 6h (`issue-agent.ts:102`) |
| `disk_io_stats` | ~12.8M rows | **30d** (metrics UI) — see defect 1 |
| `net_connections` | ~9.0M rows | 15m (`copilot.ts:319`) |
| `service_health` | ~2.6M rows | **no readers at all** |

Durable/high-signal data must be kept: `issues`, `issue_*`, `facts`, `alerts`,
`security_events`, DSM warning/error rows, Drive/ShareSync/security logs.

Postgres behavior worth knowing up front: deleting rows does **not** immediately
shrink the size Supabase reports. It frees space for reuse inside the tables.
Returning space to the OS needs `VACUUM FULL`/repack — never casually on production.

## The 2026-06-22 incident: work installed on the wrong project

A session installed this migration and ran a ~27.8M-row foreground purge against
`qnjimovrsaacneqkggsn` — the **pre-migration Ohio project** — reasoning that it
"matches the hardcoded app URL and the 29GB baseline", and explicitly dismissed the
checkout's `supabase/.temp/linked-project.json` link to `aaxtrlfpnoutziwhshlt` as stale.

That was backwards. The `.temp` link was right. The hardcoded URLs were the stale
thing: the repo-wide ref-swap was sitting **unapplied in a `git stash`**, so 13 files
still advertised the retired project and supplied the false evidence. `AGENTS.md`
already said, in as many words, not to point new work at the old project.

The old project has since been deleted, taking every live change with it — the purge,
the functions, and the hourly cron. Nothing needed undoing; nothing was banked.

**Why it matters beyond this one migration:** a stale string in the repo outvoted the
tool that was actually connected to reality. Future sessions should trust
`supabase projects list` and `supabase/.temp/linked-project.json` over any URL
committed in a doc, script default, or `.env.example`.

Guards added so it cannot silently recur (`scripts/run-telemetry-retention-cleanup.mjs`):
the silent `DEFAULT_SUPABASE_URL` fallback is **gone**, the script refuses to run
without an explicit `SUPABASE_URL`, hard-refuses any URL naming `qnjimovrsaacneqkggsn`,
and logs its target project before acting.

## Known defects — fix before installing

Verified 2026-07-16 by auditing every reader of the 17 policy tables.

**1. `disk_io_stats` 14d retention vs. a 30d UI range — a real break.**
The metrics page offers a `30d` option (`apps/web/src/app/(dashboard)/metrics/page.tsx:18`)
and queries `disk_io_stats` with it (`:114`, `parseRange` at `:892`). Retention at 14d
silently halves that chart with no empty state or warning. The same `ranges` array also
feeds `metrics` (90d retention, fine) — which is exactly why the mismatch is easy to
miss. **Either raise `disk_io_stats` to ≥30d or remove the 30d option from that panel.**

**2. Four policy tables have no `CREATE TABLE` in any migration.**
`process_snapshots`, `disk_io_stats`, `net_connections`, `sync_task_snapshots` are only
ever *renamed* (`00031_rename_smon_tables.sql:27,40-42`); the `smon_*` originals were
created out-of-band and exist only in the live DB. So `00042`'s `CREATE INDEX` on them
(lines 175-183) is not guarded and **hard-fails any rebuild from migrations**. Their
`captured_at` columns were verified from the writers instead
(`apps/agent/internal/sender/types.go:112,130,145,181`), not from a schema of record.

**3. Redundant row-level DELETEs layered over pg_partman.**
`metrics`, `nas_logs`, `storage_snapshots`, `container_status` are `PARTITION BY RANGE`
(`00002:18-70`) and already partman-managed (`00003`). Row-by-row `DELETE` on a
partitioned parent is far more expensive than a partition drop, and:
- `metrics` / `storage_snapshots`: partman already drops at **84d** (`00003:15,45`);
  `00042` sets row retention to 90d, which therefore **can never fire**, and *loosens*
  the partman setting 84d→90d.
- `nas_logs`: partman drops whole partitions at 180d regardless of severity, so the
  "keep warning/error/critical longer" intent at `00042:243` is silently capped at 180d.
- `container_status`: `00042:277` overrides partman's **180d** — set deliberately, with
  the comment *"6 months for better pattern analysis"* (`00003:60`) — down to **30d**.
  Mechanically safe (only reader is `docker/page.tsx:45`, latest 50 rows) but it
  silently reverses a documented decision.

**Recommendation:** let partman own these four and drop them from
`telemetry_retention_policies`.

**4. Over-retention worth revisiting.** `dsm_errors` (180d) has one reader at 48h.
`drive_activities` (180d), `service_health` (14d) and `drive_team_folders` (30d) have
**zero readers**.

## Verified safe

- **No foreign keys** point at any of the 17 tables (grep for `REFERENCES` across all
  migrations: zero hits). No cascade or delete-failure risk.
- **No views or materialized views** aggregate them.
- All 17 timestamp column names in the policies are correct (`captured_at` /
  `recorded_at` / `logged_at` / `ingested_at` as appropriate) — a wrong name would make
  `cleanup_table_by_age` raise.
- The `nas_logs` `extra_where` source values are real, and the `source` CHECK whitelist
  was dropped in `00035`, so no constraint conflict.
- `issue_evidence_items` snapshots evidence *out of* telemetry rather than referencing
  it (`00038:50`), so trimming telemetry does not damage issue history.

## What is in the repo

- `supabase/migrations/00042_telemetry_retention_cleanup.sql` —
  `telemetry_retention_policies`; `cleanup_table_by_age(...)` (bounded batch deletes,
  per-batch local `statement_timeout` 120s); `cleanup_high_volume_telemetry(...)`;
  `telemetry_retention_estimates()` (cheap `pg_stat_user_tables` estimates — an earlier
  version scanned `min/max` on huge tables and timed out); the policies; defensive
  partman alignment under both old and new parent names; hourly pg_cron job
  `telemetry-retention-cleanup`.
- `scripts/run-telemetry-retention-cleanup.mjs` — `--install`, `--dry-run`, `--cleanup`.
  Never prints the service key.
- `package.json` — `cleanup:telemetry`.

## Install procedure (live, `aaxtrlfpnoutziwhshlt`)

Indexes first: the 2026-06-22 purge bogged down precisely because the retention columns
were unindexed.

1. Resolve the defects above (at minimum defect 1 — the `disk_io_stats` window).
2. **Do not** apply the migration's plain `CREATE INDEX` (lines 175-197) to the big live
   tables; it blocks writes while it builds. Use:
   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_disk_io_stats_retention
     ON public.disk_io_stats (captured_at);
   ```
   `CREATE INDEX CONCURRENTLY` **cannot run inside a transaction block**, so the REST
   `exec_sql` RPC is not a valid path — use a direct DB SQL console. One index at a
   time, verify, then proceed.
3. Confirm the delete predicate uses the index before any large delete:
   ```sql
   EXPLAIN SELECT tableoid, ctid FROM public.disk_io_stats
   WHERE captured_at < now() - interval '14 days' LIMIT 1000;
   ```
   Good: `Index Scan` / `Bitmap Index Scan`. Bad: `Seq Scan` — stop.
4. Tiny batch first:
   ```sql
   SELECT public.cleanup_table_by_age('disk_io_stats','captured_at',interval '14 days',NULL,1000);
   ```
   Expect a fast return of 0-1000 and no agent write failures.
5. Escalate 10k → 50k. Stop on lock waits, API timeouts, or agent ingest errors.
6. Repeat for `process_snapshots` (largest table).
7. `ANALYZE` both afterward through a path with enough timeout, or let autovacuum catch
   up. `ANALYZE` timed out on these two in the 2026-06-22 run.
8. Only then install the rest and let the hourly cron take over.

## Operational notes

- `exec_sql` on this project is **void-returning** (HTTP 204, no rows). Reads must go
  through a `RETURNS TABLE` function or PostgREST directly.
- The local Supabase CLI is authenticated; the service key can be fetched with
  `supabase projects api-keys --project-ref aaxtrlfpnoutziwhshlt -o env`. There is no
  local `.env` holding it. Do not print it.
- The Virginia project was resized to 36 GB after a bulk load filled its disk and
  crashed the DB read-only. AWS gp3 allows a resize only **once per 4h** — do not
  assume headroom.
- **There is no rollback project anymore.** Deletes here are final.
- Do not `VACUUM FULL` live tables without a maintenance window (strong locks).
- Do not trust row estimates right after large deletes unless `ANALYZE` has run.
</content>
