# Synology Monitor — Active Work Handoff

Updated: 2026-07-17 (America/New_York)

This file exists because production operations remain unfinished. It contains
continuation state only; completed implementation history belongs in `AGENTS.md`
and topic docs.

## 1. What this application is

Synology Monitor operates POP Creations' two production Synology NAS units:
`edgesynology1` and `edgesynology2`. A Go agent on each NAS sends telemetry to
Supabase project `aaxtrlfpnoutziwhshlt` (Virginia). A Next.js dashboard at
`https://mon.designflow.app` detects issues and runs a three-stage AI diagnostic
pipeline. A Go NAS API on port `7734` executes guarded commands and native archive
jobs. The FastMCP service at `https://nas-mcp.designflow.app/mcp` exposes NAS
diagnostics and approval-gated repairs.

Repository: `u2giants/synology-monitor`, local path `/worksp/monitor/app`, branch
`main`. Normal deployment is GitHub Actions → GHCR → Coolify or NAS Watchtower.

## 2. What active work is trying to accomplish, and why

Four operational efforts remain:

1. Restore nine incorrect directory mtimes in the archived `___OLD` tree on
   `edgesynology1` using `edgesynology2` evidence.
2. Finish and verify Seafile inotify remediation so seaf-cli cannot silently claim
   synchronization after its filesystem monitor goes blind.
3. Finish telemetry retention and restore pg_partman without overwhelming the
   one-gigabyte Supabase database instance.
4. Reconcile the live NAS compose files with the repository's durable archive-job
   mount and `NAS_API_NAME`, which are still absent live even though other pending
   compose improvements were applied.

These are operational continuations, not unfinished application builds.

## 3. Current state

### A. Archive `___OLD` directory mtime repair — partial

Completed:

- Source directory mtimes under
  `/volume1/mac/Decor/Character Licensed/___OLD` on `edgesynology1` were repaired
  from `/tmp/edges2_dir_current_authority_20260615.csv`.
- Verification returned `source_authority_mismatches_after_repair 0`,
  `source_dirs_today_count=0`, and `source_files_today_count=0`.
- Commit `eb253f25fc6d8e1bdab1f76133b290017e9a0d8a` preserves source directory
  mtimes when a partial archive move leaves the source directory in place.

Still required on `edgesynology1` under
`/volume1/mac/Archive/Decor/Character Licensed/___OLD`:

| Relative directory | Correct mtime | Current/wrong mtime recorded 2026-06-16 |
|---|---|---|
| `Decor/Character Licensed/___OLD` | `2023-02-24 15:38:42 -0500` | `2026-06-16 10:33:20 -0400` |
| `.../Blinds - Paper Shades/Redi Order 1/Raw/Revised 36x78in` | `2024-12-06 08:10:42 -0500` | `2024-12-06 08:10:36 -0500` |
| `.../CNV012 Nick 10x13.5 no LED` | `2026-04-05 12:51:27 -0400` | `2026-03-25 00:51:05 -0400` |
| `.../Collage/Marvel AGE001/Cap` | `2026-04-05 12:51:25 -0400` | `2026-03-25 00:51:05 -0400` |
| `.../Collage/Marvel AGE001/Iron Man` | `2026-04-05 12:51:32 -0400` | `2026-03-25 00:51:05 -0400` |
| `.../Collage/Marvel AGE001/Old/Hulk` | `2026-04-05 12:51:45 -0400` | `2026-03-25 00:51:05 -0400` |
| `.../Collage/Marvel AGE001/SpiderMan` | `2026-04-05 12:51:33 -0400` | `2026-03-25 00:51:05 -0400` |
| `.../Embossed PVC/WonderWoman` | `2026-04-05 12:51:21 -0400` | `2026-03-25 00:51:05 -0400` |
| `.../Jojo Siwa/HIRES (1)` | `2026-04-05 12:51:31 -0400` | `2026-03-25 00:51:05 -0400` |

The SSH user could not apply these with `os.utime`; it returned
`PermissionError(1, 'Operation not permitted')`. The operation needs an approved
root-capable path. Read `docs/timestamp-audit-2026-06-15.md` and
`docs/layered-timestamp-audit-2026-06-15.md` before continuing.

### B. Seafile inotify remediation — code live, operational verification partial

Root cause and runbook: `docs/seafile-sync-inotify.md`.

Code state:

- `set_inotify_watches` and `write_seafile_ignore` are defined and enabled.
- NAS API and NAS MCP builds containing them are deployed.
- Validator tests cover their write classification.

Live state verified 2026-07-17:

| NAS | `max_user_watches` | `max_user_instances` | Meaning |
|---|---:|---:|---|
| `edgesynology1` | `1048576` | `1024` | Ceiling raise is live |
| `edgesynology2` | `8192` | `128` | Default remains; change only if this NAS runs the affected seaf-cli workload |

