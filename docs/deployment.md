# Deployment

## Overview

```
push to main
  │
  ├─ agent-image.yml   → ghcr.io/u2giants/synology-monitor-agent:latest
  ├─ nas-api-image.yml → ghcr.io/u2giants/synology-monitor-nas-api:latest
  ├─ nas-mcp-image.yml → ghcr.io/u2giants/synology-monitor-nas-mcp:latest
  └─ web-image.yml     → ghcr.io/u2giants/synology-monitor-web:latest
                             └─ triggers Coolify redeploy (webhook at end of workflow)
```

Each workflow has a `paths:` filter — it only runs when files in its app directory (or the workflow file itself) change.

## Web app, NAS API, NAS MCP

These three deploy automatically end-to-end:

1. Push to `main` with relevant file changes
2. GitHub Actions builds and pushes image to GHCR
3. Workflow's final step calls the Coolify redeploy webhook
4. Coolify pulls the new image and recreates the container

No manual steps needed. The Coolify webhook URL and token are in GitHub Secrets (`COOLIFY_WEBHOOK_UUID`, `COOLIFY_TOKEN`).

**Non-obvious:** `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` for the web app are build-time secrets — they are baked into the Next.js bundle during `docker build`. They must be set as GitHub Secrets (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`) so the workflow can pass them as build args. Changing them in Coolify's runtime env after the image is already built has no effect.

## Agent and NAS API (NAS-side containers)

Watchtower on each NAS polls GHCR and pulls new image layers automatically. However, **Synology Container Manager reuses the existing container definition on `compose up -d`** — pulling a new image does not guarantee the running container uses it. You must explicitly recreate:

```sh
DOCKER=/var/packages/ContainerManager/target/usr/bin/docker
cd /volume1/docker/synology-monitor-agent

$DOCKER compose -f compose.yaml pull
$DOCKER stop synology-monitor-agent synology-monitor-nas-api || true
$DOCKER rm synology-monitor-agent synology-monitor-nas-api || true
$DOCKER compose -f compose.yaml up -d
```

Run this on both NASes after pushing changes to the agent or nas-api.

## Compose file on NAS

The compose file on each NAS lives at `/volume1/docker/synology-monitor-agent/compose.yaml` and should be kept in sync with `deploy/synology/docker-compose.agent.yml` in this repo.

The NAS compose file mounts individual shares (e.g. `/volume1/mac`) rather than the whole `/volume1` because Synology Container Manager rejects top-level `/volume1` bind mounts on compose-driven recreates.

Required mounts — do not remove these:

| Host path | Container path | Why |
|---|---|---|
| `/proc` | `/host/proc` | Process stats, mdstat, network stats |
| `/sys` | `/host/sys` | cgroup I/O stats, Btrfs counters, thermal |
| `/volume1/@SynologyDriveShareSync` | `/host/shares/@SynologyDriveShareSync` | ShareSync logs for the sharesync collector |
| `/var/log` | `/host/log` | DSM logs, Drive logs, backup logs |

The nas-api container also needs `pid: host` for commands that reference live process PIDs.

## Pinning the agent image

If you need to hold a specific agent version, set `AGENT_IMAGE_TAG` in the NAS `.env` to the SHA tag from GHCR. Watchtower will stop auto-updating until you remove the pin.

```sh
# In /volume1/docker/synology-monitor-agent/.env
AGENT_IMAGE_TAG=sha-abc1234
```

## Rolling back

To roll back the web app: in Coolify, redeploy from a previous image tag. Images are tagged `latest`, `sha-<git-sha>`, and `main`.

To roll back the agent: update `AGENT_IMAGE_TAG` on the NAS to the previous SHA tag and run the recreate sequence above.

## Environment parity

Three sets of credentials must stay in sync:

| What | NAS .env | Web app (Coolify) |
|---|---|---|
| NAS 1 API secret | `NAS_API_SECRET` | `NAS_EDGE1_API_SECRET` |
| NAS 1 signing key | `NAS_API_APPROVAL_SIGNING_KEY` | `NAS_EDGE1_API_SIGNING_KEY` |
| NAS 2 API secret | `NAS_API_SECRET` | `NAS_EDGE2_API_SECRET` |
| NAS 2 signing key | `NAS_API_APPROVAL_SIGNING_KEY` | `NAS_EDGE2_API_SIGNING_KEY` |

A mismatch causes silent 403s from the NAS API — the request is made but every response is unauthorized.
