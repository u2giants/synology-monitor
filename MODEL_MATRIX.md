# Model Matrix

Last updated: 2026-04-09 UTC

Scope:
- This is non-authoritative owner/reference material.
- Future agents should not treat it as required reading unless explicitly asked to work on model orchestration design.
- This file is a target-state architecture spec for model orchestration.
- It defines how reasoning work should be split across model stages, which stages should stay deterministic, and how each stage should plug into the backend issue workflow.
- It is not a statement that every stage below is fully implemented today.

Related source-of-truth docs:
- [rebuild_plan.md](rebuild_plan.md)
- [AGENTS.md](AGENTS.md)
- [PLAN.md](PLAN.md)
- [HANDOFF.md](HANDOFF.md)

## Why this exists

The system should not think in terms of only two broad models, "diagnosis" and "remediation".

That split is too coarse. Each of those buckets still mixes multiple distinct tasks:
- extracting facts from noisy telemetry
- clustering related events into one issue
- ranking root-cause hypotheses
- choosing the one most discriminating next step
- producing operator-facing explanations
- verifying post-action outcomes

Those tasks have different cost, latency, and reasoning requirements.

The right architecture is:
1. keep workflow and command control deterministic
2. use smaller cheaper models for repetitive structure work
3. reserve the strongest model for genuinely ambiguous reasoning
4. make every model stage have a narrow contract and typed output

## Non-negotiable rules

1. Command rendering is deterministic.
2. Approval policy is deterministic.
3. Queue ownership and retries are deterministic.
4. Capability checks are deterministic.
5. State transitions are deterministic.
6. Models do not directly mutate workflow state without validation.
7. Empty telemetry never implies healthy telemetry if a capability is unsupported or degraded.

## Target stage map

### Stage 0: Capability detection

Type:
- deterministic

Purpose:
- detect what each NAS can and cannot provide before reasoning begins

Inputs:
- DSM API responses
- package presence
- collector runtime errors
- ingestion warnings

Outputs:
- `smon_capability_state` rows

Examples:
- `can_list_scheduled_tasks = unsupported`
- `can_list_hyperbackup_tasks = degraded`
- `can_read_dsm_log_center = supported`

Why no model:
- this is state discovery, not reasoning

Current code touchpoints:
- [capability-store.ts](apps/web/src/lib/server/capability-store.ts)
- [issue-agent.ts](apps/web/src/lib/server/issue-agent.ts)

### Stage 1: Evidence extraction

Type:
- small cheap model, optionally mixed with deterministic rules

Purpose:
- convert noisy raw telemetry into typed fact candidates

Inputs:
- `smon_logs`
- `smon_alerts`
- task snapshots
- backup state
- snapshot state
- container I/O
- metrics
- connection snapshots

Outputs:
- fact candidates with:
  - `fact_type`
  - `fact_key`
  - `severity`
  - `title`
  - `detail`
  - `value`
  - source references

Examples:
- `drive_share_metadata_lookup_failed`
- `sharesync_task_backlogged`
- `backup_task_failed`
- `cpu_iowait_high`
- `container_hot_write`

Recommended model tier:
- small / cheap / fast

Why:
- this stage is repetitive and structured
- it should not consume the strongest reasoning budget

Guardrails:
- no remediation proposals
- no hypothesis text
- facts only
- deterministic post-validation on keys and enums

Current code touchpoints:
- [fact-store.ts](apps/web/src/lib/server/fact-store.ts)
- [issue-agent.ts](apps/web/src/lib/server/issue-agent.ts)

Target future implementation:
- move more extraction out of prompt text and into typed fact pipelines

### Stage 2: Issue clustering

Type:
- small-to-medium model

Purpose:
- determine what belongs to the same issue

Inputs:
- normalized facts
- recent issue set
- recent alerts/logs
- grouping heuristics

Outputs:
- issue grouping decisions
- cluster fingerprint
- affected NAS list
- primary evidence IDs
- grouping explanation

Examples:
- five mass-rename alerts in one folder become one issue
- many ShareSync API invalid responses across logs become one control-plane issue

Recommended model tier:
- small/medium

Why:
- pattern grouping is semantically harder than extraction but still bounded

Guardrails:
- no command or remediation output
- grouping must include a fingerprintable deterministic key
- deterministic overrides should exist for obvious stable families

Current code touchpoints:
- [issue-detector.ts](apps/web/src/lib/server/issue-detector.ts)
- [analysis/route.ts](apps/web/src/app/api/analysis/route.ts)

Target future implementation:
- deterministic pre-clustering first
- model-assisted merge second

### Stage 3: Hypothesis ranking

