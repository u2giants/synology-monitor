# Telemetry retention and database size

## Status

**Reviewed, fixed, tested — installed nowhere.** The known defects are resolved and the
logic is verified on PG17 (see below), but
`supabase/migrations/00042_telemetry_retention_cleanup.sql` has still never been applied
to any surviving database. The live project `aaxtrlfpnoutziwhshlt` has **no retention** —
verified 2026-07-16:

- `telemetry_retention_policies` → `PGRST205` (table not found)
- `telemetry_retention_estimates` → `PGRST202` (function not found)
- `process_snapshots` still returns rows dated `2026-06-06` (~40 days old) against
  an intended 3-day policy

Nothing below this line has touched live data. The remaining work is steps 2-8 of the
install procedure, which are all irreversible — and **there is no rollback project
anymore**.

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

## Defects found by the reader audit — all resolved in the file

Found 2026-07-16 by auditing every reader of the policy tables; fixed the same day
(owner decisions recorded inline). Kept here because each one is a trap that would
otherwise be reintroduced.

**1. `disk_io_stats` 14d vs. a 30d UI range — RESOLVED (now 35d).**
The metrics page offers a `30d` option (`apps/web/src/app/(dashboard)/metrics/page.tsx:18`)
and queries `disk_io_stats` with it (`:114`, `parseRange` at `:892`). At 14d that chart
silently showed half its range with no empty state. Now **35 days** — 30d of range plus
5d headroom. The same `ranges` array also feeds `metrics` (90d, fine), which is exactly
why the mismatch was easy to miss. **Do not trim below 30d without removing the 30d
option from that panel first.**

**2. `CREATE INDEX` on tables no migration creates — RESOLVED (guarded).**
`process_snapshots`, `disk_io_stats`, `net_connections`, `sync_task_snapshots` are only
ever *renamed* (`00031_rename_smon_tables.sql:27,40-42`); the `smon_*` originals were
created out-of-band and exist only in the live DB. The unguarded `CREATE INDEX` therefore
hard-failed any rebuild from migrations (reproduced: `ERROR: relation
"process_snapshots" does not exist`). Index creation is now a `to_regclass`-guarded
`DO` block that skips absent tables with a `NOTICE`. Their `captured_at` columns are
verified from the writers (`apps/agent/internal/sender/types.go:112,130,145,181`), not
from a schema of record.

**3. Row-level DELETEs layered over pg_partman — RESOLVED (partman owns its four).**
`metrics`, `nas_logs`, `storage_snapshots`, `container_status` are partman-managed
(`00003`, four `create_parent` calls). They are now **removed from
`telemetry_retention_policies`**, and `00042` no longer writes `part_config` at all.
What that draft would have done:
- *loosened* `metrics`/`storage_snapshots` from partman's 84d to 90d — while the 90d row
  policy could never fire anyway, since partman drops at 84d first;
- *reversed* `container_status` from a deliberate **180d** — *"6 months for better
  pattern analysis"* (`00003_create_partitions.sql:60`) — down to 30d, purely as a side
  effect of treating it as ordinary telemetry.

  **Known gap accepted with this decision:** `nas_logs` routine `info` rows from noisy
  polling sources now live partman's full 180d instead of being trimmed at 30d, because
  severity-selective trimming is precisely what a partition drop cannot express. If
  `nas_logs` turns out to be a real space driver, that single policy is the thing to
  reconsider — it is the one place this trade costs something.

**4. Over-retention — still open, informational.** `dsm_errors` (180d) has one reader at
48h. `drive_activities` (180d), `service_health` (14d) and `drive_team_folders` (30d)
have **zero readers**. Left as-is deliberately: they are small relative to the real
drivers, and forensic value outlives current readers.

**Note:** `drive_activities` is **not** partitioned despite older claims in
`architecture.md` — it is a plain table (`00008_create_drive_tables.sql:26`). The only
partitioned Drive object is `drive_team_folders_partitioned` (schema only, no writes).
It therefore needs its row-level policy; do not remove it assuming partman covers it.

## Verified on Postgres 17 (2026-07-16)

The migration had never run against any surviving database, so it was exercised on a
throwaway PG17 container before going near live:

- Runs clean on a **bare** DB with `ON_ERROR_STOP=1` — the guard skips all 8 absent
  tables and inserts 13 policies. The previously committed version fails at line 176.
- `cleanup_table_by_age` **honours the batch limit exactly** (asked 400 of 1000 expired
  → deleted 400).
- `cleanup_high_volume_telemetry` drains the remainder (600) and stops.
- **Rows inside retention survive**: 100 fresh `process_snapshots` untouched, and
  `disk_io_stats` rows at 20d survived the 35d policy — the exact rows the old 14d
  policy would have taken from the metrics page's 30d range.

Still unproven at scale: behavior on 43M-row tables with a cold cache. That is what the
staged batch escalation below is for.

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

Step 1 (fix the file) is **done** — the policies and guards described above are
committed. Live work starts at step 2.

1. ~~Resolve the defects above.~~ Done 2026-07-16; verified on PG17.
2. **Do not** let the migration's `DO` block build the indexes on the two big live
   tables — a plain `CREATE INDEX` blocks agent inserts for the whole build. Build these
   two **by hand first**; the block then no-ops via `IF NOT EXISTS`. Use:
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
