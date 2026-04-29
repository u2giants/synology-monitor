/**
 * Load AI model settings from smon_ai_settings table.
 * Falls back to env vars, then hardcoded defaults.
 *
 * Uses the service-role admin client so settings are readable from any
 * context — including background issue-worker runs that have no user session.
 * The session-based client would silently return {} there (RLS requires
 * authenticated role), causing all getters to fall back to hardcoded defaults
 * and ignoring whatever the operator set in Settings.
 */

import { createAdminClient } from "@/lib/supabase/admin";

let cachedSettings: Record<string, string> | null = null;
let cacheTime = 0;
const CACHE_TTL = 60_000; // 1 minute

export const AI_SETTINGS_KEYS = [
  "diagnosis_model",
  "remediation_model",
  "second_opinion_model",
  "extractor_model",
  "cluster_model",
  "hypothesis_model",
  "planner_model",
  "remediation_planner_model",
  "explainer_model",
  "verifier_model",
  "hypothesis_reasoning_effort",
  "planner_reasoning_effort",
  "remediation_planner_reasoning_effort",
  "verifier_reasoning_effort",
  "guided_mode_default",
  "deep_mode_default",
  "deep_mode_model_override",
  "deep_mode_reasoning_override",
  "deep_mode_max_messages",
  "deep_mode_max_evidence",
  "deep_mode_include_raw_logs",
  "context_rebase_threshold_pct",
  "escalation_policy",
  "escalation_turn_budget_usd",
  "escalation_issue_budget_usd",
] as const;

export type AiSettingKey = (typeof AI_SETTINGS_KEYS)[number];
export type ModelReasoningEffort = "auto" | "minimal" | "low" | "medium" | "high";
export type InvestigationMode = "guided" | "deep";
export type EscalationPolicy =
  | "ask_always"
  | "auto_approve_read_only_under_budget"
  | "manual_for_model_switch_auto_for_reasoning";

export function clearAiSettingsCache() {
  cachedSettings = null;
  cacheTime = 0;
}

async function loadSettings(): Promise<Record<string, string>> {
  if (cachedSettings && Date.now() - cacheTime < CACHE_TTL) {
    return cachedSettings;
  }

  try {
    const supabase = createAdminClient();
    const { data } = await supabase.from("ai_settings").select("key, value");

    const settings: Record<string, string> = {};
    for (const row of data ?? []) {
      settings[row.key] = row.value;
    }

    cachedSettings = settings;
    cacheTime = Date.now();
    return settings;
  } catch (error) {
    console.error("ai-settings: failed to load smon_ai_settings, falling back to env/defaults", error);
    return cachedSettings ?? {};
  }
}

function getSetting(settings: Record<string, string>, key: AiSettingKey) {
  return settings[key];
}

function parseInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFloatSetting(value: string | undefined, fallback: number) {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function parseReasoningEffort(value: string | undefined, fallback: ModelReasoningEffort): ModelReasoningEffort {
  if (value === "auto" || value === "minimal" || value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return fallback;
}

function parseInvestigationMode(value: string | undefined, fallback: InvestigationMode): InvestigationMode {
  return value === "deep" || value === "guided" ? value : fallback;
}

function parseEscalationPolicy(value: string | undefined, fallback: EscalationPolicy): EscalationPolicy {
  if (
    value === "ask_always"
    || value === "auto_approve_read_only_under_budget"
    || value === "manual_for_model_switch_auto_for_reasoning"
  ) {
    return value;
  }
  return fallback;
}

export async function getDiagnosisModel(): Promise<string> {
  const settings = await loadSettings();
  return getSetting(settings, "diagnosis_model") || process.env.MINIMAX_MODEL || "minimax/minimax-m2.7";
}

export async function getRemediationModel(): Promise<string> {
  const settings = await loadSettings();
  return getSetting(settings, "remediation_model") || process.env.OPENAI_CHAT_MODEL || "openai/gpt-5.4";
}

export async function getSecondOpinionModel(): Promise<string> {
  const settings = await loadSettings();
  return getSetting(settings, "second_opinion_model") || "anthropic/claude-sonnet-4";
}

export async function getExtractorModel(): Promise<string> {
  const settings = await loadSettings();
  return getSetting(settings, "extractor_model") || getSetting(settings, "diagnosis_model") || process.env.MINIMAX_MODEL || "minimax/minimax-m2.7";
}

export async function getClusterModel(): Promise<string> {
  const settings = await loadSettings();
  return getSetting(settings, "cluster_model") || getSetting(settings, "diagnosis_model") || process.env.MINIMAX_MODEL || "minimax/minimax-m2.7";
}

export async function getHypothesisModel(): Promise<string> {
  const settings = await loadSettings();
  return getSetting(settings, "hypothesis_model") || settings.reasoner_model || getSetting(settings, "remediation_model") || process.env.OPENAI_CHAT_MODEL || "openai/gpt-5.4";
}

export async function getPlannerModel(): Promise<string> {
  const settings = await loadSettings();
  return getSetting(settings, "planner_model") || settings.reasoner_model || getSetting(settings, "remediation_model") || process.env.OPENAI_CHAT_MODEL || "openai/gpt-5.4";
}

export async function getRemediationPlannerModel(): Promise<string> {
  const settings = await loadSettings();
  return getSetting(settings, "remediation_planner_model") || settings.reasoner_model || getSetting(settings, "remediation_model") || process.env.OPENAI_CHAT_MODEL || "openai/gpt-5.4";
}

export async function getExplainerModel(): Promise<string> {
  const settings = await loadSettings();
  return getSetting(settings, "explainer_model") || getSetting(settings, "diagnosis_model") || process.env.MINIMAX_MODEL || "minimax/minimax-m2.7";
}

export async function getVerifierModel(): Promise<string> {
  const settings = await loadSettings();
  return getSetting(settings, "verifier_model") || getSetting(settings, "remediation_model") || process.env.OPENAI_CHAT_MODEL || "openai/gpt-5.4";
}

export async function getHypothesisReasoningEffort(): Promise<ModelReasoningEffort> {
  const settings = await loadSettings();
  return parseReasoningEffort(getSetting(settings, "hypothesis_reasoning_effort"), "medium");
}

export async function getPlannerReasoningEffort(): Promise<ModelReasoningEffort> {
  const settings = await loadSettings();
  return parseReasoningEffort(getSetting(settings, "planner_reasoning_effort"), "medium");
}

export async function getRemediationPlannerReasoningEffort(): Promise<ModelReasoningEffort> {
  const settings = await loadSettings();
  return parseReasoningEffort(getSetting(settings, "remediation_planner_reasoning_effort"), "medium");
}

export async function getVerifierReasoningEffort(): Promise<ModelReasoningEffort> {
  const settings = await loadSettings();
  return parseReasoningEffort(getSetting(settings, "verifier_reasoning_effort"), "medium");
}

export async function getGuidedModeDefault(): Promise<InvestigationMode> {
  const settings = await loadSettings();
  return parseInvestigationMode(getSetting(settings, "guided_mode_default"), "guided");
}

export async function getDeepModeDefault(): Promise<InvestigationMode> {
  const settings = await loadSettings();
  return parseInvestigationMode(getSetting(settings, "deep_mode_default"), "deep");
}

export async function getDeepModeModelOverride(): Promise<string> {
  const settings = await loadSettings();
  return getSetting(settings, "deep_mode_model_override") || "";
}

export async function getDeepModeReasoningOverride(): Promise<ModelReasoningEffort> {
  const settings = await loadSettings();
  return parseReasoningEffort(getSetting(settings, "deep_mode_reasoning_override"), "high");
}

export async function getDeepModeMaxMessages(): Promise<number> {
  const settings = await loadSettings();
  return parseInteger(getSetting(settings, "deep_mode_max_messages"), 80);
}

export async function getDeepModeMaxEvidence(): Promise<number> {
  const settings = await loadSettings();
  return parseInteger(getSetting(settings, "deep_mode_max_evidence"), 150);
}

export async function getDeepModeIncludeRawLogs(): Promise<boolean> {
  const settings = await loadSettings();
  return parseBoolean(getSetting(settings, "deep_mode_include_raw_logs"), true);
}

export async function getContextRebaseThresholdPct(): Promise<number> {
  const settings = await loadSettings();
  return parseInteger(getSetting(settings, "context_rebase_threshold_pct"), 80);
}

export async function getEscalationPolicy(): Promise<EscalationPolicy> {
  const settings = await loadSettings();
  return parseEscalationPolicy(getSetting(settings, "escalation_policy"), "ask_always");
}

export async function getEscalationTurnBudgetUsd(): Promise<number> {
  const settings = await loadSettings();
  return parseFloatSetting(getSetting(settings, "escalation_turn_budget_usd"), 0.25);
}

export async function getEscalationIssueBudgetUsd(): Promise<number> {
  const settings = await loadSettings();
  return parseFloatSetting(getSetting(settings, "escalation_issue_budget_usd"), 2);
}
