# Telemetry retention and database size

## Status

**Complete and live as of 2026-07-17.** Installed, drained, and the hourly cron is armed
with the per-batch-commit procedure (`00044`).

| Thing | State |
|---|---|
| `00042` (policies + functions) | installed — 13 policies |
| `00044` (per-batch-commit procedure) | installed; cron `CALL`s `cleanup_high_volume_telemetry_proc` at `17 * * * *` |
| retention indexes | both built `CONCURRENTLY`, valid |
| **Drain** | **~81.6M expired rows deleted** (56M process_snapshots + 11.3M disk_io + 10.2M net_conn + 3M service_health + ~647k others). 0 blocked sessions; agent lag ≤31s throughout |
| `process_snapshots` | 58.7M → **1.64M live, 0 dead** (autovacuum reclaimed 57M dead tuples; plain VACUUM confirmed) |
| DB size | still **43 GB** — expected: freed space is reusable inside the tables, not returned to the OS (would need `VACUUM FULL`/repack; not done). Growth is stopped, which was the goal |
| pg_partman ~8.4 GB backlog | still open — separate problem, see below |

Measured delete performance (why the cron is safe to enable when you want it):

| Batch | Time | Blocked sessions |
|---|---|---|
| 1,000 | 48 ms | 0 |
| 10,000 | 105 ms | 0 |
| 50,000 | 532 ms | 0 |

~10.6 µs/row, scaling linearly. Draining the remaining 56.4M rows ≈ 1,130 batches of
50k ≈ **10 minutes** of *delete execution*.

**Treat that 10 minutes as a floor, not an estimate.** It measures `DELETE` under warm
cache and excludes what actually dominates on a 1 GB Micro: WAL generation, index entry
cleanup, checkpoints/writeback, autovacuum heap+index passes, and planner-statistics
correction. Likewise "0 blocked sessions" proves only that one 532 ms sample took no lock —
not that sustained deletion is safe. Deletes do not lock out the agents' inserts directly,
but can stall them indirectly via I/O saturation, WAL pressure, checkpoint frequency,
buffer-cache eviction, and autovacuum competing for the same 1 GB.

Before draining, check the things that will actually bite (none of this was done yet):

```sql
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum, autovacuum_count
FROM pg_stat_user_tables WHERE relname='process_snapshots';

SELECT * FROM pg_stat_progress_vacuum WHERE relid='public.process_snapshots'::regclass;

SELECT name, setting FROM pg_settings WHERE name IN
 ('autovacuum_vacuum_scale_factor','autovacuum_vacuum_threshold','autovacuum_vacuum_cost_limit',
  'autovacuum_vacuum_cost_delay','maintenance_work_mem','max_wal_size','checkpoint_timeout');
```

Prefer **per-table** autovacuum settings on `process_snapshots` (a scale factor tuned for a
58M-row table; the default waits far too long) over making autovacuum globally aggressive.
Do not disable autovacuum, and do not run concurrent manual vacuums on this instance.
Throttle on production health — pause between batches and stop on rising ingest latency,
failed agent writes, disk latency, or vacuum backlog — rather than running at max speed.

**XID burn is *not* a concern here** — Postgres consumes one XID per transaction, not per
row; ~1,130 committed batches is nothing. The real costs are WAL volume, dead tuples,
index cleanup and storage saturation.

**Space will not come back on its own.** Plain `VACUUM` makes the freed heap reusable
*inside* `process_snapshots`; it does not return 15 GB to the filesystem or shrink the
reported DB size. Only `VACUUM FULL` / `CLUSTER` / a repack does, each needing an
`ACCESS EXCLUSIVE` lock and roughly as much spare space as the table+indexes — on a disk
that already filled once and crashed this DB read-only, and which AWS gp3 lets you resize
only once per 4h. Given the collector writes continuously and will reuse freed pages,
leaving the table physically large is probably the right answer; if space must be returned,
plan a maintenance window or an online repack (`pg_repack`), not an improvised `VACUUM FULL`.

**Deletes are irreversible and there is no rollback project.**

### The hourly cron: use the procedure, not the function (fixed in 00044)

