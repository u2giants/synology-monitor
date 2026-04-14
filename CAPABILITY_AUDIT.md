# Synology Monitor — Capability Audit

Last verified: 2026-04-14 UTC

Purpose:
- This is the authoritative audit of what the system can do now.
- It records what gaps were filled during the April 2026 forensic/debugging pass.
- It also records important functionality that exists in code or live infrastructure but is missing or stale in older Markdown docs.

This document is intentionally comprehensive. It should be read together with:
- [AGENTS.md](./AGENTS.md)
- [HANDOFF.md](./HANDOFF.md)
- [deploy/synology/README.md](./deploy/synology/README.md)

## Executive Summary

The system is materially more capable than the older docs suggest.

The biggest capability changes made during the recent pass were:
- the app no longer depends on direct web-side SSH to the NASes
- the runtime control path is now `web/AI -> relay -> NAS API -> NAS`
- Hyper Backup historical backfill was converted from SSH to NAS API
- Hyper Backup status can now be read from mounted metadata/logs without relying on Synology DSM binaries inside the container
- the agent now has low-I/O infrastructure telemetry and churn signals for both Hyper Backup and Synology Drive
- the issue system now has a fused incident detector for the pattern:
  - Drive churn
  - backup cleanup failure
  - snapshot cleanup activity
  - elevated `cpu_iowait_pct`

The system still does not have every manual forensic trick used in the April 2026 incident investigation. The remaining gap is not basic visibility. The remaining gap is:
- first-class attribution
- first-class delete/create-vs-move comparison
- first-class Hyper Backup cleanup timeline tooling
- a first-class UI/issue explanation surface for the fused forensic diagnosis

## Live Topology

### NAS-side runtime

Each Synology runs:
- `synology-monitor-agent`
- `synology-monitor-nas-api`
- `synology-monitor-watchtower`

Canonical NAS stack location:
- `/volume1/docker/synology-monitor-agent`

Canonical compose source in repo:
- [deploy/synology/docker-compose.agent.yml](./deploy/synology/docker-compose.agent.yml)

### VPS runtime

The VPS hosts a public relay that forwards named actions to the private NAS APIs.

Important:
- this relay exists live and was used successfully during the incident
- the repo directory [apps/relay](./apps/relay) exists locally but is currently untracked in git as of this audit

Public relay path:
- `https://mon.designflow.app/relay`

Architecture:
- Lovable/web/backend -> relay -> NAS API -> Synology host

### Direct SSH status

Important distinction:
- humans can still use SSH for maintenance
- the app runtime path is intended to use NAS API, not direct SSH from the web app

The old web-side SSH helper file:
- `apps/web/src/lib/server/nas.ts`

Status:
- deleted from the web app codepath
- still referenced by stale docs in some places before this audit pass

## Capabilities Filled During This Pass

### 1. Direct web-side SSH dependency removed

What changed:
- web-side code paths were moved from `nas.ts` to NAS API-backed execution and diagnostics

Main codepaths now using NAS API:
- [apps/web/src/lib/server/nas-api-client.ts](./apps/web/src/lib/server/nas-api-client.ts)
- [apps/web/src/lib/server/copilot.ts](./apps/web/src/lib/server/copilot.ts)
- [apps/web/src/lib/server/copilot-issues.ts](./apps/web/src/lib/server/copilot-issues.ts)
- [apps/web/src/lib/server/issue-agent.ts](./apps/web/src/lib/server/issue-agent.ts)
- [apps/web/src/app/api/docker/actions/route.ts](./apps/web/src/app/api/docker/actions/route.ts)

Operational implication:
- disabling SSH on the NAS should no longer break the normal app runtime path
- separate ad hoc maintenance scripts may still need SSH unless individually migrated

### 2. Historical Hyper Backup backfill no longer depends on SSH

File:
- [scripts/backfill-synobackup.mjs](./scripts/backfill-synobackup.mjs)

What changed:
- historical backup-log ingestion was converted from SSH-based reads to NAS API-based reads
- the script was also adjusted to auto-load configuration from repo env/example files so the operator does not need to edit text files manually

Live outcome:
- backfill ran successfully against the current Supabase project
- inserted rows:
  - `edgesynology1`: 2104
  - `edgesynology2`: 2114

### 3. NAS API visibility expanded

The NAS API container now has much better read visibility than older docs imply.

Key mounts in current canonical compose:
- `/proc:/host/proc:ro`
- `/sys:/host/sys:ro`
- `/etc/passwd:/host/etc/passwd:ro`
- `/var/log:/host/log:ro`
- `/var/packages:/host/packages:ro`
- explicit share mounts for:
  - `files`
  - `styleguides`
  - `users`
  - `homes`
  - `Coldlion`
  - `Photography`
  - `freelancers`
  - `mgmt`
  - `mac`
  - `oldStyleguides`
- Synology internals:
  - `@synologydrive`
  - `@SynologyDriveShareSync`
  - `@appdata/HyperBackup`