Unknown: whether every affected library root has `seafile-ignore.txt`, whether the
seaf-cli daemon was restarted after the change, and whether logs stayed free of
`No space left on device`. Those are the remaining verification gates.

### C. Telemetry retention and pg_partman — partial, high risk

Authoritative runbook and measurements: `docs/telemetry-retention.md`.

Live project: `aaxtrlfpnoutziwhshlt`. The former Ohio project
`qnjimovrsaacneqkggsn` is deleted; there is no rollback project.

Completed as of 2026-07-16:

- Migrations `00042` and `00043` are installed live.
- Both retention indexes are installed.
- 61,000 expired `process_snapshots` rows were deleted in staged tests.
- The cleanup runner now requires explicit `SUPABASE_URL`, refuses the retired
  project ref, and logs its target.
- `disk_io_stats` retention is 35 days; partman-owned tables were removed from the
  row-policy list.
- Anonymous execution of the privileged SQL function was revoked live and recorded
  in `00043`.
- Agent backlog isolation shipped; observed lag on NAS 1 drained from about 4,950
  seconds to 17 seconds.
- `stop_grace_period: 90s` is present in both live NAS compose files as of
  2026-07-17.

Still open:

- Roughly 56.4 million expired `process_snapshots` rows remained at last measure.
- The hourly retention cron is deliberately disabled because the current batching
  function does not commit between batches.
- pg_partman has failed since 2026-05-29 because cron uses `SELECT` on a procedure.
  Roughly 27 million rows / 8.4 GB were stranded in DEFAULT partitions at last
  measure.
- The first successful `CALL public.run_maintenance_proc()` must be run manually
  and watched before cron is corrected.
- The exposed AI key still needs owner-approved rotation through 1Password/Coolify.
- Review `nas_logs` size on 2026-08-17 or four weeks after retention goes live,
  whichever is later.

### D. NAS compose reconciliation — partial

Repository source: `deploy/synology/docker-compose.agent.yml`.
Live path on each NAS:
`/volume1/docker/synology-monitor-agent/compose.yaml`.

Verified live 2026-07-17 on both NASes:

- `stop_grace_period: 90s` is present.
- `/etc/group:/host/etc/group:ro` is present and active in nas-api.
- Both NAS APIs are healthy on build
  `6dcf16c6a37412c92e209be944fa6b31ca452406`.

Still absent from both live compose files at the last check:

- `NAS_API_NAME`
- `${NAS_API_JOBS_PATH:-...}:/app/data/jobs:rw`

Consequently, archive `/jobs/*` endpoints may return 503 and native job state is
not guaranteed durable. The two NAS compose files are not byte-identical and must
not be overwritten blindly; preserve each `.env` and local device/share differences.

### E. Two stray `@prechange_*` snapshots on edgesynology1 — operator decision, open

Re-verified present 2026-07-17:

```
ID 10393 gen 9438608 top level 257 path @prechange_20260716_154207
ID 10394 gen 9438622 top level 634 path mac/@prechange_20260716_154247
```

Host paths (confirmed over `ssh edgesynology1`): `/volume1/@prechange_20260716_154207` and
`/volume1/mac/@prechange_20260716_154247`. Inside nas-api they appear under `/btrfs/volume1/...`.

**Why they exist.** Nobody asked for them. `create_prechange_snapshot` was called with
`confirmed: false` — "show me what you would do" — and the preview bug executed it for real.
Fixed in `f4c8c7a`; these two are the residue. They protect no change and no rollback depends
on them.

**Not dangerous.** Read-only point-in-time images. They cannot corrupt anything and do not
affect SMB users. The only cost is space: a snapshot pins blocks its parent has since changed,
so its footprint grows as live data diverges.

**Size: unknown, deliberately unmeasured.** `btrfs qgroup show` → `quotas not enabled`, so the
cheap answer does not exist; `btrfs filesystem du` across 57 TB is the metadata storm § 7
forbids while SMB users are active. Context makes the question small: `df -h /volume1` → **109T
total, 57T used, 53T free, 52%**, and they are a day old. No pressure, no deadline.

**Recommendation: delete when convenient.** No value, slowly growing cost, but genuinely low
priority at 52% full.

**How — operator only, from a terminal.** No MCP tool deletes snapshots (`tool_search
"snapshot"` returns create/list/restore only) and `btrfs subvolume delete` is tier 3, so
`run_command` refuses it by design. `btrfs` is **not** in the NOPASSWD sudoers list, so this
**will prompt for your password** — expected, not an error:

