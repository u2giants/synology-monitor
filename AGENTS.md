# Synology Monitor: Project Guide

## Read This First

This repository exists to monitor two Synology DS1621xs+ NAS devices, but the real
business priority is not generic hardware telemetry. The highest-value problem space is:

- Synology Drive reliability
- ShareSync behavior
- filesystem changes
- user-attributed file operations where Synology exposes a username
- sync failures, sync conflicts, rename/move/delete activity
- ransomware-style behavior on shared storage

If you are choosing between generic infrastructure work and better filesystem/sync
observability, favor the filesystem/sync work.

## Operating Rules

The owner has been explicit about change control:

- GitHub is the source of truth.
- Do not patch production code directly on the server.
- Repo changes must be committed and pushed.
- Deployments must flow from GitHub through Coolify or GitHub Actions.
- Direct server-side hotfixes are forbidden unless explicitly approved.

It is acceptable to inspect live systems for diagnostics and to restart/recreate
containers when deploying repo-produced images. It is not acceptable to edit live
application code or config outside the repository.

## Product Goal

The system has three major parts:

- `apps/agent`
  A Go Docker agent that runs on each NAS and sends telemetry/events upstream.

- `apps/web`
  A Next.js 15 dashboard with Supabase Auth + Realtime.

- `supabase`
  The central Postgres store plus migrations and in-database AI scheduling.

The long-term product is a monitoring and operational forensics system for Synology NAS
environments, with special emphasis on shared-file workflows and sync failures.

## Current Live Topology

- Repo: `https://github.com/u2giants/synology-monitor`
- Branch strategy: direct to `master`
- Web UI: `https://mon.designflow.app`
- Coolify app UUID: `lrddgp8im0276gllujfu7wm3`
- Supabase project ref: `ryltkzzernhwnojzouyb`
- Supabase URL: `https://ryltkzzernhwnojzouyb.supabase.co`
- NAS reachability from the VPS: over Tailscale

Current NAS endpoints:

- `edgesynology1`
  - Tailscale SSH target: `popdam@100.107.131.35:22`
- `edgesynology2`
  - Tailscale SSH target: `popdam@100.107.131.36:1904`

The NAS Docker deployment directory on both boxes is:

- `/volume1/docker/synology-monitor-agent`

## Repository Structure

- `apps/web`
  Next.js 15 app.

- `apps/agent`
  Go agent.

- `packages/shared`
  Shared TypeScript types.

- `supabase/migrations`
  Database schema and behavior.

- `deploy/synology`
  Synology Docker deployment assets and templates.

- `.github/workflows/agent-image.yml`
  Builds and publishes the NAS agent image to GHCR.

## Web App State

The web app currently provides:

- Supabase Auth email/password login
- Google OAuth login
- dashboard placeholders and real-time data wiring
- NAS Copilot chat with GPT-5.4, live SSH diagnostics over Tailscale, and per-action approval for repair commands
- deployment through Coolify

Relevant files:

- `apps/web/src/app/login/page.tsx`
- `apps/web/src/app/auth/callback/route.ts`
- `apps/web/src/lib/supabase/*`

Known auth facts:

- Google OAuth is working
- Google is configured through Supabase
- the callback flow was hardened for reverse-proxy deployment
- there is no app-level RBAC or admin-role model yet
- authenticated user does not imply “admin”, because no admin concept exists in the app today

## NAS Copilot

The web app now includes a `NAS Copilot` surface at:

- `/assistant`

It is intended to:

- answer questions about current NAS state
- inspect both NASes live over Tailscale SSH
- summarize recent logs, alerts, and Drive activity from Supabase
- propose exact repair commands when appropriate
- require an explicit human approval click before any proposed command executes

Relevant files:

- `apps/web/src/app/(dashboard)/assistant/page.tsx`
- `apps/web/src/app/api/copilot/chat/route.ts`
- `apps/web/src/app/api/copilot/execute/route.ts`
- `apps/web/src/lib/server/copilot.ts`
- `apps/web/src/lib/server/nas.ts`

Current implementation details:

- model default: `gpt-5.4`
- reasoning options exposed in the UI:
  - `high`
  - `xhigh`
