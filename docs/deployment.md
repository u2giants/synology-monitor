# Deployment

## Architecture overview

```
GitHub (main branch)
  │
  ├─ agent-image.yml   → ghcr.io/u2giants/synology-monitor-agent:latest
  ├─ nas-api-image.yml → ghcr.io/u2giants/synology-monitor-nas-api:latest
  ├─ nas-mcp-image.yml → ghcr.io/u2giants/synology-monitor-nas-mcp:latest  ─→ Coolify redeploy
  └─ web-image.yml     → ghcr.io/u2giants/synology-monitor-web:latest      ─→ Coolify redeploy

Coolify VPS (178.156.180.212)
  ├─ synology-monitor-web      (mon.designflow.app)
  └─ synology-monitor-nas-mcp  (nas-mcp.designflow.app/mcp)

NAS 1 — edgesynology1 (100.107.131.35)          NAS 2 — edgesynology2 (100.107.131.36)
  ├─ synology-monitor-agent    (Docker)            ├─ synology-monitor-agent
  ├─ synology-monitor-nas-api  (:7734)             ├─ synology-monitor-nas-api  (:7734)
  └─ synology-monitor-watchtower                   └─ synology-monitor-watchtower
```

Each NAS runs the agent, the NAS API, and a Watchtower container. Watchtower polls GHCR every 5 minutes and automatically recreates the agent and nas-api containers when a new image is available. The relay service has no CI workflow and is deployed manually on the VPS — treat that as an exceptional path (see `apps/relay/OPERATIONS.md`).

## GitHub Actions workflows

Four workflows live in `.github/workflows/`. Each has a `paths:` filter and also supports `workflow_dispatch` for manual runs.

| Workflow | Trigger paths | Image published | Coolify redeploy |
|---|---|---|---|
| `agent-image.yml` | `.github/workflows/agent-image.yml`, `apps/agent/**` | `ghcr.io/u2giants/synology-monitor-agent` | No |
| `nas-api-image.yml` | `.github/workflows/nas-api-image.yml`, `apps/nas-api/**` | `ghcr.io/u2giants/synology-monitor-nas-api` | No |
| `nas-mcp-image.yml` | `.github/workflows/nas-mcp-image.yml`, `apps/nas-mcp/**`, `packages/shared/**` | `ghcr.io/u2giants/synology-monitor-nas-mcp` | Yes — UUID `efl17f5iocnz94840pexre9d` (hardcoded) |
| `web-image.yml` | `.github/workflows/web-image.yml`, `apps/web/**`, `packages/shared/**`, `package.json`, `pnpm-workspace.yaml`, `turbo.json` | `ghcr.io/u2giants/synology-monitor-web` | Yes — UUID from secret `COOLIFY_WEBHOOK_UUID` |

All workflows tag images three ways: `:latest`, `:sha-<short-sha>`, and `:main`.

### Verification gates (deploy is gated by these)

A production image is built and published **only if** that app's verification
passes first — a failing gate means no image, which means no deploy (Coolify is
never triggered, and Watchtower never sees a new image). This is the enforcement
point for "deploys must pass required checks": it lives in the workflow, not just
in docs.

| Workflow | Pre-build gate | Compile gate (in Docker build) |
|---|---|---|
| `nas-api-image.yml` | `go vet ./... && go test ./...` (`apps/nas-api`) | `go build` |
| `agent-image.yml` | `go vet ./... && go test ./...` (`apps/agent`) | `go build` |
| `web-image.yml` | `pnpm --filter web run guard:ai` | `next build` (tsc) |
| `nas-mcp-image.yml` | _none yet — Docker build runs_ | `tsc` (pnpm build) |

> The Go services historically only had the compile-level gate from `go build` in
> their Dockerfiles. Both `nas-api-image.yml` and `agent-image.yml` now run
> `go vet` + `go test` before the build, so vet findings and unit tests (e.g. the
> nas-api `internal/jobs` and validator suites) gate the deploy. The agent has no
> test files yet, so its gate is currently `go vet` plus future-proofing.

### Required GitHub Secrets

