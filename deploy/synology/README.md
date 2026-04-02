# Synology Agent Deployment

This directory contains deployment assets for running `synology-monitor-agent` on Synology NAS devices.

## Quick Start

1. Copy `docker-compose.agent.yml` and `nas-*.env.example` to `/volume1/docker/synology-monitor-agent`
2. Rename the env file to `.env` and fill in real values
3. Run:
   ```sh
   docker compose -f docker-compose.agent.yml pull
   docker compose -f docker-compose.agent.yml up -d
   ```

## Required Environment Variables

| Variable | Description |
|----------|-------------|
| `NAS_ID` | UUID (maps to `smon_nas_units.id`) |
| `DSM_USERNAME` | DSM API credentials |
| `DSM_PASSWORD` | DSM API credentials |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `DSM_URL` | Default: `https://localhost:5001` |
| `DSM_INSECURE_SKIP_VERIFY` | Default: `true` (for self-signed certs) |
| `AGENT_IMAGE_TAG` | Default: `latest` |

## Deployment Model

- **Image Source:** Pre-built from GitHub Container Registry (`ghcr.io/u2giants/synology-monitor-agent`)
- **Build Pipeline:** GitHub Actions (`.github/workflows/agent-image.yml`)
- **No source builds on NAS** - agents pull published images

## Container Manager Compatibility

The compose file uses specific share mounts (not `/volume1`) because Synology Container Manager's web UI cannot parse `/volume1` as a valid share name. If you add shares, list them explicitly in the bind mounts.

## Log Sources

The agent monitors:
- `/var/log/synologydrive.log` → `drive_server`
- `WATCH_PATHS/@synologydrive/log/*.log` → `drive`
- `WATCH_PATHS/@synologydrive/log/syncfolder.log` → `drive_sharesync`
- `EXTRA_LOG_FILES=path|source` for additional logs

## Important Notes

- Both NAS units use only `/volume1`
- Docker socket works fine; web UI path validation is stricter
- Healthcheck verifies WAL database creation only
- NAS pulls `latest` by default; pin specific tags for controlled rollouts

## Files

- `docker-compose.agent.yml` - Container orchestration
- `.env.agent.example` - Base template
- `nas-1.env.example` - Edge1 configuration
- `nas-2.env.example` - Edge2 configuration
