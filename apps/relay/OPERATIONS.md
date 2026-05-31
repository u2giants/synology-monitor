# Relay Operations

## Status

All components are deployed:

- relay is live at `https://mon.designflow.app/relay` (local container: `http://127.0.0.1:8787`)
- NAS API hardening (strict validator, process-group kill) is live on both NASes via Watchtower auto-update
- expanded NAS-side mounts are live on both NASes

The NAS API is deployed automatically via GitHub Actions (`nas-api-image.yml`) — push to `main` and Watchtower picks up the new image within ~5 minutes. **The relay has no CI workflow.** Relay changes must be committed to the repo and then deployed manually (see below). Treat the relay deploy path as exceptional, not routine; the goal is to add a `relay-image.yml` workflow and move to the same automated path as the other services.

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

## Manual deploy (emergency / break-glass only)

The relay currently has no CI workflow. Until one is added, manual deployment is the exceptional path — not the normal one. Any manual change must be committed back to the repo immediately so the live server does not become a hidden source of truth.

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