Type:
- strongest reasoning model

Purpose:
- decide what is most likely true now

Inputs:
- issue thread
- normalized facts
- capability state
- recent evidence
- prior actions and outcomes
- operator constraints

Outputs:
- current hypothesis
- alternate hypotheses
- confidence
- strongest supporting evidence
- strongest counterevidence
- missing evidence

Recommended model tier:
- strong reasoning model

Why:
- this is the most ambiguity-heavy step
- this is where real issue ownership lives

Guardrails:
- no command text
- no broad multi-step narrative
- must return exactly one best hypothesis plus alternatives
- must explicitly degrade confidence if telemetry visibility is degraded

Current code touchpoints:
- [issue-agent.ts](apps/web/src/lib/server/issue-agent.ts)

Target future implementation:
- split this out from the current all-in-one decision prompt

### Stage 4: Next-step selection

Type:
- medium or strong reasoning model

Purpose:
- choose exactly one next action:
  - one read-only diagnostic
  - one user question
  - one remediation candidate
  - or explicit blocked state

Inputs:
- ranked hypothesis
- missing evidence
- operator constraints
- blocked tools
- available tool catalog
- capability state

Outputs:
- one next-step object

Recommended model tier:
- medium for routine cases
- strong when the issue has competing plausible hypotheses

Guardrails:
- exactly one next step
- no multi-branch plans shown to the operator
- must not propose blocked or already-rejected actions without justification
- remediation requires an exact target

Current code touchpoints:
- [issue-agent.ts](apps/web/src/lib/server/issue-agent.ts)

Target future implementation:
- separate from hypothesis ranking prompt

### Stage 5: Remediation planning

Type:
- strong reasoning model

Purpose:
- translate an accepted hypothesis into a single concrete remediation candidate

Inputs:
- accepted hypothesis
- issue history
- action history
- capability state
- tool catalog

Outputs:
- one remediation proposal with:
  - tool name
  - exact target
  - reason
  - expected outcome
  - rollback plan
  - risk

Recommended model tier:
- strong

Guardrails:
- no vague fix proposals
- no manual fallback hand-waving disguised as an action
- no remediation if exact target is unknown
- must separate "not enough information" from "manual step required"

Current code touchpoints:
- [issue-agent.ts](apps/web/src/lib/server/issue-agent.ts)

Target future implementation:
- keep action templates deterministic even if planning remains model-driven

### Stage 6: Operator explanation

Type:
- cheap medium model, or piggyback on Stage 4/5 if already available

Purpose:
- explain current belief and next step clearly to the operator

Inputs:
- hypothesis state
- selected next step
- strongest evidence
- capability gaps

Outputs:
- concise operator-facing message

Recommended model tier:
- medium

Why:
- explanation is not the expensive reasoning step
- it should be optimized for clarity and consistency

Guardrails:
- no new reasoning beyond what prior stages decided
- no hidden extra actions
- must mention degraded visibility when relevant

Current code touchpoints:
- [issue-agent.ts](apps/web/src/lib/server/issue-agent.ts)
- [assistant/page.tsx](apps/web/src/app/(dashboard)/assistant/page.tsx)

### Stage 7: Verification

Type:
- medium reasoning model, sometimes deterministic

Purpose:
- decide whether an action changed the issue state

Inputs:
- executed action result
- fresh telemetry snapshot
- prior hypothesis

Outputs:
- verification result:
  - fixed
  - partially improved
  - failed
  - inconclusive
- what changed
- whether to resolve, continue, or pivot

Recommended model tier:
- medium

Why:
- post-action verification is narrower than root-cause ranking

Guardrails:
- no new remediation generation in this stage
- first answer whether the last action helped
- if inconclusive, specify what evidence is still missing

Current code touchpoints:
- [issue-agent.ts](apps/web/src/lib/server/issue-agent.ts)
- [nas-api-client.ts](apps/web/src/lib/server/nas-api-client.ts)

## Recommended model allocation

This is the target cost/performance allocation.

### Model A: Extractor

Use for:
- Stage 1 evidence extraction

Priority:
- cheapest reliable model

Traits:
- good structured JSON compliance
- low latency
- low cost

Should not do:
- remediation planning
- hypothesis ranking

### Model B: Clusterer / explainer

Use for:
- Stage 2 issue clustering
- Stage 6 operator explanation
- optionally Stage 7 verification for simpler cases

Priority:
- low-to-medium cost
- strong enough semantic grouping

Traits:
- good summarization
- good entity grouping
- decent structured output

Should not do:
- final remediation decisions on ambiguous issues

### Model C: Reasoner

