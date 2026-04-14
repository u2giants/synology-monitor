# Synology Monitor — Forensic Capability Handoff

Last verified: 2026-04-14 UTC

Purpose:
- This handoff is for the next AI or engineer.
- Its job is to make the remaining forensic investigation tricks first-class product capabilities.
- It is intentionally detailed and prescriptive so implementation does not drift.

Read these first:
- [CAPABILITY_AUDIT.md](./CAPABILITY_AUDIT.md)
- [AGENTS.md](./AGENTS.md)
- [deploy/synology/README.md](./deploy/synology/README.md)

## What Was Already Solved

The April 2026 incident investigation already proved the system can collect enough raw evidence to explain a complex Synology Drive / Hyper Backup failure.

Specifically, the investigation established all of the following:
- Hyper Backup on `edgesynology2` finished the backup successfully.
- The task then entered version deletion / version rotation.
- The version-delete cleanup got stuck and later failed.
- `cpu_iowait_pct` was high because storage was saturated by cleanup work.
- kernel logs and Synology Drive logs showed share snapshot deletion and Btrfs snapshot drop activity.
- Synology Drive logs showed real rename, remove, upload, and conflict activity.
- The change pattern was primarily a large reorganization / conflict-cleanup wave, not a one-way destructive wipe.

The system already has:
- agent-side churn signals
- web-side fused issue/fact detection for this pattern
- NAS API and relay read access to the required logs and metadata

What is still missing is not “more raw access.” What is missing is productized forensic tooling.

## The Four Tasks To Implement

The next engineer must implement these four tasks:

1. Drive client attribution
2. delete/create-vs-rename matcher
3. Hyper Backup cleanup timeline tool
4. unified forensic incident explainer UI

These tasks are not optional refinements. They are the direct productization of the manual forensic work already proven valuable in production.

## Non-Negotiable Constraints

### 1. Do not regress into direct web-side SSH

The app runtime path must remain:
- web / AI / operator -> relay -> NAS API -> NAS

Do not reintroduce:
- web-side direct SSH helpers
- browser-facing NAS secrets

### 2. Do not assume Synology host binaries will execute cleanly inside the NAS API container

This was already tested and failed.

Do not build new features that depend on:
- `/host/usr/syno/bin/synopkg`
- `/host/usr/syno/bin/synobackup`
- `/host/usr/syno/bin/hibackup`

being executable inside the Alpine NAS API container.

Preferred sources:
- mounted logs
- mounted metadata
- DSM API responses
- agent-collected structured telemetry

### 3. Keep NAS I/O impact low

The user explicitly cares about not causing extra disk thrash on the Synology hosts.

Do not implement:
- recursive share scans
- full-drive file walks
- large repeated `find` or `grep` sweeps across user content
- repeated full-file reads of huge logs

Prefer:
- recent-line windows
- rolling summaries
- sampling
- derived telemetry written by the agent

### 4. Treat `edgesynology2` shell access as unreliable

Known reality:
- `popdam` SSH works on `edgesynology1`
- `popdam` SSH has been unreliable or unavailable on `edgesynology2`
- `ahazan` exists on `edgesynology2` but a valid password was not available in-session

So anything you build should not require direct shell access to `edgesynology2`.

## Current Relevant Code And Commits

### Agent-side churn collection

Committed:
- `e10f2e9` — `Add Drive and Hyper Backup churn signals`

Files:
- [apps/agent/internal/collector/drive.go](./apps/agent/internal/collector/drive.go)
- [apps/agent/internal/collector/infra.go](./apps/agent/internal/collector/infra.go)

Existing signals added there:
- Hyper Backup:
  - `hyperbackup_last_new_files`
  - `hyperbackup_last_removed_files`
  - `hyperbackup_last_renamed_files`
  - `hyperbackup_last_copy_miss_files`
  - log source: `hyperbackup_churn`
- Drive:
  - `drive_log_rename_hits`
  - `drive_log_delete_hits`
  - `drive_log_move_hits`
  - `drive_log_conflict_hits`
  - `drive_log_connect_hits`
  - `drive_log_disconnect_hits`
  - `drive_log_mac_hits`
  - log source: `drive_churn_signal`

### Web-side fused incident reasoning

Committed:
- `5c6d4d2` — `Fuse Drive churn into backup incident detection`

Files:
- [apps/web/src/lib/server/fact-store.ts](./apps/web/src/lib/server/fact-store.ts)
- [apps/web/src/lib/server/issue-detector.ts](./apps/web/src/lib/server/issue-detector.ts)
- [apps/web/src/lib/server/issue-agent.ts](./apps/web/src/lib/server/issue-agent.ts)

