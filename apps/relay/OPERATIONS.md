# Relay Operations

## Status

Implemented in the repo:

- public relay app exists under [apps/relay](/worksp/monitor/app/apps/relay:1)
- NAS API repo hardening is implemented in:
  - [apps/nas-api/cmd/server/main.go](/worksp/monitor/app/apps/nas-api/cmd/server/main.go:1)
  - [apps/nas-api/internal/validator/validator.go](/worksp/monitor/app/apps/nas-api/internal/validator/validator.go:1)
  - [apps/nas-api/Dockerfile](/worksp/monitor/app/apps/nas-api/Dockerfile:1)
- Synology `nas-api` live mounts were expanded on both NASes

Important:

- The stricter NAS API code is **not live yet** until the NAS API image is rebuilt and redeployed.
- The expanded mounts **are live now** on both NASes.
- The relay is live on this VPS at:
  - `https://mon.designflow.app/relay`
  - local-only container endpoint: `http://127.0.0.1:8787`

## Required relay env

- `PORT`
- `RELAY_ALLOWED_ORIGINS`
- `RELAY_BEARER_TOKEN`
- `RELAY_ADMIN_SECRET`
- `NAS_EDGE1_API_URL`
- `NAS_EDGE1_API_SECRET`
- `NAS_EDGE1_API_SIGNING_KEY`
- `NAS_EDGE2_API_URL`
- `NAS_EDGE2_API_SECRET`
- `NAS_EDGE2_API_SIGNING_KEY`

## Run locally on the VPS

From repo root:

```bash
cd /worksp/monitor/app/apps/relay
cp .env.example .env
node src/server.mjs
```

## Docker run example

```bash
docker build -t synology-monitor-relay /worksp/monitor/app/apps/relay
docker run -d \
  --name synology-monitor-relay \
  --restart unless-stopped \
  --env-file /path/to/relay.env \
  -p 8787:8787 \
  synology-monitor-relay
```

## Recommended deployment shape

- run the relay on the VPS, not on Lovable
- expose the relay over HTTPS
- keep NAS API private on Tailscale only
- let the Lovable app call the relay, not the NAS API directly

## Recommended next deployment steps

1. Deploy the relay on the VPS.
2. Put it behind HTTPS.
3. Restrict `RELAY_ALLOWED_ORIGINS` to the exact Lovable app origin.
4. Update the Lovable app to call the relay.
5. Rebuild and redeploy the NAS API image so the stricter validator and extra runtime tools become live.

## Verification

Relay:

```bash
curl http://127.0.0.1:8787/health
```

Catalog:

```bash
curl \
  -H "Authorization: Bearer $RELAY_BEARER_TOKEN" \
  http://127.0.0.1:8787/catalog
```

Preview:

```bash
curl \
  -H "Authorization: Bearer $RELAY_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"target":"edgesynology1","action":"check_backup_status","input":{"lookbackHours":12}}' \
  http://127.0.0.1:8787/actions/preview
```

Execute read action:

```bash
curl \
  -H "Authorization: Bearer $RELAY_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"target":"edgesynology1","action":"check_backup_status","input":{"lookbackHours":12}}' \
  http://127.0.0.1:8787/actions/exec
```

Execute write action:

```bash
curl \
  -H "Authorization: Bearer $RELAY_BEARER_TOKEN" \
  -H "X-Relay-Admin-Secret: $RELAY_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"target":"edgesynology1","action":"restart_monitor_agent"}' \
  http://127.0.0.1:8787/actions/exec
```
