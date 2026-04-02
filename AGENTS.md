# Synology Monitor: Project Guide

## Read This First

This repository monitors two Synology DS1621xs+ NAS devices. The core business priority is:

- Synology Drive reliability and ShareSync behavior
- Filesystem changes and user-attributed file operations
- Sync failures, conflicts, rename/move/delete activity
- Ransomware-style behavior detection on shared storage

**Operating Rules:**
- GitHub is the source of truth
- Do NOT patch production code directly on the server
- All changes must be committed and pushed
- Deployments flow from GitHub → Coolify (web) or GitHub Actions (agent)
- Direct server-side hotfixes are forbidden unless explicitly approved

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Synology NAS (Edge1 & Edge2)                                │
│  ┌─────────────────────┐    ┌─────────────────────────────┐│
│  │ Go Agent Container  │───▶│ Supabase PostgreSQL         ││
│  │ - DSM API polling   │    │ - smon_logs                 ││
│  │ - Log ingestion     │    │ - smon_metrics              ││
│  │ - Security watching │    │ - smon_alerts               ││
│  │ - Drive parsing     │    │ - smon_copilot_*            ││
│  └─────────────────────┘    └─────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Next.js Web App (Coolify)      NAS Copilot (GPT-4o)        │
│  https://mon.designflow.app     SSH diagnostics over        │
│  - Dashboard                   Tailscale                    │
│  - /sync-triage                                                  │
│  - /assistant                                                   │
└─────────────────────────────────────────────────────────────┘
```

## Current Live Infrastructure

| Component | URL/Identifier |
|-----------|----------------|
| Web UI | https://mon.designflow.app |
| GitHub Repo | https://github.com/u2giants/synology-monitor |
| Coolify App UUID | `lrddgp8im0276gllujfu7wm3` |
| Supabase Project | `ryltkzzernhwnojzouyb` |
| Supabase URL | `https://ryltkzzernhwnojzouyb.supabase.co` |
| Agent Image | `ghcr.io/u2giants/synology-monitor-agent` |

## NAS Endpoints (Tailscale)

| NAS | SSH Target | Container Path |
|-----|------------|----------------|
| edgesynology1 | `popdam@100.107.131.35:22` | `/volume1/docker/synology-monitor-agent` |
| edgesynology2 | `popdam@100.107.131.36:1904` | `/volume1/docker/synology-monitor-agent` |

## Deployment Flow

### Web App (Next.js)
- **NOT** deployed via GitHub Actions
- Connected directly to Coolify
- Push to `master` → Coolify webhook → automatic redeploy
- Check Coolify deployment history, not GitHub Actions

### Agent Image (Go)
- Built and published by GitHub Actions
- Workflow: `.github/workflows/agent-image.yml`
- Publishes to `ghcr.io/u2giants/synology-monitor-agent`
- NAS pulls the `latest` tag

## Repository Structure

```
synology-monitor/
├── apps/
│   ├── web/                 # Next.js 15 dashboard
│   │   └── src/
│   │       ├── app/         # App Router pages
│   │       │   ├── (dashboard)/  # Protected dashboard routes
│   │       │   │   ├── sync-triage/    # Sync errors & triage UI
│   │       │   │   ├── assistant/      # NAS Copilot chat
│   │       │   │   ├── ai-insights/    # AI analysis dashboard
│   │       │   │   └── ...
│   │       │   ├── api/
│   │       │   │   └── copilot/        # Copilot endpoints
│   │       │   └── login/
│   │       ├── components/   # React components
│   │       ├── hooks/        # Custom React hooks
│   │       └── lib/          # Server utilities
│   │           └── server/
│   │               ├── copilot.ts  # AI integration
│   │               └── nas.ts      # SSH diagnostics
│   └── agent/             # Go monitoring agent
│       ├── cmd/agent/     # Entry point
│       └── internal/      # Core packages
│           ├── config/    # Configuration
│           ├── dsm/       # DSM API client
│           ├── logwatcher/# Log file parsing
│           ├── security/  # Ransomware detection
│           └── sender/    # Supabase upload
├── packages/
│   └── shared/            # Shared TypeScript types
├── supabase/
│   └── migrations/        # Database schema
├── deploy/
│   └── synology/          # NAS deployment files
└── .github/
    └── workflows/         # CI/CD pipelines
```