| Secret | Used by | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | All workflows | Push images to GHCR |
| `COOLIFY_TOKEN` | `nas-mcp-image.yml`, `web-image.yml` | Authenticate Coolify redeploy webhook |
| `COOLIFY_WEBHOOK_UUID` | `web-image.yml` | UUID of the web app in Coolify |
| `NEXT_PUBLIC_SUPABASE_URL` | `web-image.yml` | Baked into Next.js client bundle at build time |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `web-image.yml` | Baked into Next.js client bundle at build time |

## Docker images

| Image | Contents | Who pulls it |
|---|---|---|
| `ghcr.io/u2giants/synology-monitor-agent` | Go binary; telemetry collectors, SQLite WAL sender | Watchtower on each NAS |
| `ghcr.io/u2giants/synology-monitor-nas-api` | Go binary; three-tier command validator and executor, port 7734 | Watchtower on each NAS |
| `ghcr.io/u2giants/synology-monitor-nas-mcp` | Node.js; MCP server with 132-definition tool registry | Coolify on VPS |
| `ghcr.io/u2giants/synology-monitor-web` | Next.js; dashboard, issue detector, issue-agent pipeline | Coolify on VPS |

All images are public in GHCR under the `u2giants` organization. Tags: `:latest` (always the most recent main-branch build), `:sha-<short-sha>` (pinnable), `:main` (branch ref, same as latest on main).

## Deploying the web app

**Normal path — fully automatic:**

1. Push to `main` with changes under `apps/web/`, `packages/shared/`, or the web workflow file.
2. `web-image.yml` builds the image. It passes `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `BUILD_SHA` as Docker build args — these are baked into the Next.js client bundle.
3. The workflow calls the Coolify redeploy webhook: `GET http://178.156.180.212:8000/api/v1/deploy?uuid=${COOLIFY_WEBHOOK_UUID}&force=false` with `Authorization: Bearer ${COOLIFY_TOKEN}`.
4. Coolify pulls the new `:latest` image and recreates the container.

**Env vars that must exist in Coolify before the first deploy** (runtime, server-side only — not build-time):

| Variable | Purpose |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side Supabase writes |
| `OPENROUTER_API_KEY` or `OPENAI_API_KEY` | LLM calls for the issue agent |
| `NAS_EDGE1_API_URL`, `NAS_EDGE1_API_SECRET`, `NAS_EDGE1_API_SIGNING_KEY` | NAS 1 access |
| `NAS_EDGE2_API_URL`, `NAS_EDGE2_API_SECRET`, `NAS_EDGE2_API_SIGNING_KEY` | NAS 2 access |
| `ISSUE_WORKER_TOKEN` | Auth for the internal issue-worker drain endpoint (if using background mode) |

