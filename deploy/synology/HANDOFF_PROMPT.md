# Handoff Prompt For The Next Developer

You are taking over maintenance of the Synology NAS agent deployment for the
`synology-monitor` repository.

Read these files first, in order:

1. `AGENTS.md` — full project guide, architecture, schema, gotchas
2. `deploy/synology/README.md` — deployment procedures and volume mount details
3. `deploy/synology/docker-compose.agent.yml` — canonical compose spec
4. `deploy/synology/.env.agent.example` — all env vars with defaults
5. `apps/agent/internal/config/config.go` — config validation logic

## Current Live State (as of 2026-04-06)

### Both NAS units are running the current image

- Image: `ghcr.io/u2giants/synology-monitor-agent:latest`
- All thirteen collectors are active (see startup logs below)
- All data tables are receiving data

**edgesynology1** (`popdam@100.107.131.35:22`)
- NAS ID: `4f1d7e2a-7d5d-4d5f-8b55-0f8efb0d1001`
- Container: `synology-monitor-agent`, status: running

**edgesynology2** (`popdam@100.107.131.36:1904`)
- NAS ID: `9dbd4646-5f4e-4fa0-8f44-1d0dbe6f1002`
- Container: `synology-monitor-agent`, status: running

Expected startup log output (all thirteen collectors should appear):
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
fallback runs but currently finds no active tasks. `smon_sync_task_snapshots` will
be empty until this changes. This is expected and not a bug.

### 8. First process/disk sample is baseline-only

`ProcessCollector` and `DiskStatsCollector` need two samples to calculate rates.
The first collection pass stores baseline values only (no rows written to Supabase).
Data starts appearing after the second tick (~15–30s after startup).

### 9. Custom metric collector uses NAS_NAME, not NAS_ID

The `CustomCollector` polls `smon_custom_metric_schedules` using the `NAS_NAME`
environment variable (e.g. `edgesynology1`) as the `nas_id` filter — NOT the UUID.
This allows the web app's resolution agent to target schedules by name without
needing to manage UUIDs.

### 10. SSH banner output is a diagnostic symptom

When SSH returns a banner (Synology EULA, legal notice, etc.) and no further output,
the resolution agent now treats this as a symptom — not normal output — and tries
alternative diagnostic approaches. Don't mistake banner-only output for a working
command response.

## Recommended Debugging Workflow

```sh
DOCKER=/var/packages/ContainerManager/target/usr/bin/docker

# 1. Verify which image is actually running
$DOCKER inspect synology-monitor-agent --format "{{.Image}}"
$DOCKER images ghcr.io/u2giants/synology-monitor-agent

# 2. Check startup logs (all thirteen collectors should appear)
$DOCKER logs synology-monitor-agent 2>&1 | head -40

# 3. Validate compose config renders correctly
cd /volume1/docker/synology-monitor-agent
$DOCKER compose -f compose.yaml config

# 4. Check container state
$DOCKER ps -a
$DOCKER inspect synology-monitor-agent

# 5. Verify data in Supabase (run in Supabase SQL Editor)
SELECT
  (SELECT COUNT(*) FROM smon_process_snapshots WHERE captured_at > now() - interval '5 min') AS process_rows,
  (SELECT COUNT(*) FROM smon_disk_io_stats      WHERE captured_at > now() - interval '5 min') AS disk_rows,
  (SELECT COUNT(*) FROM smon_net_connections    WHERE captured_at > now() - interval '5 min') AS conn_rows,
  (SELECT COUNT(*) FROM smon_service_health     WHERE captured_at > now() - interval '5 min') AS service_rows,
  (SELECT COUNT(*) FROM smon_custom_metric_data WHERE captured_at > now() - interval '5 min') AS custom_rows;
```

## What Has Changed Over Time (Brief History)

1. **Initial deployment** — basic system/log/security collectors, DSM API polling

2. **Share mount refactor** — replaced `/volume1:/host/volume1:ro` with per-share explicit
   mounts. Reason: Container Manager UI rejected top-level `/volume1` during recreates.
   All compose files and env examples updated.

3. **Supabase migration** — moved from shared `popdam-prod` project to dedicated
   `qnjimovrsaacneqkggsn` project. NAS unit UUIDs preserved. All env references updated.

