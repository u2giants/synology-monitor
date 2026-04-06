# Synology Agent Deployment

This directory contains deployment assets for running `synology-monitor-agent` on Synology NAS devices.

## Live Deployment State

Both NAS units are currently running. The live files on each NAS are at:
```
/volume1/docker/synology-monitor-agent/
  compose.yaml   ← copy of docker-compose.agent.yml from this repo
  .env           ← NAS-specific values (not in repo)
```

## Quick Start (for a new NAS)

1. Copy `docker-compose.agent.yml` to `/volume1/docker/synology-monitor-agent/compose.yaml`
2. Create `.env` from `nas-1.env.example` (or `nas-2.env.example`) and fill in real values
3. Run:
   ```sh
   DOCKER=/var/packages/ContainerManager/target/usr/bin/docker
   cd /volume1/docker/synology-monitor-agent
   $DOCKER compose -f compose.yaml pull
   $DOCKER compose -f compose.yaml up -d
   ```

**Note:** The Docker binary on Synology is at `/var/packages/ContainerManager/target/usr/bin/docker`. It is not on the default PATH in SSH sessions.

## Updating to a New Image

After GitHub Actions publishes a new image:

```sh
DOCKER=/var/packages/ContainerManager/target/usr/bin/docker
cd /volume1/docker/synology-monitor-agent

# Force pull the new image
$DOCKER pull ghcr.io/u2giants/synology-monitor-agent:latest

# Stop and remove the old container (required — compose up -d alone won't switch)
$DOCKER stop synology-monitor-agent
$DOCKER rm synology-monitor-agent

# Start with the new image
$DOCKER compose -f compose.yaml up -d

# Confirm new image is running
$DOCKER inspect synology-monitor-agent --format "{{.Image}}"

# Check logs
$DOCKER logs synology-monitor-agent 2>&1 | head -40
```

**Why stop+rm?** Docker Compose compares the existing container against the compose spec. If the container is already running (even with the wrong image), it will reuse it rather than recreate from the newly pulled image. Stop and remove forces a fresh container creation.

**AGENT_IMAGE_TAG gotcha:** If `.env` contains `AGENT_IMAGE_TAG=sha-<something>` (a pinned SHA), `compose up -d` will use that specific old image even after you pulled `latest`. The value must be `AGENT_IMAGE_TAG=latest` for auto-updates to work.

## Expected Startup Log (13 collectors)

After starting, the log should show all thirteen collectors:

```
[docker] collector started (interval: 30s)
[system] collector started (interval: 30s)
[process] collector started (interval: 15s)
[diskstats] collector started (interval: 15s)
[drive] collector started (interval: 30s)
[connections] collector started (interval: 30s)
[storage] collector started (interval: 1m0s)
[logwatcher] started (interval: 10s, dir: /host/log)
[share-health] started (every 2m0s)
[service-health] started (every 1m0s)
[sys-extras] started (every 30s)
[custom-collector] started (polling every 60s)
[security] watcher started
Agent running for NAS: edgesynology1 (...)
```

## Required Environment Variables

