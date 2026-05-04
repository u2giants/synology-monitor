# NAS API

Go HTTP service that runs on each NAS. Provides a three-tier shell execution API used by the web app and the NAS MCP server.

Access is over Tailscale only — the API is never exposed to the public internet.

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/health` | None | Returns build SHA and timestamp |
| `POST` | `/preview` | Bearer | Classifies a command's tier and returns a human-readable summary; does not execute |
| `POST` | `/exec` | Bearer + HMAC token (tier 2/3) | Executes the command after validating tier rules |

Default port: `7734` (set via `NAS_API_PORT`).

## Tier system

Every command is classified before execution:

| Tier | Name | Approval | Examples |
|------|------|----------|---------|
| 1 | Read-only | Auto-executes | `smartctl -a`, `cat /var/log/...`, `btrfs filesystem df` |
| 2 | Service op | HMAC token required | `docker compose restart`, `synopkg restart SynologyDrive` |
| 3 | File op | HMAC token required | `mv /volume1/...`, `chown`, `btrfs snapshot` |
| -1 | Blocked | Never executes | `mkfs`, `fdisk`, `dd of=/dev/sda`, `shutdown`, `useradd` |

`/preview` returns `{"tier": N, "summary": "...", "blocked": false}`. The caller uses this to build the approval UI and, for tier 2/3, to create an HMAC-signed approval token.

## Approval token flow

Tier 2 and 3 commands require a signed token to be included in the `/exec` request:

1. Caller hits `/preview` → gets tier and summary
2. Caller builds an `ApprovalToken` struct: `{command, tier, expires_at (RFC3339, 15 min from now)}`
3. Caller signs it: `HMAC-SHA256(key=NAS_API_APPROVAL_SIGNING_KEY, data=command + "\n" + expires_at)`, hex-encoded into `signature`
4. Caller base64url-encodes the JSON and sends it as `approval_token` in the `/exec` body
5. NAS API verifies command, tier, expiry, and signature — rejects on any mismatch

The signing key must match between the NAS (`NAS_API_APPROVAL_SIGNING_KEY`) and the web app / NAS MCP (`NAS_EDGE*_API_SIGNING_KEY`).

The token binds exactly one command at exactly one tier. Replaying the token against a different command or tier fails verification.

## Auth

All requests to `/exec` and `/preview` require `Authorization: Bearer <NAS_API_SECRET>`.

Both the NAS API and web app use constant-time HMAC comparison (not string equality) to avoid timing attacks that could leak the expected token length.

## Validator

`internal/validator/validator.go` classifies tier and enforces hard blocks.

**Hard-blocked regardless of tier (sampling):**
- Disk destruction: `mkfs`, `fdisk`, `parted`, `wipefs`, `dd of=/dev/sd*`
- Root filesystem: `rm /`, `rm /boot`, `rm /usr`, `rm /etc`
- System writes: `> /usr/syno`, `synopkg install/uninstall`
- Firmware/kernel: `insmod`, `rmmod`, `flash_eraseall`
- User management: `useradd`, `userdel`, `usermod`, `passwd <user>`
- Shutdown: `shutdown`, `reboot`, `poweroff`, `halt`, `systemctl poweroff`
- Package managers: `apt install/remove`, `pip install`, `npm install -g`
- Volume unmount: `umount /volume*`
- Docker (allowlisted subcommands only): `docker run`, `docker exec`, `docker cp`, and all other subcommands are blocked; only the monitor-stack compose commands pass
- Pipe-to-shell: `| sh`, `| bash`, `| sudo`, etc.
- `eval`
- Writes to system paths (`chmod`, `chown`, `cp`, `mv` targeting `/etc`, `/usr`, `/boot`, `/sys`, `/proc`, `/lib`)

**Intentional exceptions:**
- `dd if=<device> of=/dev/null iflag=direct` — tier 1. Only `dd` writing *to* a block device is blocked; reads to `/dev/null` are the standard NAS disk latency test pattern and are explicitly allowed.
- Docker compose commands for the monitor stack are allowed at tier 2 via an allowlist in `validator.go:allowedServiceCommands`. `docker run`, `docker exec`, `docker cp`, etc. are blocked.

The validator has a regression test suite (`validator_test.go`, 240+ cases). Run with `go test ./internal/validator/...`.

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `NAS_API_SECRET` | Yes | Bearer token for all requests |
| `NAS_API_APPROVAL_SIGNING_KEY` | Yes | HMAC key for tier 2/3 approval tokens |
| `NAS_API_PORT` | No | Listening port (default `7734`) |

Both `NAS_API_SECRET` and `NAS_API_APPROVAL_SIGNING_KEY` must match the values configured in the web app (`NAS_EDGE1_*` / `NAS_EDGE2_*`) and NAS MCP server.

## Build

```sh
cd apps/nas-api
go build ./cmd/server/...
```

The Dockerfile runs `go vet` and `go test ./...` before building the final binary. CI fails fast if tests break.

Build-time version info is injected via `-ldflags`:
```
-ldflags="-X main.BuildSHA=$(git rev-parse --short HEAD) -X main.BuildTime=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

## Deployment

Push to `main` with changes under `apps/nas-api/**`. GitHub Actions builds `ghcr.io/u2giants/synology-monitor-nas-api:latest` and pushes to GHCR. Watchtower on each NAS picks up the new image within 5 minutes and restarts the container.

See [deploy/synology/README.md](../../deploy/synology/README.md) for container requirements (`privileged`, `/dev` mount, etc.) and the compose config change workflow.
