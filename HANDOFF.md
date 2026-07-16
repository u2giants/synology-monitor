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
**partial — installed on live, deletes paused mid-way, hourly cron deliberately NOT
enabled.** `00042` and both retention indexes are on `aaxtrlfpnoutziwhshlt`; 61,000
`process_snapshots` rows were deleted in staged batches to prove the path, leaving
**56.4M expired rows** (97% of the table) still there. Full live state, measured delete
timings, and the re-enable SQL are in
**[docs/telemetry-retention.md](docs/telemetry-retention.md)**.

**A bigger problem was found while doing this: pg_partman has been dead since
2026-05-29** (cron uses `select` on a procedure; 25/25 failures), stranding ~8.4 GB in
DEFAULT partitions that partman retention can never drop. That doc's first section
covers it. It is the larger cause of growth and it is **not fixed** — and it means
`metrics` / `nas_logs` / `storage_snapshots` / `container_status` currently have **no
retention from either mechanism**.

Full detail — design, the wrong-project incident, known defects, verified-safe list,
and the step-by-step live install — is in **[docs/telemetry-retention.md](docs/telemetry-retention.md)**.
Read that first; this section is only the continuation context.

Done (2026-07-16):
- Landed the stashed ref-swap: 13 files no longer name the deleted Ohio project
  `qnjimovrsaacneqkggsn`. That stash was the root cause of the 2026-06-22 mistake —
  it made the repo advertise a retired project.
- Removed the silent `DEFAULT_SUPABASE_URL` fallback from
  `scripts/run-telemetry-retention-cleanup.mjs`; it now refuses to run without an
  explicit `SUPABASE_URL`, hard-refuses the retired ref by name, and logs its target.
  All three guards were exercised and verified.
- Confirmed at session start that live `aaxtrlfpnoutziwhshlt` had **no retention**
  (`telemetry_retention_policies` → PGRST205, `telemetry_retention_estimates` → PGRST202)
  — i.e. the 2026-06-22 work never reached it. *(Superseded: retention has since been
  installed this session — see Status above.)*
- Verified the old project `qnjimovrsaacneqkggsn` is **deleted** — absent from
  `supabase projects list`. Its purge/functions/cron went with it. **There is no
  rollback project anymore.**
- Audited every reader of all policy tables (see the doc). No FK or view risk; all
  timestamp column names correct. Found four defects — all now resolved in the file.
- Applied the owner's decisions (2026-07-16) and fixed `00042`:
  - `disk_io_stats` 14d → **35d**, so the metrics page's 30d range keeps working.
  - Index creation is now `to_regclass`-guarded (it previously hard-failed a rebuild:
    `ERROR: relation "process_snapshots" does not exist`).
  - `metrics` / `nas_logs` / `storage_snapshots` / `container_status` removed from the
    policies, and all `part_config` writes dropped — **pg_partman keeps ownership at its
    existing settings**, so the deliberate 180d `container_status` decision stands.
- Verified on a throwaway PG17 container: clean run on a bare DB (guard skips 8 absent
  tables, inserts 13 policies); batch limit honoured exactly (400 of 1000); runner
  drains the rest; fresh rows and 20d `disk_io_stats` rows survive.

Next action — two independent decisions, both awaiting the owner:

**A. Finish the `process_snapshots` drain (~10 min of work, big win).**
56.4M expired rows remain; measured 50k per 532 ms with zero blocked sessions. Either
re-enable the hourly cron (SQL in the doc) and let it grind down over ~2 days, or drain
it in one controlled pass and then enable the cron. Then `ANALYZE`. Expect most of
`process_snapshots`' 16 GB back — though **the reported DB size will not drop until
vacuum reuses/returns the space**; that is expected, not a failure.

**B. Fix pg_partman (the ~8.4 GB problem).**
One-word fix (`select` → `CALL`) but the first successful run has 48 days of backlog and
~27M default rows to relocate on a 1 GB Micro. **Do not** set `ignore_default_data = true`
to dodge it — that makes partition creation *fail* rather than skip work (Postgres must
validate the DEFAULT partition on `ATTACH`). Run `CALL public.run_maintenance_proc()`
manually and watched **before** repointing the cron. Procedure in the doc.

Connecting for either: the DB password is in 1Password →
`Supabase DB Password - synology-monitor (aaxtrlfpnoutziwhshlt, Virginia)`; use `op_run`
so it never enters a transcript. Direct host is **IPv6-only**; the pooler rejects the
tenant. `postgres` role has a ~2min `statement_timeout` — override with `PGOPTIONS`.

⚠️ **Two live issues found while doing this — neither is caused by the retention work, both are unfixed:**
1. **`anon` could run arbitrary SQL + read the AI key** — CLOSED on live and in `00043`, but
   **the `sk-or-v1-…` key must still be rotated by the owner.** See AGENTS.md § 15.
2. **Agent ingestion cannot keep up**: `process_snapshots` is ~80 min stale on edge1 and
   drifting ~8% further behind. Sender flushes one 100-row batch per 30s (200/min) vs a
   collector emitting up to 240/min. Structural; backlogs never drain. See AGENTS.md § 16.
   (edge2 is ~282 min stale for a separate reason — it was unreachable all session.)

⚠️ **Gotcha for whoever re-runs `00042`:** its final `DO` block **re-schedules the hourly
cron**. Re-running the migration silently re-armed the job that was deliberately
unscheduled (caught 2026-07-16 before it fired). After any `00042` re-run, verify:
`SELECT count(*) FROM cron.job WHERE jobname='telemetry-retention-cleanup';` and unschedule
until the commit-per-batch issue is fixed.

Scheduled review — **2026-08-17**: is `nas_logs` a real space driver?