The original `cleanup_high_volume_telemetry` is a **function** (`prokind='f'`), and a function
cannot `COMMIT`. Its inner batch loop ran entirely in **one transaction** — 13 policies × 10 ×
25,000 = up to **3.25M rows in a single transaction** per hourly run, one WAL burst and a
long-lived snapshot blocking vacuum. So the cron must **never** run `SELECT * FROM
cleanup_high_volume_telemetry(...)`.

**Migration `00044` fixes this** with a procedure, `cleanup_high_volume_telemetry_proc`, that
`COMMIT`s after every batch, and repoints the cron to `CALL` it. Two non-obvious constraints,
verified on PG17 (both raise `invalid transaction termination` otherwise):

- a procedure that is **`SECURITY DEFINER`** cannot `COMMIT`;
- a procedure with a **`SET search_path`** clause cannot `COMMIT`.

So the procedure is deliberately **plain** (neither) and instead **fully schema-qualifies**
every reference (`public.telemetry_retention_policies`, `public.cleanup_table_by_age`). That is
safe because the privileged delete happens inside `cleanup_table_by_age`, which *is* `SECURITY
DEFINER`; the procedure only orchestrates and commits. The `REVOKE … FROM PUBLIC, anon,
authenticated` + `GRANT … TO service_role` lockdown still applies (a plain procedure in
`public` is exposed to anon by default — see the security incident above).

The cron block in `00044` schedules `CALL public.cleanup_high_volume_telemetry_proc(10, 25000)`
at `'17 * * * *'`. Capacity is ample: `process_snapshots` accrues ~22k rows/hour (≈1.6M
surviving / 72h), and the job can do 250k/hour — ~11× production.

## 🚨 pg_partman has been dead since 2026-05-29 — read this first

Found 2026-07-16 while installing retention. **This is the bigger cause of database
growth, and it invalidates the naive reading of the partman decision below.**

The pg_cron job `smon-partition-maintenance` runs:

```sql
select public.run_maintenance_proc()   -- WRONG
```

In pg_partman 5.3.1 `run_maintenance_proc` is a **procedure** (`pg_proc.prokind = 'p'`),
so Postgres rejects this every time:
`ERROR: run_maintenance_proc() is a procedure … HINT: To call a procedure, use CALL.`
**25 of 25 runs failed** — a 100% failure rate, daily, since the cron jobs were manually
recreated after the 2026-06-21 migration. The job reports `active = true`, so nothing
surfaced it. `part_config.maintenance_last_run` is still **2026-05-29**.

Consequences, measured:
- The newest bounded partition is `metrics_p20260606` (ends **2026-06-13**). Every
  `metrics` / `nas_logs` / `container_status` / `storage_snapshots` row written since
  then has landed in the **DEFAULT** partition.
- **partman retention never drops a DEFAULT partition** — only bounded children. So this
  data is immortal and growing:

  | default partition | size | rows |
  |---|---|---|
  | `smon_metrics_default` | 4,444 MB | 18.3M |
  | `smon_logs_default` | 3,454 MB | 7.8M |
  | `smon_container_status_default` | 383 MB | 986k |
  | `smon_storage_snapshots_default` | 140 MB | 95k |
  | **total** | **~8.4 GB** | **~27M** |

- A further ~1.36 GB of genuinely expired bounded partitions (3 × `metrics`,
  3 × `storage_snapshots`) sit undropped because retention never ran.

**This qualifies the partman decision in "Defects" below.** Removing `metrics`,
`nas_logs`, `storage_snapshots` and `container_status` from `telemetry_retention_policies`
is correct *only if partman actually runs*. It has not been running. Until the cron is
fixed, those four tables have **no retention from either mechanism**.

### The fix is one word — but the backfill is not

`SELECT` → `CALL` (or use the function form, `SELECT public.run_maintenance()`).

**Do not simply set `ignore_default_data = true` to avoid the backfill.** That looks like
the safe option and is not: partman creates a child table and `ATTACH`es it, and Postgres
must verify that no row in the DEFAULT partition belongs to the new partition — it
**errors** if any do. So `ignore_default_data = true` makes partition creation *fail* for
exactly the weeks that need it, rather than skip work.

