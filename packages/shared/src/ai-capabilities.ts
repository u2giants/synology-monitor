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
  /** Short purpose blurb (also feeds the §8.1 copy-spec button). */
  purpose: string;
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
      "One agentic, cached, resumable loop: holds a stable cached prefix + a " +
      "bounded evidence slice, pulls more evidence/live NAS data on demand via " +
      "tools, and resumes from DB state across approval gates. Strong, high " +
      "effort. Requires tool use.",
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
      "Operator-facing reply + durable agent_memory entries. Cheap, low " +
      "effort, single-shot.",
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
