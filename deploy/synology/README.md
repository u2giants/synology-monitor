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
$DOCKER logs synology-monitor-agent 2>&1 | head -50
```

**Why stop+rm?** Docker Compose compares the existing container against the compose spec. If the container is already running (even with the wrong image), it will reuse it rather than recreate from the newly pulled image. Stop and remove forces a fresh container creation.

**AGENT_IMAGE_TAG gotcha:** If `.env` contains `AGENT_IMAGE_TAG=sha-<something>` (a pinned SHA), `compose up -d` will use that specific old image even after you pulled `latest`. The value must be `AGENT_IMAGE_TAG=latest` for auto-updates to work.

## Expected Startup Log (17 collectors)

After starting, the log should show all seventeen collectors:

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
[schedtasks] collector started (interval: 5m0s)
[hyperbackup] collector started (interval: 5m0s)
[storagepool] collector started (mdstat: 60s, snapshots: 5m0s)
[container-io] collector started (interval: 30s)
Agent running for NAS: edgesynology1 (...)
```

If fewer than 17 collector lines appear, check for startup errors above them.

## Required Environment Variables

| Variable | Description |
|----------|-------------|
| `NAS_ID` | UUID — must match `smon_nas_units.id`. Validated at startup; agent refuses to start if not a valid UUID. |
| `NAS_NAME` | Human-readable NAS name (e.g. `edgesynology1`) — used by CustomCollector to filter `smon_custom_metric_schedules` |
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
- Scheduled tasks: 5 minutes
- Hyper Backup: 5 minutes
- Storage pool (mdstat): 60 seconds
- Storage pool (snapshot replicas): 5 minutes
- Container I/O: 30 seconds

## Volume Mounts

The compose file mounts:

| Host Path | Container Path | Purpose |
|-----------|---------------|---------|
| `/proc` | `/host/proc` | Process stats, disk stats, network connections, iowait, NFS stats |
| `/sys` | `/host/sys` | Btrfs error counters (`/sys/fs/btrfs`), cgroup I/O (`/sys/fs/cgroup`) |
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

### Why `/sys` must be mounted

Three collectors need `/sys`:
- `sysextras`: reads `/sys/fs/btrfs/<uuid>/` for Btrfs error counters; reads `/sys/class/thermal/thermal_zone*/temp` for CPU temperature
- `container_io`: reads `/sys/fs/cgroup/blkio/docker/<id>/` (cgroup v1) or `/sys/fs/cgroup/system.slice/docker-<id>.scope/` (cgroup v2) for per-container block I/O

Both paths try `/host/sys` first, then fall back to bare `/sys` if the mount isn't there. However, mounting `/sys` read-only is strongly recommended: without it, container I/O data will be missing and Btrfs errors will not be detected.

### Why explicit shares instead of `/volume1`

Synology Container Manager rejects top-level volume bind mounts like `/volume1:/host/volume1` during compose-managed recreates. Error seen: `Fail to parse share name from [/volume1]`. The Docker CLI accepts it but the Container Manager UI and recreate path do not. The workaround is mounting each named share individually.

If a share listed in the compose file does not exist on a specific NAS, the container will fail to start. Comment out or remove binds for missing shares and remove the corresponding path from `WATCH_PATHS`/`CHECKSUM_PATHS` in `.env`.

## Log Sources

The logwatcher tails 13+ log sources by default:

| Host file | `smon_logs.source` | Notes |
|-----------|---------------------|-------|
| `/var/log/synologydrive.log` | `drive_server` | Main Drive server syslog (200 lines bootstrapped) |
| `/var/packages/@synologydrive/target/var/log/*.log` | `drive` | Per-folder Drive logs (200 lines bootstrapped) |
| `/volume1/@synologydrive/*/log/syncfolder.log` | `drive_sharesync` | ShareSync per-folder log |
| `/var/log/synolog/synowebapi.log` | `webapi` | **"Failed to SYNOShareGet" lives here** (100 lines bootstrapped) |
| `/var/log/synolog/synostorage.log` | `storage` | Share/volume management (75 lines bootstrapped) |
| `/var/log/synolog/synoshare.log` | `share` | Share database operations (100 lines bootstrapped) |
| `/var/log/kern.log` | `kernel` | I/O stalls, SCSI/ATA errors (75 lines bootstrapped) |
| `/var/log/synolog/synoinfo.log` | `system_info` | DSM config changes |
| `/var/log/synolog/synoservice.log` | `service` | Service start/stop/crash (100 lines bootstrapped) |

On startup, the logwatcher also checks for `.1` rotated files (e.g., `synowebapi.log.1`). If the current file is < 8 KB (just rotated), the `.1` file is read first to backfill recent history.

Additional sources written via DSM API (not log file tailing):

| Source | From | Description |
|--------|------|-------------|
| `share_config` | sharehealth | Share enumeration |
| `share_health` | sharehealth | Share DB failures |
| `package_health` | sharehealth | Package status |
| `dsm_system_log` | sharehealth | Structured DSM Log Center entries |
| `kernel_health` | servicehealth | OOM kills and segfaults from dmesg |
| `service_restart` | servicehealth | Service state transitions |
| `scheduled_task_failure` | schedtasks | Failed tasks with non-zero exit code |
| `btrfs_error` | sysextras | Btrfs filesystem error counters |
| `sharesync_detail` | drive | Per-task ShareSync companion entries |
