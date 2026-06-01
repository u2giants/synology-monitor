// === AI provider capability matrix (PLAN.md §8.3) ===
//
// Single source of truth for the 3-stage issue-agent rebuild's model config.
// Pure data + pure functions only — this module is imported by BOTH the admin
// UI (client component) and server code (the future provider client + the
// ai-settings getters), so it must stay free of secrets, Node APIs, and
// server-only imports. Model IDs are provider-NATIVE (no OpenRouter/aggregator
// prefix): the rebuild calls provider SDKs directly and never routes the cached
// inference path through an aggregator (PLAN.md §9.1).
//
// "Effort is not universal" (§8.3): each provider exposes a differently-shaped
// reasoning control, and tool-use / structured-output support varies per model.
// We model an ABSTRACT effort level here; the per-provider client (build step 2)
// maps the abstract level onto that provider's concrete shape (Anthropic
// budget_tokens, OpenAI reasoning_effort enum, Gemini thinking config, …) or
// omits the parameter when the selected model has no effort knob.

export type AiProvider = "anthropic" | "openai" | "gemini" | "deepseek" | "qwen";

/**
 * Shape of a provider/model's reasoning-effort control. The admin effort control
 * is enabled/populated from the selected model's descriptor; a model whose
 * control is `none` (or whose reasoning is a `separate_model`, like DeepSeek)
 * disables the admin effort control and the provider client omits the parameter.
 */
export type EffortControl =
  | "anthropic_budget" // extended thinking budget_tokens (temperature must = 1)
  | "openai_enum" // reasoning_effort enum on reasoning models
  | "gemini_thinking" // thinking config (thinkingBudget)
  | "separate_model" // DeepSeek: the reasoner is a distinct model, not a knob
  | "none"; // no effort control for this model

/** Abstract, provider-independent effort level chosen by the operator. */
export type EffortLevel = "minimal" | "low" | "medium" | "high";

export const EFFORT_LEVELS: readonly EffortLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
] as const;

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * How prompt caching is expressed for a provider (PLAN.md §9.2). Carried here so
 * the provider client and the cache-observability layer can branch on it without
 * a second lookup table.
 */
export type CacheStyle =
  | "explicit_cache_control" // Anthropic: cache_control breakpoints
  | "automatic_prefix" // OpenAI / DeepSeek: implicit prefix cache
  | "implicit_plus_explicit" // Gemini: implicit + explicit cachedContent
  | "markers_session"; // Qwen/DashScope: markers + previous_response_id

export interface ModelDescriptor {
  /** Provider-native model id (NOT an aggregator id). */
  id: string;
  provider: AiProvider;
  /** Human label for the admin dropdown. */
  label: string;
  effortControl: EffortControl;
  /**
   * Abstract effort levels this model accepts. Empty when the model has no
   * gradable effort knob (effortControl `none` or `separate_model`) — the admin
   * control is then disabled and the provider client omits the parameter.
   */
  effortLevels: readonly EffortLevel[];
  /** Supports tool / function calling. Required for Stage 2 (reasoning core). */
  toolUse: boolean;
  /** Supports structured / JSON output. Required for all three stages. */
  structuredOutput: boolean;
  cache: CacheStyle;
}

// Per-provider defaults for the cache style + the typical effort shape, so model
// rows stay terse and consistent.
const GRADED: readonly EffortLevel[] = EFFORT_LEVELS;
// OpenAI reasoning models reject 'minimal' on some variants (e.g. gpt-5.4-mini
// returns 400 "does not support 'minimal'"), so only offer low/medium/high.
const OPENAI_EFFORT: readonly EffortLevel[] = ["low", "medium", "high"];

/**
 * The model catalog. Provider-native ids only. This is intentionally a curated
 * list (not the full aggregator catalog): the stages are gated by required
 * capabilities (§8.3), and the admin dropdown offers exactly these.
 *
 * NOTE: provider API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY,
 * DEEPSEEK_API_KEY, DASHSCOPE_API_KEY) must be present in Coolify for a provider
 * to actually run — see PLAN.md §12. Listing a model here does not configure it.
 */
