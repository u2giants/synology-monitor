# PLAN — Issue-Agent AI Rebuild (3-stage)

Status: **design complete, not yet built.** Authored 2026-05-29.
Read `AGENTS.md` first for repo rules. This plan is the handoff artifact for a
fresh coding session — it intentionally repeats context so the coder needs no
prior conversation.

## Why we're doing this

The "Issue Investigator" feels far dumber than Claude with a live SSH session.
Root causes found in the current pipeline (all in `apps/web/src/lib/server/`):

1. **Lossy compression** — `compressLogsToFacts` truncates each log to 200 chars,
   collapses all "baseline" lines into one fact/source, and strips metadata; raw
   logs are then deleted before the reasoning models ever see them.
2. **Fragmented reasoning** — work is split across 7 separate model calls
   (extractor → hypothesis → planner → remediation_planner → explainer →
   verifier → memory_consolidation), each handing a lossy summary to the next.
   No single mind holds the whole picture; the model that writes the reply isn't
   the one that reasoned.
3. **Narrow vision** — the detector pre-scopes each issue to one fingerprint; the
   agent only sees that slice, never a whole-system view.
4. **Re-chewing** — the cycle loop (`runIssueAgent`, MAX_AGENT_CYCLES=8) has NO
   detection that the evidence is unchanged; it re-runs the same stages on the
   same data and repeats itself.
5. **No live data mid-reasoning** — stages read only pre-stored Supabase
   telemetry; the agent never pulls fresh NAS data while thinking (it CAN run
   tools, but only as a separate proposed action).
6. **No prompt caching anywhere**, and prompts are cache-hostile (volatile
   `backendFindings` prepended first; static instructions interleaved with
   per-issue JSON in a single user message). Calls go through OpenRouter
   (`baseURL https://openrouter.ai/api/v1`), no `cache_control`.

(Separately, ingestion was stalled and partman was broken — both FIXED on
2026-05-29; see the memory note. Data flows fresh now. This rebuild is purely the
reasoning pipeline.)

## Target architecture — 3 stages

Replace the 7 model calls with 3 stages. Each stage reads **model + reasoning/effort
level from config** (admin-selectable; see Config below). Caching makes the strong
middle stage affordable.

### Stage 1 — Lossless Structurer  (cheap model, low effort)
- Replaces `compressLogsToFacts` / the extractor.
- Input: raw telemetry for the issue window (logs, audit_logs, alerts, metrics,
  process/disk/container I/O, sync/backup snapshots).
- Job: **remove only exact repetition/noise; preserve EVERY distinct event in
  full.** No truncation, no summarization of distinct events, no dropped fields.
  Deduplicate identical lines (with a count), group by source/time, normalize
  format for token efficiency. Storage is cheap — keep ALL signal.
- Output: a structured, deduplicated, COMPLETE evidence set that flows into
  stage 2 (raw logs are NOT discarded the way they are today).

### Stage 2 — Reasoning Core  (strong model, high effort, CACHED, live tools)
- Consolidates hypothesis + planner + remediation_planner + verifier into ONE
  agentic loop — the "SSH-genius" brain, with guardrails.
- Context (assembled ONCE per cycle as a STABLE cacheable prefix):
  system prompt + curated NAS tool catalog + **whole-system health snapshot**
  (not just the fingerprint slice) + issue history/messages + the stage-1
  evidence set. Each turn appends only a short stage instruction as the volatile
  suffix.
- Capabilities:
  - **Live tools on demand** — call the curated NAS-API tool catalog (read-only
    tier-1 freely; tier-2/3 still go through the operator approval gate) to pull
    up-to-the-second data WHILE reasoning, not just read stored telemetry.
  - **Re-chew guard** — fingerprint the evidence/tool-result set each cycle; if
    unchanged from the prior cycle AND the next planned step repeats a prior one,
    STOP looping and switch to "what's missing": request specific new data,
    escalate, or ask the operator.
  - Produces: hypothesis + confidence, next action (diagnostic/remediation/none),
    approval requirements, and a verification verdict after an action runs.

### Stage 3 — Explainer / Memory  (cheap model, low effort)
- Consolidates explainer + memory_consolidation.
- Input: stage-2 conclusion + issue state.
- Job: write the operator-facing message; extract durable memory entries.

## Caching architecture

- Build the large shared context (system prompt + tool catalog + whole-system
  snapshot + issue history + stage-1 evidence) as a **stable prefix** with
  Anthropic `cache_control` breakpoints; append the short per-turn instruction
  last. Identical prefix across stage-2 turns/cycles → cache hits.
