# PLAN — Issue-Agent AI Rebuild (3-stage, cached, live-tool)

Status: **BUILT, deployed, and live as the only issue-agent pipeline** (2026-05-30).
Authored 2026-05-29. All build-order steps (§10) shipped: config layer +
capability matrix, provider-native clients + caching core + CI guards, lossless
evidence store + Stage 1 + fetch_evidence, resumable turn state machine, Stage 2
reasoning core, Stage 3 explainer/memory, admin UI (3 stages + cache-hit + NAS
offline badge), §6 tool-catalog sharing into packages/shared, the cutover (v2 is
the default in code), and the cleanup (legacy 7-stage pipeline + OpenRouter
inference path removed). The sections below are the original design, kept for
reference. Provider keys (Anthropic/OpenAI/Gemini/DeepSeek/Qwen) are live in
Coolify. Outstanding (separate from this rebuild): rotate the leaked secrets
still in git history.

**How to use this doc:** This is the self-contained handoff for a *fresh* coding
session (start clean — prompt caching makes re-reads cheap but does not stop a
cluttered context from degrading reasoning). Read `AGENTS.md` first for repo
rules, then this. It restates everything so the coder needs no prior conversation.
Where this doc and your assumptions conflict, trust this doc.

---

## 0. TL;DR

Replace the current 7-call, OpenRouter-routed, no-caching, lossy issue-agent
pipeline with **3 config-driven stages**:

1. **Lossless Structurer** (cheap) — de-noise/dedup raw telemetry into a complete,
   structured **evidence store persisted in the DB**. "Lossless" means no distinct
   event is discarded — *not* that everything is force-fed into one prompt.
2. **Reasoning Core** (strong, cached, live tools, resumable) — one agentic loop
   that holds a stable cached prefix + a **bounded** evidence slice, pulls more
   evidence/live NAS data **on demand** via tools, and resumes from DB state across
   approval gates. The "SSH-genius" brain, with guardrails.
3. **Explainer / Memory** (cheap) — operator reply + durable memory.

Inference uses **provider-native SDKs directly** (Anthropic, OpenAI, Google Gemini,
DeepSeek, Qwen) — **never an aggregator** on the cached inference path — with
caching done correctly per provider (§9). Models + reasoning-effort are chosen by
the operator at runtime via an admin page (3 stages × 2 controls), gated by a
**provider capability matrix** (§8.3). The operator's choice always overrides, but
each stage keeps a hardcoded final-fallback default so a cold/empty `ai_settings`
still boots (§8.1).

Five decisions this plan locks down (previously gaps): the **context budget**
(§5), the **tool integration boundary** (§6), the **approval/resume state machine**
(§7), the **config key-map + capability matrix** (§8), and **cache correctness
under resume** (§9). Stage 2's three invariants tie them together: it must be
**bounded**, **resumable from the DB**, and **cache-correctness-independent**.

---

## 1. Why we're doing this — full diagnosis

The Issue Investigator feels far dumber than Claude with a live SSH session. When
you SSH, Claude has a flashlight and the keys to the room: any command, raw output,
iterative digging with a frontier model. The Investigator is the opposite, for six
verified reasons (all in `apps/web/src/lib/server/`):

### 1a. It reads pre-stored telemetry, not live data — over fixed windows
`gatherTelemetryContext` (`issue-agent.ts`) reads Supabase and makes **zero live
NAS calls during reasoning**. Windows/limits as built:

| source | window | limit | note |
|---|---|---|---|
| alerts | none | 12 | latest active |
| nas_logs (warning+) | 6h | 60 | excludes system/storage/scheduled_task/share_quota/share_health |
| nas_logs (audit, high-signal) | 48h | 80 | only those excluded sources |
| process_snapshots / disk_io_stats | 6h | 20 | |
| scheduled_tasks / storage_snapshots / dsm_errors | 48h | 20 / 20 / 30 | |
| backup_tasks | 6h | 30 | |
| snapshot_replicas / sync_task_snapshots | 6h | 20 / 15 | |
| container_io / metrics | 30m | 15 / 40 | |

Freshness measured 2026-05-29 (before the ingestion fix): metrics ~30s fresh, but
logs were 19h stale and alerts 23 days stale (ingestion was broken — now fixed,
§4). The wins: keep ingestion healthy (done) **and** let Stage 2 pull
up-to-the-second data live via tools (this rebuild).

### 1b. The "compression" is lossy (the core defect)
`compressLogsToFacts` (`issue-stage-models.ts`): slims each log to `{t,sev,msg}`
and **truncates msg to 200 chars**, caps input to ~140 rows (40/source), prompts
for **one baseline "pattern" fact per source** + one per anomaly (summarizing away
all non-anomalous detail), and the **raw `logs`/`audit_logs` are stripped before
hypothesis/planner** (`telemetryWithoutLogs` in `issue-agent.ts`). So the reasoning
models work from a lossy summary of stale data. Stage 1 fixes this — see §3/§5.

### 1c. Free-form tools instead of a curated catalog
The Investigator does **not** use a fixed menu; the planner generates *arbitrary*
tier-1/2/3 shell commands gated only by the nas-api validator. It reinvents
commands rather than using the curated, battle-tested catalog
(`apps/nas-mcp/src/tool-definitions.ts`, 108 tools; the web app's own `tools.ts`
has ~42 for the legacy copilot). There is a `tool_gaps` output but **no
"what am I missing" step**, and no way to fetch live data mid-cycle except by
proposing a diagnostic action that costs a whole cycle. Fixed in §3/§6.

### 1d. Narrow vision — pre-scoped to one fingerprint
`issue-detector.ts` fingerprints alerts+logs into issues (families:
sharesync-metadata-corruption, sharesync-api-invalid, drive-not-ready,
sync-failure, sync-conflict, thumbnail-extract-failure, backup-failure,
rename-activity; sustained I/O pressure ≥20% avg iowait / critical ≥40%;
`buildCorrelatedIncidentGroups` correlates drive/hyperbackup churn + snapshot
cleanup + I/O). The agent then sees only that slice. Fixed in §3 (whole-system
snapshot + sibling-issue visibility).

### 1e. Re-chewing — no "nothing changed" detection
`runIssueAgent` (`MAX_AGENT_CYCLES = 8`) re-runs hypothesis→planner→explanation
each cycle with no check that the evidence set is unchanged; `hasAlreadyTried`
compares command *text* only. Fixed in §3 (re-chew guard).

### 1f. No caching, and the prompts are cache-hostile
`callStageModel` uses the OpenAI SDK with `baseURL: openrouter.ai`, sends a single
user message `` `${backendFindings}\n\n${prompt}` `` with no `cache_control`, and
puts the semi-dynamic `backendFindings` **first** — so there is no stable prefix to
cache. Realizations (operator was right): stages **can** share a cache via a
byte-identical prefix; ~80–90% of each stage's context is identical; only the
trailing instruction differs. Fixed in §9.

---

## 2. Current pipeline inventory (what exists today)

**7 model calls** (in `issue-stage-models.ts` unless noted), each reading a model
key from `ai_settings` via a fallback chain (`ai-settings.ts`):