Use for:
- Stage 3 hypothesis ranking
- Stage 4 next-step selection
- Stage 5 remediation planning
- Stage 7 verification on ambiguous cases

Priority:
- strongest reasoning model

Traits:
- high coherence
- good counterfactual handling
- good at constraint-aware action choice

Should be used sparingly:
- only after telemetry has been reduced into facts and clustered issues

## What stays deterministic

These tasks should not be model-owned:

- action template lookup
- command rendering
- approval token creation and validation
- role permission checks
- queue claim / retry / backoff
- issue state transitions
- capability state writes
- issue-job writes
- duplicate action suppression where the rule is exact
- schema validation
- source evidence linking

## Worker pipeline mapping

This is how the target model stages should map onto the backend worker.

### Current worker entrypoints

- [issue-workflow.ts](apps/web/src/lib/server/issue-workflow.ts)
- [issue-agent.ts](apps/web/src/lib/server/issue-agent.ts)
- [issue-worker.mjs](apps/web/scripts/issue-worker.mjs)
- [drain/route.ts](apps/web/src/app/api/internal/issue-worker/drain/route.ts)

### Current job types

- `detect_issue`
- `run_issue`
- `user_message`
- `approval_decision`

### Target staged flow

#### `detect_issue`

1. deterministic pre-cluster on alerts/logs
2. Stage 2 clusterer refines groupings
3. create/update issue rows
4. attach seed evidence and facts
5. enqueue `run_issue`

#### `run_issue`

1. refresh telemetry
2. Stage 0 capability detection update
3. Stage 1 evidence extraction / fact updates
4. Stage 3 hypothesis ranking
5. Stage 4 next-step selection
6. if remediation selected, Stage 5 remediation planning
7. Stage 6 operator explanation
8. persist typed outputs
9. if read-only diagnostic selected and auto-runnable, execute deterministically
10. if approval needed, stop in `waiting_for_approval`

#### `approval_decision`

1. validate approval deterministically
2. render command deterministically
3. execute action deterministically
4. refresh telemetry
5. Stage 7 verification
6. Stage 6 operator explanation
7. persist next state

#### `user_message`

1. append message deterministically
2. update explicit constraints if directly parseable
3. rerun `run_issue`

## Failure handling

Every stage should fail in a visible, typed way.

### Model-stage failures must record:

- stage name
- issue ID
- model name
- prompt contract version
- parse failure or API error
- raw truncated output if safe

### Product behavior on failure

- no silent drops
- append a system or workflow note
- record in `smon_issue_jobs.last_error`
- retry only when the failure is plausibly transient
- stop and expose blocked state when the failure is deterministic

### Common failure classes

- model returned markdown-fenced JSON
- model returned malformed JSON
- upstream AI provider returned 502/504
- capability registry says required telemetry is unsupported
- action selected without exact target
- command render rejected by deterministic validator

## Output contracts

Every model stage should produce a typed schema.

Minimum rules:
- no freeform mixed prose + JSON
- no markdown-wrapped JSON
- no optional hidden fields relied on by later stages
- explicit version number per schema

Recommended versioned contracts:
- `fact_extraction_v1`
- `issue_clustering_v1`
- `hypothesis_rank_v1`
- `next_step_v1`
- `remediation_plan_v1`
- `verification_v1`
- `operator_explanation_v1`

## Evaluation plan

Each stage should be evaluated separately.

### Extraction eval
- precision and recall on fact families
- duplicate suppression quality

### Clustering eval
- over-splitting rate
- over-merging rate

### Hypothesis eval
- root-cause correctness
- confidence calibration

### Next-step eval
- diagnostic usefulness
- stale action repetition rate

### Remediation eval
- exact-target success rate
- rollback completeness

### Verification eval
- false-resolved rate
- false-failed rate

## Immediate implementation order

1. Split the current all-in-one issue-agent prompt into:
   - hypothesis ranking
   - next-step selection
   - operator explanation
2. Keep command rendering deterministic.
3. Add typed stage failure logging.
4. Add model contract version fields to persisted metadata.
5. Move issue detection closer to:
   - deterministic pre-cluster
   - model-assisted merge
6. Add replay fixtures for:
   - ShareSync metadata faults
   - Drive permission failures
   - repeated backup failures
   - mass rename bursts

## Bottom line

The best target architecture is not "one model for diagnosis and one for remediation".

The best target architecture is:
- deterministic workflow orchestration
- multiple narrow model stages
- smaller cheaper models for structure work
- one strong model reserved for ambiguity
- explicit typed contracts between stages
- replay and evaluation at each stage boundary