`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are **not** runtime vars — they must be GitHub Secrets so the build workflow can bake them in. Setting them only in Coolify has no effect after the image is already built.

## Deploying the NAS MCP server

**Normal path — fully automatic:**

1. Push to `main` with changes under `apps/nas-mcp/` or `packages/shared/`.
2. `nas-mcp-image.yml` builds and pushes the image.
3. The workflow calls the Coolify redeploy webhook with the hardcoded UUID `efl17f5iocnz94840pexre9d`.
4. Coolify recreates the container.

**Env vars that must exist in Coolify:**

| Variable | Purpose |
|---|---|
| `MCP_BEARER_TOKEN` | Auth token required by all MCP clients |
| `NAS_EDGE1_API_URL`, `NAS_EDGE1_API_SECRET`, `NAS_EDGE1_API_SIGNING_KEY` | NAS 1 access |
| `NAS_EDGE2_API_URL`, `NAS_EDGE2_API_SECRET`, `NAS_EDGE2_API_SIGNING_KEY` | NAS 2 access |

Tool availability is controlled by `apps/nas-mcp/tools-config.json` in the repo, not by env vars.

**Shared tool catalog build invariant:** `packages/shared/src/nas-tools.ts` is the
single source of truth for NAS tool definitions used by both the web issue-agent
and nas-mcp. The nas-mcp image workflow must keep `packages/shared/**` in its
`paths:` trigger and must build with the repo root as Docker context
(`context: .`, `file: ./apps/nas-mcp/Dockerfile`). If the workflow is narrowed
back to `context: ./apps/nas-mcp`, shared tool changes will not be visible to the
Docker build and nas-mcp can silently deploy an old tool catalog.

## Deploying the agent to a NAS

### Normal path — Watchtower (fully automatic)

1. Push to `main` with changes under `apps/agent/`.
2. `agent-image.yml` builds and pushes `ghcr.io/u2giants/synology-monitor-agent:latest`.
3. Watchtower on each NAS polls GHCR every 5 minutes, detects the new digest, stops the old container, removes it, and starts a new one using the **same compose file and env**.

> **Important — compose config changes are NOT auto-deployed by Watchtower.**
> Watchtower only pulls a new image and restarts with the existing compose state. If
> `deploy/synology/docker-compose.agent.yml` changes (new capabilities, new volume
> mounts, new env vars), the NAS containers will not see those changes until you run
> `docker compose up -d` manually on each NAS. Examples of changes that require this:
> - Adding or removing `cap_add` entries (e.g. `SYS_PTRACE`)
> - Adding or removing bind-mount entries (e.g. `/dev/sda:/dev/sda:ro`)
> - Adding new environment keys that were not in the original container spec
>
> **Procedure:** Copy the new `deploy/synology/docker-compose.agent.yml` to
> `/volume1/docker/synology-monitor-agent/compose.yaml` on the NAS, then:
> ```sh
> DOCKER=/var/packages/ContainerManager/target/usr/bin/docker
> cd /volume1/docker/synology-monitor-agent
> $DOCKER compose -f compose.yaml up -d
> ```

### Container Manager lifecycle rule

What changed:
Routine monitor-agent start/stop/restart actions are driven through the backend
using DSM Container Manager WebAPI (`SYNO.Docker.Container`), not Docker CLI
lifecycle commands.

Why:
Starting, stopping, removing, or recreating containers from ad hoc Docker CLI
commands can make Synology Container Manager's GUI stop reporting status
correctly.

Future sessions should:
Use the web dashboard/backend actions or DSM Container Manager itself for routine
container lifecycle. Keep `docker compose up -d` limited to the exceptional cases
above where a compose-file change must be materialized, and document any such
manual operation.

No manual steps are needed. Allow up to 5 minutes for the update to propagate after the image push completes.

Because Watchtower recreates the NAS API automatically, a bad image can put both
NAS API containers into `Exited` or `Restarting` state at nearly the same time.
`ECONNREFUSED` from the MCP host to `100.107.131.35:7734` and
`100.107.131.36:7734` means TCP reached the NAS host but no process is listening.
First check container state and logs, not Tailscale:

```sh
DOCKER=/var/packages/ContainerManager/target/usr/bin/docker
$DOCKER ps -a | grep synology-monitor-nas-api
$DOCKER logs synology-monitor-nas-api --tail 100
```

If the logs show `panic: regexp: Compile(...)`, the NAS API validator contains an
invalid Go/RE2 regex. Fix the code, push to `main`, wait for `nas-api-image.yml`,
then pull/recreate only `nas-api`:

```sh
DOCKER=/var/packages/ContainerManager/target/usr/bin/docker
cd /volume1/docker/synology-monitor-agent
$DOCKER compose -f compose.yaml pull nas-api
$DOCKER compose -f compose.yaml up -d --no-deps nas-api
curl http://127.0.0.1:7734/health
```

### Checking the current version

```sh
# On the NAS (via Synology SSH or Container Manager terminal):
DOCKER=/var/packages/ContainerManager/target/usr/bin/docker
$DOCKER inspect synology-monitor-agent --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
# Or check the image tag:
$DOCKER ps --format 'table {{.Names}}\t{{.Image}}'
```

### Forcing an immediate update

Prefer waiting for Watchtower's 5-minute poll. If an update truly cannot wait,
use Synology Container Manager's UI/backend-managed project update path so DSM
remains the source of truth. Avoid `docker stop`, `docker rm`, `docker start`,
or ad hoc compose lifecycle commands for routine updates; those can desync the
Container Manager GUI. Use compose manually only for the documented exceptional
config-application or recovery cases in this doc.

### First deployment to a new NAS

1. Install Docker via Synology Container Manager package.
2. Enable SSH on the NAS temporarily for initial setup (DSM > Control Panel > Terminal).
3. Create `/volume1/docker/synology-monitor-agent/`.
4. Copy `deploy/synology/docker-compose.agent.yml` to `/volume1/docker/synology-monitor-agent/compose.yaml`.
5. Create `/volume1/docker/synology-monitor-agent/.env` from `deploy/synology/nas-1.env.example` (or `nas-2.env.example`) and fill in all required values (see `docs/configuration.md`).
6. Authenticate Docker with GHCR:
   ```sh
   echo $GITHUB_PAT | $DOCKER login ghcr.io -u <username> --password-stdin
   ```
7. Pull and start:
   ```sh
   DOCKER=/var/packages/ContainerManager/target/usr/bin/docker
   cd /volume1/docker/synology-monitor-agent
   $DOCKER compose -f compose.yaml pull
   $DOCKER compose -f compose.yaml up -d
   ```
8. Verify: `$DOCKER ps` should show `synology-monitor-agent`, `synology-monitor-nas-api`, and `synology-monitor-watchtower` running.
9. Insert a row in `nas_units` in Supabase matching the `NAS_ID` in the `.env`.

**Required mounts — do not remove these from the compose file:**

| Host path | Container path | Why |
|---|---|---|
| `/proc` | `/host/proc` | Process stats, mdstat, network stats |
| `/sys` | `/host/sys` | cgroup I/O stats, Btrfs counters, thermal |
| `/usr/syno` | `/host/usr/syno` | DSM binaries/config used by NAS API diagnostics |
| `/var/packages` | `/host/packages` | DSM package state; Snapshot Replication and scheduler probes rely on this path |
| `/volume1/@SynologyDriveShareSync` | `/host/shares/@SynologyDriveShareSync` | ShareSync logs for the sharesync collector |
| `/var/log` | `/host/log` | DSM logs, Drive logs, backup logs |
| `/volume1` | `/btrfs/volume1` | Full Btrfs volume mount for subvolume/snapshot listing and scrub commands |

The nas-api container also needs `pid: host` for commands that reference live
process PIDs. Do not replace `/btrfs/volume1` with only individual share mounts:
snapshot and Btrfs tools need the full volume mount, while file-inspection tools
use the narrower `/volume1/<share>` mounts.

## Deploying the NAS API

The NAS API image (`ghcr.io/u2giants/synology-monitor-nas-api`) is built by `nas-api-image.yml` and deployed by the same Watchtower mechanism as the agent. The NAS API is a sidecar in the same Docker Compose file — Watchtower manages both. All steps in the agent section above apply equally to the NAS API.

## Archive job state &amp; snapshots (on the NAS)

The archive feature (file inventory + archive move) persists all job state to the
durable host bind mount on each NAS — **not** Supabase. It survives Watchtower
image recreations.

Host path (default; overridable via `NAS_API_JOBS_PATH`), mounted at
`/app/data/jobs` in the nas-api container:

```
/volume1/docker/synology-monitor-agent/nas-api-jobs/
  file-inventory/<job_id>/   status.json, yearly.csv, cutoff.csv, dirs.csv, overlay.csv
  archive-move/<job_id>/     status.json, manifest.jsonl, move-report.csv,
                             verify-report.csv, preflight.json
```

These files are read-only audit data and safe to inspect or delete (deleting an
inventory job's dir just discards its results). On startup, jobs left mid-run by a
restart are marked `interrupted`.

**Btrfs snapshots (archive move only).** Before any destructive move, the executor
takes a read-only Btrfs snapshot of the share subvolume at
`/volume1/@archive_move_snapshots/<job_id>` (recorded as `snapshot_id` /
`snapshot_path` in the job). It is the last-resort whole-run recovery. It is **not**
auto-deleted — once a move is confirmed good, reclaim the space:

```sh
sudo btrfs subvolume delete /volume1/@archive_move_snapshots/<job_id>
```

Archive moves write via the read-write `/btrfs/volume1` mount (resolving paths as
`/btrfs/volume1/<share>/…`); the per-share `/volume1/<share>` mounts stay
read-only. No compose change beyond the Phase 1 jobs mount is required. The first
real move should follow `docs/archive-move-runbook.md`.

## Supabase migrations

**How they are applied:** Manually, via the Supabase CLI or the Supabase dashboard SQL editor. There is no CI step that auto-applies migrations. After writing a new migration file, the operator runs it against the production project `aaxtrlfpnoutziwhshlt`.

**Naming convention:** Sequential five-digit prefix, then a short snake_case description:

```
supabase/migrations/00001_initial_schema.sql
supabase/migrations/00035_drop_source_whitelists.sql
supabase/migrations/00043_revoke_anon_execute_on_security_definer.sql
```

**Rules:**
- Do not edit or rewrite already-applied migration files. Treat them as append-only history.
- New columns or tables always get a new migration file.
- The latest repository/live migration is `00043`. Confirm live history before
  applying a future migration and use a new number; never edit a migration that
  may already have run.

## Environment variable management

**Coolify is the source of truth for all production runtime env vars.** Rules:
- AI may apply runtime env changes directly in Coolify through the Coolify API or UI — that is the correct and preferred path for runtime configuration.
- Do not route runtime env changes through GitHub Actions shell commands or SSH into the VPS to edit container configs.
- Do not commit real secret values to any file in the repo, including `*.env.example` files.
- Do not set production runtime env inside Docker images or GitHub Actions shell steps.

For NAS-side services (agent, nas-api), env vars live in `/volume1/docker/synology-monitor-agent/.env` on each NAS. Changes take effect on the next container recreate (Watchtower will pick up the new image, but it will not re-read `.env` unless the container is stopped and restarted).

### Cross-service credential parity

Three credential pairs must be kept in sync across the NAS `.env` and Coolify:

| Credential | NAS `.env` key | Coolify key (web + nas-mcp) |
|---|---|---|
| NAS 1 API bearer secret | `NAS_API_SECRET` | `NAS_EDGE1_API_SECRET` |
| NAS 1 HMAC signing key | `NAS_API_APPROVAL_SIGNING_KEY` | `NAS_EDGE1_API_SIGNING_KEY` |
| NAS 2 API bearer secret | `NAS_API_SECRET` (on NAS 2) | `NAS_EDGE2_API_SECRET` |
| NAS 2 HMAC signing key | `NAS_API_APPROVAL_SIGNING_KEY` (on NAS 2) | `NAS_EDGE2_API_SIGNING_KEY` |

A mismatch produces silent 403s from the NAS API — the request is made but every response is unauthorized.

## Rollback procedure

### Web app and NAS MCP (Coolify-managed)

In the Coolify UI, navigate to the service, go to Deployments, and redeploy a previous deployment entry. Coolify stores deployment history. Alternatively, in the Coolify service configuration, pin the image to a specific SHA tag (e.g. `ghcr.io/u2giants/synology-monitor-web:sha-abc1234`) and trigger a redeploy.

Image tags for pinning are available in the GHCR package pages:
- `https://github.com/u2giants/synology-monitor/pkgs/container/synology-monitor-web`
- `https://github.com/u2giants/synology-monitor/pkgs/container/synology-monitor-nas-mcp`

### Agent and NAS API (Watchtower-managed)

Pin the agent image by setting `AGENT_IMAGE_TAG` in the NAS `.env` to the SHA tag of the last known-good image, then recreate the container:

```sh
# In /volume1/docker/synology-monitor-agent/.env
AGENT_IMAGE_TAG=sha-abc1234
```

```sh
DOCKER=/var/packages/ContainerManager/target/usr/bin/docker
cd /volume1/docker/synology-monitor-agent
$DOCKER stop synology-monitor-agent synology-monitor-nas-api || true
$DOCKER rm synology-monitor-agent synology-monitor-nas-api || true
$DOCKER compose -f compose.yaml up -d
```

Watchtower will stop auto-updating the agent while `AGENT_IMAGE_TAG` is pinned to a non-`latest` value. Remove the pin (or set it back to `latest`) to resume auto-updates.

To roll back via code: `git revert` the offending commit on `main`, push, let the workflow build a new image, and allow Watchtower to pick it up within 5 minutes.

## SSH access

**Public SSH is disabled on the VPS by design.** SSH is not a routine deployment or debugging path. Access the VPS only via the Coolify terminal in the Coolify UI when absolutely necessary. Do not propose SSH-based deploys or manual `docker build` on the VPS — these create undocumented state that `main` cannot reproduce.

NAS SSH is available (DSM > Control Panel > Terminal) but should only be used for initial setup or emergency diagnosis. Any changes made via NAS SSH must be reflected in the repo to remain reproducible.

## Secrets rotation

If a secret is compromised:

1. **Generate a new value** using a cryptographically random generator (e.g. `openssl rand -hex 32`).
2. **Update the secret in Coolify** (for web and nas-mcp runtime env) or in the NAS `.env` (for agent and nas-api).
3. **Redeploy affected services:**
   - For Coolify services: trigger a redeploy in the Coolify UI after saving the new env var.
   - For NAS services: stop and recreate the containers using the manual recreate sequence above (Watchtower picks up the `.env` change only on recreate, not on image pull).
4. **For paired secrets** (`NAS_API_SECRET` / `NAS_EDGE{1,2}_API_SECRET` and `NAS_API_APPROVAL_SIGNING_KEY` / `NAS_EDGE{1,2}_API_SIGNING_KEY`): update both ends simultaneously. A mismatch will cause all NAS API requests to return 403 until both sides are in sync.
5. **For `NEXT_PUBLIC_SUPABASE_*` keys:** these are baked into the web image at build time. Changing them requires updating the GitHub Secrets and triggering a new image build (push a trivial change to `apps/web/` or use `workflow_dispatch`).

### Leaked secrets in git history (2026-05-29 incident)

On 2026-05-29, real NAS API secrets, relay tokens, a Supabase service-role key, and a NAS SSH password were found committed in example and recovery files. All values were redacted to placeholders, and `.env.runtime` was untracked and gitignored. **However, the leaked values remain in git history and must still be rotated by the owner.** Regenerate in the NAS `.env`, Coolify, and Supabase as appropriate. Do not consider them safe simply because the files were redacted — git history is public.

## Monitoring deployments

### Coolify log viewer

In the Coolify UI, select the service and open the Logs tab. Logs stream in real time from the running container. This is the primary way to confirm a deploy succeeded or diagnose a startup failure.

### NAS container logs

```sh
DOCKER=/var/packages/ContainerManager/target/usr/bin/docker
$DOCKER logs synology-monitor-agent --tail 200
$DOCKER logs synology-monitor-nas-api --tail 100
$DOCKER logs synology-monitor-watchtower --tail 50
```

Look for `[sender] error` lines in agent logs to identify WAL flush failures. Collector-specific errors are prefixed by collector name (e.g. `[sharesync]`, `[drive]`, `[share-health]`).

### Health check endpoints

The NAS API exposes `GET /health` on port 7734. A `200 OK` response confirms the process is running and the validator loaded:

```sh
curl http://100.107.131.35:7734/health   # NAS 1
curl http://100.107.131.36:7734/health   # NAS 2
```

These endpoints require no auth. They are reachable from the VPS and any Tailscale-connected machine.

If `/health` returns `ECONNREFUSED`, the NAS-side container is down or not bound to
`:7734`; this is different from `ETIMEDOUT`, which would indicate network or
firewall reachability. For `ECONNREFUSED`, inspect `synology-monitor-nas-api`
container state and logs on each NAS.

### Watchtower update log

Watchtower logs image pull and container recreate events. Check with:

```sh
$DOCKER logs synology-monitor-watchtower --tail 100
```

A successful update looks like: `Pulling image for synology-monitor-agent ... Stopping container ... Recreating container ...`. If Watchtower shows a credentials error, re-authenticate Docker with GHCR.

## Pinning the agent image

Set `AGENT_IMAGE_TAG` in the NAS `.env` to any GHCR tag to hold that version. Watchtower will not update the container while the tag is non-`latest` and no newer image exists at that exact tag. Remove the variable (or set it to `latest`) to resume automatic updates.

```sh
# /volume1/docker/synology-monitor-agent/.env
AGENT_IMAGE_TAG=sha-abc1234
```
