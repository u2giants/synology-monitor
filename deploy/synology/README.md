# Synology Agent Deployment

Last verified: 2026-04-09 UTC

Scope:
- Canonical deployment and runtime contract for the Synology agent and monitor-stack controls.

This file documents the actual deployment contract for the Synology agent.

It also documents the monitor-stack control assumption used by the web app:
- monitor write actions target `/volume1/docker/synology-monitor-agent`
- the web app does not assume arbitrary Docker control outside that stack

## Canonical layout on each NAS

Live directory:
```text
/volume1/docker/synology-monitor-agent/
  compose.yaml
  .env
```

`compose.yaml` should be kept in sync with:
- [docker-compose.agent.yml](/worksp/monitor/app/deploy/synology/docker-compose.agent.yml)

`.env` is generated from the per-NAS example file:
- NAS 1: [nas-1.env.example](/worksp/monitor/app/deploy/synology/nas-1.env.example)
- NAS 2: [nas-2.env.example](/worksp/monitor/app/deploy/synology/nas-2.env.example)

## Archive file-inventory mount (Phase 1)

The nas-api service mounts a durable host path for read-only file-inventory job
state and sets a logical NAS name:

```yaml
nas-api:
  environment:
    NAS_API_NAME: ${NAS_API_NAME:-}     # edgesynology1 / edgesynology2
  volumes:
    - ${NAS_API_JOBS_PATH:-/volume1/docker/synology-monitor-agent/nas-api-jobs}:/app/data/jobs:rw
```

Set `NAS_API_NAME` in each NAS `.env` to the name the web/MCP target this box by
(`edgesynology1` or `edgesynology2`). This is **separate** from the agent's
`NAS_NAME` (a heartbeat display name) — reusing that value would break the HMAC
approval signatures for the inventory job endpoints.

**One-time step after this image ships:** Watchtower updates the image but not the
compose configuration, so run once on each NAS to materialize the mount + env:

```sh
cd /volume1/docker/synology-monitor-agent && docker compose up -d
```

Until then, the `/jobs/inventory/*` endpoints return `503` (and the
`/archive-inventory` page shows a "mount not present" message). Job results under
`/volume1/docker/synology-monitor-agent/nas-api-jobs` are read-only inventory data
and safe to inspect or delete.

## Running containers

The compose stack runs three containers:

| Container | Image | Purpose |
|---|---|---|
| `synology-monitor-agent` | `ghcr.io/u2giants/synology-monitor-agent:latest` | Passive metrics collector, pushes to Supabase |
| `synology-monitor-nas-api` | `ghcr.io/u2giants/synology-monitor-nas-api:latest` | Three-tier HTTP shell execution API for issue agent |
| `synology-monitor-watchtower` | `containrrr/watchtower` | Auto-updates the named containers from GHCR (`agent`, `nas-api`, and `seaf-cli`). Scope is by explicit name in the `command:` — add a container's name there for it to auto-update. |

The NAS API listens on port 7734 (configurable via `NAS_API_PORT` in `.env`).

Docker binary on Synology:
- `/var/packages/ContainerManager/target/usr/bin/docker`

Monitor-stack control commands used by the web app and issue agent:
- `docker compose stop`
- `docker compose up -d`
- `docker compose restart`
- `docker compose pull`
- `docker compose build --pull`

All of them run from:
- `/volume1/docker/synology-monitor-agent`

## Deployment model

1. Push to `main`
2. GitHub Actions builds and publishes `ghcr.io/u2giants/synology-monitor-agent:latest` (and `synology-monitor-nas-api:latest`)
3. Watchtower on each NAS polls GHCR every 5 minutes, detects the new image, stops the old container, removes it, and starts a new one automatically

No manual steps are required for routine deploys.

## Manual update sequence (for recovery only)

Only needed if Watchtower is down or you need to force an immediate update before the next poll cycle:

```sh
DOCKER=/var/packages/ContainerManager/target/usr/bin/docker
cd /volume1/docker/synology-monitor-agent

$DOCKER compose -f compose.yaml pull
$DOCKER stop synology-monitor-agent synology-monitor-nas-api || true
$DOCKER rm synology-monitor-agent synology-monitor-nas-api || true
$DOCKER compose -f compose.yaml up -d
```

## Coolify web app environment variables

The web app reads NAS API credentials from these environment variables (set in Coolify):

```
NAS_EDGE1_API_URL=http://100.107.131.35:7734
NAS_EDGE1_API_SECRET=<must match NAS_API_SECRET in NAS 1 .env>
NAS_EDGE1_API_SIGNING_KEY=<must match NAS_API_APPROVAL_SIGNING_KEY in NAS 1 .env>

NAS_EDGE2_API_URL=http://100.107.131.36:7734
NAS_EDGE2_API_SECRET=<must match NAS_API_SECRET in NAS 2 .env>
NAS_EDGE2_API_SIGNING_KEY=<must match NAS_API_APPROVAL_SIGNING_KEY in NAS 2 .env>
```

The exact values are in [apps/web/.env.example](/worksp/monitor/app/apps/web/.env.example).

## AGENT_IMAGE_TAG rule

`.env` should normally contain:

```sh
AGENT_IMAGE_TAG=latest
```

