# NAS Deployment

Deployment contract for the NAS-side monitor stack.

## Layout on each NAS

```
/volume1/docker/synology-monitor-agent/
  compose.yaml      ← keep in sync with deploy/synology/docker-compose.agent.yml
  .env              ← generated from nas-1.env.example or nas-2.env.example
```

The file is named `compose.yaml` on the NAS. The authoritative source in the repo is `deploy/synology/docker-compose.agent.yml`. They should be kept in sync manually when you deploy compose config changes.

## Running containers

| Container | Image | Purpose |
|-----------|-------|---------|
| `synology-monitor-agent` | `ghcr.io/u2giants/synology-monitor-agent:latest` | Passive metrics/log collector, pushes to Supabase |
| `synology-monitor-nas-api` | `ghcr.io/u2giants/synology-monitor-nas-api:latest` | Three-tier HTTP shell execution API |
| `synology-monitor-watchtower` | `containrrr/watchtower` | Polls GHCR every 5 minutes and restarts updated containers |

NAS API listens on port 7734 (configurable via `NAS_API_PORT` in `.env`).

Docker binary on Synology: `/usr/local/bin/docker` (symlinked by Container Manager at install time). The full package path `/var/packages/ContainerManager/target/usr/bin/docker` also works but is longer — prefer `/usr/local/bin/docker` in scripts.

## Normal update flow (code changes only)

1. Push to `main`
2. GitHub Actions builds and pushes `ghcr.io/u2giants/synology-monitor-{agent,nas-api}:latest`
3. Watchtower polls GHCR within 5 minutes, pulls the new image, and restarts the container

No manual NAS access required for code-only changes.

## Compose config changes (volumes, privileged, env)

Watchtower restarts containers from their **original creation parameters** — it does not re-read `compose.yaml`. When you change `docker-compose.agent.yml` (e.g., adding mounts, changing `privileged`), the compose file must be updated on the NAS and the container must be recreated:

**After pushing to `main` and waiting for Watchtower to pull the new image:**

```sh
DOCKER=/usr/local/bin/docker
cd /volume1/docker/synology-monitor-agent

# Update compose.yaml with the new content from the repo
# Then recreate the container:
$DOCKER compose -f compose.yaml up -d nas-api        # just the NAS API
# or
$DOCKER compose -f compose.yaml up -d                # full stack
```

Alternatively, use the `restart_nas_api` MCP write tool — it runs `docker compose up -d nas-api`, which recreates the container from the current compose file.

**Full stop-and-recreate (when Synology Container Manager reuses old parameters):**

```sh
$DOCKER compose -f compose.yaml pull
$DOCKER stop synology-monitor-agent synology-monitor-nas-api || true
$DOCKER rm synology-monitor-agent synology-monitor-nas-api || true
$DOCKER compose -f compose.yaml up -d
```

## NAS API container requirements

The `nas-api` service in `docker-compose.agent.yml` requires:

| Config | Why |
|--------|-----|
| `privileged: true` | Raw block device access for `dd iflag=direct` (disk latency tests) and `smartctl` |
| `pid: host` | `pkill`/`ps` must reach DSM processes outside the container |
| `/dev:/dev` | Exposes `/dev/sda`–`/dev/sdf` and other block devices inside the container |
| `cap_add: SYS_ADMIN` | `btrfs subvolume list`, `btrfs scrub`, and snapshot operations |
| `security_opt: apparmor=unconfined` | Synology DSM rejects the default apparmor profile on container init |

Without `privileged: true` and `/dev:/dev`, disk latency tests and SMART extended diagnostics will fail because block device files don't exist inside the container.

## Required mounts (agent)

| Host path | Container path | Why |
|-----------|---------------|-----|
| `/proc` | `/host/proc` | Per-process CPU/mem/IO and disk stats |
| `/sys` | `/host/sys` | cgroup IO stats, Btrfs counters, thermal data |
| `/etc/passwd` | `/host/etc/passwd` | UID→username resolution |
| `/var/log` | `/host/log` | System, Drive, backup logs |
| `/var/packages` | `/host/packages` | Synology package logs |
| `/volume1/@appdata/HyperBackup` | `/host/appdata/HyperBackup` | Hyper Backup fallback task metadata |

