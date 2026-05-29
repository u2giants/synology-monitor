# PLAN — Issue-Agent AI Rebuild (3-stage, cached, live-tool)

Status: **design complete, not yet built.** Authored 2026-05-29.

**How to use this doc:** This is the self-contained handoff for a *fresh* coding
session (start clean — do not carry the planning session's debugging clutter;
prompt caching makes re-reads cheap but does not stop a cluttered context from
degrading reasoning). Read `AGENTS.md` first for repo rules, then this. It
intentionally restates everything so the coder needs no prior conversation.
Where this doc and your assumptions conflict, trust this doc.

---

## 0. TL;DR

Replace the current 7-call, OpenRouter-routed, no-caching, lossy issue-agent
pipeline with **3 config-driven stages**:

1. **Lossless Structurer** (cheap) — de-noise/dedup raw telemetry while keeping
   *every distinct signal*; never truncate or summarize away detail.
2. **Reasoning Core** (strong, cached, live tools) — one agentic loop that holds
   a whole-system view, calls NAS tools on demand, and won't re-chew stale
   evidence. The "SSH-genius" brain with guardrails.
3. **Explainer / Memory** (cheap) — operator reply + durable memory.

Inference goes through **provider-native SDKs directly** (Anthropic, OpenAI,
Google Gemini, DeepSeek, Qwen) — **never an aggregator** — with caching done
**correctly per provider** (Part 6). Models + reasoning-effort are chosen by the
operator at runtime via an admin page (3 stages × 2 dropdowns). Nothing hardcoded.

---

## 1. Why we're doing this — full diagnosis

The Issue Investigator feels far dumber than Claude with a live SSH session. When
you SSH, Claude has a flashlight and the keys to the room: it runs any command,
sees raw output, and digs iteratively with a frontier model. The Investigator is
the opposite, for six concrete, verified reasons (all in
`apps/web/src/lib/server/`):

### 1a. It reads pre-stored telemetry, not live data — and over fixed windows
`gatherTelemetryContext` (in `issue-agent.ts`) pulls from Supabase and makes
**zero live NAS calls during reasoning**. Per-source windows/limits as built:

| source | window | limit | note |
|---|---|---|---|
| alerts | none | 12 | latest active |
| nas_logs (warning+) | 6h | 60 | excludes system/storage/scheduled_task/share_quota/share_health |
| nas_logs (audit, high-signal) | 48h | 80 | only system/storage/scheduled_task/share_quota/share_health |
| process_snapshots | 6h | 20 | |
| disk_io_stats | 6h | 20 | |
| scheduled_tasks | 48h | 20 | |
| backup_tasks | 6h | 30 | |
| snapshot_replicas | 6h | 20 | |
| container_io | 30m | 15 | |
| sync_task_snapshots | 6h | 15 | |
| metrics | 30m | 40 | iowait + specific types |
| storage_snapshots | 48h | 20 | deduped by volume |
| dsm_errors | 48h | 30 | |

Freshness reality (measured 2026-05-29, *before* the ingestion fix): metrics were
~30s fresh, but **logs were 19h stale and alerts 23 days stale** because ingestion
was broken (now fixed — see §4). The agent reasons on recent windows, so the win
is: (i) keep ingestion healthy (done) AND (ii) let the Reasoning Core pull
up-to-the-second data live via tools (this rebuild).

### 1b. The "compression" is lossy (the big one)
`compressLogsToFacts` (in `issue-stage-models.ts`) is the extractor stage. It:
- slims each log row to `{t, sev, msg}` and **truncates msg to 200 chars** (drops
  stack traces, full paths),
- caps input to ~140 rows (40/source),
- prompts the model to emit **one baseline "pattern" fact per source** + one per
  anomaly — i.e. it *summarizes away* all non-anomalous detail,
- and crucially, the **raw `logs`/`audit_logs` are stripped before the hypothesis
  and planner stages ever run** (`telemetryWithoutLogs` in `issue-agent.ts`).