**And do not expect `run_maintenance_proc()` to fix this either.** (Corrected 2026-07-16
after review — an earlier draft of this doc claimed partman would move each week's rows as
it created that week's partition. **It will not.**) `run_maintenance[_proc]` creates and
drops partitions; **it is not the DEFAULT-data mover.** The documented movers are
`partition_data_proc()` / `partition_data_time()`. This matches what actually happened
during the 2026-05-29 repair, where `partition_data_proc` did the draining.

**Consequence: fixing the cron alone will not fix this.** With ~27M rows sitting in DEFAULT
across the ranges partman needs to create, a corrected `CALL` will just fail differently —
or skip ranges — until the DEFAULT is drained. **Drain first, fix cron last.**

### AGREED RECOVERY PLAN (Claude + Codex, 2026-07-20) — read before choosing an approach

Two approaches were debated. The decision, and the fact that settles it:

**A "minimal-move" shortcut was considered and REJECTED as the end state.** The idea: clear
only the *current week* out of DEFAULT, create current+future partitions, fix the cron, and
leave the ~30 days of older DEFAULT rows in place (legal — a DEFAULT partition may hold rows
in ranges no bounded partition covers; `ATTACH` validates only the *new* partition's bounds,
not the whole DEFAULT — verified against the PG17 `ALTER TABLE` docs).

**Why it was rejected:** attaching a new partition makes Postgres **scan the entire DEFAULT
partition** to prove no row falls in the new range, and it does so holding an **`ACCESS
EXCLUSIVE` lock on DEFAULT**. With 8.8 GB parked there, *every future weekly partition
creation* would pay a full 8.8 GB exclusive-locked scan — weekly, forever, on a 1 GB Micro
with two agents writing continuously. The shortcut trades a one-time cost for a recurring
one. pg_partman's own docs warn that excessive default rows "greatly affect partition
maintenance performance".

Secondary reasons: queries over the 2026-06-13→now gap hit one 28M-row partition instead of
weekly children; planner estimates degrade; and the cleanup debt is not one dated `DELETE`
but a **months-long, repeated** process (37 days of data across tables with 84d and 180d
retention, aging out gradually), which pg_partman retention will never do for you.

**Also rejected: detach-the-DEFAULT-wholesale-and-archive.** Mechanically clean and it does
stop the write race, but the detached rows **vanish from queries against the parent tables**.
"Preserved in a side table" is not "preserved in `metrics`". It would need union views or app
changes. Only viable if an audit first proves nothing queries that 37-day window.

**The agreed plan is a staged hybrid — containment first, then a throttled real repartition:**

1. **Contain**: clear only the current interval from DEFAULT, atomically establish current +
   `premake` future partitions, and fix the cron (`select` → `CALL`). New writes stop landing
   in DEFAULT. This is *containment, not recovery* — do not stop here.
2. **Drain**: migrate the historical DEFAULT rows interval-by-interval with
   `partition_data_proc()`, throttled and health-gated, exactly like the 81.6M-row retention
   drain (which proved this instance tolerates careful staged maintenance — though note
   *moving* rows is more expensive than *deleting* them, so it is not a free read-across).
3. **Finish**: verify row conservation per table and interval, confirm current+premake
   coverage, restore the normal `ignore_default_data` setting, and only then re-enable the
   recurring maintenance cron. pg_partman is not "recovered" until DEFAULT is drained.

**Do this in a dedicated session, not as the tail of a long one** (both models, high
confidence). Capture this evidence verbatim first, rather than re-deriving it — re-derivation
is exactly how the 2026-06-22 wrong-project incident happened:
project ref; server timezone + current UTC; every `pg_get_expr(relpartbound, oid)`; per-table
DEFAULT min/max/count; the `part_config` rows (incl. `premake`, `infinite_time_partitions`,
`retention_keep_*`, `ignore_default_data`); cron state; free disk/WAL headroom; and the
health stop-conditions. Leave the broken partman cron **disabled** during preparation — the
retention cron is separate and stays enabled.

Open questions to answer before step 1: do all four DEFAULTs have usable partition-key
indexes; what are the exact weekly boundaries in the partition timezone; and does anything in
the app actually query the 2026-06-13→now interval.

Sequence, when someone picks this up:
1. Leave the broken job disabled/unfixed while recovering — you do not want the 07:00 cron
   firing mid-drain.
2. Record exact bounds and row counts per DEFAULT partition first, so conservation can be
   verified afterwards.
3. Drain the **completed** historical weeks with `partition_data_proc()` in batches.
4. Handle the **actively-written current week separately** — `partition_data_proc` races
   live writes and never converges (proven on 2026-05-29). That needed a manual atomic
   `detach → create current+future partitions → backfill`.
5. Verify row conservation per table and interval.
6. Ensure current + `premake` future partitions exist.
7. Run `CALL public.run_maintenance_proc()` manually and confirm it completes and that
   `part_config.maintenance_last_run` advances.
8. **Only then** repoint the cron at `CALL`, so the recurring job inherits a drained default.
9. Expect ~1.36 GB reclaimed from expired partitions on the first successful retention pass.

**Do not run a blind `CALL run_maintenance_proc()` against 27M DEFAULT rows as step 1.**

### Hard-won details from the last time this happened (2026-05-29)

This exact class of failure — partman stops, defaults fill — was repaired once before on
the old project (then: `00031`'s table rename left `part_config.parent_table` pointing at
stale `smon_*` names; `metrics_default` reached 12.85M rows / 3.3 GB). Reuse that
experience rather than rediscovering it:

- **`partition_data_proc`'s lock-wait branch is broken** in 5.3.1 — a `format()` call with
  too few arguments. **Do not pass `p_lock_wait`**, or it errors out on the very path you
  need under live writes.
- **The actively-written current week cannot be drained by `partition_data_proc`** — it
  races the incoming writes and never converges. Last time this needed a manual atomic
  `detach → create current+future partitions → backfill`. Expect the same for `metrics`.
- **`ignore_default_data = false` is the correct setting** (it was set deliberately during
  that repair — consistent with the `ATTACH` trap above).
- **A 120s `statement_timeout` kills big batches** — use `PGOPTIONS='-c statement_timeout=0'`.
- pg_partman 5.3.1 lives in the **`public`** schema here, not `partman` (verified again
  2026-07-16), so it is `public.run_maintenance_proc()`.
- Verify conservation before dropping any `*_olddefault` backup table, as was done then.

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

**1. `disk_io_stats` 14d vs. a 30d UI range — RESOLVED (now 35d), but see the caveat.**
The metrics page offers a `30d` option (`apps/web/src/app/(dashboard)/metrics/page.tsx:18`)
and queries `disk_io_stats` with it (`:114`, `parseRange` at `:892`). At 14d that chart
silently showed half its range with no empty state. Now **35 days** — 30d of range plus
5d headroom. The same `ranges` array also feeds `metrics` (90d, fine), which is exactly
why the mismatch was easy to miss. **Do not trim below 30d without removing the 30d
option from that panel first.** 35d still expires 12.27M of 16.8M rows, so this costs
little.

> **Caveat (review, 2026-07-16): the 30d option is already broken independently of
> retention.** `useDiskIO` does `.order("captured_at", {ascending: true}).limit(2000)`
> (`:118-123`), so it returns the **oldest 2,000 rows** in the window — at a 15s cadence
> across several devices that is a few hours of data from 30 days ago, not a 30-day chart.
> Retention was never what broke it. **35d is a compatibility window, not an endorsement of
> retaining 35 days of raw per-15s I/O.** The real fix is to downsample: hourly buckets via
> an aggregate/RPC for long ranges, keep raw I/O brief. Once that ships, `disk_io_stats`
> can drop back to ~14d and reclaim more. Tracked in AGENTS.md § 16.

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
   WHERE captured_at < now() - interval '35 days' LIMIT 1000;
   ```
   Good: `Index Scan` / `Bitmap Index Scan`.

   **"`Seq Scan` = stop" needs judgement, not reflex.** On `process_snapshots` the plan
   *was* a `Seq Scan` and that was correct: the 3-day predicate matched 57.9M of 58M
   rows, and when a predicate matches ~everything, `Seq Scan` + `LIMIT` finds qualifying
   rows immediately and beats an index scan. Measured: 50k rows in 532 ms. The rule
   assumes a *selective* predicate. A `Seq Scan` is a genuine stop signal only when few
   rows match — then it scans the whole table to find them. The index still earns its
   keep at the tail, once the bulk is gone and the predicate turns selective; the planner
   switches on its own. Verify with timings, not just the plan shape.
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
