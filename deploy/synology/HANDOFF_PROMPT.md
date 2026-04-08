# Handoff Prompt For The Next Developer

You are taking over maintenance of the Synology NAS agent deployment for the
`synology-monitor` repository.

Read these files first, in order:

1. `AGENTS.md` — full project guide, architecture, schema, gotchas
2. `deploy/synology/README.md` — deployment procedures and volume mount details
3. `deploy/synology/docker-compose.agent.yml` — canonical compose spec
4. `deploy/synology/.env.agent.example` — all env vars with defaults
5. `apps/agent/internal/config/config.go` — config validation logic
6. `HANDOFF.md` — AI issue agent architecture and current state

## Current Live State (as of 2026-04-07)

### Both NAS units are running the current image

- Image: `ghcr.io/u2giants/synology-monitor-agent:latest`
- All seventeen collectors are active (see startup logs below)
- All data tables are receiving data including new April 2026 tables

**edgesynology1** (`popdam@100.107.131.35:22`)
- NAS ID: `4f1d7e2a-7d5d-4d5f-8b55-0f8efb0d1001`
- Container: `synology-monitor-agent`, status: running

**edgesynology2** (`popdam@100.107.131.36:1904`)
- NAS ID: `9dbd4646-5f4e-4fa0-8f44-1d0dbe6f1002`
- Container: `synology-monitor-agent`, status: running

Expected startup log output (all seventeen collectors should appear):
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
Agent running for NAS: edgesynology1 (4f1d7e2a-7d5d-4d5f-8b55-0f8efb0d1001)
```

### Live `.env` on both NAS units

Both `.env` files have:
- `AGENT_IMAGE_TAG=latest` — set correctly (was previously pinned to `sha-373b526` which caused outdated image to run)
- `SUPABASE_URL=https://qnjimovrsaacneqkggsn.supabase.co`
- All share paths are mounted (both NAS units use only `/volume1`)

## Deployment Architecture

### Web App
- **Platform:** Coolify, UUID `lrddgp8im0276gllujfu7wm3`
- **Trigger:** Push to `master` branch → Coolify webhook → automatic redeploy
- **Not** deployed via GitHub Actions

### Agent
- **Build:** GitHub Actions (`.github/workflows/agent-image.yml`)
- **Registry:** `ghcr.io/u2giants/synology-monitor-agent`
- **Tags:** `latest` (always current) + `sha-<short-sha>` (immutable)
- **Deploy:** Manual pull on each NAS after GitHub Actions completes

### Supabase
- **Project:** `qnjimovrsaacneqkggsn` (dedicated to synology-monitor)
- **Migrated from:** shared `popdam-prod` project, April 2026
- **NAS unit UUIDs were preserved** during migration

## New Tables (April 2026)

Four new tables were added and are now receiving data from the new collectors:

| Table | Collector | First data after |
|-------|-----------|-----------------|
| `smon_scheduled_tasks` | schedtasks | ~5 min after container start |
| `smon_backup_tasks` | hyperbackup | ~5 min after container start |
| `smon_snapshot_replicas` | storagepool | ~5 min after container start |
| `smon_container_io` | container_io | ~60 sec after container start (first tick is baseline-only) |

If these tables are empty after 10 minutes, check the agent startup log and verify the `/sys` mount is present in the compose file (required for container I/O).

## Known Operational Quirks

### 1. AGENT_IMAGE_TAG must be `latest`

If `.env` contains `AGENT_IMAGE_TAG=sha-<something>`, Docker Compose will use that
specific old image even after you pull `latest`. The value must be `AGENT_IMAGE_TAG=latest`.

Recovery when wrong image is running despite pull:
```sh
DOCKER=/var/packages/ContainerManager/target/usr/bin/docker
grep AGENT_IMAGE_TAG /volume1/docker/synology-monitor-agent/.env   # verify
$DOCKER inspect synology-monitor-agent --format "{{.Image}}"       # check sha
$DOCKER images ghcr.io/u2giants/synology-monitor-agent             # compare
```

Fix: edit `.env` to `AGENT_IMAGE_TAG=latest`, then stop+rm+up.

### 2. Always stop+rm before `compose up -d` when updating

Docker Compose reuses existing containers if the spec hasn't changed in its view.
Even after pulling a new image, `up -d` may not recreate if the container is running.

Safe update sequence:
```sh
DOCKER=/var/packages/ContainerManager/target/usr/bin/docker
cd /volume1/docker/synology-monitor-agent
$DOCKER pull ghcr.io/u2giants/synology-monitor-agent:latest
$DOCKER stop synology-monitor-agent
$DOCKER rm synology-monitor-agent
$DOCKER compose -f compose.yaml up -d
sleep 5
$DOCKER logs synology-monitor-agent 2>&1 | head -30
```