So the reasoning models work from a lossy summary of stale data. **Operator
directive: storage is cheap. Stage 1 must remove only fluff/repetition and pass
ALL relevant signal forward — no truncation, no collapsing distinct events.**

### 1c. The tool surface — it free-forms instead of using a curated catalog
The Investigator does **not** use a fixed menu; the planner prompt generates
*arbitrary* tier-1/2/3 shell commands, gated only by the nas-api validator. So:
- It reinvents commands instead of using the **108 curated, battle-tested tools**
  in `apps/nas-mcp/src/tool-definitions.ts` (the web app's own `tools.ts` defines
  only ~42 for the legacy copilot).
- There is a `tool_gaps` output (planner can flag "can't do X without env var"),
  surfaced to the operator — but **no dedicated "what am I missing / what data
  would settle this" introspection step**, and no way to pull live data mid-cycle
  except by proposing a diagnostic action that costs a whole cycle.
Fix: wire the curated catalog into the Reasoning Core as real tools + add a
data-sufficiency / blind-spot step.

### 1d. Narrow vision — pre-scoped to one fingerprint
`issue-detector.ts` fingerprints/groups alerts+logs into issues (families:
sharesync-metadata-corruption, sharesync-api-invalid, drive-not-ready,
sync-failure, sync-conflict, thumbnail-extract-failure, backup-failure,
rename-activity, …; sustained I/O pressure at ≥20% avg iowait / critical ≥40%;
`buildCorrelatedIncidentGroups` correlates drive churn + hyperbackup churn +
snapshot cleanup + I/O pressure). The agent then sees only *that issue's* slice.
Fix: give the Reasoning Core a **whole-system health snapshot** + visibility of
correlated/sibling issues, and let it widen scope when its hypothesis implicates
another subsystem.

### 1e. Re-chewing — no "nothing changed" detection
The cycle loop (`runIssueAgent`, `MAX_AGENT_CYCLES = 8`) re-runs
hypothesis→planner→explanation every cycle with fresh telemetry but has **no check
that the evidence set is unchanged** from the prior cycle. `hasAlreadyTried`
compares command *text* only. So with no new evidence it reaches the same
conclusion and repeats. Loop control today: execute approved actions → if open
proposal, go `waiting_for_approval` → hypothesis → planner → (remediation) →
explainer → if diagnostic_action & not already tried, `continue`; else
`deriveTerminalPlanStatus` (forces `stuck` if running with no action).
Fix: fingerprint the evidence+planned-action each cycle; if unchanged, STOP and
switch to "what's missing": request specific data, escalate, or ask the operator.

### 1f. No caching, and the prompts are cache-hostile
`callStageModel` (in `issue-stage-models.ts`) uses the OpenAI SDK with
`baseURL: https://openrouter.ai/api/v1`, sends a **single user message**
`` `${backendFindings}\n\n${prompt}` `` with `max_tokens`, and sets **no
`cache_control`**. `backendFindings` (semi-dynamic, refreshed each call) is placed
**first**, so there isn't even a stable prefix to cache. `minimax.ts`
(`callMinimaxJSON`) does 4-strategy JSON parsing incl. truncated-JSON repair.
Key realizations from planning (operator pushed back and was right):
- Different stages **can** share a cache if they share a byte-identical prefix.
- The prompts differ only because of how it was built, not because they must.
- ~80–90% of each stage's context (issue, telemetry, history, snapshot) is
  identical; only the trailing instruction differs.

---

## 2. Current pipeline inventory (what exists today)

**7 model calls** (in `issue-stage-models.ts` unless noted), each reads a model
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

Other settings keys present: `diagnosis_model`, `remediation_model`,
`reasoner_model`, `second_opinion_model` (`anthropic/claude-sonnet-4`),
`cluster_model`. **Must read via `createAdminClient()` (service role)** — the
background worker has no user session, and the session client returns `{}` under
RLS, silently falling back to defaults (this bit us before; keep it).

**Loop / workflow:**
- `runIssueAgent` while `cycles < MAX_AGENT_CYCLES (8)`.
- Job queue `issue_jobs`; `ISSUE_WORKER_MODE` = `inline` (drains 3/req) or
  `background` (`issue-worker.mjs` polls `/api/internal/issue-worker/drain`,
  auth `ISSUE_WORKER_TOKEN`, drains 10/global).
