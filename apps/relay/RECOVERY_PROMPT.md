# Recovery Prompt

This file intentionally contains secrets and access details. Keep it offline or in a secure password vault.

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
- password: `D@Mp0p123`

## NAS API secrets

- `NAS_EDGE1_API_SECRET`
  - `f611b43668599521c71421bc96deae0b7920f91cd0381888a8746238526ef1a4`
- `NAS_EDGE1_API_SIGNING_KEY`
  - `fcd42b9f33be9dfdedbf5614a92e263ca474a6a14284927c95ce695699f9f677`
- `NAS_EDGE2_API_SECRET`
  - `1bedfb80619a564d8905fa2c7eacb6207cae77d1acd3169519a4483e4504e3ef`
- `NAS_EDGE2_API_SIGNING_KEY`
  - `f0c85bbca930ab902d6dbbfd48d154e800b1d3a494b5f3b9209d2897bacdfc76`

## Supabase

- project url:
  - `https://qnjimovrsaacneqkggsn.supabase.co`
- service role key:
  - `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFuamltb3Zyc2FhY25lcWtnZ3NuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTM2MDE3NSwiZXhwIjoyMDkwOTM2MTc1fQ.3EaEht21dAjN3PFIX6glJkBb1BTshzvZkU5m1yab07c`

## Relay secrets

- `RELAY_BEARER_TOKEN`
  - `46a1d0348bd7075a8c25d24b969ba58a35d6364fc7d55cafb215bc37cb317732`
- `RELAY_ADMIN_SECRET`
  - `54d7dcb5448434cf0fda5a9e3a347f7801da169bf6ee673e068599e37998fe39`

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
curl -H 'Authorization: Bearer f611b43668599521c71421bc96deae0b7920f91cd0381888a8746238526ef1a4' \
  http://100.107.131.35:7734/health

curl -H 'Authorization: Bearer 1bedfb80619a564d8905fa2c7eacb6207cae77d1acd3169519a4483e4504e3ef' \
  http://100.107.131.36:7734/health
```

### Inspect live mounts on a NAS

```bash
sshpass -p 'D@Mp0p123' ssh -o StrictHostKeyChecking=no popdam@100.107.131.35 \
  "printf '%s\n' 'D@Mp0p123' | sudo -S /var/packages/ContainerManager/target/usr/bin/docker inspect synology-monitor-nas-api --format '{{json .Mounts}}'"
```

### Backfill command

```bash
cd /worksp/monitor/app
SUPABASE_URL='https://qnjimovrsaacneqkggsn.supabase.co' \
SUPABASE_SERVICE_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFuamltb3Zyc2FhY25lcWtnZ3NuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTM2MDE3NSwiZXhwIjoyMDkwOTM2MTc1fQ.3EaEht21dAjN3PFIX6glJkBb1BTshzvZkU5m1yab07c' \
node scripts/backfill-synobackup.mjs
```

## Relay env to use

```env
PORT=8787
RELAY_ALLOWED_ORIGINS=https://your-lovable-app.example.com
RELAY_BEARER_TOKEN=46a1d0348bd7075a8c25d24b969ba58a35d6364fc7d55cafb215bc37cb317732
RELAY_ADMIN_SECRET=54d7dcb5448434cf0fda5a9e3a347f7801da169bf6ee673e068599e37998fe39
NAS_EDGE1_API_URL=http://100.107.131.35:7734
NAS_EDGE1_API_SECRET=f611b43668599521c71421bc96deae0b7920f91cd0381888a8746238526ef1a4
NAS_EDGE1_API_SIGNING_KEY=fcd42b9f33be9dfdedbf5614a92e263ca474a6a14284927c95ce695699f9f677
NAS_EDGE2_API_URL=http://100.107.131.36:7734
NAS_EDGE2_API_SECRET=1bedfb80619a564d8905fa2c7eacb6207cae77d1acd3169519a4483e4504e3ef
NAS_EDGE2_API_SIGNING_KEY=f0c85bbca930ab902d6dbbfd48d154e800b1d3a494b5f3b9209d2897bacdfc76
```

## Instruction to future AI

Prefer the safest path that preserves observability and does not interrupt active Hyper Backup work unless explicitly authorized. Keep NAS API private. Use the VPS relay as the public entry point for the Lovable app.

---