This already creates:
- a fused fact when Drive churn + backup cleanup failure + storage pressure line up
- a fused detected issue for that same pattern

### NAS API / relay forensic read path

Important files:
- [apps/web/src/lib/server/nas-api-client.ts](./apps/web/src/lib/server/nas-api-client.ts)
- [apps/relay/src/server.mjs](./apps/relay/src/server.mjs)
- [apps/nas-api/cmd/server/main.go](./apps/nas-api/cmd/server/main.go)
- [apps/nas-api/internal/validator/validator.go](./apps/nas-api/internal/validator/validator.go)

Important live truth:
- `apps/relay/` exists locally and is deployed live
- but `apps/relay/` is currently untracked in git

## Task 1 — Drive Client Attribution

### Goal

Given a Drive-heavy issue, the system should be able to answer:
- which Drive client devices were involved
- which users/share contexts they belong to
- which shares or task IDs were most active
- whether the churn was likely single-client or multi-client

### Why this matters

Manual investigation found device names like:
- `DESKTOP-R78HRI5`
- `DESKTOP-497E0EB`
- `DESKTOP-HKGCSV3`
- `LAPTOP-461OGMB5`
- `Elizabeths-MacBook-Pro.local`
- `Vies-MacBook-Pro.local`

That came from Drive DB metadata and conflict-style filenames, but it is not yet exposed as a first-class product capability.

### Required behavior

Create a deterministic forensic function that returns:
- `devices`: array of device summaries
- `users`: array of likely usernames tied to those devices
- `shares`: array of shares seen in recent relevant Drive log events
- `active_task_ids`: array of active `NativeSyncTask #...` ids
- `conflict_device_names`: array of device names inferred from conflict-style filenames
- `attribution_confidence`: `high | medium | low`
- `notes`: explanatory caveats

### Data sources to use

Primary:
- `/volume1/@synologydrive/@sync/user-db.sqlite`
- `/volume1/@synologydrive/@sync/client-udc-db.sqlite`
- `/volume1/@synologydrive/@sync/job-db.sqlite`
- `/volume1/@synologydrive/@sync/syncfolder-db.sqlite`
- `/volume1/@synologydrive/log/syncfolder.log*`

Secondary:
- issue telemetry already in Supabase:
  - `nas_logs`
  - `metrics`
  - `process_snapshots`

### Important implementation rule

Do not require `sqlite3` on the NAS host unless it already exists in the runtime you are actually using.

Safer choices:
- extend the Go agent to extract compact attribution summaries into structured telemetry
- or add a low-I/O parser that reads only selected DB strings and selected recent log windows

Recommended implementation:
- implement DB parsing in the Go agent, not in ad hoc shell
- emit a compact structured log or metric summary once per interval

### Exact files to modify

Agent:
- [apps/agent/internal/collector/drive.go](./apps/agent/internal/collector/drive.go)

Sender payloads, if needed:
- [apps/agent/internal/sender/types.go](./apps/agent/internal/sender/types.go)
- [apps/agent/internal/sender/sender.go](./apps/agent/internal/sender/sender.go)

Web read path:
- [apps/web/src/lib/server/issue-agent.ts](./apps/web/src/lib/server/issue-agent.ts)
- [apps/web/src/lib/server/fact-store.ts](./apps/web/src/lib/server/fact-store.ts)

Optional UI surfacing later:
- forensic UI files described in Task 4

### Suggested output contract

Emit one or both of:
- `nas_logs` source `drive_client_attribution`
- metrics if useful for counts only

Structured metadata should include:
- `devices`
- `users`
- `task_ids`
- `share_names`
- `conflict_device_names`
- `matched_paths`
- `confidence`

### Done criteria

This task is complete only if:
- a new issue about Drive churn can display likely participating clients without ad hoc NAS shell work
- the issue agent can attach a derived fact like:
  - `Likely Drive clients involved: DESKTOP-R78HRI5, ZAR-LAPTOP, Elizabeths-MacBook-Pro.local`
- output is stable enough that repeated runs do not generate noisy duplicate facts every cycle

## Task 2 — Delete/Create-Vs-Rename Matcher

### Goal

Given a churn event, the system should determine whether observed delete activity is:
- mostly true destructive deletion
- mostly move/rename/restructure
- mixed / indeterminate

### Why this matters

Manual forensic work showed:
- many `NativeRemove` lines
- many `NativeUpload` lines
- many explicit `NativeRename` lines

And in the April 13–14 sample on `edgesynology2`:
- `88` of `97` deletes had same-name replacements in nearby paths

That logic must become a first-class tool.