| # | stage (fn) | purpose | settings key → fallback | default |
|---|---|---|---|---|
| 1 | extractor (`compressLogsToFacts`) | compress logs→facts | `extractor_model`→`diagnosis_model` | `minimax/minimax-m2.7` |
| 2 | hypothesis (`rankIssueHypothesis`) | rank root cause | `hypothesis_model`→`reasoner_model`→`remediation_model` | `openai/gpt-5.4` |
| 3 | planner (`planIssueNextStep`) | choose next action | `planner_model`→… | `openai/gpt-5.4` |
| 4 | remediation_planner (`planIssueRemediation`) | refine/refuse fix | `remediation_planner_model`→… | `openai/gpt-5.4` |
| 5 | explainer (`explainIssueState`) | operator reply | `explainer_model`→`diagnosis_model` | `minimax/minimax-m2.7` |
| 6 | verifier (`verifyIssueAction`) | did the fix work | `verifier_model`→`remediation_model` | `openai/gpt-5.4` |
| 7 | memory (`consolidateIssueMemory`) | durable knowledge | `extractor_model`→… | `minimax/minimax-m2.7` |

Non-stage keys that also exist and are **out of scope** for this rebuild:
`diagnosis_model`, `remediation_model`, `reasoner_model` (used only as fallback
aliases by the stages above) and — used by other features, not the issue-agent
loop — `second_opinion_model` (`anthropic/claude-sonnet-4`, the related-problems /
second-opinion feature) and `cluster_model` (the analyzed-problems clustering).
See §8.2 for exactly what the migration may and may not touch.

**Must read settings via `createAdminClient()` (service role)** — the background
worker has no user session; the session client returns `{}` under RLS, silently
falling back to defaults. Keep this.

**Loop / workflow (the layer the rebuild must thread through):** `runIssueAgent`
while `cycles < 8`; job queue `issue_jobs`; `ISSUE_WORKER_MODE` `inline`
(drains 3/req) or `background` (`issue-worker.mjs` polls
`/api/internal/issue-worker/drain`, auth `ISSUE_WORKER_TOKEN`, 10/global);
cross-issue deps (`depends_on_issue_id`, `releaseDependentIssues`,
`maybeNudgeBlockingIssue` in `issue-workflow.ts`); approval gate (tier-2/3 need
`confirmed`/HMAC token, 15-min expiry, `buildApprovalToken`/`verifyApprovalToken`).
Issue statuses (the `issues.status` CHECK allows exactly these seven — verified):
`open / running / waiting_on_user / waiting_for_approval / resolved / stuck /
cancelled`. The rebuild adds one more, `waiting_on_issue` (§7). Issue data model:
`issues`, `issue_messages`,
`issue_evidence`, `issue_actions`, `issue_jobs`, `issue_state_transitions`,
`facts`, `fact_sources`, `issue_facts`, `capability_state`, `agent_memory`.

---

## 3. Target architecture — 3 stages

Each stage reads **(model, reasoning/effort)** from config (§8). Caching (§9)
makes the strong middle stage affordable. Stage 2's invariants — **bounded,
resumable, cache-independent** — are defined in §5/§7/§9.

### §3.1 Stage 1 — Lossless Structurer (deterministic, no model call)

#### What this stage is doing

Stage 1 is a deterministic data transformation pipeline — it makes **no model calls**. Its job is to convert raw Supabase telemetry into a structured, deduplicated, prioritised evidence store that Stage 2 can reason over without drowning in noise or losing signal. The core insight driving the design: the old `compressLogsToFacts` threw away information before Stage 2 ever saw it, silently hiding anomalies behind summaries. Stage 1 is the antidote — nothing distinct is discarded, but repetition is collapsed and the volume is managed before hitting a prompt. Think of it as a lossless event recorder followed by a smart index, not a summariser.

The stage does five things in order:

1. **Ingest.** Query Supabase across all telemetry source tables for the issue's time window. Gather every row and tag each with its evidence source label (see table below).

2. **Deduplicate.** For each `(source, body)` pair, collapse byte-identical rows into one row with `dedup_count` tracking occurrence count and `first_ts`/`last_ts` spanning the range. Two rows are identical only if their entire bodies are the same — paraphrase-similar rows are never merged. The goal is to eliminate "same thing 4,000 times" noise without ever hiding a structurally different event.

3. **Classify: anomalous.** Mark each row `anomalous=true` if severity is `error` or higher, OR if severity is `warning` and the body contains at least one state-change keyword: `failed`, `error`, `timeout`, `degraded`, `offline`, `crash`, `panic`, `rejected`, `aborted`, `stopped`, `restart`, and a few dozen more. The keyword list is conservative — false negatives (missed anomaly) are worse than false positives (extra rows in the priority tier).

4. **Classify: in-scope.** Mark each row `in_scope=true` if the row's `nas_id` matches `issue.affected_nas`, OR severity is `error+`, OR the issue has no explicit `affected_nas`. The purpose: cross-NAS noise that is merely informational stays in the evidence store but ranks lower in the budget allocation.

5. **Budget and persist.** Allocate `EVIDENCE_TOKEN_BUDGET = 12,000 tokens` (≈48,000 chars) across two tiers. Tier 1 (70% of budget): in-scope anomalous rows, full bodies, sorted by descending severity then recency. Tier 2 (30%): everything else as dedup-with-count one-liners. The evidence index (source × time-bucket × count summary) is always included and does not count against the budget — it is Stage 2's map of what else exists and how to fetch it. Delete existing `issue_evidence_items` rows for the issue before inserting — Stage 1 is idempotent and safe to re-run.

**Telemetry sources ingested** (`TELEMETRY_SOURCES` constant):

| Source key | Evidence source label | Why it matters |
|---|---|---|
| `alerts` | `alert` | Active alert severities; the primary issue-detection signal |
| `logs` / `audit_logs` | per-DB `source` field | Raw DSM log lines; the richest free-text signal |
| `top_processes` | `process_snapshot` | CPU/mem/IO hotspots; used to attribute resource contention |
| `disk_io` | `disk_io` | Per-device IOPS, throughput, latency, utilisation, queue depth |
| `scheduled_tasks_with_issues` | `scheduled_task` | Failed/overdue DSM tasks; often the root cause of backup/sync failures |
| `backup_tasks` | `backup_task` | Hyper Backup task status and timing |
| `snapshot_replicas` | `snapshot_replica` | Replication job status and error codes |
| `container_io_top` | `container_io` | Per-container I/O attribution; separates agent I/O from Drive I/O |
| `sharesync_tasks` | `sync_task` | ShareSync pair status, error codes, pending item counts |
| `io_pressure_metrics` | `io_metric` | Aggregate iowait and pressure over time |
| `storage_snapshots` | `storage_snapshot` | Space snapshot timeline; detects runaway growth |
| `dsm_errors` | `dsm_error` | Structured DSM error events from the system journal |

**Evidence body construction (losslessness).** For log-type rows (`logs`, `audit_logs`, `dsm_errors`) the per-DB `source` field is the evidence source label and the `message` field is the body. For all other structured rows the body is the full JSON serialisation via `stableJson`, which strips only the top-level `metadata` key (fields already promoted to evidence columns) to avoid duplication without hiding data.