Why this date exists: to let partman own the partitioned tables, `nas_logs` was dropped
from `telemetry_retention_policies`, so its routine `info` rows (sources `share_config`,
`package_health`, `drive_admin_stats`, `dsm_system_log`, `backup`, `service`,
`system_info`) now live partman's full **180d** instead of being trimmed at 30d. A
partition drop cannot express "delete only low-severity rows", so this was the accepted
cost of the simpler design. It is the one policy decision in `00042` that was a trade
rather than a fix, and nothing will surface it on its own — hence a date.

Check on **2026-08-17** (or 4 weeks after retention actually goes live, whichever is
later — the comparison is meaningless until the other tables have been trimmed):

```sql
-- nas_logs total size and share of the database
SELECT pg_size_pretty(pg_total_relation_size('public.nas_logs')) AS nas_logs_size,
       pg_size_pretty(pg_database_size(current_database()))      AS db_size,
       round(100.0 * pg_total_relation_size('public.nas_logs')
             / nullif(pg_database_size(current_database()),0), 1) AS pct_of_db;

-- how much of it is the trimmable routine-info noise
SELECT severity, source, count(*)
FROM public.nas_logs
WHERE ingested_at < now() - interval '30 days'
GROUP BY 1,2 ORDER BY 3 DESC LIMIT 15;
```

Decide with it:
- **< ~5% of the DB** → leave it alone; the simpler partman-only design wins.
- **> ~10%, mostly `severity='info'` from those sources** → reinstate the single
  `nas_logs` row-level policy that `e1eea2f` removed (recover it from that commit:
  `git show e1eea2f^:supabase/migrations/00042_telemetry_retention_cleanup.sql`). Accept
  that row-level DELETEs on a partitioned parent are slower than partition drops, and
  give it a `(ingested_at)` index built `CONCURRENTLY` first.

Risks / watchouts:
- **No rollback project exists.** Deletes on `aaxtrlfpnoutziwhshlt` are final.
- Retention is **not** additive: it deletes rows hourly, forever. (It no longer touches
  `part_config` — that was removed deliberately; do not reintroduce it.)
- Untested at scale: the PG17 verification used small tables. Cold-cache behavior on a
  43M-row table is exactly what the staged batch escalation is there to find.
- Plain `CREATE INDEX` on the big live tables blocks agent writes while it builds. Use
  `CONCURRENTLY`, which cannot run in a transaction block (so not via `exec_sql`, which
  is void-returning anyway — HTTP 204, no rows).
- The Virginia project sits on a 36 GB disk that already filled and crashed the DB
  read-only once; AWS gp3 allows a resize only once per 4h.
- Deleting rows will **not** immediately shrink the size Supabase reports.

## NAS write-preview fix — `edgesynology2` still on the old nas-api build

Status:
partial (code complete, pushed, verified live on `edgesynology1`; `edgesynology2` unreachable)

Done:
- Fixed the reported bug: `create_prechange_snapshot` with `confirmed: false` executed a
  real snapshot instead of previewing. `apps/nas-mcp` gated confirmation on nas-api's
  tier classification (`preview.tier >= 2 && !input.confirmed`) rather than the tool's
  own `write: true` flag, so any write tool the classifier under-scored auto-executed.
  Now every `write: true` tool previews regardless of tier (`f4c8c7a`).
- Fixed the root cause underneath it: `ClassifyTier` had **no btrfs patterns at all**, so
  every btrfs subcommand — including `btrfs subvolume delete` — scored tier 1
  (read-only, auto-execute). An audit of all 40 shell write tools against the real
  classifier found the same gap for `smartctl -t`/`-X` and `setfacl`, affecting
  `create_prechange_snapshot`, `start_btrfs_scrub`, `start`/`cancel_smart_test`, and
  `repair_path_acl` (`8e0971b`).
- Verified live on `edgesynology1` after Watchtower picked up `f4c8c7a` (16:56 UTC
  2026-07-16): `create_prechange_snapshot` with `confirmed: false` returns a preview and
  creates nothing (`btrfs subvolume list` unchanged); the command now classifies tier 2;
  `run_command` now refuses `btrfs subvolume delete`, which it previously executed; and
  read-only diagnostics (`subvolume list`, `scrub status`, `smartctl -a`,
  `-l selftest`) still run at tier 1.

Next action:
- Confirm `GET http://100.107.131.36:7734/health` on `edgesynology2` reports
  `build_sha` `f4c8c7a` or newer once the host is reachable again. It was unreachable
  during this session (10s curl timeout from this workstation, and a 45s MCP
  `run_command` timeout from the VPS over Tailscale, so it is the host — not the network
  path). `edgesynology1` reported `f4c8c7a` at 16:56 UTC. No action should be needed:
  Watchtower polls GHCR every 5 minutes and will recreate the container on its own.
- Decide whether to delete the two stray snapshots the bug created on `edgesynology1`
  before it was fixed: `@prechange_20260716_154207` and `mac/@prechange_20260716_154247`
  (both 2026-07-16 15:42 UTC). They are read-only btrfs snapshots — harmless, but they
  pin CoW space that grows as the live subvolume diverges. Deleting them is now tier 3.

Risks / watchouts:
- Until `edgesynology2` is updated, its `run_command` still executes `btrfs`,
  `smartctl -t`/`-X`, and `setfacl` commands unattended as tier 1. The `nas-mcp` fix is
  already live and covers the **named** write tools on both NASes (it does not depend on
  nas-api's tier), but it cannot cover free-form `run_command`, which takes no
  `confirmed` argument and gates only on the classifier.
- Do not "simplify" the two layers back into one. They are independent on purpose: the
  MCP gate cannot protect `run_command`, and the classifier cannot be trusted to have no
  gaps. Background: AGENTS.md §10 and `docs/architecture.md`.
