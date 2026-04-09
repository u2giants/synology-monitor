# Rebuild Plan

Last updated: 2026-04-09 UTC

Scope:
- This file is a target-state build specification.
- It is not a statement of current live behavior.
- For current live architecture and verified behavior, use:
  - [AGENTS.md](/worksp/monitor/app/AGENTS.md)
  - [PLAN.md](/worksp/monitor/app/PLAN.md)
  - [HANDOFF.md](/worksp/monitor/app/HANDOFF.md)
  - [deploy/synology/README.md](/worksp/monitor/app/deploy/synology/README.md)
- For the target model-stage split and model allocation, use:
  - [MODEL_MATRIX.md](/worksp/monitor/app/MODEL_MATRIX.md)
- For stage-by-stage model research and evaluation criteria, use:
  - [MODEL_SELECTION_GUIDE.md](/worksp/monitor/app/MODEL_SELECTION_GUIDE.md)

## Purpose

Rebuild the product as a deterministic issue-resolution system with:
- durable issue state
- explicit telemetry capability detection
- raw telemetry preservation
- normalized fact extraction
- backend-owned issue workflow
- approval-gated action execution
- replayable and testable reasoning steps

This rebuild treats the current system as a useful prototype, not as an architectural constraint.

## Goals

1. One durable issue thread per problem.
2. One backend-owned workflow per issue.
3. No silent blind spots. Unsupported data must be explicit.
4. No UI-polling dependency for core issue progression.
5. No model-driven command generation without deterministic validation.
6. Shared backend for issue agent and Copilot.
7. Replayable evaluation for prompt and workflow changes.

## Non-goals

1. Rebuilding the Go agent from scratch.
2. Hiding platform limitations behind optimistic prompts.
3. Making every markdown file equally authoritative.
4. Preserving existing AI prompt shapes if they conflict with the new architecture.

## Design principles

1. Raw before derived.
2. Facts before hypotheses.
3. Workflow before prompts.
4. Deterministic state transitions before LLM judgment.
5. Exact action targets before approvals.
6. Explicit unsupported capability before empty telemetry.
7. Replay and evaluation before production trust.

## Target architecture

### 1. Telemetry ingestion layer

Responsibilities:
- ingest raw data from:
  - DSM APIs
  - file logs
  - `/proc`
  - `/sys`
  - security watchers
  - package state
- preserve raw source evidence
- normalize raw evidence into stable domain tables
- emit collector health and capability state

Subcomponents:
- agent collectors
- sender/WAL
- raw ingestion tables
- normalizers
- capability detector

### 2. Capability registry

Purpose:
- persist what each NAS can and cannot provide
- avoid repeated probing of unsupported APIs
- make blind spots visible to the UI and planner

Examples:
- `can_list_scheduled_tasks`
- `can_list_hyperbackup_tasks`
- `can_list_snapshot_replication`
- `can_read_dsm_log_center`
- `drive_package_installed`
- `snapshot_replication_installed`
- `hyperbackup_installed`

Each capability should store:
- capability key
- NAS ID
- state: `supported`, `unsupported`, `unverified`, `degraded`
- evidence source
- last checked timestamp
- raw error or code

### 3. Fact layer

Purpose:
- bridge noisy telemetry and issue reasoning
- reduce prompt clutter
- make issue clustering and planning stable

Examples of facts:
- `scheduled_task_api_unavailable(code=103)`
- `sharesync_task_backlogged(task_id=X, backlog_count=Y)`
- `drive_share_metadata_lookup_failed`
- `raid_array_degraded(md0)`
- `container_hot_write(container=synology-monitor-agent, write_bps=...)`
- `backup_task_last_result_failed(task_id=...)`
- `service_restart_detected(service=...)`
- `share_quota_above_threshold(share=..., pct=...)`

Facts should be:
- typed
- deduplicated
- time-bounded
- linked to source evidence

### 4. Issue engine

Purpose:
- create and merge issues from facts and operator input
- maintain one issue record per real problem
- own issue lifecycle progression

Responsibilities:
- detect issue candidates
- merge duplicates
- attach evidence and facts
- maintain hypothesis state
- manage action queue
- mark issues `running`, `waiting_on_user`, `waiting_for_approval`, `resolved`, `stuck`

### 5. Workflow worker

Purpose:
- move issues forward without depending on UI polling

This should be a backend worker, not a frontend tick loop.

Responsibilities:
- claim queued issue jobs
- load issue state
- load relevant facts and fresh telemetry
- run the next orchestration step
- persist outputs
- schedule retries with backoff
- avoid concurrent workers on the same issue

Recommended implementation:
- Postgres-backed durable queue
- one active lock per issue
- retry metadata
- dead-letter state for persistent failures

### Narrow operator-control principle

The rebuilt system should prefer narrow, audited operational control surfaces over broad shell power.

Current example already implemented:
- monitor-container controls are restricted to the monitor stack compose directory
- the product does not expose generic Docker mutation for arbitrary containers

