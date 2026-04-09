# Model Selection Guide

Last updated: 2026-04-09 UTC

Scope:
- This file is a research guide for choosing actual models for each stage in [MODEL_MATRIX.md](/worksp/monitor/app/MODEL_MATRIX.md).
- It is intentionally vendor-neutral.
- It defines selection criteria, benchmark tasks, and evaluation questions for each stage.

Related docs:
- [MODEL_MATRIX.md](/worksp/monitor/app/MODEL_MATRIX.md)
- [rebuild_plan.md](/worksp/monitor/app/rebuild_plan.md)

## How to use this file

For each stage:
1. Identify candidate models.
2. Score them on the criteria in this file.
3. Run the benchmark prompts against captured historical issue fixtures.
4. Prefer the cheapest model that meets the stage contract reliably.
5. Only use the strongest model where ambiguity actually requires it.

Do not pick models by brand reputation alone.
Pick them by:
- contract compliance
- stability under noisy telemetry
- latency
- cost
- failure mode quality

## Global scoring dimensions

Every candidate model should be scored on the same dimensions.

### Contract compliance

Questions:
- Does it return valid JSON consistently?
- Does it respect schemas without wrapping results in markdown?
- Does it avoid extra prose outside the contract?

Why it matters:
- parse failures should be rare
- malformed output should not stall the worker

### Telemetry tolerance

Questions:
- Can it reason over noisy logs without drifting?
- Can it distinguish missing telemetry from healthy telemetry?
- Can it use capability-gap context correctly?

Why it matters:
- the system operates on imperfect NAS data

### Latency

Questions:
- How long does it take at p50 and p95?
- Is it fast enough for interactive stages?

Why it matters:
- some stages can tolerate seconds
- others should feel immediate

### Cost

Questions:
- What is the average cost per issue turn for this stage?
- Does it scale acceptably under worker throughput?

Why it matters:
- extraction and clustering may run frequently
- the strongest model should be used sparingly

### Failure mode quality

Questions:
- When wrong, is it safely wrong or dangerously wrong?
- Does it overclaim confidence?
- Does it hallucinate nonexistent tools or actions?

Why it matters:
- a cheaper model that fails safely can be better than a stronger one that fails confidently

## Stage-by-stage research matrix

### Stage 1: Evidence extraction

Primary task:
- Convert raw telemetry into typed facts.

Good candidate traits:
- very strong JSON compliance
- low cost
- low latency
- good at short structured classification
- low hallucination rate on enums

Less important:
- deep world knowledge
- long-form reasoning
- elegant prose

Context shape:
- many short rows
- repetitive data
- moderate context window

Latency target:
- sub-second to low-single-digit seconds

Cost sensitivity:
- very high

Failure tolerance:
- moderate if deterministic validation catches bad rows
- low for malformed JSON

Benchmark tasks:
- classify 100 noisy log lines into fact types
- extract issue-relevant fields from mixed telemetry
- produce no markdown-wrapped JSON under repetition

Evaluation questions:
- Does it invent fact types not in the schema?
- Does it confuse source symptoms with hypotheses?
- Does it keep extraction purely factual?

Recommended candidate class:
- small structured-output model

### Stage 2: Issue clustering

Primary task:
- Decide which facts and events belong to the same issue.

Good candidate traits:
- strong semantic grouping
- stable handling of repeated patterns
- decent structured output
- low over-merge and over-split rates

Less important:
- extremely deep causal reasoning

Context shape:
- set of facts, evidence summaries, recent issue list

Latency target:
- low single-digit seconds

Cost sensitivity:
- high

Failure tolerance:
- moderate
- deterministic pre-clustering should already narrow the problem

Benchmark tasks:
- cluster repeated ShareSync failures into one issue
- separate unrelated backup, rename, and storage issues
- merge same-root-cause issues across repeated events

Evaluation questions:
- Does it over-split one real issue into many?
- Does it over-merge unrelated symptoms?
- Does it generate a stable fingerprinting basis?

Recommended candidate class:
- small-to-medium semantic grouping model

### Stage 3: Hypothesis ranking

Primary task:
- Decide what is most likely true and how confident to be.

Good candidate traits:
- strong causal reasoning
- good confidence calibration
- good counterevidence handling
- low tendency to jump prematurely to fixes

Less important:
- ultra-low latency

Context shape:
- issue history
- normalized facts
- evidence timeline
- capability gaps
- prior failed actions

Latency target:
- seconds are acceptable

Cost sensitivity:
- medium

Failure tolerance:
- low

Benchmark tasks:
- explain recurring ShareSync metadata errors
- distinguish storage saturation from application-layer sync faults
- degrade confidence correctly when telemetry is missing

Evaluation questions:
- Does it carry forward a coherent train of thought?
- Does it remember prior rejected actions?
- Does it state what evidence argues against its current belief?