- Stage boundaries are natural cache breakpoints anyway (a cache never crosses
  models/providers), so each stage can use a different model with zero caching
  penalty. Keep each stage's prefix stable.
- **Direct provider APIs**, not OpenRouter (user has Anthropic/Google/Qwen/
  DeepSeek/OpenAI keys). Stage 2 → Anthropic direct for reliable caching + the
  longer cache TTLs + tool use. Stages 1/3 → whichever provider the config
  selects. The `claude-api` skill's guidance ("always include prompt caching")
  applies.

## Config surface (admin) — REQUIRED

- The Settings/admin page exposes **exactly 3 stages**, each with **2 dropdowns:
  model + reasoning/effort level.** Mirror the existing per-stage dropdown setup,
  consolidated from 7 to 3. User picks all models at runtime (do NOT hardcode).
- Each stage row also gets a **"copy spec" button** (no on-screen text) that
  copies an AI-optimized description of that stage to the clipboard: purpose,
  exact inputs, expected output schema, required capabilities (reasoning depth,
  context size, JSON reliability, tool-use, cost sensitivity), current model.
  Used to ask an external model "what's the best model for this stage?".
- Persist in `smon_ai_settings`→`ai_settings` (the renamed table). Migrate the
  current keys (extractor/hypothesis/planner/remediation_planner/explainer/
  verifier/reasoner/diagnosis/...) to the 3-stage scheme + add per-stage
  `*_effort` keys. Keep sane defaults if unset (read via `createAdminClient()` —
  service role — never the session client, or RLS silently returns defaults).

## Build order (most efficient; dependencies first)

1. **Config layer** — define the 3 stages' `model` + `effort` settings keys;
   refactor `ai-settings.ts` so every stage reads (model, effort) from one place
   with defaults. Foundation everything plugs into.
2. **Provider client + caching module** — replace `callStageModel`'s OpenRouter
   client with a provider-routing model client (pick provider from the configured
   model id), per-call effort, and Anthropic prompt caching (`cache_control` on
   the stable prefix). Foundation for all stages.
3. **Stage 1 — lossless structurer** — rewrite the extractor. Immediate quality
   win, low risk, self-contained.
4. **Stage 2 — reasoning core** — cached context + whole-system snapshot + live
   tool use + re-chew guard; consolidate hypothesis/planner/remediation/verifier.
   Biggest change; depends on 1+2.
5. **Stage 3 — explainer/memory** — consolidate explainer + memory.
6. **Admin UI** — 3 stages × (model, effort) dropdowns + per-stage copy-spec
   button; wire to config.
7. **Cleanup** — remove the old 7-stage code paths and stale settings keys;
   update docs.

## Key files

- Pipeline/loop: `apps/web/src/lib/server/issue-agent.ts`
- Stage models / model calls: `apps/web/src/lib/server/issue-stage-models.ts`,
  `minimax.ts`, `model-json.ts`, `ai-settings.ts`, `backend-findings.ts`
- Tools (curated catalog to wire into stage 2): `apps/web/src/lib/server/tools.ts`,
  `nas-api-client.ts`; richer catalog reference: `apps/nas-mcp/src/tool-definitions.ts`
- Telemetry gather / facts: `gatherTelemetryContext` in `issue-agent.ts`,
  `fact-store.ts`, `forensics-*.ts`
- Settings UI + API: `apps/web/src/app/(dashboard)/settings/page.tsx`,
  `apps/web/src/app/api/settings/route.ts`, `apps/web/src/app/api/models/route.ts`
- DB: `supabase/migrations/` (new migration for any settings-key changes)

## Constraints (from AGENTS.md / this repo)

- One branch `main`; commit + deploy via main→Actions→Coolify (web auto-redeploys).
- Web env: model provider API keys must be added in Coolify (new direct-provider
  keys). `OPENROUTER_API_KEY` is the current key; new ones needed for direct APIs.
- Do NOT regress the ingestion fix or partman repair.
- `ISSUE_WORKER_MODE` inline/background still applies.
- Keep the operator approval gate for tier-2/3 actions intact.

## Open items deferred to the coder
- Exact settings-key names + the migration to consolidate 7→3 stages.
- Whole-system snapshot shape (what to include without bloating the cached prefix).
- Re-chew fingerprint definition (hash of evidence set + planned action).