- monitor stack path
- Docker socket

Key implication:
- the monitor now has the raw access needed to inspect the same log and metadata paths used in the incident investigation

### 4. Relay exists and is operational

This is not clearly captured in the older top-level docs.

Repo path:
- [apps/relay](./apps/relay)

Live behavior verified during this incident:
- public relay accepted authenticated requests
- disk-space checks worked against both NASes
- backup-status checks worked against both NASes

The relay is now a first-class part of the real system, even if older docs still describe only the web app directly talking to NAS APIs.

### 5. Hyper Backup status no longer depends on DSM executables inside the container

Important lesson learned during the incident:
- mounting `/usr/syno` into the NAS API container was not enough
- Synology host binaries like `synopkg` and `synobackup` are dynamically linked and do not execute cleanly inside the Alpine-based NAS API container

So the working solution became:
- read Hyper Backup status from mounted task-state files and logs instead of relying on host executables

Relevant paths:
- `/volume1/@appdata/HyperBackup/config/task_state.conf`
- `/volume1/@appdata/HyperBackup/last_result/backup.last`
- `/volume1/@appdata/HyperBackup/log/hyperbackup.log`
- `/volume1/@appdata/HyperBackup/log/synolog/synobackup.log`

This is now the correct design direction for backup-status diagnostics.

### 6. Scheduled task DSM API fallback fixed

Observed during live API verification:
- `SYNO.Core.TaskScheduler` version `4` returned DSM error `103`
- versions `3`, `2`, and `1` returned usable data

What changed:
- the DSM client now falls back across versions instead of assuming v4 works

Relevant file:
- [apps/agent/internal/dsm/client.go](./apps/agent/internal/dsm/client.go)

Important note:
- older docs that say scheduled tasks are still wholly unavailable are stale
- the repo now contains a real fallback fix

### 7. Snapshot replication API family corrected

Observed during live API discovery:
- older guessed APIs were wrong for the installed package on `edgesynology2`
- the NAS advertises APIs such as `SYNO.DR.Plan`

What changed:
- the DSM client now tries the advertised snapshot-replication / DR family instead of only the older guessed APIs

What was learned:
- `edgesynology2` has the package installed
- `SYNO.DR.Plan v1 list` succeeds
- current response showed no configured plans
- `edgesynology1` does not expose the same active API surface

### 8. Low-I/O infra collector added

File:
- [apps/agent/internal/collector/infra.go](./apps/agent/internal/collector/infra.go)

Added telemetry includes:
- network link up/down
- network link speed
- per-interface throughput and error/drop rates
- per-share used/free/used%
- share growth bytes
- Hyper Backup fallback task state and age/error metrics

Design goal:
- add visibility without recursively scanning shares or causing unnecessary disk load

### 9. Hyper Backup fallback telemetry improved

File:
- [apps/agent/internal/collector/hyperbackup.go](./apps/agent/internal/collector/hyperbackup.go)

Behavior:
- when DSM Hyper Backup APIs are unavailable or incomplete, the collector falls back to mounted metadata and task-state files

This matters because:
- current DSM builds on these NASes do not reliably expose everything through a clean API contract

### 10. Churn detection added

Committed in:
- `e10f2e9` — `Add Drive and Hyper Backup churn signals`

Files:
- [apps/agent/internal/collector/infra.go](./apps/agent/internal/collector/infra.go)
- [apps/agent/internal/collector/drive.go](./apps/agent/internal/collector/drive.go)

New Hyper Backup metrics:
- `hyperbackup_last_new_files`
- `hyperbackup_last_removed_files`
- `hyperbackup_last_renamed_files`
- `hyperbackup_last_copy_miss_files`

New Drive metrics:
- `drive_log_rename_hits`
- `drive_log_delete_hits`
- `drive_log_move_hits`
- `drive_log_conflict_hits`
- `drive_log_connect_hits`
- `drive_log_disconnect_hits`
- `drive_log_mac_hits`

New warning log sources:
- `hyperbackup_churn`
- `drive_churn_signal`

### 11. Fused forensic incident detection added

Committed in:
- `5c6d4d2` — `Fuse Drive churn into backup incident detection`

Files:
- [apps/web/src/lib/server/fact-store.ts](./apps/web/src/lib/server/fact-store.ts)
- [apps/web/src/lib/server/issue-detector.ts](./apps/web/src/lib/server/issue-detector.ts)
- [apps/web/src/lib/server/issue-agent.ts](./apps/web/src/lib/server/issue-agent.ts)

What the web app can now infer directly:
- if Hyper Backup cleanup is stuck in a version-delete state
- and storage pressure is high
- and Drive churn / Hyper Backup churn / snapshot cleanup evidence exists
- then one explicit fact and one explicit issue can be created describing the root pattern

This is the biggest reasoning improvement added during this pass.

## What The Incident Investigation Proved