The `/sys` mount is required. Without it: cgroup-based container I/O stats are incomplete, and Btrfs error collection cannot work.

## Share mounts

Explicit share-by-share mounts are used instead of `/volume1` because Synology Container Manager rejects top-level `/volume1` bind mounts on compose-driven recreates.

If a share path does not exist on a NAS, either create the share or remove that bind from the local `compose.yaml` and the corresponding env var.

## Environment variables

See `deploy/synology/nas-1.env.example` and `nas-2.env.example` for the full list.

Key variables:

| Variable | Purpose |
|----------|---------|
| `NAS_API_SECRET` | Bearer token for NAS API access (must match web app `NAS_EDGE*_API_SECRET`) |
| `NAS_API_APPROVAL_SIGNING_KEY` | HMAC key for approval tokens (must match web app `NAS_EDGE*_API_SIGNING_KEY`) |
| `NAS_API_PORT` | NAS API listening port (default `7734`) |
| `AGENT_IMAGE_TAG` | Image tag to deploy (keep as `latest` for auto-updates) |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` | Supabase API key for the agent |
| `TZ` | Timezone (e.g., `America/New_York`) |

If `AGENT_IMAGE_TAG` is pinned to a SHA, Watchtower will not pick up `latest` on the next pull. Reset to `latest` for normal operation.

## Verification commands

```sh
DOCKER=/usr/local/bin/docker

# Check all three containers are running
$DOCKER ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'

# Check the deployed revision
$DOCKER logs --tail 1 synology-monitor-agent 2>&1 | grep sha=

# NAS API health check
curl http://localhost:7734/health

# Recent agent logs
$DOCKER logs --tail 120 synology-monitor-agent 2>&1

# Recent NAS API logs
$DOCKER logs --tail 60 synology-monitor-nas-api 2>&1

# Verify /dev is accessible inside nas-api (disk latency tests need this)
$DOCKER exec synology-monitor-nas-api ls /dev/sd* 2>/dev/null
```

## Tuning agent I/O impact

The agent is designed to be low-I/O. If NAS disk pressure becomes a concern, increase these intervals:

| Env var | Default | Controls |
|---------|---------|---------|
| `PROCESS_INTERVAL` | 15s | Process snapshots |
| `DISKSTATS_INTERVAL` | 15s | Disk I/O stats |
| `LOG_INTERVAL` | 10s | Log watcher |
| `INFRA_INTERVAL` | 2m | Network link, share metrics, HyperBackup fallback |

## DSM-specific caveats

**Scheduled tasks:** `SYNO.Core.TaskScheduler` v4 returns error 103 on current NAS builds. The agent falls back through v3/v2/v1 automatically. Warning logs appear in `smon_logs` if all versions fail.

**Snapshot replication:** Uses the `SYNO.DR.Plan` API family. `SYNO.SynologyDrive.SnapshotReplication` (a Drive 4.x API) was removed from the probe list because it does not exist on current DSM builds and generated error 102 on every poll. `edgesynology2` has the Snapshot Replication package; `edgesynology1` does not. No DR plans are currently configured on either NAS.

**Drive ShareSync APIs:** `SYNO.SynologyDrive.ShareSync` and `SYNO.SynologyDrive.Admin.ShareSync` return error 102 on Drive 4.x. The collector applies exponential backoff (up to 1 hour) when these fail, so the Drive server log (`synologydrive.log`) is no longer flooded with failed API calls.

**Hyper Backup:** DSM API task listing may be unreliable. The agent falls back to reading from `/volume1/@appdata/HyperBackup/` — this path must be mounted (it is, in the canonical compose file).

**DSM Log Center entries:** The parser handles both int and string log level formats. Live ingestion is not yet verified.

**Watchtower and Container Manager:** Watchtower uses `restart: always`. If you see it in "Created" state for a few seconds after a code deploy, that is normal — Watchtower logs "Creating /container-name" before the `docker start` call, so there is a brief window between container creation and start. Synology Container Manager uses `docker stop` internally; `restart: always` ensures Watchtower restarts even after CM stops it. The old `restart: unless-stopped` policy would have treated that as a permanent stop.

An empty telemetry table does not mean a subsystem is healthy. Check `smon_logs` for `API unavailable` or similar warning entries.