**Overflow rule.** If the priority tier alone exceeds its 70% budget, include the full evidence index plus as many full bodies as fit, highest-priority first. Never silently drop bodies — the index ensures Stage 2 can always retrieve omitted items via `fetch_evidence`.

#### Why there is no model call here

Using a model to compress logs before the reasoner is the original defect (§1b). Stage 1 is deterministic because lossy compression is the enemy of diagnosis: a summarising model decides what matters before the reasoning model has formed a hypothesis, so it inevitably discards the evidence that falsifies the wrong hypothesis. The structurer's job is to preserve and organise, not to interpret. There is no interpretation task here that benefits from a model.

---

### §3.2 Stage 2 — Reasoning Core (strong model, agentic loop, resumable)

#### What this stage is doing

Stage 2 is the diagnostic mind of the pipeline. Its goal is to determine what is wrong with one or both Synology NAS units, why it is wrong, and either propose a safe remediation or produce a definitive "we can't fix this without operator input / more information" verdict. It does this by forming and iteratively testing hypotheses using a combination of stored telemetry and live NAS data, in the same way an expert engineer would reason through an incident with an SSH session and the logs in front of them.

This is not a summarisation task, not a question-answering task, and not a classification task. It is **iterative multi-hypothesis investigation under uncertainty**, using active data gathering to rule hypotheses in or out. The model must:

- Read a structured evidence slice and extract the meaningful signal — differentiating genuine anomalies from background noise and from DSM quirks that look like errors but are normal (e.g. the scheduled-task DSM error 103 on edgesynology1 that is a known blind spot, or the `container_status` CPU/mem always showing 0).
- Commit to a ranked hypothesis rather than hedging across all possibilities. Vague "it could be X or Y" turns are useless — the model should state its working hypothesis with a confidence level and identify the single most diagnostic piece of evidence it would need to confirm or refute it.
- Choose tools precisely. The 100+ curated predefined tools plus `run_command` and `fetch_evidence` give the model direct read access to nearly everything on the NAS. A poor model will spam tools randomly or re-run tools it already called. A good one will identify the exact file path, counter, or service log that would distinguish between two plausible root causes, call that one tool, read the result, and update its hypothesis.
- Know when it has enough. The model must recognise when the evidence is conclusive and stop gathering, rather than continuing to call tools to fill the turn cap. Premature stops and unnecessary loops are both failure modes.
- Respect tier boundaries. Write-capable commands are hard-blocked by the NAS validator. When a fix is warranted, the model proposes it as a structured remediation for operator approval — it does not attempt to execute the fix itself.
- Degrade gracefully when the NAS is offline. If `withNasReachability` returns `nas_unreachable`, the model must pivot to diagnosing from the stored evidence only via `fetch_evidence` and communicate to the operator what it can and cannot determine without live access.
- Know when to ask the operator. Some issues require context only a human has (is this backup expected to take 6 hours? is that ShareSync pair intentionally paused?). The model must recognise these cases and ask a specific, answerable question rather than producing a vague escalation.

One job invocation = one turn. Turns are bounded by `TURN_CAP = 8`. The process dies at every approval/user gate and may resume in a different worker after arbitrary time; Stage 2 must be fully resumable from DB state only (§7).

#### The investigation flow across turns

A well-behaved investigation across up to 8 turns typically follows this shape:

- **Turn 1 — Orient.** Read the evidence slice. Identify the highest-severity events, cross-reference with the whole-system snapshot (other open issues, NAS reachability, active alert counts). Form an initial ranked hypothesis list (usually 1–3 candidates). Pick the single most discriminating test and call exactly that tool or `fetch_evidence` aggregate query. Produce `decision=continue` with the current hypothesis and a brief rationale.
- **Turns 2–4 — Test and narrow.** Each turn: evaluate the new tool result against the hypothesis. If the result is consistent with hypothesis A and inconsistent with hypothesis B, update the hypothesis confidence and move to the next discriminating test. If the result is ambiguous, choose a more targeted follow-up. Tools called in earlier turns are already in `issue_evidence_items` and will appear in the evidence slice on the next turn — do not re-call a tool that already returned a result.
- **Turn N (diagnosis confident) — Produce verdict.** Once the evidence is conclusive: either `propose_remediation` (with a specific action, tier, rationale, and expected outcome) or `conclude_stuck` (with a clear statement of what is known, what is unknown, and what operator action is needed). Do not continue gathering evidence after the hypothesis is settled.
- **Turn N (needs operator input) — Ask precisely.** If the investigation hits a decision point requiring human context, produce `ask_user` with a specific, single-sentence question. Do not ask multiple questions at once; each approval/ask cycle costs operator attention.

The re-chew guard enforces forward progress: if the evidence slice hash and the planned action are identical to the prior turn (nothing new was learned, nothing new was proposed), the repeat counter increments. After ≥ 2 consecutive identical turns, the outcome is overridden to `ask_user` automatically, because the model is stuck without saying so.

#### Prompt structure (strictly stable→dynamic for cache correctness, §9)

Every turn rebuilds the full prompt from DB state. The ordering is non-negotiable for cache hit rates:

1. `[stable]` System prompt — role definition, operating rules, tier policy, tool inventory summary with usage guidance for `fetch_evidence`, `run_command`, and predefined tools
2. `[stable]` Output schema — the exact JSON decision format the model must produce
3. `[stable]` NAS taxonomy — the known issue families (ShareSync metadata corruption, sync-failure, Drive-not-ready, backup-failure, I/O pressure, etc.), DSM blind spots (error 103, container_status zero values, etc.), known NAS hardware profiles
4. `[semi-stable]` Whole-system snapshot — NAS reachability result from 3s `nas-api /health` probe, active alert counts by severity over 6h, list of open/running sibling issues with titles
5. `[semi-stable]` Issue summary — title, severity, status, affected NAS, current hypothesis field, any operator constraints from prior messages
6. `[dynamic]` Evidence slice — the prioritised budget-managed output of Stage 1, rebuilt on every turn as new `issue_evidence_items` rows (tool results) are appended
7. `[dynamic]` Prior transcript — loaded from `issue_messages` (cap: 60 messages); `role=agent` → `"assistant"`, `role=system` → prefixed `"[system] …"` user turn
8. `[dynamic]` Per-turn instruction — one of: initial investigation prompt, re-chew warning (evidence unchanged, change your approach), or respond-to-user (operator replied)

**Tool catalog (all tier-1, auto-execute):**