- chat history now prefers Supabase persistence and falls back to browser local storage if the copilot tables are unavailable
- messages can carry evidence bundles derived from alerts, logs, and SSH diagnostics
- write actions are server-signed and expire after a short window before execution
- the assistant uses a structured NAS tool catalog instead of unconstrained shell proposals
- the UI exposes a bounded history window selector (`1h`, `2h`, `6h`, `24h`)
- roles can be supplied through `smon_user_roles` and/or `COPILOT_ADMIN_EMAILS`

Runtime env required by the web app:

- `OPENAI_API_KEY`
- `OPENAI_CHAT_MODEL`
- `COPILOT_ACTION_SIGNING_KEY` (recommended)
- `COPILOT_ADMIN_EMAILS`
- `NAS_EDGE1_HOST`
- `NAS_EDGE1_PORT`
- `NAS_EDGE1_USER`
- `NAS_EDGE1_PASSWORD`
- `NAS_EDGE1_SUDO_PASSWORD`
- `NAS_EDGE2_HOST`
- `NAS_EDGE2_PORT`
- `NAS_EDGE2_USER`
- `NAS_EDGE2_PASSWORD`
- `NAS_EDGE2_SUDO_PASSWORD`

Important safety boundary:

- the execute endpoint must never trust arbitrary browser-supplied commands
- only server-signed proposed actions may execute
- destructive command families are blocked in `apps/web/src/lib/server/nas.ts`
- the model proposes structured tools which the server materializes into shell commands
- this is still not equivalent to a full privileged access system; it is a constrained approval layer

## Agent State

The agent currently does all of the following:

- DSM API login
- system metrics collection
- storage/volume/disk collection
- Docker/container collection
- DSM/system/security/connection/package log ingestion
- filesystem watching via `fsnotify`
- entropy-based ransomware detection
- mass-rename detection
- checksum-based scanning
- local SQLite WAL buffering before Supabase flush

Relevant files:

- `apps/agent/cmd/agent/main.go`
- `apps/agent/internal/config/config.go`
- `apps/agent/internal/dsm/client.go`
- `apps/agent/internal/logwatcher/watcher.go`
- `apps/agent/internal/security/watcher.go`
- `apps/agent/internal/sender/sender.go`

## Synology Drive Coverage

Drive-related observability has been expanded substantially.

The agent now ingests these Drive-related sources:

- `/var/log/synologydrive.log`
  - stored as `source=drive_server`

- `WATCH_PATHS/@synologydrive/log/*.log`
  - stored as `source=drive`

- `WATCH_PATHS/@synologydrive/log/syncfolder.log`
  - stored as `source=drive_sharesync`

- any extra package logs supplied through:
  - `EXTRA_LOG_FILES=path|source,path|source`

The live database was updated to allow:

- `drive`
- `drive_server`
- `drive_sharesync`

Relevant migration:

- `supabase/migrations/00006_expand_log_sources_for_drive.sql`

## Startup Backfill

Drive logs are too important to only tail from EOF after a restart.

Current behavior:

- on startup, Drive-related sources bootstrap the last `200` lines
- after bootstrap, normal tail-from-EOF resumes

This is intentionally bounded so the agent does not replay entire historical system logs
on each restart.

That startup backfill is implemented in:

- `apps/agent/internal/logwatcher/watcher.go`

## Drive Parsing: What It Extracts

The Drive parser attempts to enrich events with:

- `user`
- `path`
- `share_name`
- `new_share_name`
- `component`
- `action`

Current component values include:

- `drive`
- `sharesync`
- `admin_console`

Current action values include:

- `create`
- `delete`
- `rename`
- `move`
- `upload`
- `download`
- `sync_conflict`
- `sync_failure`

## What Is Actually Verified

Verified from live NAS logs and live Supabase ingestion:

- `drive` rows are landing
- `drive_server` rows are landing
- `drive_sharesync` rows are landing
- ShareSync snapshot-style events are being classified as `drive_sharesync`
- delete events from ShareSync-style notifications are being detected
- Drive user attribution works when Synology includes the user in the log line

Examples already observed:

- repeated download events with `metadata.user = "ahazan"`
- `drive_server` bootstrap rows from edge2 with messages like:
  - `Checking user 'ahazan' ...`

Important caveat:

