# Recovery Prompt

> **SECURITY NOTE:** This file used to contain live secrets in plaintext and was
> committed to the repo. Those values are considered **leaked and must be rotated**
> (NAS API secrets + signing keys, relay tokens, Supabase service-role key, NAS SSH
> password). All secrets below have been replaced with `__REDACTED__` placeholders.
> Pull the real values from your secret vault / Coolify / Supabase dashboard at
> recovery time — do not paste them back into this file.

Copy this prompt into a future AI session if the Synology Monitor relay or NAS-control path breaks.

---

You are operating on the Synology Monitor VPS. Read this entire prompt carefully and use the exact credentials and endpoints below.

## Objective

Recover or verify the Synology Monitor control path:

- Lovable frontend should call the VPS relay
- VPS relay should call private NAS APIs over Tailscale
- NAS APIs should remain private
- Hyper Backup jobs must not be interrupted unless explicitly instructed

## Repo

- repo root: `/worksp/monitor/app`
- relay app: `/worksp/monitor/app/apps/relay`
- NAS API code: `/worksp/monitor/app/apps/nas-api`
- Synology deploy compose: `/worksp/monitor/app/deploy/synology/docker-compose.agent.yml`

## Current architecture

- frontend domain currently in use: `https://mon.designflow.app`
- relay public base url:
  - `https://mon.designflow.app/relay`
- frontend is intended to be Lovable-hosted and should not call NAS APIs directly
- each NAS API is private on Tailscale
- relay should be public on the VPS and forward named actions to the private NAS APIs

## NAS targets

- `edgesynology1`
  - host: `100.107.131.35`
  - ssh port: `22`
  - nas api url: `http://100.107.131.35:7734`
  - nas id: `4f1d7e2a-7d5d-4d5f-8b55-0f8efb0d1001`
- `edgesynology2`
  - host: `100.107.131.36`
  - ssh port: `1904`
  - nas api url: `http://100.107.131.36:7734`
  - nas id: `9dbd4646-5f4e-4fa0-8f44-1d0dbe6f1002`

## NAS SSH credentials

- username: `popdam`
- password: `__REDACTED__`

## NAS API secrets

- `NAS_EDGE1_API_SECRET`
  - `__REDACTED__`
- `NAS_EDGE1_API_SIGNING_KEY`
  - `__REDACTED__`
- `NAS_EDGE2_API_SECRET`
  - `__REDACTED__`
- `NAS_EDGE2_API_SIGNING_KEY`
  - `__REDACTED__`

## Supabase

- project url:
  - `https://qnjimovrsaacneqkggsn.supabase.co`
- service role key:
  - `__REDACTED__`

## Relay secrets

- `RELAY_BEARER_TOKEN`
  - `__REDACTED__`
- `RELAY_ADMIN_SECRET`
  - `__REDACTED__`

## Current live state

- NAS API live mounts were expanded on both NASes
- live NAS API now has access to:
  - `/proc`
  - `/sys`
  - `/etc/passwd`
  - `/var/log`
  - `/var/packages`
  - main `/volume1/...` shares
  - `/volume1/@synologydrive`
  - `/volume1/@SynologyDriveShareSync`
  - `/volume1/@appdata/HyperBackup`
  - `/volume1/docker/synology-monitor-agent` as read-only
  - `/var/run/docker.sock`
- Hyper Backup backfill already succeeded once:
  - `edgesynology1`: inserted `2104`
  - `edgesynology2`: inserted `2114`

## Important caveat

The repo contains newer NAS API hardening code, but that code is not live until the NAS API image is rebuilt and redeployed.

Files to review:

- `/worksp/monitor/app/apps/nas-api/Dockerfile`
- `/worksp/monitor/app/apps/nas-api/cmd/server/main.go`
- `/worksp/monitor/app/apps/nas-api/internal/validator/validator.go`

## Relay files to review

- `/worksp/monitor/app/apps/relay/src/server.mjs`
- `/worksp/monitor/app/apps/relay/README.md`
- `/worksp/monitor/app/apps/relay/OPERATIONS.md`

## What to do first in a recovery session

1. Verify relay health if deployed.
2. Verify NAS API health on both NASes.
3. Confirm NAS API mounts on both NASes.
4. Confirm Hyper Backup is not currently in a sensitive state before any container restarts.
5. If NAS API code changes need to go live, rebuild and redeploy only `synology-monitor-nas-api`.

## Verification commands

### NAS API health

```bash
curl -H 'Authorization: Bearer __REDACTED__' \
  http://100.107.131.35:7734/health

curl -H 'Authorization: Bearer __REDACTED__' \
  http://100.107.131.36:7734/health
```

### Inspect live mounts on a NAS

```bash
sshpass -p '__REDACTED__' ssh -o StrictHostKeyChecking=no popdam@100.107.131.35 \
  "printf '%s\n' '__REDACTED__' | sudo -S /var/packages/ContainerManager/target/usr/bin/docker inspect synology-monitor-nas-api --format '{{json .Mounts}}'"
```

### Backfill command

```bash
cd /worksp/monitor/app
SUPABASE_URL='https://qnjimovrsaacneqkggsn.supabase.co' \
SUPABASE_SERVICE_KEY='__REDACTED__' \
node scripts/backfill-synobackup.mjs
```

## Relay env to use

```env
PORT=8787
RELAY_ALLOWED_ORIGINS=https://your-lovable-app.example.com
RELAY_BEARER_TOKEN=__REDACTED__
RELAY_ADMIN_SECRET=__REDACTED__
NAS_EDGE1_API_URL=http://100.107.131.35:7734
NAS_EDGE1_API_SECRET=__REDACTED__
NAS_EDGE1_API_SIGNING_KEY=__REDACTED__
NAS_EDGE2_API_URL=http://100.107.131.36:7734
NAS_EDGE2_API_SECRET=__REDACTED__
NAS_EDGE2_API_SIGNING_KEY=__REDACTED__
```

## Instruction to future AI

Prefer the safest path that preserves observability and does not interrupt active Hyper Backup work unless explicitly authorized. Keep NAS API private. Use the VPS relay as the public entry point for the Lovable app.

---
