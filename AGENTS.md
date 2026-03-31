# Synology Monitor: Developer Handoff

## Purpose

This repository is building a monitoring system for two Synology DS1621xs+ NAS units.
The main business priority is not generic hardware monitoring. It is filesystem and
sync observability, especially:

- Synology Drive / ShareSync problems
- Drive Admin Console style events
- rename / move / delete patterns
- user-attributed activity where Synology exposes a username
- ransomware-style behavior such as entropy spikes and mass rename bursts

The current deployment also includes a web dashboard and Supabase-backed storage, but
filesystem and sync visibility are the primary operational concern.

## Architecture

- `apps/web`
  Next.js 15 dashboard with Supabase Auth and Realtime.

- `apps/agent`
  Go agent deployed as a Docker container on each NAS.

- `packages/shared`
  Shared TypeScript types for the monorepo.

- `supabase/migrations`
  Database schema and server-side logic. Tables are prefixed `smon_` because the
  Supabase project is shared with another app.

## Live Topology

- Web UI is deployed through Coolify from GitHub.
- GitHub is the source of truth for code and deployment inputs.
- The NAS agents pull their image from GHCR via the GitHub Actions workflow in
  `.github/workflows/agent-image.yml`.
- The two NAS boxes are reachable from the VPS over Tailscale.

## Current Web App State

- Login supports email/password and Google OAuth through Supabase.
- The Google OAuth callback flow was hardened for proxy deployment and currently
  works at `https://mon.designflow.app/login`.
- There is no app-specific admin role system yet. Authenticated users can access
  the dashboard, but there is no separate RBAC model in the app today.

Relevant files:

- `apps/web/src/app/login/page.tsx`
- `apps/web/src/app/auth/callback/route.ts`

## Current Agent State

The agent currently collects:

- system metrics
- storage snapshots
- Docker/container status
- DSM log files
- connection logs
- security logs
- filesystem watcher events via `fsnotify`
- entropy-based and mass-rename ransomware signals
- checksum-based security scanning

Relevant files:

- `apps/agent/cmd/agent/main.go`
- `apps/agent/internal/config/config.go`
- `apps/agent/internal/dsm/client.go`
- `apps/agent/internal/logwatcher/watcher.go`
- `apps/agent/internal/security/watcher.go`
- `apps/agent/internal/sender/sender.go`

## Synology Drive Coverage

Current Drive-related ingestion is intentionally layered:

1. `watcher.go` tails `/var/log/synologydrive.log` by default.
   This is the main confirmed Drive server syslog source on both NASes.

2. It also auto-discovers files under:
   - `WATCH_PATHS/@synologydrive/log/*.log`
   - `WATCH_PATHS/@synologydrive/log/syncfolder.log`

3. Additional package or admin logs can be injected with:
   - `EXTRA_LOG_FILES=path|source,path|source`

Drive parsing currently attempts to extract:

- `user`
- `path`
- `component`
  - `drive`
  - `sharesync`
  - `admin_console`
- `action`
  - `rename`
  - `move`
  - `delete`
  - `sync_conflict`
  - `sync_failure`

Important limitations:

- Not every filesystem event has a reliable username.
- Raw `fsnotify` events do not inherently carry a user identity.
- Username attribution depends on Synology log content.
- We do not yet ingest every possible Drive Admin Console event source through an
  official Synology API.

## Startup Backfill Behavior

Drive logs are important enough that waiting for only new lines after container
restart is not acceptable.

The agent now performs a bounded startup bootstrap for Drive sources only:

- on startup, it ingests the last 200 lines from each Drive source
- after that, it switches to normal tail-from-EOF behavior

This is meant to surface recent Drive failures immediately without replaying the
entire historical system log set.

## Known Operational Findings

- `/var/log/synologydrive.log` exists on both NASes and contains real Drive events.
- Those logs can contain usernames in lines such as:
  - `Checking user 'ahazan' ...`
- The Drive package also references ShareSync components internally, but the exact
  package-private log files were not cleanly exposed in the initial filesystem scan.
- If more Drive Admin Console coverage is needed, the next likely step is to
  identify additional package log files or API endpoints and add them via
  `EXTRA_LOG_FILES` or new DSM/API collectors.

## Synology Deployment Notes

The Synology deployment assets live in:

- `deploy/synology/docker-compose.agent.yml`
- `deploy/synology/.env.agent.example`
- `deploy/synology/nas-1.env.example`
- `deploy/synology/nas-2.env.example`
- `deploy/synology/README.md`

Important environment details:

- `DSM_USERNAME` / `DSM_PASSWORD` are DSM API credentials used by the agent.
- They are not the same thing as SSH credentials.
- `NAS_ID` must be a UUID because Supabase expects UUID foreign keys.

## Deployment / Change-Control Rules

The operating model for this repo is strict:

- do not patch production code directly on the server
- GitHub is the source of truth
- repo changes must be committed and pushed
- Coolify and GHCR deployments must flow from GitHub changes
- NAS Docker cleanup may still be required locally when DSM Docker state gets wedged,
  but application changes must still come from the repo

## Useful Verification Paths

- Web app health:
  - `https://mon.designflow.app/login`

- Dashboard data verification script:
  - `scripts/check-dashboard-data.mjs`
  - `pnpm check:dashboard-data`

- Agent image publishing workflow:
  - `.github/workflows/agent-image.yml`

## Next High-Value Work

If continuing from here, prioritize in this order:

1. Improve Drive/Admin coverage beyond `synologydrive.log`
2. Add richer user attribution where Synology exposes it
3. Expand SMB observability only if needed for actual file-operation debugging
4. Add app-level RBAC/admin concepts if the product needs them

When choosing between generic infra work and better filesystem/sync visibility,
the filesystem/sync work is the higher-value path for this project.