- Cross-issue deps: `depends_on_issue_id`, `releaseDependentIssues`,
  `maybeNudgeBlockingIssue` (`issue-workflow.ts`).
- Approval gate: tier-2/3 actions need `confirmed`/HMAC token (15-min expiry,
  `buildApprovalToken`/`verifyApprovalToken` in `tools.ts`; `nas-api-client.ts`).

**Issue data model (Supabase, unprefixed since migration 00031):** `issues`
(status: open/running/waiting_on_user/waiting_for_approval/resolved/stuck/cancelled),
`issue_messages`, `issue_evidence`, `issue_actions`, `issue_jobs`,
`issue_state_transitions`, `facts`, `fact_sources`, `issue_facts`,
`capability_state`, `agent_memory`, `ai_settings`.

---

## 3. Target architecture — 3 stages

Each stage reads **(model, reasoning/effort)** from config; caching makes the
strong middle stage affordable.

### Stage 1 — Lossless Structurer  (cheap model, low effort, single-shot)
- Replaces `compressLogsToFacts`.
- Input: raw telemetry for the issue window (all sources in §1a).
- Job: **remove only exact repetition/noise; preserve EVERY distinct event in
  full** — no 200-char truncation, no "one fact per source" collapsing, no
  dropped fields. Collapse byte-identical lines into `{line, count, first_ts,
  last_ts}`; group by source/time; normalize to a compact-but-complete structure.