- username attribution is only available when Synology includes it in the log line
- raw filesystem watcher events do not inherently contain a user identity
- not every Drive/Admin log row contains a username

## Known Gaps

These are still incomplete:

- SMB per-file audit coverage
  - current SMB visibility is only basic connection-level logging

- complete Synology Drive Admin Console coverage
  - current coverage is log-based, not API-complete

- guaranteed per-user attribution for all file operations
  - only available where Synology provides the identity

- polished parsing for every Synology Drive log variant
  - many useful variants are covered, but the log surface is large and still evolving

## Synology Deployment Model

The NAS agents do not build from source on the appliances.

Instead:

- GitHub Actions builds the agent image
- the image is pushed to GHCR
- each NAS pulls `ghcr.io/u2giants/synology-monitor-agent:latest`

Deployment assets:

- `deploy/synology/docker-compose.agent.yml`
- `deploy/synology/.env.agent.example`
- `deploy/synology/nas-1.env.example`
- `deploy/synology/nas-2.env.example`
- `deploy/synology/README.md`

Important environment facts:

- `NAS_ID` must be a UUID
- `DSM_USERNAME` / `DSM_PASSWORD` are DSM API credentials, not SSH credentials
- the Synology boxes in this environment only use `/volume1`
- `/volume2` should not be assumed

## Supabase Notes

This Supabase project is shared with another application.

Consequences:

- all tables are prefixed `smon_`
- do not casually change global auth settings without checking cross-app impact
- auth/provider settings may affect the other app if changed incorrectly

Current important tables:

- `smon_nas_units`
- `smon_metrics`
- `smon_logs`
- `smon_storage_snapshots`
- `smon_container_status`
- `smon_security_events`
- `smon_alerts`
- `smon_ai_analyses`

## Important Historical Fixes

These fixes already happened and matter for future work:

- Google OAuth added to the web app
- auth callback hardened for proxy-safe redirects
- agent `NAS_ID` changed from ad hoc strings to UUID-compatible values
- DSM JSON parsing fixed for real device responses
- sender batch payloads normalized so PostgREST accepts them
- Drive startup backfill added
- Supabase constraint expanded to allow Drive log sources

Recent relevant commits:

- `86e2135` Ingest Synology Drive syslog by default
- `dd43e1e` Bootstrap recent Drive logs on startup
- `622a33b` Allow Drive log sources in Supabase
- `d1f29cb` Normalize Drive usernames from DSM logs

## Operational Pitfalls

These are worth remembering:

- Synology DSM Docker operations can be very slow during `compose up -d --force-recreate`
- DSM may leave replacement containers in `Created` state while an older one still exists
- invoking `sudo sh -lc` can lose the original working directory, so `docker compose` should
  `cd` inside the sudo shell
- `docker` is available on the NAS at `/usr/local/bin/docker`
- some log files are old and only become visible after startup backfill, not from fresh tailing

## Advice For The Next Developer / Next Codex Session

If continuing from here:

1. Prefer improving Drive/Admin/file-operation observability over generic metrics polish.
2. Query live `smon_logs` samples before changing parsers. The exact Synology log format matters.
3. Treat NAS-side Docker behavior as operationally flaky; verify image revision explicitly.
4. Keep repo and production aligned. If a live schema change is required, land the migration in
   the repo first, then apply the same SQL to production.
5. Be careful with Supabase auth changes because the project is shared with another app.
6. Do not assume SMB auditing is already solved. It is not.

## Practical Verification

Useful checks:

- web login:
  - `https://mon.designflow.app/login`

- dashboard data script:
  - `pnpm check:dashboard-data`

- recent Drive rows:
  - query `smon_logs` where `source in ('drive','drive_server','drive_sharesync')`

- agent image publishing:
  - `.github/workflows/agent-image.yml`

- NAS deployment path:
  - `/volume1/docker/synology-monitor-agent`

## Immediate Next High-Value Work

If there is time for one more meaningful improvement, do one of these:

1. Improve Drive/Admin username extraction coverage further.
2. Add cleaner parsing for move/rename/delete events that include old/new names.
3. Expand admin-console event capture if additional package logs or DSM endpoints are found.
4. Add SMB file-audit coverage only if the business workflow actually depends on SMB-level forensic detail.