| Tool | What the model uses it for |
|---|---|
| `fetch_evidence` | Reading the full lossless evidence store beyond what fits in the slice. The model should aggregate first (`group_by: source` or `group_by: time_bucket`) to see the shape of the data before paging into raw rows. Runs against Supabase, not the NAS — always available even when the NAS is offline. |
| `run_command` | Free-form read-only shell command on a specific NAS target: `cat /proc/mdstat` (RAID state), `cat /sys/block/md5/inflight` (live I/O gauge), `tail -n 200 /var/log/kern.log`, `cat /proc/net/dev`, etc. For situations where no predefined tool covers the exact file or command needed. Write commands are hard-blocked by the NAS validator regardless of what the model requests. |
| Predefined tools (100+) | Curated read-only diagnostic commands covering SMART health, BTRFS scrub/device status, ShareSync task detail, Hyper Backup job logs, Docker container state, top-process snapshots, network interface stats, package health, filesystem health, kernel I/O errors, and more. The model should prefer these over `run_command` when they cover the query, because they have tuned timeouts, known output formats, and tested behaviour. |

Every tool result is persisted to `issue_evidence_items` immediately after execution. The evidence slice on the next turn will include these new rows, which means the re-chew fingerprint changes and the model is working from a genuinely larger evidence base.

#### What model capabilities this stage requires — and which matter most

Stage 2 is the most capability-demanding model call in the pipeline. The right model for this stage has:

**Strong multi-step reasoning (critical).** The model must hold a hypothesis, identify what would falsify it, select the right tool call, evaluate the result against the hypothesis, and update its belief — across up to 8 turns, with a growing context. This requires genuine systematic reasoning, not pattern-matching to a likely answer. Models that produce fluent-sounding responses without real logical chains will confidently propose wrong remediations. Extended thinking / chain-of-thought modes directly improve performance here: the harder the issue (multi-causal, rare DSM behaviour, cascading RAID + sync + backup failure), the more the model benefits from spending tokens on internal reasoning before producing its output. For Anthropic models, `extended_thinking` with a meaningful `budget_tokens` value is recommended for this stage. For OpenAI reasoning models, `reasoning_effort: 'high'`.

**Tool use reliability (critical).** The model must call tools with correct schema adherence on every turn. Incorrect parameter types, missing required fields, or hallucinated tool names cause the executor to return errors, wasting turns. Models with strong native function-calling (not prompting-based tool use) are required. Tool-call accuracy should be tested explicitly during model selection — a model with 95% per-call accuracy fails 40% of 8-turn investigations.

**Long-context coherence (important).** By turn 5–6 the context may be 20,000–40,000 tokens: the stable prefix, the full evidence slice, 4–5 prior turns of tool calls and results. The model must stay coherent over this context — remembering what it already called, what the results were, and what hypothesis it is currently testing. Models that lose track of their own earlier tool results and re-call the same tools waste turns.

**Calibrated self-knowledge (important).** The model needs to know what it does and does not know. Over-confident models produce definitive diagnoses from insufficient evidence; under-confident ones never reach a verdict and exhaust the turn cap hedging. The ideal behaviour is explicit: "my hypothesis is X at 85% confidence; the next tool call would confirm or rule it out; if the result is Y the answer is X, if Z I need to investigate further". Models that express well-calibrated uncertainty in their reasoning produce better stopping decisions.

**Structured output fidelity (important).** Every turn must produce a valid JSON object matching the output schema — hypothesis, confidence, decision type, and the relevant payload. The schema is non-trivial (nested, typed, conditional fields). Models that frequently produce malformed JSON or fill optional fields inconsistently require extra retry/repair logic that wastes turns and tokens.

**Instruction following under constraint (important).** The system prompt contains hard rules: never execute write commands, always propose tier-2/3 actions for approval, aggregate before paginating, do not re-chew evidence you already have. Models that reliably follow complex multi-rule instruction sets under the pressure of an active investigation (where the "obvious" next move might violate a rule) are strongly preferred.

**Domain familiarity with Linux storage and Synology DSM (helpful but compensatable).** The NAS taxonomy section of the prompt provides the known issue families and DSM blind spots explicitly. A strong general reasoner can work from this. However, a model with pre-training familiarity with `/proc/mdstat` format, BTRFS device status output, and Synology's log structure will recognise signal in tool output faster and make better tool-selection decisions. This is a secondary factor — a model that is weaker here but stronger on reasoning and tool use will outperform a domain-familiar model with poor multi-step reasoning.

**Properties that are NOT needed for this stage:**
- Creative writing or natural-language fluency — the output is JSON and a hypothesis string, not prose
- Large output generation — most turns produce 200–600 tokens of output; output length is not a bottleneck
- Web search or retrieval — the tool layer handles all data access; the model does not need to retrieve external knowledge
- Speed-optimised / low-latency serving — this is a background worker; a 30-second model call per turn is acceptable; correctness matters far more than throughput

**Recommended model tier:** A frontier reasoning model. Anthropic Claude Opus / Sonnet with extended thinking, OpenAI `o-series` with `reasoning_effort: high`, or Google Gemini with thinking config enabled. Do not use a fast/small model for this stage — the turn cap is 8, so the total cost is bounded, and a weak model burning through all 8 turns without reaching a diagnosis is more expensive than a strong model converging in 3.

---

### §3.3 Stage 3 — Explainer / Memory (cheap model, single-shot)

#### What this stage is doing

Stage 3 runs once, after Stage 2 reaches a terminal decision (`resolved` or `stuck`). It has two outputs with different audiences and different purposes:

**Output 1: Operator message.** A 2–5 sentence plain-language summary written for the owner of the NAS — a non-developer who understands that things broke but not why. The message must translate the investigation's technical findings into human terms: what happened, what caused it, what was done or proposed, and what to watch for next. The operator message is posted to `issue_messages` with `role="agent"` and appears in the dashboard as the final agent response.

**Output 2: Memory entries.** Up to 5 durable `agent_memory` records extracted from this issue's investigation. Each entry must be specific, non-obvious, and genuinely reusable — it should capture something that would meaningfully improve Stage 2's reasoning on a future issue of the same type. Generic observations ("ShareSync can fail") are not memory. Actionable specifics are ("edgesynology1's ShareSync metadata DB becomes corrupted after a hard power cycle; the symptom is error code 2006 in the sync log, not a generic sync-fail alert; the fix is a DB repair via the DSM package manager, not a restart").

The operator message and memory entries are generated in a single model call with a structured JSON output schema. Stage 3 is wrapped in `try/catch` in `pipeline-v2` — a Stage 3 failure must never fail or undo the issue resolution that Stage 2 already reached.

#### Context fed to Stage 3

- Issue fields: `title`, `severity`, `status`, `affected_nas`, `current_hypothesis`, `conversation_summary`
- Evidence highlights: `issue_evidence_items` filtered to `in_scope=true`, most recent 30 rows, body truncated to 300 chars each — enough for Stage 3 to ground the operator message in specifics without the full evidence set
- Action history: `issue_actions`, first 20 rows — what was actually done or proposed

Stage 3 does not receive the full multi-turn Stage 2 transcript. It receives the outcome and the curated highlights. The intent is that Stage 2 has already done the diagnostic work; Stage 3 is a communication and distillation layer, not a re-investigation.

#### Memory types (max 5 per issue)

Each memory entry must be assigned a type that describes what kind of knowledge it encodes:

| Type | What it records | Example |
|---|---|---|
| `nas_profile` | Persistent hardware or software characteristics of a specific named NAS unit that affect how to interpret its telemetry or how to interact with it | "edgesynology2's BTRFS scrub reliably triggers iowait spikes above 60% for the first 4–6 hours; this is normal for its disk configuration and should not be treated as a storage emergency unless accompanied by device errors" |
| `issue_pattern` | A recurring failure pattern that has a recognisable symptom signature and a known effective response | "ShareSync metadata corruption on either NAS always presents as error 2006 in the syncfolder log, not as a generic sync-fail alert, and persists through restarts until the DB is repaired; the repair procedure is X" |
| `calibration` | A threshold, baseline, or expected-value insight for a specific metric or alert type on this system | "The Hyper Backup job for the primary volume takes 4–6 hours on Sunday nights and routinely generates iowait warnings above the 20% threshold; these warnings during that window are not actionable" |
| `institutional` | Human-facing process, ownership, or escalation knowledge that the agent cannot derive from telemetry | "The owner does not want the Synology Drive package restarted during business hours (8am–6pm UTC+8) because client sync sessions are active; always propose an off-hours maintenance window for Drive package restarts" |

#### What model capabilities this stage requires — and which matter most

Stage 3 has almost opposite requirements from Stage 2. The task is communication and pattern distillation, not investigation. The model capabilities that matter are:

**Writing quality and register calibration (critical).** The operator message must be clear, jargon-free, and calibrated to a non-developer reader. The model must translate "BTRFS device had 3 uncorrectable read errors on /dev/sdb3 which caused ShareSync to abort with error 2006" into language the owner understands, without being condescending or losing the essential fact. Models with strong natural language output quality matter here; a model that produces technically accurate but stiff, jargon-heavy prose fails at the actual goal.

**Synthesis under compression (important).** Stage 3 receives a rich investigation transcript and must produce 2–5 sentences. Selecting which facts belong in those sentences — and which to omit without losing the essential meaning — is a non-trivial compression task. Models that reliably identify the most relevant causal chain and anchor the summary to it, rather than producing a generic "there was an issue and it was investigated" summary, are strongly preferred.

**Pattern extraction quality (important).** Memory entries are only useful if they are specific and durable. The model must distinguish between observations that are generalisable (and worth encoding as memory) and observations that are specific to this one incident's state at a point in time (which should not be encoded). A model that produces generic memory entries is producing noise. The quality test for a memory entry: would a fresh Stage 2 turn on a future issue of the same type make a materially better decision if it had this memory, versus not having it?

**Structured output fidelity (important).** The output schema includes both the operator message string and a typed array of memory entries. The model must produce valid JSON, correctly typed, with the right number of entries. The failure mode is malformed output or producing more than 5 memory entries of poor specificity.

**Properties that are NOT needed for this stage:**

- Multi-step reasoning or extended thinking — there is no hypothesis to test, no tool to call, no decision tree to navigate. The investigation is over; this stage just communicates it.
- Tool use — Stage 3 makes no tool calls. The `try/catch` wrapper exists precisely so that even if this stage fails completely, nothing breaks.
- Long-context coherence across turns — this is a single-shot call with a bounded, carefully selected context. The model does not need to track state across multiple turns.
- Domain expertise in Linux/storage — the evidence highlights provide the grounded facts; the model is translating them, not interpreting them.
- Reasoning effort controls — do not waste `extended_thinking` budget or `reasoning_effort: high` tokens here. The task does not benefit from deeper reasoning; it benefits from better writing.

**Recommended model tier:** A capable but fast and inexpensive model. Claude Haiku, GPT-4o-mini, Gemini Flash, or similar. The operator message quality difference between a frontier model and a good mid-tier model is small for this task; the cost and latency difference is large. Because Stage 3 is wrapped in `try/catch` and its failure is non-fatal, a cheaper model with occasional output quality variation is an acceptable tradeoff.

---

## 4. What was fixed 2026-05-29 (don't regress; data is reliable now)

The rebuild assumes complete, fresh ingestion (memory note
`db-partman-and-ingestion-state`):
- **Ingestion stall** — brittle `smon_logs/alerts_source_check` whitelists rejected
  ~13 log sources + ShareSync alert sources; PostgREST batch-inserts meant one bad
  row failed the whole batch → dropped after 5 retries → logs froze 19h, alerts
  23d. Fixed: migration 00035 dropped the whitelists; the agent stops emitting
  `"filter"` severity; the WAL sender isolates a poison row
  (`apps/agent/.../sender.go postRows`). **Do not re-add a source whitelist; do not
  revert to all-or-nothing batches.**
- **pg_partman** — re-pointed config to renamed parents, drained the backlog,
  restored retention/premake, reclaimed 3.34 GB.

---

## 5. Context budget & evidence retrieval (resolves the "lossless vs. window" tension)

"Lossless" applies to the **persisted evidence store**, not to a single prompt. A
model context is bounded and priced per token regardless of how cheap disk is.

- **Persist, don't inline.** Stage 1 writes the full deduped evidence set to the DB
  (extend `issue_evidence`/`facts`, or a new `issue_evidence_items` table keyed by
  `issue_id` with `(source, ts, severity, body, dedup_count)`). Nothing distinct is
  dropped.
- **Bounded slice into Stage 2.** Stage 2's prompt carries only a prioritized,
  budgeted slice: (a) all in-scope + anomalous events in full, (b) dedup-with-counts
  summaries for high-volume noise, (c) an **index** of what else exists (source ×
  time-bucket × count). Define an explicit `EVIDENCE_TOKEN_BUDGET` for this block.
- **Retrieval-by-ID for the rest — bounded, aggregable, paginated.** Provide a
  `fetch_evidence` tool (§6) so Stage 2 pulls more detail on demand instead of
  pre-loading it (the same mechanism as live NAS tools — the agent decides what it
  needs, like an SSH session). The schema MUST be safe against a cascade that
  produces tens of thousands of rows:
  - **server-side hard caps** — `limit` is clamped to a max (e.g. 100) *regardless*
    of what the model requests, and a bounded `start_time`/`end_time` is required;
  - **byte cap on the result, not just rows** — one pathological log line can blow
    the budget at a single row, so cap total result bytes and truncate row bodies
    in the *result*;
  - **a cursor** — return `has_more` + `next_offset` + total match count so the
    model knows more exists (never silent truncation) and can paginate;
  - **aggregation mode** — support count/group-by queries (`group_by: source |
    error | time_bucket`) so the agent sees the *shape* of 50k lines cheaply
    instead of brute-forcing through them. This is what keeps the cap from blunting
    effectiveness: an expert greps-and-counts rather than `cat`-ing everything, and
    a model can't reason over 50k raw lines in one prompt anyway. The prompt
    instructs the model to aggregate first, then page into specifics.
- **Overflow rule.** If even the prioritized in-scope set exceeds the budget,
  include the index + a representative sample and rely on `fetch_evidence`; `log()`
  / record that truncation happened so it's visible, never silent.
- **Keep the cached prefix lean.** Evidence is **dynamic** (per-issue, per-turn) and
  belongs in the dynamic suffix, never in the cached prefix (§9). The cacheable
  region is system + tool schemas + output schema + taxonomy; the whole-system
  snapshot is semi-stable (cache within an issue).

---

