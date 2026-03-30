# Synology Agent Deployment

This directory contains the repo-backed deployment assets for running the
`synology-monitor-agent` container on each Synology NAS.

## What changed

- The NAS should pull a prebuilt image from GHCR instead of building source on
  the appliance.
- A GitHub Actions workflow now publishes `ghcr.io/u2giants/synology-monitor-agent`.
- The compose file is isolated here so the NAS deployment is explicit and
  repeatable.

## Files

- `docker-compose.agent.yml`: Compose file to run on each NAS.
- `.env.agent.example`: Base env template.
- `nas-1.env.example`: Example for the first NAS.
- `nas-2.env.example`: Example for the second NAS.

## First-time setup

1. Push this repository to GitHub so the `Publish Agent Image` workflow can build
   and publish the agent image.
2. In GitHub, confirm the package `ghcr.io/u2giants/synology-monitor-agent` has
   been published successfully.
3. On each NAS, create a directory such as `/volume1/docker/synology-monitor-agent`.
4. Copy `docker-compose.agent.yml` and the appropriate `nas-*.env.example` file
   to that directory.
5. Rename the env file to `.env` and replace placeholders with real values.
6. In Synology Container Manager or via SSH, run:

```sh
docker compose -f docker-compose.agent.yml pull
docker compose -f docker-compose.agent.yml up -d
```

## Required secrets

- `DSM_USERNAME`
- `DSM_PASSWORD`
- `SUPABASE_SERVICE_KEY`
- `NAS_ID` must be a UUID because it maps directly to `smon_nas_units.id`

## Notes

- `DSM_URL` defaults to `https://localhost:5001` because the agent talks to the
  DSM API on the same NAS.
- `DSM_INSECURE_SKIP_VERIFY=true` is the safe default for local DSM certificates
  that are usually self-signed.
- The example env files now use fixed UUIDs for `NAS_ID`. Keep each NAS on its
  own UUID consistently.
- The default compose file mounts only `/volume1`. If a NAS has additional data
  volumes, add the extra bind mounts explicitly and keep `WATCH_PATHS` and
  `CHECKSUM_PATHS` aligned with the actual mounted paths.
- The healthcheck only verifies that the agent created its WAL database. It is a
  lightweight process check, not a full application-level health probe.