## Database Schema (Supabase)

All tables are prefixed `smon_` (shared Supabase project).

### Core Tables

| Table | Purpose |
|-------|---------|
| `smon_nas_units` | NAS device registry |
| `smon_metrics` | CPU, memory, storage metrics |
| `smon_logs` | Ingested log events from NAS |
| `smon_container_status` | Docker container state |
| `smon_security_events` | Ransomware/entropy alerts |
| `smon_alerts` | Active system alerts |
| `smon_ai_analyses` | AI-generated insights |

### Log Sources (smon_logs.source)

| Source | Description |
|--------|-------------|
| `drive` | Drive package logs (`@synologydrive/log/*.log`) |
| `drive_server` | Drive server syslog (`synologydrive.log`) |
| `drive_sharesync` | ShareSync activity log (`syncfolder.log`) |
| `smb` | SMB file operations |
| `security` | Security/firewall events |
| `system` | DSM system logs |
| `connection` | Connection logs |

### Copilot Tables

| Table | Purpose |
|-------|---------|
| `smon_copilot_sessions` | Chat session metadata |
| `smon_copilot_messages` | Individual chat messages |
| `smon_copilot_actions` | Approved/rejected actions |

## Sync Triage Page (`/sync-triage`)

Located at `apps/web/src/app/(dashboard)/sync-triage/page.tsx`.

**Purpose:** Central hub for investigating sync failures, conflicts, and file operations.

**Features:**
- Displays error/warning/critical logs from: `drive`, `drive_server`, `drive_sharesync`, `smb`
- Filters by source, action type, user, and search text
- Shows active alerts and pending remediations
- Alerts modal with severity badges and details
- Links to Copilot for AI-assisted investigation

**Query Sources:**
```typescript
.in("source", ["drive", "drive_server", "drive_sharesync", "smb"])
.in("severity", ["error", "warning", "critical"])
```

## NAS Copilot (`/assistant`)

AI-powered assistant using GPT-4o for NAS diagnostics.

**Capabilities:**
- Answer questions about current NAS state
- Live SSH diagnostics over Tailscale
- Summarize recent logs, alerts, Drive activity
- Propose repair commands with explicit approval
- Multiple chat sessions with history persistence

**Safety Model:**
- Server-signed action proposals
- Destructive commands blocked in `nas.ts`
- Structured tool catalog (not raw shell)
- Short expiration window for approved actions

**Required Environment Variables:**
```
OPENAI_API_KEY
OPENAI_CHAT_MODEL=gpt-4o
NAS_EDGE1_HOST=100.107.131.35
NAS_EDGE1_PORT=22
NAS_EDGE1_USER=popdam
NAS_EDGE1_PASSWORD=...
NAS_EDGE1_SUDO_PASSWORD=...
NAS_EDGE2_HOST=100.107.131.36
NAS_EDGE2_PORT=1904
NAS_EDGE2_USER=popdam
NAS_EDGE2_PASSWORD=...
NAS_EDGE2_SUDO_PASSWORD=...
```

## Agent Capabilities

The Go agent running on each NAS:

- **DSM API Integration:** System metrics, storage, volumes, disks, containers
- **Log Ingestion:** DSM, system, security, connection, package logs
- **Drive Monitoring:** 
  - `/var/log/synologydrive.log` → `source=drive_server`
  - `@synologydrive/log/*.log` → `source=drive`
  - `@synologydrive/log/syncfolder.log` → `source=drive_sharesync`
- **Security Watcher:**
  - Entropy-based ransomware detection
  - Mass-rename detection
  - Checksum-based integrity scanning