## 6. Tool integration boundary (decision, not an option)

Stage 2 needs the curated catalog, which is *machinery* — lazy discovery,
`tools-config.json` gating, approval previews, tuned timeouts — not a command list
(`apps/nas-mcp` README + `architecture.md`).

**Decision: share the definitions, execute in the web app. Do NOT route Stage 2
through nas-mcp.**

- **Single source of tool definitions** → move them into `packages/shared` (name,
  tier, params/schema, group, `buildCommand`, enable flag). Both `apps/nas-mcp` and
  `apps/web` import from there. This removes the current duplication
  (`nas-mcp/tool-definitions.ts` ~108 vs `web/.../tools.ts` ~42); the cost is one
  shared module to keep in sync, which is the point of the package.
- **Stage 2 executes directly** through the web app's existing `nas-api-client.ts`
  + approval/HMAC/tier machinery (`buildApprovalToken`, tier preview). It does
  **not** call nas-mcp's `tool_search`/`invoke_tool` lazy-load surface — that
  indirection exists for token-starved chat clients; an autonomous agent should
  hold real tool schemas directly (Stage 2's prompt budget is managed in §5/§9, not
  by hiding tools).
- **Reuse, don't reinvent:** enable/disable gating (a `tools-config`-equivalent),
  tier classification + approval preview, and the 8s/25s/45s timeout discipline all
  move with the shared definitions or are reused from the web app's NAS client.