- Output: a structured, deduplicated, COMPLETE evidence set. Raw detail is
  retained and flows into Stage 2 (today it's discarded).
- This is the lowest-risk, highest-immediate-value change → build first.

### Stage 2 — Reasoning Core  (strong model, high effort, CACHED, live tools, multi-turn)
- Consolidates hypothesis + planner + remediation_planner + verifier into ONE
  agentic loop.
- Context assembled ONCE per cycle as a **stable cacheable prefix** (see §6):
  system prompt → curated NAS tool catalog → output schema → NAS domain taxonomy
  (issue families, capability_state, known DSM blind spots) → whole-system health
  snapshot → issue history → Stage-1 evidence. The per-turn instruction is the
  only dynamic suffix.
- Capabilities:
  - **Live tools on demand** — call the curated catalog (read-only tier-1 freely;
    tier-2/3 still through the operator approval gate) to fetch fresh data WHILE
    reasoning. This is the "SSH-genius" behavior.
  - **Whole-system view** — not just the fingerprint slice; can widen scope.
  - **Re-chew guard** — fingerprint evidence + planned action each cycle; if
    unchanged and repeating, STOP → request data / escalate / ask operator.
  - Outputs: hypothesis+confidence, next action (diagnostic/remediation/none),
    approval requirement, and post-action verification verdict.

### Stage 3 — Explainer / Memory  (cheap model, low effort, single-shot)
- Consolidates explainer + memory_consolidation: operator-facing message +
  durable `agent_memory` entries.

---

## 4. What was fixed 2026-05-29 (don't regress; data is reliable now)

The rebuild assumes complete, fresh ingestion. Two production issues were fixed
this day (see memory `db-partman-and-ingestion-state`):
- **Ingestion stall** — brittle `smon_logs/alerts_source_check` whitelists
  rejected ~13 log sources + ShareSync alert sources; PostgREST batch-inserts
  meant one bad row failed the whole batch → dropped after 5 retries → logs froze
  19h, alerts 23d. Fixed: migration 00035 dropped the whitelists; the agent stops
  emitting `"filter"` severity; the WAL sender now isolates a poison row instead
  of failing the batch (`apps/agent/.../sender.go postRows`). Verified flowing.
- **pg_partman** — re-pointed config to renamed parents, drained 6 weeks of
  default-partition backlog, restored retention/premake, reclaimed 3.34 GB.

Do not reintroduce a source whitelist; do not regress the per-row sender fix.

---

## 5. Config surface (admin) — REQUIRED

- Settings page shows **exactly 3 stages**, each with **2 dropdowns: model +
  reasoning/effort level** (consolidate today's 7 keys → 3). Operator picks all
  models at runtime; **do not hardcode**. Files: `settings/page.tsx`,
  `api/settings/route.ts` (whitelist new keys), `api/models/route.ts` (catalog).
- Each stage row also gets a **"copy spec" button** (no on-screen text) that
  copies an AI-optimized stage description to the clipboard: purpose, exact
  inputs, expected output schema, required capabilities (reasoning depth, context
  size, JSON reliability, tool-use, cost sensitivity), current model. For asking
  an external model "what model fits this stage?".
- Persist in `ai_settings`; add per-stage `*_effort` keys; migrate old keys.
  Defaults if unset (read via `createAdminClient()`).
- **Model catalog enrichment** (the dropdown list, pricing) MAY use an aggregator
  API — but **never route inference through it** (see §6).

---

## 6. Caching — implement it CORRECTLY (provider-native)

These are hard-won production lessons (adapted from a system called "Oracle").
Treat as principles + gotchas, not copy-paste. The numeric thresholds are Oracle's
tuning — **re-derive them against this app's pricing/reuse before trusting them.**

### 6.0 This app's answers to the three prerequisite questions
- **(a) Providers:** Anthropic, OpenAI, Google Gemini, DeepSeek, Qwen/DashScope
  (operator has direct keys for all five). OpenRouter is currently used — **remove
  it from the inference path.**
- **(b) Stable vs dynamic content per prompt:**
  - *Stable* (cache target, same across many calls): system instructions, the
    curated NAS **tool catalog**, the JSON **output schema**, NAS **domain
    taxonomy** (issue families, capability_state, DSM blind spots).
  - *Semi-stable* (changes per issue, stable within an issue's cycles):
    whole-system snapshot, issue history.
  - *Dynamic* (every call): the cycle's new evidence/tool results + the per-turn
    instruction + any retry/validation suffix.
- **(c) Single-shot vs multi-turn:** Stage 2 (Reasoning Core) is **multi-turn**
  (the cycle loop) — cache the prior-turns prefix. Stages 1 & 3 are single-shot
  per invocation but **reused across many issues**, so their stable instruction/
  schema prefix caches across calls.

### 6.1 Foundational decisions (Part 1)
1. **Use provider-native SDKs** (`@anthropic-ai/sdk`, `openai`, `@google/genai`,
   DeepSeek via its OpenAI-compatible SDK, Qwen/DashScope SDK) — **NOT** a
   normalizing abstraction (no Vercel AI SDK) and **NOT** an aggregator
   (OpenRouter/gateways) for inference. Aggregators erase provider-native cache
   usage fields; if you can't see cache reads/writes per provider you can't tune
   or prove caching. Aggregator is OK for model-catalog/pricing only.
2. **Separate stable from dynamic — the whole game.** Order every prompt:
   `[stable system] → [stable tools] → [stable schema] → [semi-stable taxonomy]
   → [retrieved/whole-system context] → [dynamic input] → [retry suffix]`.
   **INVARIANT: no dynamic content before stable content** — one early dynamic
   token busts the cache for everything after. Build a small **context compiler**
   that sorts blocks into this order and **throws** if a dynamic block precedes a
   stable one. Make cache-busting structurally impossible.

### 6.2 Per-provider mechanics (Part 2 — they differ)
- **Anthropic** — explicit opt-in breakpoints: `cache_control:{type:'ephemeral',
  ttl:'5m'|'1h'}` on a content block. Mark the **last text part of the stable
  prefix**; for multi-turn (Stage 2) mark the **penultimate** message so the
  latest turn stays dynamic and all prior turns cache. Min cacheable ~1024 tok
  (Sonnet) / ~2048 (Haiku) — below that, skip cache_control. Usage:
  `cache_creation_input_tokens` (write), `cache_read_input_tokens` (read). Max 4
  breakpoints. 5m for interactive, 1h for batch reuse. Gotcha: `temperature` must
  be 1 when extended thinking is on.
- **OpenAI** — automatic prefix caching (≥1024 tok); no breakpoints, just keep the
  prefix stable. Tune `prompt_cache_retention: 'in_memory' | '24h'`. Usage:
  `prompt_tokens_details.cached_tokens`. No explicit cache resource API.
- **Google Gemini/Vertex** — implicit auto-cache (hits in
  `usageMetadata.cachedContentTokenCount`) AND explicit server-side `cachedContent`
  (billed hourly while alive). Only create explicit caches when big+reused —
  Oracle heuristic `useExplicit = (tokens≥25k AND reuses≥3) OR (tokens≥100k AND
  reuses≥2)`; re-derive for us. Server min TTL 60s; 1h chat / 24h batch. For large
  docs, upload to object storage once and build the cache from a `gs://` reference
  (gate behind a bucket env var) — not relevant unless we attach big files.
- **DeepSeek** — automatic disk-backed prefix cache, no client action. Usage is
  DeepSeek-specific: `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` (NOT
  the OpenAI shape) — read these explicitly or savings read as zero.
- **Qwen/DashScope** — OpenAI-style `cache_control` markers on the prefix; for
  multi-turn there's a session cache requiring a session header + persisting
  `previous_response_id` across requests — **without persisting that id the
  session cache resets every turn and savings vanish.**

### 6.3 Proposed breakpoints per stage
- **Stage 1 / Stage 3 (single-shot, reused):** put the stable
  instructions+schema(+taxonomy) prefix first; for Anthropic mark one breakpoint
  at the end of that prefix (only if ≥ the model's min size). OpenAI/DeepSeek:
  automatic. The per-issue evidence is the dynamic suffix.
- **Stage 2 (multi-turn):** the big shared context (system+tools+schema+taxonomy+
  snapshot+history+evidence) is the cacheable region; Anthropic breakpoint on the
  penultimate message; OpenAI/DeepSeek automatic; Qwen persist `previous_response_id`.

### 6.4 Observability (Part 3 — if you can't measure it, it's not working)
- Define ONE normalized usage struct `{ inputTokens, outputTokens,
  cachedInputTokens, cacheWriteTokens, reasoningTokens }` and a **per-provider
  normalizer** mapping each native field set into it (incl. DeepSeek's and
  Gemini's non-standard fields). Persist normalized usage **and** raw provider
  usage JSON per call.
- Track `cache_hit_ratio = cachedInputTokens / inputTokens` on a dashboard — the
  single most important tuning signal. An un-normalized provider silently reads 0%.

### 6.5 Explicit-cache lifecycle (Part 3 — only Gemini explicit needs this)
- If/when explicit Gemini caches are used, track them in a DB table
  `provider_cached_content`: one row per cache with `source_hash` (dedup/reuse),
  `expected_reuse_count`, `hard_expiration_at`, `cleanup_owner`, `status`
  (active|deleted|expired|failed|orphaned). All status changes via a
  `recordCacheTermination()` helper (never raw SQL); CHECK constraint
  `deleted_at IS NULL iff status='active'`. Cleanup: no known follow-up → delete in
  a `finally` block (don't wait for TTL); known follow-ups → keep until last pass
  or TTL. In-memory tracking leaks billing across worker/web processes — use the DB.
- **Cache keys from hashes:** hash the stable prefix → `stable_prefix_hash`. Same
  content → same key → reuse; changed → new hash, old orphaned. This is why the
  stable-before-dynamic ordering is load-bearing (the cacheable region must be
  contiguous and at the front for the hash to mean anything).

### 6.6 Mistakes NOT to repeat (Part 4)
- Normalizing SDK → lost cache observability. (Use native SDKs.)
- A doc-caching "optimization" collapsed multi-turn history to one turn — cache
  worked, conversation broke. **Any caching change must preserve full
  conversation history** (Stage 2). Add a regression guard.
- Process-local cache tracking leaked caches → use shared DB.
- Qwen session id not persisted → session cache reset every turn.
- Forgot to normalize a provider's cache field → dashboard showed 0%.

### 6.7 CI guards (Part 5 — these failures are SILENT)
Wire as hard blockers in the build/lint command:
1. Assert **stable-before-dynamic** ordering (the context compiler throws).
2. Assert **multi-turn history is preserved** through any caching path.
3. Assert **every provider's cache usage field is normalized**.

---

## 7. Build order (most efficient; foundation → stages → UI → cleanup)

1. **Config layer** — define the 3 stages' `model` + `effort` keys; refactor
   `ai-settings.ts` so every stage reads (model, effort) from one place with
   defaults; add the migration to consolidate 7→3 keys.
2. **Provider client + caching core** — replace the OpenRouter `callStageModel`
   with a provider-native router (pick SDK by configured model id), per-call
   effort, the **context compiler** (stable→dynamic ordering, throws on
   violation), per-provider cache breakpoint logic (§6.2–6.3), and the normalized
   usage struct + persistence (§6.4). Add the CI guards (§6.7).
3. **Stage 1 — lossless structurer** (immediate win, low risk, self-contained).
4. **Stage 2 — reasoning core** — cached context + whole-system snapshot + live
   tools + re-chew guard; consolidate hypothesis/planner/remediation/verifier.
5. **Stage 3 — explainer/memory.**
6. **Admin UI** — 3 stages × (model, effort) dropdowns + copy-spec button; wire to
   config; build the `cache_hit_ratio` view.
7. **Cleanup** — remove the old 7-stage code/keys, OpenRouter inference path, and
   `provider_cached_content` only if explicit caches were adopted; update docs.

---

## 8. Key files
- Loop/gather: `apps/web/src/lib/server/issue-agent.ts`
- Model calls/stages: `issue-stage-models.ts`, `minimax.ts`, `model-json.ts`,
  `ai-settings.ts`, `backend-findings.ts`
- Tools to wire into Stage 2: `tools.ts`, `nas-api-client.ts`; richer catalog
  reference: `apps/nas-mcp/src/tool-definitions.ts`
- Facts/forensics: `fact-store.ts`, `forensics-drive.ts`, `forensics-hyperbackup.ts`
- Detector (scope source): `issue-detector.ts`
- Settings UI/API: `app/(dashboard)/settings/page.tsx`, `app/api/settings/route.ts`,
  `app/api/models/route.ts`
- Supabase server clients: `lib/supabase/{admin,server}.ts` (use `admin` for the worker)
- DB: `supabase/migrations/` (new migration for settings keys; possibly
  `provider_cached_content`)

---

## 9. Constraints & gotchas
- One branch `main`; commit + deploy via main→Actions→Coolify (web auto-redeploys
  on `apps/web/**`). Top-level `*.md` triggers no build.
- **New provider API keys** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GEMINI_API_KEY`/Vertex creds, `DEEPSEEK_API_KEY`, `DASHSCOPE_API_KEY`) must be
  added in **Coolify** before the corresponding provider works in prod. Stages
  1/3 build can proceed before keys; Stage 2 (Anthropic) needs the key live.
- Keep the operator approval gate for tier-2/3 actions intact.
- Read `ai_settings` via `createAdminClient()` (service role) in the worker.
- Known DSM blind spots — never read empty as healthy: `container_status` CPU/mem
  always 0 (use `container_io`); `scheduled_tasks` DSM error 103 on edgesynology1;
  some snapshot-replication APIs unsupported. Log-derived fields are regex-parsed
  (categorizations imperfect; raw text faithful).
- Secrets: leaked creds from history still need rotation (separate task).

---

## 10. Open items deferred to the coder
- Exact 3-stage settings-key names + the 7→3 migration.
- Whole-system snapshot shape (rich enough to be useful, small enough to keep the
  cached prefix lean).
- Re-chew fingerprint definition (hash of evidence set + planned action).
- **Re-derive caching thresholds** (min cacheable size benefit, Gemini explicit
  25k/3·100k/2, TTLs) against this app's actual model pricing + reuse counts.
- Whether to keep an aggregator purely for the model-catalog dropdown.