export const MODEL_CATALOG: readonly ModelDescriptor[] = [
  // --- Anthropic (explicit cache_control; extended-thinking budget) ---
  {
    id: "claude-opus-4-8",
    provider: "anthropic",
    label: "Claude Opus 4.8",
    effortControl: "anthropic_budget",
    effortLevels: GRADED,
    toolUse: true,
    structuredOutput: true,
    cache: "explicit_cache_control",
  },
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    label: "Claude Sonnet 4.6",
    effortControl: "anthropic_budget",
    effortLevels: GRADED,
    toolUse: true,
    structuredOutput: true,
    cache: "explicit_cache_control",
  },
  {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    label: "Claude Haiku 4.5",
    effortControl: "anthropic_budget",
    effortLevels: GRADED,
    toolUse: true,
    structuredOutput: true,
    cache: "explicit_cache_control",
  },
  // --- OpenAI (automatic prefix cache; reasoning_effort enum) ---
  {
    id: "gpt-5.4",
    provider: "openai",
    label: "GPT-5.4",
    effortControl: "openai_enum",
    effortLevels: OPENAI_EFFORT,
    toolUse: true,
    structuredOutput: true,
    cache: "automatic_prefix",
  },
  {
    id: "gpt-5.4-mini",
    provider: "openai",
    label: "GPT-5.4 mini",
    effortControl: "openai_enum",
    effortLevels: OPENAI_EFFORT,
    toolUse: true,
    structuredOutput: true,
    cache: "automatic_prefix",
  },
  // --- Google Gemini (implicit + explicit cachedContent; thinking config) ---
  {
    id: "gemini-3.1-pro-preview",
    provider: "gemini",
    label: "Gemini 3.1 Pro (preview)",
    effortControl: "gemini_thinking",
    effortLevels: GRADED,
    toolUse: true,
    structuredOutput: true,
    cache: "implicit_plus_explicit",
  },
  {
    id: "gemini-3.1-flash-lite-preview",
    provider: "gemini",
    label: "Gemini 3.1 Flash-Lite (preview)",
    effortControl: "gemini_thinking",
    effortLevels: GRADED,
    toolUse: true,
    structuredOutput: true,
    cache: "implicit_plus_explicit",
  },
  {
    id: "gemini-2.5-flash",
    provider: "gemini",
    label: "Gemini 2.5 Flash",
    effortControl: "gemini_thinking",
    effortLevels: GRADED,
    toolUse: true,
    structuredOutput: true,
    cache: "implicit_plus_explicit",
  },
  // --- DeepSeek (automatic prefix cache; reasoner is a SEPARATE model) ---
  {
    id: "deepseek-chat",
    provider: "deepseek",
    label: "DeepSeek Chat (V3)",
    effortControl: "none",
    effortLevels: [],
    toolUse: true,
    structuredOutput: true,
    cache: "automatic_prefix",
  },
  {
    id: "deepseek-reasoner",
    provider: "deepseek",
    label: "DeepSeek Reasoner (R1)",
    effortControl: "separate_model",
    effortLevels: [],
    toolUse: false, // reasoner historically does not support tool use
    structuredOutput: true,
    cache: "automatic_prefix",
  },
  // --- Qwen / DashScope (OpenAI-style markers + session id) ---
  {
    id: "qwen3.6-plus",
    provider: "qwen",
    label: "Qwen3.6 Plus",
    effortControl: "none",
    effortLevels: [],
    toolUse: true,
    structuredOutput: true,
    cache: "markers_session",
  },
] as const;

const MODEL_BY_ID = new Map(MODEL_CATALOG.map((m) => [m.id, m]));

export function getModelDescriptor(id: string): ModelDescriptor | undefined {
  return MODEL_BY_ID.get(id);
}

/** Abstract effort levels a given model accepts (empty if it has no knob). */
export function effortLevelsForModel(id: string): readonly EffortLevel[] {
  return MODEL_BY_ID.get(id)?.effortLevels ?? [];
}

// === The three stages (PLAN.md §3, §8.1, §8.2) ===

export type AiStage = "structurer" | "reasoning" | "explainer";

export const AI_STAGES: readonly AiStage[] = [
  "structurer",
  "reasoning",
  "explainer",
] as const;

/** Capabilities a model MUST have to be offered for a stage (§8.3). */
export interface StageCapabilityRequirement {
  toolUse: boolean;
  structuredOutput: boolean;
}