### Required behavior

Build a matcher that:
- consumes a bounded recent window of Drive events
- normalizes filenames
- compares delete paths against:
  - exact re-upload
  - same-name replacement in same directory
  - same-name replacement in adjacent directory
  - explicit rename target
- produces a summary classification:
  - `restructure_likely`
  - `destructive_delete_likely`
  - `mixed`

### Use these normalization rules

At minimum normalize:
- case
- repeated spaces / underscores / dashes
- conflict suffixes:
  - `_Conflict`
  - `_UploadNameConflict`
  - `_CaseConflict`
- workstation tags:
  - `_DESKTOP-*`
  - `_ZAR-LAPTOP_*`
  - `_DiskStation_*`
- obvious “Copy” suffixes

### Exact files to modify

Best place for core logic:
- new deterministic helper under:
  - `apps/web/src/lib/server/`

Recommended new file:
- `apps/web/src/lib/server/forensics-drive.ts`

Then integrate with:
- [apps/web/src/lib/server/fact-store.ts](./apps/web/src/lib/server/fact-store.ts)
- [apps/web/src/lib/server/issue-agent.ts](./apps/web/src/lib/server/issue-agent.ts)

If you decide to collect a rolling summary agent-side instead:
- extend [apps/agent/internal/collector/drive.go](./apps/agent/internal/collector/drive.go)

### Required output

For a bounded recent event window, return:
- `remove_count`
- `upload_count`
- `rename_count`
- `exact_match_count`
- `same_base_same_dir_count`
- `same_base_near_dir_count`
- `rename_into_subdir_count`
- `classification`
- `sample_pairs`

### Required fact

Add a fact like:
- `Recent delete activity mostly matches file moves and replacements`

or:
- `Recent delete activity appears destructive and unmatched`

### Done criteria

This task is complete only if:
- a future issue can explicitly say whether a large delete wave looks like a move/restructure
- the result is visible in issue evidence or facts without requiring ad hoc Node parsing in the shell

## Task 3 — Hyper Backup Cleanup Timeline Tool

### Goal

Turn the manual backup-status reconstruction into a first-class timeline.

During the incident, we had to manually correlate:
- backup start
- backup finish
- version rotation start
- skipped next backup
- keepalive death
- `version_delete_failed`

That must become a first-class forensic timeline.

### Required behavior

Create a tool/function that returns a normalized timeline for a given NAS / backup task:
- backup started
- backup completed
- version deletion started
- destination busy / skipped next run
- cleanup failed
- current task-state metadata

### Data sources to use

Primary:
- `/volume1/@appdata/HyperBackup/log/hyperbackup.log`
- `/volume1/@appdata/HyperBackup/log/synolog/synobackup.log`
- `/volume1/@appdata/HyperBackup/config/task_state.conf`
- `/volume1/@appdata/HyperBackup/last_result/backup.last`

Secondary:
- `backup_tasks` telemetry already stored in Supabase
- `hyperbackup_fallback` logs already produced
- `hyperbackup_churn` logs already produced

### Exact files to modify

Recommended new helper:
- `apps/web/src/lib/server/forensics-hyperbackup.ts`

Integrate with:
- [apps/web/src/lib/server/nas-api-client.ts](./apps/web/src/lib/server/nas-api-client.ts)
- [apps/web/src/lib/server/fact-store.ts](./apps/web/src/lib/server/fact-store.ts)
- [apps/web/src/lib/server/issue-agent.ts](./apps/web/src/lib/server/issue-agent.ts)

Optional relay tool if needed:
- [apps/relay/src/server.mjs](./apps/relay/src/server.mjs)

### Required timeline schema

Return an ordered array of events like:
- `backup_started`
- `backup_finished_success`
- `version_rotation_started`
- `backup_skipped_destination_busy`
- `cleanup_keepalive_died`
- `cleanup_failed`

Each event should include:
- `timestamp`
- `kind`
- `message`
- `source`
- `task_id`

### Required derived fact

Add a fact like:
- `Latest backup succeeded, but post-backup version cleanup failed`

This distinction is important and must be preserved.

### Done criteria

This task is complete only if:
- the issue thread can explain the difference between backup success and cleanup failure
- the operator can see that the task is unhealthy even when `last_backup_success_time` is recent

## Task 4 — Unified Forensic Incident Explainer UI

### Goal

The operator should not have to stitch together:
- Drive churn
- backup cleanup state
- snapshot deletion
- iowait

The UI should expose one coherent forensic explanation.

### Required behavior

Add a forensic incident panel or issue view section that shows:
- current incident classification
- confidence
- why the system believes it
- top supporting evidence
- what likely happened in plain English
- recommended next actions