### Hyper Backup state interpretation

The app previously risked over-reading “last success” as if the task were healthy.

What the investigation proved:
- the backup itself on `edgesynology2` did finish successfully
- the task then entered version deletion / version rotation
- the next scheduled run could not start because the destination was still busy deleting versions
- later, the cleanup worker died and the state became `version_delete_failed`

Operational meaning:
- “backup succeeded” and “backup workflow is healthy” are not the same thing

### I/O thrash interpretation

The investigation proved that the high `cpu_iowait_pct` was real and storage-bound.

Main signals:
- high `cpu_iowait_pct`
- busy RAID/device queues
- kernel Btrfs snapshot-drop logs
- Hyper Backup cleanup / version-delete state

Most important conclusion:
- the monitor containers were not the main culprit
- the storage thrash was driven by post-backup snapshot/version cleanup, which itself was triggered by heavy Drive churn

### Synology Drive churn interpretation

The investigation did not find evidence of random corruption or a one-way wipe.

It did find:
- many real `NativeRename` events
- many real `NativeRemove` events
- many real `NativeUpload` events
- multiple Drive client devices in the Drive sync metadata
- multiple conflict-style files

Quantitative sample result for April 13–14:
- `97` removes
- `867` uploads
- `11` explicit renames
- `88` of `97` removes had same-name replacements in the same or adjacent path

Conclusion:
- this was primarily a large reorganization / move / conflict-cleanup event
- Synology Drive represented a lot of that as delete/create churn

## Functionality That Exists But Is Missing Or Stale In Older Docs

This section is intentionally blunt. These are real capabilities or behaviors that the old docs do not describe accurately enough.

### The relay is real

Older top-level docs focus on web -> NAS API.

Reality:
- the public VPS relay exists
- it was used successfully during the incident
- it is part of the real production control path

### NAS API is the app’s SSH replacement

The older docs do not always state this clearly.

Reality:
- the intended runtime replacement for app-side SSH is NAS API
- the web app no longer depends on `nas.ts`

### Scheduled task fallback is fixed in code

Older docs still emphasize “TaskScheduler returns 103”.

Reality:
- that diagnosis was true, but the fix has now been implemented in the DSM client

### Snapshot replication discovery is better than older docs imply

Older docs say current APIs are unsupported/unavailable.

Reality:
- the repo now uses a more accurate DR API family
- at least on `edgesynology2`, the system can determine that the package exists but there are currently no plans

### Hyper Backup status has a working metadata/log path

Older docs emphasize API uncertainty.

Reality:
- mounted metadata and logs provide a reliable backup-status path
- this was verified live during the incident

### Forensic correlation now exists in code

Older docs describe issue/fact flow at a high level.

Reality:
- the web app now has a fused forensic rule for Drive churn + backup cleanup + snapshot cleanup + `iowait`

### Edge deployment state differs by NAS

Important verified state:
- `edgesynology1` was directly confirmed on the newer agent image during this pass
- `edgesynology2` was not directly confirmed by shell/Docker inspection because shell/Docker access remained inconsistent

Older docs do not capture this asymmetry.

## Known Limitations Still Present

### 1. The app still does not expose every manual forensic step as a first-class tool

Missing first-class capabilities:
- Synology Drive client attribution by device/user/share
- delete/create-vs-rename matcher
- explicit Hyper Backup cleanup timeline viewer
- explicit UI view that explains this correlated incident type without requiring deeper log reading

### 2. Relay container-control actions still need cleanup

Current limitation:
- some relay write actions use plain `docker`
- inside the current NAS API runtime that does not always resolve correctly

Observed behavior:
- `pull_monitor_agent` through the relay returned `docker: command not found`

Meaning:
- the forensic read path is stronger than the maintenance write path

### 3. NAS API should not rely on host DSM binaries executing inside Alpine

This was experimentally disproven during the incident.

Design rule going forward:
- prefer mounted files/logs/metadata or a host wrapper
- do not plan around `/usr/syno` binaries executing directly inside the NAS API container

### 4. Git worktree is still dirty

This repo contains other modifications from the longer session that were not part of the final forensic feature commits.

Important state:
- `apps/relay/` is still untracked in git as of this audit
- many older files are modified but were not committed in the two focused commits above

This is operationally important for any future engineer.

## Commits Added During This Forensic Capability Pass

Focused commits:
- `e10f2e9` — `Add Drive and Hyper Backup churn signals`
- `5c6d4d2` — `Fuse Drive churn into backup incident detection`

These are the commits that specifically improve forensic capability.

## Recommended Next Step

The next engineering step is not “collect more random logs”.

The correct next step is to implement the remaining four forensic capabilities:
1. Drive client attribution
2. delete/create-vs-rename matcher
3. Hyper Backup cleanup timeline tool
4. unified forensic incident explainer UI

That implementation plan is documented in:
- [HANDOFF.md](./HANDOFF.md)