| Variable | Description |
|----------|-------------|
| `NAS_ID` | UUID — must match `smon_nas_units.id`. Validated at startup; agent refuses to start if not a valid UUID. |
| `NAS_NAME` | Human-readable NAS name (e.g. `edgesynology1`) — used by CustomCollector to filter schedules |
| `DSM_URL` | Default: `https://localhost:5001` |
| `DSM_USERNAME` | DSM API credentials |
| `DSM_PASSWORD` | DSM API credentials |
| `DSM_INSECURE_SKIP_VERIFY` | Default: `true` (for self-signed certs) |
| `SUPABASE_URL` | `https://qnjimovrsaacneqkggsn.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `AGENT_IMAGE_TAG` | **Must be `latest`** unless intentionally pinning |

## Collection Interval Variables (optional, defaults shown)

| Variable | Default | What it controls |
|----------|---------|-----------------|
| `METRICS_INTERVAL` | `30s` | System CPU/mem/network |
| `STORAGE_INTERVAL` | `60s` | Volume and disk health |
| `LOG_INTERVAL` | `10s` | Log file tailing |
| `DOCKER_INTERVAL` | `30s` | Container stats |
| `SECURITY_INTERVAL` | `15m` | Background integrity scans |
| `PROCESS_INTERVAL` | `15s` | Per-process CPU/mem/disk I/O |
| `DISKSTATS_INTERVAL` | `15s` | Per-disk IOPS/throughput |
| `CONNECTIONS_INTERVAL` | `30s` | Active TCP connection counts |

The following collectors use hardcoded intervals (not configurable via env):
- Share health: 2 minutes
- Service health: 60 seconds
- SysExtras: 30 seconds
- Custom metrics: 60-second poll (individual schedule intervals are in the DB row)

## Volume Mounts

The compose file mounts:

| Host Path | Container Path | Purpose |
|-----------|---------------|---------|
| `/proc` | `/host/proc` | Process stats, disk stats, network connections |
| `/etc/passwd` | `/host/etc/passwd` | UID → username resolution |
| `/var/log` | `/host/log` | System and Drive logs (synowebapi.log, kern.log, etc.) |
| `/var/packages` | `/host/packages` | Synology package log files |
| `/volume1/files` | `/host/shares/files` | File monitoring |
| `/volume1/styleguides` | `/host/shares/styleguides` | File monitoring |
| `/volume1/users` | `/host/shares/users` | File monitoring |
| `/volume1/homes` | `/host/shares/homes` | File monitoring |
| `/volume1/Coldlion` | `/host/shares/Coldlion` | File monitoring |
| `/volume1/Photography` | `/host/shares/Photography` | File monitoring |
| `/volume1/freelancers` | `/host/shares/freelancers` | File monitoring |
| `/volume1/mgmt` | `/host/shares/mgmt` | File monitoring |
| `/volume1/mac` | `/host/shares/mac` | File monitoring |
| `/volume1/oldStyleguides` | `/host/shares/oldStyleguides` | File monitoring |
| `/volume1/@synologydrive` | `/host/shares/@synologydrive` | Drive log parsing |
| `/volume1/@SynologyDriveShareSync` | `/host/shares/@SynologyDriveShareSync` | ShareSync log parsing |
| (Docker volume) | `/app/data` | SQLite WAL buffer |

### Why explicit shares instead of `/volume1`

Synology Container Manager rejects top-level volume bind mounts like `/volume1:/host/volume1` during compose-managed recreates. Error seen: `Fail to parse share name from [/volume1]`. The Docker CLI accepts it but the Container Manager UI and recreate path do not. The workaround is mounting each named share individually.

If a share listed in the compose file does not exist on a specific NAS, the container will fail to start. Comment out or remove binds for missing shares and remove the corresponding path from `WATCH_PATHS`/`CHECKSUM_PATHS` in `.env`.

The share paths are configurable via env vars (e.g. `SHARE_FILES_PATH`, `SHARE_USERS_PATH`) — see the compose file for the full list.

## Log Sources

The logwatcher tails 13+ log sources by default:

| Host file | `smon_logs.source` | Notes |
|-----------|---------------------|-------|
| `/var/log/synologydrive.log` | `drive_server` | Main Drive server syslog |
| `/var/packages/@synologydrive/target/var/log/*.log` | `drive` | Per-folder Drive logs |
| `/volume1/@synologydrive/*/log/syncfolder.log` | `drive_sharesync` | ShareSync per-folder log |
| `/var/log/synolog/synowebapi.log` | `webapi` | **"Failed to SYNOShareGet" lives here** |
| `/var/log/synolog/synostorage.log` | `storage` | Share/volume management |
| `/var/log/synolog/synoshare.log` | `share` | Share database operations |
| `/var/log/kern.log` | `kernel` | I/O stalls, SCSI/ATA errors |
| `/var/log/synolog/synoinfo.log` | `system_info` | DSM config changes |
| `/var/log/synolog/synoservice.log` | `service` | Service start/stop/crash |

Additional sources written via DSM API (not log file tailing):

| Source | Collector | Notes |
|--------|-----------|-------|
| `share_config` | sharehealth | Share enumeration |
| `share_health` | sharehealth | Share DB failure events |
| `package_health` | sharehealth | Package status (Drive, ShareSync, etc.) |
| `dsm_system_log` | sharehealth | Structured DSM Log Center entries |
| `kernel_health` | services | OOM kills and segfaults from dmesg |

## Deployment Model

- **Image source:** GitHub Container Registry (`ghcr.io/u2giants/synology-monitor-agent`)
- **Build pipeline:** GitHub Actions (`.github/workflows/agent-image.yml`) triggered on push to `master`
- **No builds on NAS** — agents pull published images only

## How AI-Requested Custom Metrics Work

The AI resolution agent can permanently expand what the agent collects without a code change:

1. AI identifies missing data → writes a row to `smon_custom_metric_schedules` with `nas_id = NAS_NAME`
2. `CustomCollector` polls Supabase every 60 seconds, picks up new schedules
3. Runs `sh -c <collection_command>` natively inside the container (30-second timeout)
4. Results stored in `smon_custom_metric_data`
5. Next AI analysis injects this data via `getCustomMetricContext()`
6. `referenced_count` increments each time the data is used
7. At `referenced_count >= 3`: metric is a candidate for promotion to a built-in collector

**No deployment needed for custom metrics** — the command runs inside the existing container image. Any CLI tool already in the container can be used.

## Healthcheck

The container healthcheck runs: `test -f /app/data/wal.db`

This only verifies that the SQLite WAL database file was created. It does not check whether data is flowing to Supabase or whether the DSM API connection is healthy. A `healthy` status means the agent started and initialized its buffer, not that all collectors are working.

## Files

- `docker-compose.agent.yml` — canonical compose spec (copy to NAS as `compose.yaml`)
- `.env.agent.example` — base template for all env vars
- `nas-1.env.example` — edgesynology1 specific values
- `nas-2.env.example` — edgesynology2 specific values
- `HANDOFF_PROMPT.md` — full operational history and gotchas for the NAS deployment