### Scope

This should appear in the issue-centric workflow, not as a hidden debug-only view.

Recommended places:
- issue view / resolution thread
- optionally dashboard issue detail or copilot issue session view

### Exact files to inspect and likely modify

Issue view state:
- [apps/web/src/lib/server/issue-view.ts](./apps/web/src/lib/server/issue-view.ts)

Issue-centric routes and UI:
- [apps/web/src/app/api/resolution/create/route.ts](./apps/web/src/app/api/resolution/create/route.ts)
- [apps/web/src/app/api/resolution/message/route.ts](./apps/web/src/app/api/resolution/message/route.ts)
- relevant issue UI under `apps/web/src/app/(dashboard)/...`

Issue session / copilot surfaces:
- [apps/web/src/lib/server/copilot-issues.ts](./apps/web/src/lib/server/copilot-issues.ts)
- [apps/web/src/lib/server/copilot.ts](./apps/web/src/lib/server/copilot.ts)

### Required contents

At minimum show:
- `Incident classification`
- `Likely cause`
- `Affected NAS`
- `Storage pressure`
- `Drive churn summary`
- `Backup cleanup state`
- `Why this is probably restructure, not destruction`
- `Recommended next step`

### Required plain-English language

The UI explanation must be operator-facing and direct.

For example:
- `Hyper Backup finished the backup itself, but got stuck deleting old versions after a large Synology Drive reorganization.`
- `Most of the delete activity matches moves or replacements, so this does not look like a one-way wipe.`

### Done criteria

This task is complete only if:
- a non-technical operator can understand the incident from the issue page alone
- the explanation clearly distinguishes cause from symptom

## Implementation Order

Implement in this order:

1. Drive client attribution
2. delete/create-vs-rename matcher
3. Hyper Backup cleanup timeline tool
4. unified forensic incident explainer UI

Reason:
- tasks 1–3 produce the evidence needed for task 4

## Testing Requirements

### Required automated checks

For agent code:
- run:
```sh
cd /worksp/monitor/app/apps/agent
docker run --rm -v /worksp/monitor/app/apps/agent:/src -w /src golang:1.23-alpine sh -lc '/usr/local/go/bin/go test ./...'
```

For web code:
- run:
```sh
cd /worksp/monitor/app
pnpm --filter @synology-monitor/web type-check
```

### Required live verification

You are not done with code-only validation.

At minimum verify on real data:
- a Drive churn issue produces attribution output
- a Drive churn issue produces a restructure-vs-delete classification
- a Hyper Backup cleanup issue produces a normalized timeline
- the issue UI shows the fused explanation

### Use the known incident for validation

Use `edgesynology2` as the real validation case because this incident already produced:
- backup completion
- version deletion stall/failure
- high `iowait`
- Drive churn
- snapshot deletion

## What Not To Change

Do not:
- remove NAS API
- replace the relay with direct browser-to-NAS access
- reintroduce web-side SSH execution
- assume `/usr/syno` binaries are the long-term answer
- add high-I/O recursive scans to the agent
- broaden Docker control beyond the monitor stack in the name of convenience

## Operational Notes For The Next Engineer

### Git state

Be careful:
- the repo worktree contains other modified files unrelated to these four tasks
- `apps/relay/` is untracked locally even though it exists and is deployed live

Do not blindly commit the whole worktree.

### Deployment caveat

`edgesynology1` was directly confirmed on a newer agent image during the incident pass.

`edgesynology2` was not directly confirmed by shell/Docker inspection because shell access remained inconsistent.

So if you rely on new agent collectors, verify they are actually live on both NASes before claiming success.

### Existing forensic truth to preserve

This is the root incident explanation already established and must not be lost:
- A large Synology Drive reorganization / conflict-cleanup wave caused massive rename/delete/create churn.
- Hyper Backup completed the backup itself.
- Hyper Backup then jammed during version deletion / cleanup.
- Snapshot deletion and Btrfs cleanup drove high storage pressure and high `cpu_iowait_pct`.
- The evidence suggests restructure rather than one-way destructive deletion.

Any new implementation that contradicts this without new evidence is probably wrong.

## Minimum Acceptable Final Outcome

After the four tasks are done, the product should be able to do this without manual shell forensics:

1. detect abnormal Drive churn
2. identify likely clients and users involved
3. determine whether deletes mostly match moves/replacements
4. reconstruct the Hyper Backup cleanup timeline
5. explain the entire incident in one issue thread in plain English

If the app still requires manual ad hoc log parsing to answer those questions, this handoff was not completed.