If it is pinned to a SHA tag, pulling `latest` will not change the running image.

## Required mounts

The canonical compose file mounts:

| Host path | Container path | Why |
|---|---|---|
| `/proc` | `/host/proc` | process stats, disk stats, network stats, proc I/O fallback |
| `/sys` | `/host/sys` | cgroup stats, Btrfs counters, thermal data |
| `/etc/passwd` | `/host/etc/passwd` | UID to username resolution |
| `/var/log` | `/host/log` | system logs, Drive logs, backup logs |
| `/var/packages` | `/host/packages` | Synology package logs |
| `/volume1/@appdata/HyperBackup` | `/host/appdata/HyperBackup` | Hyper Backup task fallback metadata |

This `/sys` mount is not optional for the current design. Without it:
- cgroup-based container I/O becomes incomplete
- Btrfs error collection cannot work correctly

## Share mounts

The compose file mounts explicit shares instead of `/volume1` because Synology Container Manager rejects top-level `/volume1` bind mounts on compose-driven recreates.

If a share path does not exist on a NAS:
- either create the share
- or remove/comment that bind from the NAS-local compose file and matching env references

## Expected startup signals

You should see startup lines for all major collectors, including:
- `schedtasks`
- `hyperbackup`
- `infra`
- `storagepool`
- `container-io`
- `share-health`
- `service-health`
- `sys-extras`

## Low-I/O design

The agent is intentionally conservative about host disk I/O:
- the new `infra` collector reads only small proc/sys counters, `statfs`, and small Hyper Backup metadata files
- it does not recursively scan shares
- it does not tail large files beyond the existing log watcher behavior
- default cadence is `INFRA_INTERVAL=2m`

The highest-I/O collectors remain:
- process snapshots
- diskstats
- log watcher

If NAS disk pressure becomes a concern, raise these env vars first:
- `PROCESS_INTERVAL`
- `DISKSTATS_INTERVAL`
- `LOG_INTERVAL`
- `INFRA_INTERVAL`

## Live telemetry expectations

### Confirmed working

- `container_io` should receive rows after the second 30-second sample
- `metrics.type='cpu_iowait_pct'` should continue to receive rows
- `metrics.type in ('net_rx_errors_ps','net_tx_errors_ps','share_used_bytes','share_growth_bytes')` should receive rows
- `scheduled_task` warnings can appear in `nas_logs`
- snapshot-replication API warnings can appear in `nas_logs`
- Hyper Backup fallback metrics can appear even when the DSM API does not return task rows

Operator-visible surfaces that depend on that telemetry:
- `/metrics` CPU chart includes `cpu_iowait_pct`
- `/metrics` shows a current iowait card

### Not guaranteed to produce rows on current DSM

The following collectors are deployed, but the current NAS units do not yet fully support their request shapes:
- scheduled tasks
- snapshot replication
- possibly Hyper Backup task listing
- DSM Log Center structured log listing

Important:
- empty tables do not imply healthy subsystems
- check `nas_logs` for explicit API-unavailable warnings

## Current DSM-specific caveats

### Scheduled tasks

Observed on current NAS:
- `SYNO.Core.TaskScheduler` is advertised
- current call shape returns `API error code: 103`

Current behavior:
- no task rows yet
- warning log emitted instead

### Snapshot replication

Observed on current NAS:
- current attempted APIs return unsupported/unavailable responses

Current behavior:
- no snapshot rows yet
- warning log emitted instead

### Hyper Backup

Current behavior:
- collector is deployed
- DSM API task rows may still be unavailable on some DSM builds
- fallback task metadata is now read from Hyper Backup appdata
- last-success age and error-code metrics can continue even when the API is empty

### DSM structured Log Center entries

Current behavior:
- parser handles string log levels now
- live row ingestion is not yet confirmed on the current NASes

## Verification commands

### Confirm running revision

```sh
DOCKER=/var/packages/ContainerManager/target/usr/bin/docker
$DOCKER ps --format 'table {{.Names}}\t{{.Status}}\t{{.Label "org.opencontainers.image.revision"}}'
```

### Confirm `/host/sys` exists in the running container

```sh
$DOCKER exec synology-monitor-agent sh -lc 'ls -d /host/sys /host/sys/fs /host/sys/fs/btrfs 2>/dev/null || true'
```

### Check recent agent logs

```sh
$DOCKER logs --tail 120 synology-monitor-agent 2>&1
```

### Check current CPU iowait manually on the NAS

```sh
vmstat 1 3 | tail -1
top -b -n2 -d0.3 2>/dev/null | grep 'Cpu(s)' | tail -1
```

The web tool `check_cpu_iowait` runs equivalent checks for the issue agent.

### Check for explicit blind-spot warnings in Supabase

Look for `nas_logs.source` values such as:
- `scheduled_task`
- `hyperbackup`
- `dsm_system_log`
- `storage` messages beginning with `Snapshot replication API unavailable:`

## Why the latest deployment changes were made

The extended telemetry work originally had two structural problems:
- the code emitted data for tables that were not in tracked schema
- DSM API failures often degraded into “no data” without any warning

The deployment and runtime changes in this repo now enforce:
- schema exists before emitter code depends on it
- unsupported DSM APIs surface as warning logs
- `/sys` is mounted because the collectors now rely on it