This principle should continue:
- prefer explicit action templates over broad admin shells
- when operational control is needed, scope it to the subsystem the product owns

### 6. Action engine

Purpose:
- separate planning from execution
- make command execution deterministic and auditable

Responsibilities:
- receive approved action template + exact target
- render exact command preview
- verify operator approval token
- run command through NAS execution layer
- capture stdout, stderr, exit code, completion time
- store rollback metadata if present

Important rule:
- models may suggest actions
- only deterministic templates render executable commands

### 7. Operator interface

Purpose:
- show the true state of the issue engine
- make blind spots visible

Views:
- issue list
- issue detail
- approval queue
- telemetry health view
- action history

Issue detail should show:
- current hypothesis
- alternate hypotheses
- confidence
- strongest supporting evidence
- strongest counterevidence
- blocked tools
- unsupported telemetry warnings
- next recommended step
- pending approvals

### 8. Replay and evaluation harness

Purpose:
- prevent prompt and architecture regressions
- test improvements against real historical issues

Responsibilities:
- capture issue timelines
- replay old issues with new model contracts
- compare:
  - hypothesis quality
  - action repetition
  - operator-facing clarity
  - unsupported-data handling
  - false confidence

## Unified backend model

The future system should not keep separate reasoning stacks for `Copilot` and the issue agent.

Target:
- one issue backend
- one evidence backend
- one action backend
- one planner

UI distinction:
- `Copilot` becomes an issue-aware conversational entrypoint
- `Issue view` becomes the canonical persistent lifecycle UI

## LLM responsibilities

LLMs should only own ambiguous reasoning tasks.

### Stage A: Evidence extraction

Input:
- raw logs
- raw alerts
- process snapshots
- disk stats
- task state
- backup state
- replication state
- connection data

Output:
- typed extracted facts
- evidence links

This may be partly deterministic and partly LLM-assisted depending on source quality.

### Stage B: Issue clustering

Input:
- facts
- recent issue set

Output:
- issue group assignments
- merge or split recommendations

### Stage C: Hypothesis ranking

Input:
- issue facts
- recent actions
- recent operator input

Output:
- current hypothesis
- alternate hypotheses
- confidence
- missing evidence

### Stage D: Next-step planning

Input:
- issue state
- current hypothesis
- capability state
- operator permissions and constraints

Output:
- one next diagnostic
- or one remediation candidate
- or one focused operator question

### Stage E: Operator explanation

Input:
- issue state
- planner output

Output:
- concise plain-English response for the operator

### Stage F: Verification

Input:
- action result
- updated telemetry/facts

Output:
- did the action help
- what changed
- whether the hypothesis should update

## Deterministic responsibilities

The following should not be left to the model:
- issue lifecycle state transitions
- approval gating
- role/permission checks
- command rendering
- action template validation
- capability checks
- deduplication fingerprints where rules are stable
- retry policy
- queue scheduling
- telemetry-error surfacing

## Database specification

### Layer 1: Raw telemetry

Append-only tables. Keep these close to source format.

Existing or analogous:
- `smon_logs`
- `smon_alerts`
- `smon_process_snapshots`
- `smon_disk_io_stats`
- `smon_container_status`
- `smon_container_io`
- `smon_service_health`
- `smon_storage_snapshots`
- `smon_sync_task_snapshots`
- `smon_scheduled_tasks`
- `smon_backup_tasks`
- `smon_snapshot_replicas`

### Layer 2: Capability and health

New tables:
- `smon_capability_state`
- `smon_ingestion_health`
- `smon_ingestion_events`

Suggested columns for `smon_capability_state`:
- `id`
- `nas_id`
- `capability_key`
- `state`
- `evidence_source`
- `error_code`
- `error_message`
- `checked_at`

Suggested columns for `smon_ingestion_health`:
- `id`
- `nas_id`
- `collector_name`
- `status`
- `last_success_at`
- `last_failure_at`
- `consecutive_failures`
- `last_error`
- `backlog_count`
- `backlog_bytes`
- `updated_at`

### Layer 3: Facts

New tables:
- `smon_facts`
- `smon_fact_sources`

Suggested columns for `smon_facts`:
- `id`
- `nas_id`
- `fact_type`
- `fact_key`
- `severity`
- `value_json`
- `first_seen_at`
- `last_seen_at`
- `fingerprint`

Suggested columns for `smon_fact_sources`:
- `fact_id`
- `source_table`
- `source_row_id`
- `extracted_at`

### Layer 4: Issues

Retain and evolve:
- `smon_issues`
- `smon_issue_messages`
- `smon_issue_evidence`
- `smon_issue_actions`

Add:
- `smon_issue_facts`
- `smon_issue_jobs`
- `smon_issue_state_transitions`

Suggested columns for `smon_issue_jobs`:
- `id`
- `issue_id`
- `job_type`
- `status`
- `attempt_count`
- `run_after`
- `locked_by`
- `locked_at`
- `payload_json`
- `last_error`

### Layer 5: Replays and evals