4. **AI model migration** — replaced `MINIMAX_API_KEY` + `OPENAI_API_KEY` with single
   `OPENROUTER_API_KEY`. Diagnosis model: `google/gemini-2.5-flash`. Remediation: `openai/gpt-5.4`.

5. **I/O attribution collectors (April 2026)** — added three new collectors:
   - `process.go` — per-process CPU/mem/disk I/O from `/proc`
   - `diskstats.go` — per-disk IOPS/throughput/await from `/proc/diskstats`
   - `connections.go` — active TCP connection counts from `/proc/net/tcp`
   Added volume mounts: `/proc:/host/proc:ro` and `/etc/passwd:/host/etc/passwd:ro`
   Created four new Supabase tables via `resource-snapshot-migration.sql`
   Updated both NAS `.env` files from SHA-pinned tag to `AGENT_IMAGE_TAG=latest`

6. **Drive/ShareSync diagnosis overhaul (April 2026)** — major expansion to fix the AI's
   inability to diagnose Synology Drive/ShareSync failures:

   **New log sources in logwatcher** (added to `defaultLogFiles`):
   - `synolog/synowebapi.log` → source `webapi` — **"Failed to SYNOShareGet" lives here**
   - `synolog/synostorage.log` → source `storage` — share/volume management
   - `synolog/synoshare.log` → source `share` — share database operations
   - `kern.log` → source `kernel` — I/O stalls, SCSI/ATA errors
   - `synolog/synoinfo.log` → source `system_info` — DSM config changes
   - `synolog/synoservice.log` → source `service` — service start/stop/crash

   **New DSM API integrations** (added to `dsm/client.go`):
   - `GetShares()` via `SYNO.Core.Share`
   - `GetInstalledPackages()` via `SYNO.Core.Package`
   - `GetRecentSystemLogs(limit)` via `SYNO.Core.SyslogClient.Log`

   **New collectors**:
   - `sharehealth.go` — share DB health, package status, structured DSM logs (2m interval)
   - `services.go` — DSM service status for 12 key services + kernel OOM/segfault detection (60s)
   - `sysextras.go` — memory pressure, inode usage, CPU temperature (30s)
   - `custom.go` — AI-requested custom metric collection (60s poll of Supabase)

   **New Supabase tables** (migrations 00018, 00019, 00020):
   - `smon_custom_metric_schedules` — AI-requested collection schedules
   - `smon_custom_metric_data` — results of custom metric collections
   - `smon_service_health` — DSM service status snapshots
   - `referenced_count` column in schedules — tracks how often each metric is used

   **Resolution agent overhaul**:
   - AI personality rewritten as "THE DRIVER" (not a passive passenger)
   - Three-model architecture (diagnosis + remediation + second opinion)
   - MAX_DIAGNOSTIC_ROUNDS = 3 to prevent infinite loops
   - 8 new diagnostic tools for share DB, kernel I/O, Drive database, etc.
   - Dynamic metric collection: AI can permanently expand what the agent collects
   - Timing awareness: AI asks if now is a good time before interrupting services
   - Admin version banner showing build SHA + date

## Things to Watch Out For

- Keep `WATCH_PATHS` and `CHECKSUM_PATHS` aligned with actual mounted share paths in `.env`
- If a share in compose.yaml doesn't exist on a specific NAS, the container will fail to start — remove that bind and its corresponding path from `WATCH_PATHS`
- The healthcheck only verifies `/app/data/wal.db` exists — healthy ≠ data flowing
- `smon_process_snapshots`, `smon_disk_io_stats`, and `smon_net_connections` have no automated cleanup — they will grow indefinitely without a retention job (see `resource-snapshot-migration.sql` comments)
- If you see the agent writing to Supabase but the web app shows no new data, check RLS policies — all tables need both `authenticated` SELECT and `service_role` INSERT policies
- The `CustomCollector` uses `NAS_NAME` (human-readable string) not `NAS_ID` (UUID) to filter schedules
- The second opinion model (`anthropic/claude-sonnet-4`) requires special JSON enforcement — it ignores `response_format` and needs an explicit system message + prompt instruction to return valid JSON
