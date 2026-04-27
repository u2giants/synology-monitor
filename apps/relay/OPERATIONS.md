# Relay Operations

## Status

The relay is live at `https://mon.designflow.app/relay` (local: `http://127.0.0.1:8787`).

It is deployed as a Docker container on the VPS. There is no GitHub Actions workflow for it — deployments are manual.

## Running locally on the VPS

```bash
cd apps/relay
cp .env.example .env
# edit .env with real values
node src/server.mjs
```

## Docker deployment

```bash
docker build -t synology-monitor-relay apps/relay
docker run -d \
  --name synology-monitor-relay \
  --restart unless-stopped \
  --env-file /path/to/relay.env \
  -p 8787:8787 \
  synology-monitor-relay
```

## Recommended setup

- Run the relay on the VPS, not on Lovable
- Expose it over HTTPS via the existing Coolify/Caddy reverse proxy
- Restrict `RELAY_ALLOWED_ORIGINS` to the exact Lovable app origin
- Keep NAS API private on Tailscale only

## Verification

```bash
curl http://127.0.0.1:8787/health
curl -H "Authorization: Bearer $RELAY_BEARER_TOKEN" http://127.0.0.1:8787/catalog
```