Recommended candidate class:
- strongest reasoning model

### Stage 4: Next-step selection

Primary task:
- Choose exactly one next move.

Good candidate traits:
- disciplined constraint following
- low repetition
- good tool awareness
- good prioritization under uncertainty

Less important:
- long-form explanation quality

Context shape:
- current hypothesis
- missing evidence
- blocked tools
- operator constraints
- available tools

Latency target:
- low-to-medium single-digit seconds

Cost sensitivity:
- medium

Failure tolerance:
- low

Benchmark tasks:
- choose one read-only diagnostic when evidence is thin
- avoid proposing already-rejected restarts
- choose a user question instead of a fake action when target is unknown

Evaluation questions:
- Does it propose exactly one next step?
- Does it respect blocked and previously failed actions?
- Does it choose the most discriminating step instead of the easiest one?

Recommended candidate class:
- medium or strong reasoning model

### Stage 5: Remediation planning

Primary task:
- Turn an accepted hypothesis into one concrete fix candidate.

Good candidate traits:
- strong constraint awareness
- exact target discipline
- rollback awareness
- low hallucination rate on allowed actions

Less important:
- poetic explanation

Context shape:
- accepted hypothesis
- action history
- tool catalog
- exact targets and limits

Latency target:
- medium single-digit seconds acceptable

Cost sensitivity:
- medium

Failure tolerance:
- very low

Benchmark tasks:
- propose one exact remediation with rollback
- refuse to propose file actions without a file path
- avoid vague "manual repair" non-actions

Evaluation questions:
- Does it require an exact target?
- Does it produce rollback text that is actually meaningful?
- Does it stay inside the allowed tool catalog?

Recommended candidate class:
- strongest reasoning model

### Stage 6: Operator explanation

Primary task:
- Explain current state cleanly to the operator.

Good candidate traits:
- concise prose
- consistent tone
- clear summary of what changed and what happens next

Less important:
- deepest reasoning

Context shape:
- current hypothesis
- next step
- top supporting evidence
- capability gaps

Latency target:
- low

Cost sensitivity:
- high

Failure tolerance:
- moderate

Benchmark tasks:
- rewrite technical telemetry into plain English
- explain blocked state without sounding evasive
- explain why the system is waiting for approval

Evaluation questions:
- Is it concise?
- Does it explain what changed this turn?
- Does it distinguish belief from certainty?

Recommended candidate class:
- medium summarization/explainer model

### Stage 7: Verification

Primary task:
- Decide whether an action helped.

Good candidate traits:
- comparison reasoning
- change detection
- restraint about declaring success

Less important:
- very large context

Context shape:
- before/after telemetry
- action result
- prior hypothesis

Latency target:
- low-to-medium

Cost sensitivity:
- medium

Failure tolerance:
- low

Benchmark tasks:
- judge whether restart changed ShareSync error rate
- decide between fixed / partial / inconclusive / failed
- avoid claiming resolution when evidence is mixed

Evaluation questions:
- Does it over-declare resolution?
- Can it say "inconclusive" when evidence is weak?
- Does it describe exactly what changed post-action?

Recommended candidate class:
- medium reasoning model

## Suggested benchmark fixture set

Use real captured issue fixtures from this repo and production history.

Minimum fixture families:
- ShareSync metadata corruption / `SYNOShareGet` / `stoi`
- Drive API invalid-state errors
- Drive permission failures like `no permission to access node`
- repeated Hyper Backup failures
- mass rename bursts in one folder
- high iowait with high disk utilization
- high iowait with little disk activity
- unsupported DSM API capability gaps

Each fixture should include:
- raw telemetry
- normalized facts
- issue history
- prior operator replies
- expected clustering
- expected best hypothesis
- expected next step

## Model comparison worksheet

Use this worksheet for each candidate model.

Fields:
- provider
- model name
- stage tested
- prompt contract version
- p50 latency
- p95 latency
- average tokens in
- average tokens out
- estimated cost per 1000 issue runs
- valid JSON rate
- markdown-fence violation rate
- hallucinated tool rate
- overconfidence rate
- overall pass/fail

## Elimination rules

Reject a candidate model for a stage if any of these remain true after prompt tuning:
- valid JSON rate is too low for worker safety
- it repeatedly wraps JSON in markdown fences
- it proposes nonexistent tools or commands
- it ignores blocked actions or operator constraints
- it overclaims confidence under degraded telemetry
- its latency is unacceptable for that stage
- it is too expensive for the frequency of that stage

## Practical recommendation

Research against model classes, not just named products:

1. Small structured-output extractor
2. Small/medium semantic clusterer
3. Strong reasoning planner
4. Medium explainer/verifier

Then pick the cheapest model in each class that passes the stage contract.

Do not use one premium model everywhere by default.
Do not force one cheap model to do all stages either.

The architecture should route each task to the cheapest reliable model for that exact job.