- **Server-runtime only (enforce by package boundary / lint, not a Next.js
  marker).** The shared defs include `buildCommand` shell templates and must be
  imported only from server runtimes — `apps/web` *server* code and `apps/nas-mcp`
  — never from client components. Because the package is also consumed by a
  plain-Node app (nas-mcp), do **not** lean on a Next.js-only `import 'server-only'`
  marker; enforce it with package boundaries / lint rules / code review. (Not
  secret — they're in the repo — but they have no business in the client bundle.)
- `apps/nas-mcp` keeps consuming the same shared definitions for its chat clients;
  its lazy-load surface is unchanged (that's an intentional quirk — see AGENTS.md).

**Build-system cost of sharing (own it, don't gloss it):** moving the definitions
(and any `tools-config`-equivalent gating) into `packages/shared` is not free in
this monorepo:
- `web-image.yml` already builds from the repo root and already watches
  `packages/shared/**` — web is fine.
- **`nas-mcp-image.yml` builds with `context: ./apps/nas-mcp`**, so it currently
  *cannot see* `packages/shared` at all, and its `paths:` filter does **not**
  include `packages/shared/**`. To share, you must (a) change the nas-mcp build
  context to the repo root + update `apps/nas-mcp/Dockerfile`, and (b) add
  `packages/shared/**` to `nas-mcp-image.yml`'s `paths:` — otherwise a shared-tool
  edit silently rebuilds web but **not** nas-mcp, and the config change never
  reaches production.
- This is **required migration work, not an open architectural question** — the
  decision (top of §6) is to share. The build-context move + `paths:` change above
  are part of that migration. Sharing removes the current ~108-vs-42 duplication;
  the one-time build change is simply its cost.

---

## 7. Workflow, approval & resume state machine

Collapsing four stages into one loop must not break the existing job/approval
layer. The process **dies at every approval/user gate** and may resume in a
different worker after the cache TTL lapses, so:

**Invariant: Stage 2 is resumable from DB state only — never from in-memory loop
state or a warm cache.**

- **A Stage-2 "turn"** loads issue state, rebuilds the prompt from the persisted
  transcript (issue_messages/evidence) + the bounded evidence slice, runs the
  model (with tool calls for read-only data), and ends in exactly one terminal:
  | Turn outcome | DB effect | Status set | Next |
  |---|---|---|---|
  | needs tier-2/3 action | persist the action **intent** (tool name + tier + args + command preview) + transcript — **never the HMAC token** | `waiting_for_approval` | return; operator decides |
  | needs operator input | persist question + transcript | `waiting_on_user` | return |
  | read-only diagnostic only | persist tool results to evidence + transcript | `running` | enqueue next `run_issue` job (bounded by cycle cap) |
  | blocked on another issue | persist `depends_on_issue_id` | `waiting_on_issue` (**new** — added below) | `releaseDependentIssues` re-queues |
  | done | persist verdict | `resolved` / `stuck` | Stage 3 |
- **Approval resume — mint the token at execution time, never persist it.** The
  HMAC approval token expires in 15 minutes, but propose→approve can be hours, so a
  persisted token would be expired on resume and nas-api would return 403. Persist
  only the intent (row above). On approval, an `approval_decision` job is enqueued;
  the resumed Stage-2 turn re-enters with the persisted transcript + approved
  intent, **mints a fresh HMAC token immediately before the nas-api call**, executes,
  then **verifies in the same loop** (the next turn evaluates the result —
  verification is not a separate stage). The 15-min window then bounds only
  exec→exec (seconds), never the operator's think time.
- **NAS unreachable / Tailscale down — degrade, don't hang.** Live tools reach
  nas-api only over Tailscale; if the daemon/NAS is down, every call throws
  `ECONNREFUSED`. Handle this in **code, not just the prompt**: the tool layer
  retries once, then returns a structured `nas_unreachable` result (not a raw
  exception), and the whole-system snapshot carries a reachability flag. `fetch_evidence`
  reads **Supabase**, not the NAS, so it still works — the agent falls back to
  diagnosing from stored telemetry and tells the operator the NAS appears offline.
  Operator-facing UX: a periodic `GET /health` probe against nas-api drives an
  **Offline Mode** in the dashboard — live-action controls are disabled and an
  "NAS offline" badge is shown, so operators aren't left clicking actions that will
  fail. (Read-only views and `fetch_evidence`-backed diagnosis stay available.)
- **Re-entry safety:** because the transcript is the source of truth, a resumed
  turn reconstructs identical context (cache hit if within TTL, cache miss = cost
  only, never a correctness change). `hasAlreadyTried` is replaced by the re-chew
  guard (§3) operating over the persisted transcript.
- Keep `issue_jobs`, the job types, the cycle cap (rename to a turn cap), and the
  `stuck` guard. Map the four old stages' status transitions onto the table above.
  This introduces **one new status, `waiting_on_issue`** — the current
  `issues.status` CHECK allows only the seven in §2 (verified against the DB), so
  the workflow migration must add `waiting_on_issue` to that CHECK. (Cross-issue
  blocking exists today via `depends_on_issue_id`/`releaseDependentIssues` but
  without a dedicated status.)

---

## 8. Config: stages, migration key-map, capability matrix

### 8.1 Three stages, two controls each
Admin Settings shows **exactly 3 stages**, each with **model** + **reasoning/effort
level** controls (consolidating today's 7 stage keys → 3). The operator's choice
is read at runtime and overrides everything — but "operator-driven" does **not**
mean "no defaults": **each stage keeps a hardcoded final-fallback (model, effort)**
at the end of its chain, read via `createAdminClient()`, so an empty/unconfigured
`ai_settings` (cold boot) still runs instead of crashing. "Nothing hardcoded" means
the operator can always override, not that defaults are removed. Each stage row
also has a **copy-spec button** (no
on-screen text) that copies an AI-optimized stage description (purpose, exact
inputs, output schema, required capabilities, current model) for asking an external
model "what fits this stage?". Files: `settings/page.tsx`, `api/settings/route.ts`
(key whitelist), `api/models/route.ts` (catalog). Read via `createAdminClient()`.

### 8.2 Migration key-map (explicit in-scope vs untouched)
The 7→3 migration must be a precise mapping, not a blanket "delete old keys":

| New stage key | Replaces (migrate values from) |
|---|---|
| `stage_structurer_model` / `_effort` | `extractor_model` |
| `stage_reasoning_model` / `_effort` | `hypothesis_model`, `planner_model`, `remediation_planner_model`, `verifier_model` (+ `reasoner_model` alias) |
| `stage_explainer_model` / `_effort` | `explainer_model`, memory (`consolidateIssueMemory`) |

**Must remain untouched** (not part of the issue-agent loop — verify consumers
before any change): `second_opinion_model`, `cluster_model`. Fallback-alias keys
(`diagnosis_model`, `remediation_model`, `reasoner_model`) may be removed only after
confirming no remaining reader. The migration whitelists exactly the keys it
rewrites and leaves everything else intact.

**Cold-boot defaults must survive the migration.** Today the fallback chains end in
hardcoded defaults (`openai/gpt-5.4`, `minimax/minimax-m2.7`) so an empty
`ai_settings` doesn't crash the pipeline. Preserve that: keep a hardcoded
final-fallback per new stage in `ai-settings.ts`, set to a model+effort appropriate
to the new provider lineup, **and/or** have the migration seed `ai_settings` with
sane defaults so a fresh environment boots before anyone opens the admin UI. Do not
read "nothing hardcoded" (§8.1) as license to delete these.

### 8.3 Provider capability matrix (effort is not universal)
"Effort" has a different shape per provider, and tool-use / structured-output
support differs. Define a descriptor per `(provider, model)`:

| provider | effort control | tool use | structured/JSON | cache |
|---|---|---|---|---|
| Anthropic | extended thinking `budget_tokens` (temp must = 1) | yes | yes (tools/JSON) | explicit `cache_control` |
| OpenAI | `reasoning_effort` (enum) on reasoning models | yes | yes | automatic prefix |
| Gemini | thinking config | yes | yes | implicit + explicit |
| DeepSeek | reasoner is a **separate model** (not a knob) | varies | varies | automatic prefix |
| Qwen/DashScope | varies by model | yes (OpenAI-style) | yes | markers + session id |

Rules: the admin **effort** control is enabled/populated from the selected model's
descriptor; if a model has no effort knob, the control is disabled and the provider
client **omits the parameter** (maps the abstract level to that provider's shape or
no-ops). A stage's required capabilities (tool use for Stage 2, JSON for all) gate
which models are even offered. This descriptor also feeds the copy-spec button.

---

## 9. Caching — provider-native, correct, resume-safe

Hard-won production lessons (adapted from a system called "Oracle"). Principles +
gotchas, not copy-paste. The numeric thresholds are Oracle's tuning — **re-derive
against this app's pricing/reuse before trusting them.**

### 9.0 This app's answers to the prerequisite questions
- **Providers:** Anthropic, OpenAI, Google Gemini, DeepSeek, Qwen/DashScope (direct
  keys). **Remove OpenRouter from the inference path.**
- **Stable vs dynamic:** *stable* (cache target) = system instructions, tool
  schemas, output schema, NAS taxonomy. *Semi-stable* (per-issue) = whole-system
  snapshot, issue summary. *Dynamic* (every turn) = the bounded evidence slice
  (§5), tool-call results, the per-turn instruction, retry suffix. **Evidence is
  dynamic — never in the cached prefix.**
- **Single-shot vs multi-turn:** Stage 2 is **multi-turn** (the turn loop) — cache
  the prior-turns prefix. Stages 1 & 3 are single-shot but reused across many
  issues, so their stable instruction/schema prefix caches across calls.

### 9.1 Foundational decisions
1. **Provider-native SDKs** (`@anthropic-ai/sdk`, `openai`, `@google/genai`,
   DeepSeek's OpenAI-compatible SDK, DashScope) — **no** normalizing abstraction
   (no Vercel AI SDK) and **no** aggregator on the inference path. Aggregators erase
   per-provider cache usage fields; if you can't see cache reads/writes you can't
   tune. (An aggregator is fine for the model-catalog/pricing dropdown only.)
   **Wrap vs. flatten — the line that matters:** a thin per-provider client that
   standardizes *operational* concerns (timeouts, retries, error classification incl.
   `nas_unreachable`) is encouraged — that IS the "provider client" in §10 step 2.
   What's forbidden is a unifying layer that flattens the *request/response/usage*
   shape: each provider's native usage object and native cache controls
   (`cache_control`, retention, session id, `cachedContent`) must pass through
   untouched, or cache observability dies. Wrap the plumbing; never normalize the
   payload. This belongs in `apps/web`/`packages/shared` (where the agent runs), not
   in `apps/nas-mcp`.
2. **Stable-before-dynamic — enforced.** Order every prompt `[stable system] →
   [stable tools] → [stable schema] → [semi-stable taxonomy] → [whole-system
   snapshot] → [bounded evidence] → [dynamic instruction] → [retry]`. Build a
   **context compiler** that sorts blocks into this order and **throws** if a
   dynamic block precedes a stable one. One early dynamic token busts the cache for
   everything after.

### 9.2 Per-provider mechanics
- **Anthropic** — explicit `cache_control:{type:'ephemeral',ttl:'5m'|'1h'}`. Mark
  the last text part of the stable prefix; for Stage 2 mark the **penultimate**
  message so the latest turn stays dynamic and prior turns cache. Min cacheable
  ~1024 tok (Sonnet) / ~2048 (Haiku) — below that skip it. Usage:
  `cache_creation_input_tokens` (write), `cache_read_input_tokens` (read). Max 4
  breakpoints; 5m interactive / 1h batch. `temperature` must be 1 with extended
  thinking.
- **OpenAI** — automatic prefix cache (≥1024 tok); just keep the prefix stable.
  Tune `prompt_cache_retention: 'in_memory' | '24h'`. Usage:
  `prompt_tokens_details.cached_tokens`.
- **Gemini/Vertex** — implicit (`usageMetadata.cachedContentTokenCount`) + explicit
  `cachedContent` (billed hourly while alive). Explicit only when big+reused —
  Oracle heuristic `(≥25k tok AND ≥3 reuses) OR (≥100k AND ≥2)`; re-derive. Server
  min TTL 60s; 1h chat / 24h batch.
- **DeepSeek** — automatic disk-backed prefix cache; usage is DeepSeek-specific
  (`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`, **not** the OpenAI
  shape).
- **Qwen/DashScope** — OpenAI-style `cache_control` markers; for multi-turn, persist
  `previous_response_id` (without it the session cache resets every turn).

### 9.3 Breakpoints per stage
- **Stage 1 / 3 (single-shot, reused):** stable instructions+schema prefix first;
  Anthropic one breakpoint at its end (if ≥ min size); OpenAI/DeepSeek automatic.
- **Stage 2 (multi-turn):** stable+semi-stable region is the cacheable prefix;
  Anthropic breakpoint on the penultimate message; OpenAI/DeepSeek automatic; Qwen
  persist `previous_response_id`.

### 9.4 Cache correctness under resume (ties to §7)
The cache is **never** load-bearing. Stage 2 rebuilds its prompt from the persisted
transcript on every turn/resume; a hit saves money, a miss costs money, neither
changes behavior. Do not store conversation state only in a provider session — a
resumed turn (new process, expired TTL) must reconstruct identical context from the
DB. Derive a `stable_prefix_hash` from the stable blocks for reuse keys; the
stable-before-dynamic ordering is what makes that hash meaningful.

### 9.5 Observability & explicit-cache lifecycle
- Normalize every provider's usage into one struct `{ inputTokens, outputTokens,
  cachedInputTokens, cacheWriteTokens, reasoningTokens }` with a per-provider
  normalizer (incl. DeepSeek's + Gemini's non-standard fields); persist normalized
  **and** raw usage. Track `cache_hit_ratio = cachedInputTokens / inputTokens` — an
  un-normalized provider silently reads 0%.
- If explicit Gemini caches are used, track them in a `provider_cached_content`
  table (`source_hash`, `expected_reuse_count`, `hard_expiration_at`,
  `cleanup_owner`, `status`); status changes via a `recordCacheTermination()`
  helper; CHECK constraint `deleted_at IS NULL iff status='active'`; delete in a
  `finally` when no follow-up. In-memory tracking leaks billing across worker/web
  processes.

### 9.6 Mistakes not to repeat
Normalizing SDK → lost observability. A doc-cache optimization collapsed multi-turn
history → broke conversation. Process-local cache tracking → leaked caches. Qwen
session id not persisted → cache reset each turn. Un-normalized usage field → 0%
dashboard.

### 9.7 CI guards (silent failures)
Hard blockers in the build command: (1) stable-before-dynamic ordering (the context
compiler throws); (2) Stage-2 multi-turn history is preserved through any caching
path; (3) every provider's cache usage field is normalized.

---

## 10. Build order (foundation → stages → workflow → UI → cleanup)

1. **Config layer** — 3-stage `model`+`effort` keys, the **capability matrix**
   (§8.3), and the explicit **7→3 key-map migration** (§8.2) that leaves
   `second_opinion_model`/`cluster_model` intact.
2. **Provider client + caching core** — native SDKs (§9.1), the **context
   compiler** (throws on bad ordering), per-provider cache breakpoints + effort
   mapping (§8.3/§9.2–9.3), normalized usage + persistence (§9.5), CI guards (§9.7).
3. **Evidence store + Stage 1** — persist the full deduped evidence (§5); Stage 1
   emits the bounded prioritized slice + index. Add the `fetch_evidence` tool.
4. **Workflow/state-machine refactor** — make a Stage-2 "turn" resumable from the
   DB and map its terminals onto `issue_jobs` + statuses + approval tokens (§7).
   Do this **before** Stage 2 logic so the loop has a correct skeleton.
5. **Stage 2 — reasoning core** — cached bounded context + shared tool catalog via
   `nas-api-client` (§6) + whole-system snapshot + re-chew guard, persisting the
   transcript each turn; verification is a turn, not a stage.
6. **Stage 3 — explainer/memory.**
7. **Admin UI** — 3 stages × (model, effort gated by §8.3) + copy-spec button +
   `cache_hit_ratio` view + a NAS **Offline-Mode** indicator that disables
   live-action controls when the nas-api `/health` probe fails (§7).
8. **Cleanup** — remove the old 7-stage code, the OpenRouter inference path, and
   retired alias keys (only after confirming no readers); keep non-stage keys.

---

## 11. Key files
- Loop/gather: `apps/web/src/lib/server/issue-agent.ts`,
  `issue-workflow.ts`, `workflow-store.ts`, `issue-store.ts`
- Model calls/stages: `issue-stage-models.ts`, `minimax.ts`, `model-json.ts`,
  `ai-settings.ts`, `backend-findings.ts`
- Tools (→ share into `packages/shared`): `tools.ts`, `nas-api-client.ts`;
  source catalog: `apps/nas-mcp/src/tool-definitions.ts`, `tools-config.json`
- Evidence/forensics: `fact-store.ts`, `forensics-drive.ts`, `forensics-hyperbackup.ts`
- Detector (scope source): `issue-detector.ts`
- Settings UI/API: `app/(dashboard)/settings/page.tsx`, `app/api/settings/route.ts`,
  `app/api/models/route.ts`
- Supabase clients: `lib/supabase/{admin,server}.ts` (use `admin` for the worker)
- DB: `supabase/migrations/` (settings key-map; evidence store; optional
  `provider_cached_content`)

---

## 12. Constraints & gotchas
- One branch `main`; commit + deploy via main→Actions→Coolify (web auto-redeploys
  on `apps/web/**`). Top-level `*.md` triggers no build.
- **New provider keys** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`/
  Vertex creds, `DEEPSEEK_API_KEY`, `DASHSCOPE_API_KEY`) must be added in
  **Coolify** before that provider works in prod. Today only `OPENROUTER_API_KEY`/
  `OPENAI_API_KEY` are configured; the rest are net-new. Stages 1/3 can build
  before keys exist; Stage 2 (Anthropic) needs its key live.
- Keep the operator approval gate for tier-2/3 actions intact.
- Read `ai_settings` via `createAdminClient()` in the worker.
- Known DSM blind spots — never read empty as healthy: `container_status` CPU/mem
  always 0 (use `container_io`); `scheduled_tasks` DSM error 103 on edgesynology1;
  some snapshot-replication APIs unsupported. Log-derived fields are regex-parsed
  (categorizations imperfect; raw text faithful).
- Secrets: leaked creds remain in git history and need rotation (separate task).

---

## 13. Open items deferred to the coder
- Exact new settings-key names (the §8.2 names are a proposal) + the migration SQL.
- The evidence-store schema (extend `issue_evidence`/`facts` vs a new table) and the
  `EVIDENCE_TOKEN_BUDGET` value.
- Whole-system snapshot shape (useful but lean enough to keep the prefix cacheable).
- Re-chew fingerprint definition (hash over the evidence slice + planned action).
- **Re-derive caching thresholds** (min cacheable size, Gemini explicit 25k/3·100k/2,
  TTLs) against this app's real pricing + reuse counts.
- Confirm consumers of `second_opinion_model` / `cluster_model` before the cleanup
  step touches anything.
- Whether to keep an aggregator purely for the model-catalog dropdown.
- `fetch_evidence` exact schema: the hard `limit` max, the byte cap, and whether the
  aggregation mode is a separate tool or a `group_by` param (§5).
- The new `waiting_on_issue` status: the exact migration that extends the
  `issues.status` CHECK (§7). (The nas-mcp build-context + `paths:` change for tool
  sharing is decided and lives in §6, not here.)
