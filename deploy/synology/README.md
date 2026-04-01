# Synology Agent Deployment

This directory contains the repo-backed deployment assets for running the
`synology-monitor-agent` container on each Synology NAS.

## What changed

- The NAS should pull a prebuilt image from GHCR instead of building source on
  the appliance.
- A GitHub Actions workflow now publishes `ghcr.io/u2giants/synology-monitor-agent`.
- The compose file is isolated here so the NAS deployment is explicit and
  repeatable.

## Important CI/CD Clarification

This repository has two distinct deploy pipelines:

- `apps/web`
  - deployed by Coolify directly from the GitHub repo
  - pushes to `master` trigger Coolify webhook deployments
  - these web deploys do **not** appear in GitHub Actions

- `apps/agent`
  - image is built and published by GitHub Actions
  - workflow: `.github/workflows/agent-image.yml`
  - NAS units pull the published GHCR image

If you do not see a recent entry in `github.com/u2giants/synology-monitor/actions`,
that does **not** mean the web app failed to deploy. It usually just means the
web app deployed through Coolify instead of Actions.

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
- `AGENT_IMAGE_TAG` defaults to `latest`, but pinning a specific published tag
  like `sha-19e8f6a` is safer for controlled rollouts

## Credential model

- `DSM_USERNAME` and `DSM_PASSWORD` are only for the agent's local DSM API calls.
- Synology SSH access is separate operator access and is not used by the container at runtime.
- It is fine if the DSM account and the SSH account are different users.

## Notes

- `DSM_URL` defaults to `https://localhost:5001` because the agent talks to the
  DSM API on the same NAS.
- `DSM_INSECURE_SKIP_VERIFY=true` is the safe default for local DSM certificates
  that are usually self-signed.
- The example env files now use fixed UUIDs for `NAS_ID`. Keep each NAS on its
  own UUID consistently.
- **Container Manager Compatibility**: The compose file mounts specific shares instead
  of `/volume1` because Synology Container Manager's web UI cannot parse `/volume1`
  as a valid "share name". Attempting to start a container with `/volume1` as a bind
  mount via the web UI results in the error:
  `Fail to parse share name from [/volume1]` / `Failed to get c2 share list from volume binds`.
  The Docker socket works fine, but the web UI's path validation is stricter.
  If a NAS has shares not listed in the compose file, add them explicitly.
- The compose file also mounts `/var/packages` read-only so package logs can be
  added through `EXTRA_LOG_FILES` without another image change.
- The compose file reads `AGENT_IMAGE_TAG` from `.env`, so each NAS can pin a
  specific published GHCR image revision during rollout without editing the
  compose file itself.
- The agent also tails `/var/log/synologydrive.log` by default, which captures
  Synology Drive server events emitted through syslog.
- The agent now auto-discovers Synology Drive logs under
  `WATCH_PATHS/@synologydrive/log/*.log`, including `syncfolder.log` when it is
  present.
- If Drive Admin Console or package-specific logs live outside the watched
  volume, set `EXTRA_LOG_FILES` using `path|source` entries separated by commas.
  Example:
  `/host/packages/SynologyDrive/target/var/custom.log|drive_admin`
- The healthcheck only verifies that the agent created its WAL database. It is a
  lightweight process check, not a full application-level health probe.

## Practical Notes From This Environment

- Both NAS units in this environment only use `/volume1`.
- Recursive filesystem searches over all of `/volume1` can be too expensive for
  interactive diagnostics. Prefer shallow per-share patterns when possible.
- Tailscale is the preferred path from the VPS to the NASes.
  - `edgesynology1`: `100.107.131.35:22`
  - `edgesynology2`: `100.107.131.36:1904`
- Synology Docker/Compose can be flaky during recreate operations. If a running
  container does not switch to the intended image tag, verify the actual running
  image explicitly instead of assuming the compose action succeeded.