### 3. Docker binary is not on default PATH

Use the full path: `/var/packages/ContainerManager/target/usr/bin/docker`

### 4. Synology Container Manager rejects `/volume1` as a top-level bind

The compose file mounts named shares individually (`/volume1/files:/host/shares/files:ro`)
instead of mounting `/volume1` directly. Reason: Container Manager's UI/recreate path
errors with `Fail to parse share name from [/volume1]`.

Do **not** reintroduce `/volume1:/host/volume1`.

### 5. Compose recreate can wedge

During Synology-UI-managed recreates, the old container can remain in `Running` state
while a replacement ends up in `Created` (never started). When this happens:
- Do not blindly retry
- Check `docker ps -a` to see both containers
- If the replacement has the right mounts, just `docker start synology-monitor-agent`
- If the original is still running with old config, do the stop+rm+up sequence

### 6. Attached diagnostic starts are misleading

Running `docker start -a` (attached) in an SSH session — when the SSH session ends,
the container receives a signal and may shut down. This looks like a crash but isn't.
Use `docker start` (detached) or `docker compose up -d` for recovery.

### 7. ShareSync API returns code 102

DSM API error 102 = endpoint not available at this DSM version. All three ShareSync
API variants tried by `drive.go` return 102 on both NAS units. The log-parsing
fallback runs. `smon_sync_task_snapshots` will be empty until this changes. This is
expected and not a bug. ShareSync detail logs still appear in `smon_logs` source
`sharesync_detail` from the drive collector's companion log emission.

### 8. First process/disk/container-IO sample is baseline-only

`ProcessCollector`, `DiskStatsCollector`, and `ContainerIOCollector` need two samples
to calculate rates. The first collection pass stores baseline values only (no rows
written to Supabase). Data starts appearing after the second tick:
- Process and diskstats: ~15s after startup
- Container I/O: ~30s after startup

### 9. Custom metric collector uses NAS_NAME, not NAS_ID

The `CustomCollector` polls `smon_custom_metric_schedules` using the `NAS_NAME`
environment variable (e.g. `edgesynology1`) as the `nas_id` filter — NOT the UUID.
This allows the web app's issue agent to target schedules by name without
needing to manage UUIDs.

### 10. SSH banner output is a diagnostic symptom

When SSH returns a banner (Synology EULA, legal notice, etc.) and no further output,
the issue agent treats this as a symptom — not normal output — and tries
alternative diagnostic approaches. Don't mistake banner-only output for a working
command response.

### 11. Container I/O requires `/sys` mount

`ContainerIOCollector` reads cgroup files from `/sys/fs/cgroup/`. If the `/sys`
bind mount is missing from the compose file, container I/O data will be absent and
the collector will silently skip all containers. Check the compose file if
`smon_container_io` is empty after 60 seconds.

### 12. Btrfs error detection requires `/sys` mount

`sysextras.go` reads `/sys/fs/btrfs/<uuid>/` for error counters. Same dependency as
container I/O — requires `/sys:/host/sys:ro` in the compose file.

### 13. PostgREST rejects unknown columns (HTTP 400)

If you add a new field to a payload struct in `sender/types.go` without first adding
the column to Supabase, the sender will get HTTP 400 errors and that table's data
will be silently lost. Always add the Supabase column before deploying new struct
fields. The SQLite WAL will retry failed rows, but if the column never gets added,
the WAL will fill up and eventually the oldest rows will be dropped.

## Recommended Debugging Workflow

```sh
DOCKER=/var/packages/ContainerManager/target/usr/bin/docker

# 1. Verify which image is actually running
$DOCKER inspect synology-monitor-agent --format "{{.Image}}"
$DOCKER images ghcr.io/u2giants/synology-monitor-agent

# 2. Check startup logs (all seventeen collectors should appear)
$DOCKER logs synology-monitor-agent 2>&1 | head -50

# 3. Validate compose config renders correctly
cd /volume1/docker/synology-monitor-agent
$DOCKER compose -f compose.yaml config

# 4. Check container state
$DOCKER ps -a
$DOCKER inspect synology-monitor-agent

# 5. Check for errors in running logs
$DOCKER logs synology-monitor-agent 2>&1 | grep -i "error\|panic\|fatal"

# 6. Verify /sys mount is present (needed for container I/O and Btrfs)
$DOCKER exec synology-monitor-agent ls /host/sys/fs/cgroup 2>/dev/null || echo "/host/sys not mounted"

# 7. Verify /proc mount (needed for process, diskstats, connections, iowait, NFS)
$DOCKER exec synology-monitor-agent ls /host/proc/diskstats 2>/dev/null || echo "/host/proc not mounted"
```