```sh
ssh edgesynology1
sudo btrfs subvolume list /volume1 | grep prechange     # expect exactly IDs 10393 and 10394
sudo btrfs subvolume delete /volume1/@prechange_20260716_154207
sudo btrfs subvolume delete /volume1/mac/@prechange_20260716_154247
sudo btrfs subvolume list /volume1 | grep prechange     # expect NO output
```

**Do not blind-delete anything else matching the pattern.** The same volume holds
`@archive_move_snapshots/mv_*` subvolumes (six seen, 2026-06-11 → 06-16). Those are the
archive-move feature's documented rollback points — deleting one could remove the only way back
from a move. Whether that set is stale is a separate open question (§ 9).

## 4. Everything tried that did not work

| Attempt | Why it seemed reasonable | How it failed / lesson |
|---|---|---|
| Apply archive mtimes as the SSH user | The target directories were visible and ordinary `utime` works on owned files | DSM returned `EPERM`; use an approved privileged path, not repeated retries |
| Restart seaf-cli without raising limits | Restart temporarily restores watches | It only masks exhaustion; the monitor goes blind again |
| Lower inotify ceilings to reduce memory | A smaller ceiling sounds cheaper | It is only a ceiling, not preallocation; lowering removes needed headroom |
| Install retention on the remembered Supabase project | The old project had been used as rollback | Work landed on Ohio, not production; always verify project ref first |
| Run retention batches expecting independent commits | The procedure loops in batches | One function call is one transaction; dead tuples and locks accumulate until return |
| Fix pg_partman cron immediately | The syntax defect is only `SELECT` versus `CALL` | First success must process a huge backlog on a small instance; observe manually first |
| Set `ignore_default_data=true` to skip backlog | It sounds like a way to bypass DEFAULT rows | PostgreSQL must validate DEFAULT on attach; this causes partition creation to fail |
| Assume repository compose changes reach NASes | Watchtower updates the related services | Watchtower updates images only; compose is a manual, NAS-specific copy |

## 5. Root causes and key findings

- Synology/Seafile worktrees contain roughly 541,000 directories; about 82% were
  `@eaDir`, exhausting the default 8,192 inotify watch ceiling.
- `edgesynology2` is evidence authority for timestamp repairs, but writes should
  normally occur only on `edgesynology1` to avoid competing ShareSync metadata events.
- Retention migration `00042` re-schedules its hourly cron when rerun. After any
  rerun, explicitly check `cron.job` and unschedule it until commit-per-batch is fixed.
- Row deletion does not immediately reduce reported database size; vacuum must reuse
  or return space.
- Direct Supabase database access is IPv6-only; the pooler rejects this tenant.
  The `postgres` role has an approximately two-minute statement timeout; use the
  documented `PGOPTIONS` override through a 1Password-backed command.
- NAS compose is local state. The repo version is canonical intent, but deployment
  must merge NAS-specific differences rather than copy blindly.

## 6. Exact next steps

1. **Archive mtime repair:** schedule a quiet window; read both timestamp audit docs;
   verify the nine current mtimes; apply only the listed directory mtimes on
   `edgesynology1` through an approved root-capable operation; rerun the authority
   comparison. Success means zero mismatches and no file-content/ownership changes.
2. **Seafile verification:** on each affected edge1 library root, confirm
   `seafile-ignore.txt` contains the standard ignore set; restart the seaf-cli stack
   through DSM Container Manager; monitor logs and watch consumption. Success means
   no new `No space left on device` and stable synchronization after restart.
3. **Retention decision:** choose a controlled one-pass drain or corrected scheduled
   drain using `docs/telemetry-retention.md`; run batches with blocking/latency checks;
   `ANALYZE` afterward. Success means expired estimates approach zero without agent lag.
4. **pg_partman:** run `CALL public.run_maintenance_proc()` manually with the documented
   timeout override and watch locks, disk, and ingestion; only then fix cron. Success
   means maintenance completes, DEFAULT rows relocate, and subsequent cron succeeds.
5. **Compose reconciliation:** diff each live compose against the repo; merge only
   `NAS_API_NAME` and the durable jobs mount plus any other explicitly approved missing
   settings; run targeted `docker compose up -d nas-api`. Success means `/app/data/jobs`
   is writable/persistent, health is current, and `/jobs/*` no longer returns 503.
6. **Credential follow-up:** obtain owner approval, rotate the AI key in 1Password and
   Coolify, restart the affected service, and verify provider health. Never print the key.
7. **Scheduled review:** on 2026-08-17 (or four live-retention weeks later), run the
   `nas_logs` size/severity queries in the retention doc and decide whether row-level
   low-severity retention is worth its cost.

## 7. Constraints and gotchas

- No large NAS crawl or recursive metadata write while SMB users are active.
- Use `/opt/bin/ionice -c3 nice -n 19` for metadata-heavy NAS work.
- Do not repair both NAS sides by default.
- Do not re-enable retention cron merely because migration `00042` exists.
- Do not run plain `CREATE INDEX` on large live telemetry tables; use
  `CONCURRENTLY` outside a transaction.
