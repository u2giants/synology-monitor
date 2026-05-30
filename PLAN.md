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

### Stage 1 — Lossless Structurer (cheap, low effort, single-shot)
- Replaces `compressLogsToFacts`.
- Input: raw telemetry for the issue window (sources in §1a).
- Job: **remove only exact repetition/noise; keep every distinct event in full.**
  Collapse byte-identical lines into `{line, count, first_ts, last_ts}`; group by
  source/time; normalize for token efficiency; **never truncate or summarize a
  distinct event, never drop fields.**
- Output: the **persisted** structured evidence set (see §5 for where it lives and
  how Stage 2 consumes a bounded slice of it). Raw detail is retained and
  retrievable — not discarded as today.

### Stage 2 — Reasoning Core (strong, high effort, cached, live tools, resumable)
- Consolidates hypothesis + planner + remediation_planner + verifier into one
  agentic loop.
- Prompt structure (stable→dynamic, §9): system prompt → tool schemas → output
  schema → NAS taxonomy (issue families, `capability_state`, DSM blind spots) →
  **whole-system health snapshot** → issue summary/history → **bounded evidence
  slice** (§5) → per-turn instruction.
- Capabilities:
  - **Live tools on demand** via the shared catalog (§6): read-only tier-1 freely;
    tier-2/3 through the operator approval gate (§7). Includes `fetch_evidence`
    (§5) to reach the rest of the persisted lossless evidence, and live NAS reads.
    Live NAS reads need Tailscale; if it's down the agent degrades to Supabase-only
    diagnosis via `fetch_evidence` and flags the NAS as offline (§7).
  - **Whole-system view** + sibling/correlated-issue visibility — can widen scope.
  - **Re-chew guard** — fingerprint (evidence slice + tool results + planned
    action) each turn; if unchanged and repeating, STOP and switch to "what's
    missing": fetch more evidence, run a new diagnostic, escalate, or ask the
    operator.
- Outputs per turn: hypothesis+confidence, and exactly one of {diagnostic action,
  remediation proposal, user question, terminal verdict}. Verification after an
  executed action is **just the next turn of the same loop**, not a separate stage.
- **Resumable**: every turn persists its transcript to the DB; the process dies at
  each approval/user gate and resumes from DB state (§7). The cache is an
  optimization only (§9).

### Stage 3 — Explainer / Memory (cheap, low effort, single-shot)
- Consolidates explainer + memory_consolidation: operator-facing message + durable
  `agent_memory` entries.

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
