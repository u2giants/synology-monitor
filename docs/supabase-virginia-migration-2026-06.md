---
summary: Record of moving the Supabase backend from the deleted Ohio project to Virginia aaxtrlfpnoutziwhshlt; no rollback exists.
kind: proof
status: done
read-when: Confirming which Supabase project is live or tracing a stale project reference.
---

# Supabase backend migration: Ohio → Virginia (2026-06-21)

## Summary

The synology-monitor Supabase backend was migrated from project
`qnjimovrsaacneqkggsn` ("SynoMon.old", us-east-2 / Ohio) to
**`aaxtrlfpnoutziwhshlt`** ("synomon", us-east-1 / N. Virginia). Full-history
copy (~29 GB).

> **Update 2026-07-16 — the rollback is gone.** The old project
> `qnjimovrsaacneqkggsn` has been **deleted** and no longer appears in
> `supabase projects list`. `aaxtrlfpnoutziwhshlt` is now the only Supabase
> project for this app, and **there is no rollback**. Treat destructive work
> against it accordingly. See [telemetry-retention.md](telemetry-retention.md)
> for what this deletion silently took with it.

> **Scope note:** synology-monitor uses its **own** Supabase project. It is **not**
> part of `u2giants/shared-db` (the DAM/CRM/PM/PLM unified backend). Do not record
> this project's changes there.

## New identifiers (update anything still pointing at the old ref)

- Project URL: `https://aaxtrlfpnoutziwhshlt.supabase.co`
- Region us-east-1 (N. Virginia); compute Micro (1 GB RAM); disk grown to 36 GB.
- Old project: `qnjimovrsaacneqkggsn` — **deleted as of 2026-07-16** (verified: absent
  from `supabase projects list`). It was the rollback during the confidence window.
  Anything still naming this ref is stale config. A session that points at it now
  fails against a nonexistent project — and, worse, one that *reasoned its way to it*
  from stale repo strings already wasted a full day's work (see
  [telemetry-retention.md](telemetry-retention.md)).

## Cutover surface (every place that holds the URL/keys)

- **Web image (baked!):** `web-image.yml` bakes `NEXT_PUBLIC_SUPABASE_URL` +
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` from **repo Secrets** at build. A runtime Coolify
  env change does **not** repoint the browser bundle — you must rebuild
  (`gh workflow run web-image.yml`), which auto-redeploys Coolify.
- **Coolify** app `lrddgp8im0276gllujfu7wm3` (nas-monitor-web, mon.designflow.app):
  runtime env `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY` — update the `is_preview=false` entries (the
  `is_preview=true` duplicates point at popdam `ryltkzz…` and are unrelated).
- **NAS agents:** `/volume1/docker/synology-monitor-agent/.env`
  (`SUPABASE_URL` + `SUPABASE_SERVICE_KEY`) on edge1 (`100.107.131.35:22`) and
  edge2 (`100.107.131.36:1904`), then `docker compose up -d synology-monitor-agent`.

## Migration method & gotchas (don't repeat the dead ends)

- Schema+roles via `supabase db dump`; data via `pg_dump -Fd -j4` (data-only,
  public) + `pg_restore -j4`. Set `ALTER ROLE postgres SET
  session_replication_role='replica'` as a **role default** to bypass FK/triggers —
  `--disable-triggers` does **not** work on Supabase (postgres isn't superuser).
- Use a **PG17** client (server is PG17; PG16 `pg_dump` refuses a newer server).
  The direct IPv6 DB host works; the transaction pooler (port 6543) is unusable for
  `pg_dump`.
- **Not in a public dump — recreate manually:** the 5 pg_cron jobs, the
  `smon_openai_api_key` vault secret, and `auth.users`+`auth.identities`. pg_partman
  `part_config` data *does* travel in the data dump.
- **Disk:** new Supabase projects start ~8 GB; a bulk 29 GB load fills it and
  crashes the DB read-only. **Pre-grow the disk first** via
  `POST /v1/projects/{ref}/config/disk`; AWS gp3 allows a resize only **once per 4h**.
- **Huge tables:** restoring `process_snapshots` (43M rows) *with* indexes thrashed
  for 7h+ on Micro (index maintenance on cold cache). Fix = drop its indexes,
  bulk-load data, rebuild indexes with `statement_timeout=0; maintenance_work_mem='400MB'`.
- **Warm-up:** right after a big load, a one-time autovacuum + cold cache cause
  agent insert timeouts. Temporarily raise `service_role` statement_timeout, let it
  warm (~15 min once autovacuum finishes), then `ALTER ROLE service_role RESET
  statement_timeout` to match source.

## Auth — project-level config does NOT transfer in a DB dump

- The new project needed Google OAuth re-enabled + `site_url` +
  `uri_allow_list` set via `PATCH /v1/projects/{ref}/config/auth`.
- **Gotcha:** the Management API returns secret fields (`external_google_secret`)
  **hashed**, so copying old→new installs a hash, not the real secret. Symptom:
  Google authenticates fine, but the code exchange fails with
  `invalid_client "The provided client secret is invalid."` and the app **silently
  bounces to /login**. Fix: set the real plaintext `GOCSPX-…` secret (from the
  Google Cloud Console / provided by the owner).
- Google "Web application" OAuth client **redirect URIs have no working
  gcloud/API path** (IAP APIs require an org + are deprecated; the internal
  `clientauthconfig` host 404s) — **Console-only**. The new callback
  `https://aaxtrlfpnoutziwhshlt.supabase.co/auth/v1/callback` must be added there
  by hand.
- Diagnose login failures with Supabase `get_logs(service=auth)` — it shows the
  exact GoTrue/OAuth error.

## Agent fixes shipped this session (`apps/agent/internal/sender/sender.go`)

Pre-existing bugs surfaced by the cutover; fixed and deployed to both NASes:

- Strip JSON NUL (`\u0000`) escapes before POST — Postgres rejects NUL with
  SQLSTATE 22P05 (hit `custom_metric_data`, `alerts`). _(commit d19c89b)_
- `package_status` upsert needs an explicit `?on_conflict=nas_id,package_id`;
  PostgREST infers the PK otherwise, so merge-duplicates 409s on every existing
  row. _(commit d19c89b)_
- Collectors emit alert severity `"error"` (btrfs/storage/hyperbackup faults) but
  the `alerts` CHECK allows only `info|warning|critical` → normalize
  `error`→`critical` in `QueueAlert`; these serious alerts were previously dropped.
  _(commit 68319f4)_

## Verified

- Per-table row parity vs source: config/state tables exact-match; telemetry tables
  source-ahead only by the migration-window drift (accepted — regenerating).
- Both NAS agents writing cleanly to the new project, including the three
  previously-failing tables.
- Web app served on the new project; **email/password and Google SSO both working.**