- Do not use `version.json` to verify Coolify deploys; use live HTML build SHA.
- Do not use routine SSH as a deployment system.
- Do not expose 1Password values in commands, logs, files, or transcripts.

## 8. Access and environment

- GitHub CLI, `supabase`, `op`, and SSH aliases are available on this workstation.
- SSH: `edgesynology1` (port 22) and `edgesynology2` (port 1904), both over Tailscale.
- Docker under non-interactive NAS sudo must use
  `/var/packages/ContainerManager/target/usr/bin/docker`.
- Secrets live in 1Password vault `vibe_coding`; the database password item is
  `Supabase DB Password - synology-monitor (aaxtrlfpnoutziwhshlt, Virginia)`.
- Production web/MCP runtime variables live in Coolify; NAS runtime variables live
  in each stack's untracked `.env`; CI values live in GitHub Secrets.
- Branch/environment: `main`, production NASes and production Virginia Supabase.

### F. `repair_path_ownership` (6dcf16c) — shipped and enabled, but an independent review says not done

An independent Codex review (read-only, 2026-07-17) of the shipped implementation found defects
that a second pair of eyes caught and the original pass did not.

**Two were confirmed by measurement and are now FIXED (`fe0186c`):**

1. ~~**The ACL safety warning can never fire — it fails open.**~~ **FIXED.**
   `synoacltool -get "$path" 2>&1 | head -8 || echo 'WARNING...'` reported `head`'s exit status
   (0), so a failed ACL read passed silently and the chown proceeded with unknown ACL state. Now
   the read is captured with its own exit status (`acl_out=$(...); acl_rc=$?`) and the warning
   fires on non-zero, before the write. A regression test asserts both directions and was
   confirmed to fail on the old code.
2. ~~**The symlink test does not test symlinks.**~~ **FIXED.** The misnamed test was split; a new
   test executes the generated command against an actual symlink through the temp-dir harness and
   asserts it aborts before the chown. Confirmed to fail when the runtime `[ ! -L ]` guard is
   removed.

**Still open (the deeper items — not addressed by `fe0186c`):**

- **Only the final path component is symlink-checked.** `[ ! -L "$path" ]` does not protect a
  symlinked *parent*; the path is never canonicalised against a share boundary.
- **Check-to-write race.** Between `[ ! -L ]`, `stat` and `chown`, an SMB client can replace the
  object; nothing binds device/inode identity across the gap.
- **Hard links** are not considered — chowning one name changes ownership for every link.
- **The preview is not informed consent for a non-developer.** It shows a Bash program;
  `Current ownership` and `=== ACL MODE ===` are echoed from *inside* that script, so they only
  appear at execution — after approval. The facts that should drive the decision arrive too late
  to inform it.
- **MCP approval binding gap.** The confirmation path rebuilds the command on the second call
  and mints a fresh token without requiring a hash/receipt of the command the human actually
  saw (`apps/nas-mcp/src/index.ts:173`). The web issue workflow executes a persisted approved
  command and does not have this gap.
- **On a Synology-ACL path an ACE can override POSIX ownership**, so `VERIFIED: ownership is
  153742:100` can be true and still change nothing an SMB user experiences. Recommendation:
  **fail closed on ACL paths** until `synoacltool -set-owner` semantics are proven, rather than
  merely reporting the mode.

**Nothing has been run against a real NAS path.** The included test is a synthetic temp-dir
no-op. The one thing the plan insisted on — a no-op chown proven on a scratch path, on **both**
NASes (es1 is Linux mode, es2 has a real ACL) — has still not happened. That is exactly how all
three of these tools stayed broken for months.

Risk is bounded meanwhile: tier 3, one path, non-recursive, human-approved, reversible. Not an
emergency; not done either.

## 9. Open questions and risks

- Is `seafile-ignore.txt` installed on every affected library, and does seaf-cli
  avoid allocating watches for ignored directories? Verify live; do not assume.
- Which controlled retention-drain strategy does the owner approve?
- How long will the first successful pg_partman maintenance run, and will the
  36-GB database disk need preemptive expansion? Observe before cron.
- Why were the nine archive directory mtimes changed? Repair evidence is strong,
  but the original actor/event remains unknown.
- Do both NASes need the archive jobs system enabled immediately, or should compose
  reconciliation wait for an operator maintenance window?
- Database deletes are irreversible because the Ohio rollback project is gone.

## Handoff self-audit

Passed 2026-07-17: a new senior engineer can identify the application, reproduce
the current state, avoid documented dead ends, execute each next step with a
verification gate, locate required access, and understand every active risk without
the prior chat transcript.