- **Filesystem Watching:** `fsnotify` on configured paths
- **Local Buffering:** SQLite WAL before Supabase flush
- **Startup Backfill:** Last 200 lines of Drive logs on restart

## Key Files

| File | Purpose |
|------|---------|
| `apps/agent/cmd/agent/main.go` | Agent entry point |
| `apps/agent/internal/dsm/client.go` | DSM API client |
| `apps/agent/internal/logwatcher/watcher.go` | Log tailing & parsing |
| `apps/agent/internal/security/watcher.go` | Ransomware detection |
| `apps/agent/internal/sender/sender.go` | Supabase upload |
| `apps/web/src/lib/server/copilot.ts` | OpenAI integration |
| `apps/web/src/lib/server/nas.ts` | SSH command execution |
| `apps/web/src/app/api/copilot/chat/route.ts` | Chat API endpoint |
| `apps/web/src/app/api/copilot/execute/route.ts` | Action execution |

## Recent Commits (2026)

| Commit | Description |
|--------|-------------|
| `501a6d9` | fix: remove duplicate sync-triage route and fix query sources |
| `65aaf6c` | Fix 18 bugs + Add Sync Triage feature |
| `86e2135` | Ingest Synology Drive syslog by default |
| `dd43e1e` | Bootstrap recent Drive logs on startup |
| `622a33b` | Allow Drive log sources in Supabase |
| `1bbe10e` | Add NAS Copilot assistant |

## What Was Recently Completed

1. **18 Bug Fixes:** Security hardening, reliability improvements, performance optimizations
2. **Sync Triage Feature:** New `/sync-triage` page for investigating sync issues
3. **Database Migration:** Applied `00012_add_missing_indexes_and_defaults.sql`
   - Updated `smon_container_status` retention to 180 days
   - Created indexes on `smon_copilot_messages` and `smon_copilot_actions`
   - Set JSONB defaults on `smon_logs`, `smon_metrics`, `smon_alerts`
4. **Source Expansion:** Added `smb` and `drive` to log sources

## Known Gaps (Not Yet Implemented)

- SMB per-file audit coverage (only connection-level logging)
- Complete Drive Admin Console API coverage
- Guaranteed per-user attribution for all file operations
- Batch AI analysis for multiple sync errors at once

## Operational Notes

- Synology Docker operations can be slow during `compose up -d --force-recreate`
- DSM may leave containers in `Created` state during replacement
- Use `cd` inside `sudo sh -lc` for Docker commands on NAS
- SSH may emit host key/post-quantum warnings - check exit status
- Copilot SSH diagnostics prefer shallow per-share lookups under:
  `/volume1/*/@synologydrive/log/syncfolder.log`

## Advice For Future Development

1. **Prioritize Drive/Admin observability** over generic metrics
2. **Query live `smon_logs`** samples before changing parsers
3. **Verify image revision explicitly** on NAS, don't assume compose succeeded
4. **Keep repo and production aligned** - land migrations in repo first
5. **Be careful with Supabase auth changes** - project is shared with another app
6. **Web deploys are in Coolify**, not GitHub Actions
7. **Debug copilot failures** by distinguishing:
   - Model/schema failures
   - Persistence/database failures
   - SSH diagnostic latency
   - UI state feedback issues

## Verification Commands

```bash
# Check web login
curl https://mon.designflow.app/login

# Check dashboard data
pnpm check:dashboard-data

# Query recent Drive rows
psql "postgresql://..." -c "SELECT * FROM smon_logs WHERE source IN ('drive','drive_server','drive_sharesync') LIMIT 10;"

# Check agent image version on NAS
ssh popdam@100.107.131.35 docker images | grep synology-monitor-agent
```

## Immediate Next Steps (If Continuing)

1. Verify Coolify deployment succeeded for commit `501a6d9`
2. Test `/sync-triage` page with real data
3. Monitor for any remaining build errors
4. Consider batch AI analysis feature for sync errors