export interface StageDescriptor {
  stage: AiStage;
  label: string;
  /** ai_settings key for the model. */
  modelKey: string;
  /** ai_settings key for the abstract effort level. */
  effortKey: string;
  /** Short purpose blurb shown in the UI. */
  purpose: string;
  /**
   * Full spec used by the copy-spec button. Describes the cognitive/computational
   * task, what the model must do well, and which capabilities matter most.
   */
  spec: string;
  requires: StageCapabilityRequirement;
  /**
   * Hardcoded final-fallback (§8.1): an empty/cold ai_settings must still boot
   * instead of crashing. The operator's runtime choice always overrides these.
   * Kept in sync with the seed in migration 00036.
   */
  fallbackModel: string;
  fallbackEffort: EffortLevel;
}

export const STAGE_DESCRIPTORS: Record<AiStage, StageDescriptor> = {
  structurer: {
    stage: "structurer",
    label: "Stage 1 — Lossless Structurer",
    modelKey: "stage_structurer_model",
    effortKey: "stage_structurer_effort",
    purpose:
      "De-noise/dedup raw telemetry into a complete, structured evidence set " +
      "persisted in the DB. Removes only exact repetition — never truncates or " +
      "summarizes a distinct event. Cheap, low effort, single-shot.",
    spec: [
      "WHAT THIS STAGE DOES",
      "Stage 1 is a deterministic data transformation pipeline — it makes no model calls.",
      "Its job is to convert raw Supabase telemetry (alerts, logs, disk_io, process snapshots,",
      "scheduled tasks, backup tasks, sync tasks, container I/O, storage snapshots, DSM errors)",
      "into a structured, deduplicated, prioritised evidence store that Stage 2 can reason over.",
      "",
      "The pipeline runs five ordered steps:",
      "1. Ingest all telemetry rows for the issue window across 12 source tables.",
      "2. Deduplicate: collapse byte-identical (source, body) pairs into one row with dedup_count,",
      "   first_ts, last_ts. Paraphrase-similar rows are never merged — only exact matches.",
      "3. Classify anomalous: severity >= error, OR severity = warning with a state-change keyword",
      "   (failed, timeout, degraded, crash, panic, rejected, aborted, stopped, restart…).",
      "4. Classify in-scope: nas_id matches issue.affected_nas, OR severity >= error.",
      "5. Budget and persist: 12,000-token budget. 70% reserved for in-scope anomalous rows",
      "   (full bodies, sorted by severity then recency). 30% for dedup-count noise summaries.",
      "   Evidence index (source × time-bucket × count) always included, doesn't count toward budget.",
      "",
      "WHY THERE IS NO MODEL CALL",
      "Using a model to compress logs before the reasoner is the core defect this pipeline replaces.",
      "A summarising model decides what matters before the reasoning model has formed a hypothesis,",
      "so it inevitably discards the evidence that would falsify the wrong hypothesis.",
      "Stage 1 preserves and organises — it never interprets. No model needed.",
      "",
      "WHAT A MODEL FOR THIS STAGE NEEDS",
      "Structured output fidelity (required). The output schema is a typed evidence array.",
      "No tool use. No reasoning depth. Fast and cheap is the right profile.",
      "The quality bar is: correct JSON, correct dedup logic, correct anomaly classification.",
    ].join("\n"),
    requires: { toolUse: false, structuredOutput: true },
    fallbackModel: "gemini-3.1-flash-lite-preview",
    fallbackEffort: "minimal",
  },
  reasoning: {
    stage: "reasoning",
    label: "Stage 2 — Reasoning Core",
    modelKey: "stage_reasoning_model",
    effortKey: "stage_reasoning_effort",
    purpose:
      "Agentic investigation loop: forms and tests hypotheses using stored telemetry and live NAS " +
      "tools, proposes remediations for operator approval, resumes from DB state across gates. " +
      "Up to 8 turns. Requires strong reasoning, reliable tool use, and long-context coherence.",
    spec: [
      "WHAT THIS STAGE DOES",
      "Stage 2 is the diagnostic mind of the pipeline. Its goal: determine what is wrong with",
      "one or both Synology NAS units, why it is wrong, and either propose a safe remediation or",
      "produce a definitive 'cannot resolve without operator input' verdict.",
      "",
      "This is iterative multi-hypothesis investigation under uncertainty — not summarisation,",
      "not classification, not Q&A. The model must:",
      "- Read a structured evidence slice and extract meaningful signal from noise, distinguishing",
      "  genuine anomalies from DSM quirks that look like errors but are normal.",
      "- Commit to a ranked hypothesis with a confidence level rather than hedging across all",
      "  possibilities. Vague 'could be X or Y' turns are useless.",
      "- Choose tools precisely: identify the exact file path, counter, or log that would",
      "  distinguish between two plausible root causes, call that one tool, read the result,",
      "  update the hypothesis. Don't spam tools or re-call tools already in the evidence.",
      "- Know when it has enough evidence and stop, rather than filling the turn cap.",
      "- Respect tier boundaries: write-capable commands are hard-blocked; fixes are proposed",
      "  as structured remediations for operator approval, never self-executed.",
      "- Degrade gracefully when the NAS is offline: pivot to fetch_evidence (reads Supabase,",
      "  always available) and communicate what can and cannot be determined without live access.",
      "- Know when to ask the operator: some issues require human context the model cannot infer.",
      "",
      "ONE TURN = ONE JOB INVOCATION. Up to 8 turns (TURN_CAP). The process dies at every",
      "approval/user gate and resumes in a fresh worker from DB state only.",
      "",
      "TYPICAL TURN FLOW",
      "Turn 1 — Orient: read evidence slice, cross-reference whole-system snapshot, form 1-3",
      "  hypothesis candidates, call the single most discriminating diagnostic tool.",
      "Turns 2-4 — Test and narrow: evaluate each tool result against the hypothesis. If it",
      "  confirms hypothesis A and refutes B, update confidence and move to the next test.",
      "  Do not re-call tools already in the evidence.",
      "Turn N (confident) — Produce verdict: propose_remediation with specific action + rationale,",
      "  or conclude_stuck with what is known, unknown, and what operator action is needed.",
      "Turn N (needs human) — ask_user with a single specific answerable question.",
      "",
      "TOOL CATALOG (all tier-1, auto-execute)",
      "fetch_evidence: pages or aggregates issue_evidence_items from the DB. Works offline.",
      "  Aggregate first (group_by: source or time_bucket) before paging into raw rows.",
      "run_command: free-form read-only shell on a named NAS target. Use for raw log files",
      "  (tail -n 200 /var/log/kern.log), /proc virtual files (cat /proc/mdstat),",
      "  /sys gauges (cat /sys/block/md5/inflight). Write commands are hard-blocked.",
      "100+ predefined tools: curated read-only commands for SMART, BTRFS, ShareSync,",
      "  Hyper Backup, Docker, process/network/storage diagnostics.",
      "",
      "RE-CHEW GUARD: if the evidence hash and planned action are identical to the prior turn,",
      "the repeat counter increments. After 2 consecutive identical turns, outcome is overridden",
      "to ask_user — the model is stuck without admitting it.",
      "",
      "WHAT CAPABILITIES MATTER MOST (in order)",
      "1. Strong multi-step reasoning (critical): must hold a hypothesis across 8 turns with a",
      "   growing context. Extended thinking / chain-of-thought modes directly improve hard cases.",
      "   For Anthropic: extended_thinking with meaningful budget_tokens is recommended.",
      "   For OpenAI: reasoning_effort 'high'. Don't use a fast/small model here — a weak model",
      "   burning all 8 turns is more expensive than a strong one converging in 3.",
      "2. Tool use reliability (critical): must call tools with correct schema on every turn.",
      "   95% per-call accuracy = 40% of 8-turn investigations fail. Native function calling required.",
      "3. Long-context coherence (important): by turn 5-6, context is 20,000-40,000 tokens.",
      "   Must remember what it already called and what results it already has.",
      "4. Calibrated self-knowledge (important): must know when evidence is conclusive and stop.",
      "   Over-confident models propose fixes from insufficient evidence.",
      "   Under-confident models exhaust the turn cap hedging without a verdict.",
      "5. Structured output fidelity (important): every turn must produce valid JSON matching",
      "   the output schema — hypothesis, confidence, decision type, payload.",
      "6. Instruction following under constraint (important): system prompt contains hard rules.",
      "   Models that follow complex multi-rule instruction sets under investigation pressure.",
      "",
      "WHAT IS NOT NEEDED",
      "Creative writing, web search, large output generation, or low-latency serving.",
      "This is a background worker; a 30-second model call per turn is acceptable.",
    ].join("\n"),
    requires: { toolUse: true, structuredOutput: true },
    fallbackModel: "claude-sonnet-4-6",
    fallbackEffort: "high",
  },
  explainer: {
    stage: "explainer",
    label: "Stage 3 — Explainer / Memory",
    modelKey: "stage_explainer_model",
    effortKey: "stage_explainer_effort",
    purpose:
      "Translates the completed investigation into a 2-5 sentence plain-language operator message " +
      "and up to 5 durable agent_memory entries. Single-shot, no tool use. Writing quality and " +
      "synthesis matter more than reasoning depth. Cheap, fast model is correct here.",
    spec: [
      "WHAT THIS STAGE DOES",
      "Stage 3 runs once after Stage 2 reaches a terminal decision (resolved or stuck).",
      "It has two outputs with different audiences:",
      "",
      "OUTPUT 1 — OPERATOR MESSAGE",
      "A 2-5 sentence plain-language summary for the NAS owner, who is non-technical.",
      "Must translate technical findings into human terms: what happened, what caused it,",
      "what was done or proposed, and what to watch for next.",
      "Posted to issue_messages with role='agent' — this is the final visible agent response.",
      "",
      "OUTPUT 2 — MEMORY ENTRIES (max 5)",
      "Durable agent_memory records extracted from this investigation.",
      "Each entry must be specific, non-obvious, and genuinely reusable.",
      "Generic observations ('ShareSync can fail') are not memory.",
      "Actionable specifics are: 'edgesynology1 ShareSync metadata DB becomes corrupted after",
      "a hard power cycle; symptom is error code 2006 in syncfolder log, not a generic alert;",
      "fix is DB repair via DSM package manager, not a restart.'",
      "",
      "Memory types:",
      "nas_profile: persistent hardware/software characteristics of a specific named NAS unit",
      "issue_pattern: recurring failure with a recognisable symptom signature and known response",
      "calibration: threshold or baseline insight for a specific metric on this system",
      "institutional: human-facing process, ownership, or escalation knowledge",
      "",
      "Stage 3 does NOT re-investigate. It receives the outcome and curated highlights.",
      "It is wrapped in try/catch — Stage 3 failure must never fail the issue resolution.",
      "",
      "WHAT CAPABILITIES MATTER MOST (in order)",
      "1. Writing quality and register calibration (critical): must produce clear, jargon-free",
      "   prose for a non-developer reader. The owner understands that things broke, not why.",
      "   A technically accurate but stiff, jargon-heavy summary fails the actual goal.",
      "2. Synthesis under compression (important): must compress a full investigation into",
      "   2-5 sentences, selecting the causal facts that matter and omitting the rest.",
      "3. Pattern extraction quality (important): must distinguish generalisable insights",
      "   (worth encoding as memory) from one-off incident state (not worth encoding).",
      "   Test: would a future Stage 2 make a materially better decision with this memory?",
      "4. Structured output fidelity (important): operator message string + typed memory array.",
      "",
      "WHAT IS NOT NEEDED",
      "Multi-step reasoning, extended thinking, tool use, long-context coherence across turns.",
      "The investigation is over — this stage communicates it.",
      "Do NOT waste extended_thinking budget or reasoning_effort here.",
      "A capable mid-tier model (Haiku, GPT-4o-mini, Gemini Flash) is the right choice.",
      "The quality difference vs a frontier model is small for this task; the cost difference is large.",
    ].join("\n"),
    requires: { toolUse: false, structuredOutput: true },
    fallbackModel: "gemini-3.1-flash-lite-preview",
    fallbackEffort: "low",
  },
};

/** Every ai_settings key owned by the 3-stage config (model + effort per stage). */
export const STAGE_SETTING_KEYS: readonly string[] = AI_STAGES.flatMap((s) => [
  STAGE_DESCRIPTORS[s].modelKey,
  STAGE_DESCRIPTORS[s].effortKey,
]);

/** Does a model satisfy a stage's capability requirements? */
export function modelSatisfiesStage(
  model: ModelDescriptor,
  stage: AiStage,
): boolean {
  const req = STAGE_DESCRIPTORS[stage].requires;
  if (req.toolUse && !model.toolUse) return false;
  if (req.structuredOutput && !model.structuredOutput) return false;
  return true;
}

/** Models offerable for a stage, gated by the capability matrix (§8.3). */
export function modelsForStage(stage: AiStage): readonly ModelDescriptor[] {
  return MODEL_CATALOG.filter((m) => modelSatisfiesStage(m, stage));
}