New tables:
- `smon_issue_replays`
- `smon_model_evals`

Purpose:
- compare outputs across prompt/model/system versions

## Services and module boundaries

### Agent runtime

Modules:
- collectors
- sender/WAL
- capability probe runner

### Telemetry normalizer

New backend module:
- reads raw telemetry
- emits facts
- updates capability and ingestion state

### Issue clusterer

New backend module:
- creates or merges issue records from facts and user input

### Issue worker

New backend module:
- owns issue jobs
- calls planner/extractor/verifier

### Action renderer

New backend module:
- converts action templates into exact commands

### Action executor

Existing concept, tighter interface:
- runs rendered commands
- records exact results

### UI adapters

- issue list API
- issue detail API
- approval API
- issue message API

## Action model

Each action should have:
- `kind`: `diagnostic` or `remediation`
- `template_key`
- exact `target`
- exact `command_preview`
- `risk`
- `reason`
- `expected_outcome`
- `rollback_plan`
- `requires_approval`
- `approval_token`
- `execution_status`
- `verification_result`

Important rule:
- model proposes `template_key + target + rationale`
- system materializes the command deterministically

## Capability-first planning rule

Before any plan step is proposed, the planner must evaluate:
- is the needed telemetry supported on this NAS
- is the needed package installed
- is the needed tool allowed for the user role
- has this action already been rejected or exhausted

If not, the planner must:
- select a fallback source
- or explicitly mark the issue blocked on unsupported visibility

## UI specification

### Issue list

Columns:
- title
- affected NAS
- current hypothesis
- confidence
- status
- waiting reason
- last significant action
- unsupported telemetry badges

### Issue detail

Sections:
- current diagnosis
- evidence summary
- counterevidence
- telemetry blind spots
- action queue
- approvals
- full conversation
- raw evidence links

### Blind-spot view

New view:
- per NAS capability status
- unsupported APIs
- collector failures
- WAL backlog / ingestion lag

## Migration plan

### Phase 0: Freeze and observe

Goals:
- stop architectural churn
- capture current behavior

Tasks:
- keep current issue system stable
- add missing telemetry warnings where not already present
- record representative historical issues for replay

### Phase 1: Capability and health layer

Goals:
- make ingestion trustable

Tasks:
- add `smon_capability_state`
- add `smon_ingestion_health`
- update collectors to persist explicit supported/unsupported state
- add UI visibility for capability state

Exit criteria:
- every blind spot is visible as `supported`, `unsupported`, `degraded`, or `unverified`

### Phase 2: Fact layer

Goals:
- reduce prompt noise and stabilize issue grouping

Tasks:
- add `smon_facts`
- build fact extraction jobs
- link facts to source telemetry rows
- drive issue grouping from facts instead of raw logs alone

Exit criteria:
- issue grouping can operate on facts
- issue planner can consume facts first

### Phase 3: Backend issue worker

Goals:
- remove UI polling ownership

Tasks:
- add `smon_issue_jobs`
- implement issue worker
- move issue progression off frontend-triggered loops
- keep UI as a client of issue state

Exit criteria:
- issues continue progressing with the browser closed

### Phase 4: Unified Copilot and Issue backend

Goals:
- eliminate divergent reasoning paths

Tasks:
- route Copilot through the issue backend
- unify message, evidence, and action storage
- keep only one planner and one action model

Exit criteria:
- same issue logic powers both entrypoints

### Phase 5: Replay and evaluation

Goals:
- make improvements measurable

Tasks:
- store replay fixtures
- compare model/planner outputs across versions
- define acceptance thresholds

Exit criteria:
- architecture changes are judged against replay quality, not intuition alone

## Acceptance criteria

The rebuild is successful when:
- issue progression is backend-owned
- blind spots are explicit and queryable
- no empty telemetry table is implicitly treated as healthy
- action execution is deterministic and approval-gated
- Copilot and issue flow share one backend issue model
- replay can catch regressions before release
- operators can see unsupported telemetry directly in the UI

## Risks and mitigations

### Risk: overbuilding the fact layer

Mitigation:
- start with a small set of high-value fact types
- only normalize what the issue engine actually needs

### Risk: excessive model fragmentation

Mitigation:
- keep one orchestrator
- only split LLM stages where the outputs are materially different

### Risk: queue complexity

Mitigation:
- use Postgres-backed jobs first
- avoid introducing another infrastructure dependency unless necessary

### Risk: stale docs

Mitigation:
- keep this file as design-only
- keep live-state truth in the existing authoritative docs

## Recommended immediate next steps

1. Implement `smon_capability_state` and `smon_ingestion_health`.
2. Add a UI page or panel for telemetry blind spots and collector health.
3. Define the initial fact taxonomy for:
   - scheduled task failures
   - backup failures
   - ShareSync backlog/errors
   - degraded arrays
   - hot containers/processes
4. Design `smon_issue_jobs` and move issue progression into a backend worker.
5. Build replay fixtures from recent real issues before changing prompts again.
