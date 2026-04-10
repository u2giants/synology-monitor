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
    const { data } = await supabase.from("smon_ai_settings").select("key, value");

    const settings: Record<string, string> = {};
    for (const row of data ?? []) {
      settings[row.key] = row.value;
    }

    cachedSettings = settings;
    cacheTime = Date.now();
    return settings;
  } catch {
    return cachedSettings ?? {};
  }
}

export async function getDiagnosisModel(): Promise<string> {
  const settings = await loadSettings();
  return settings.diagnosis_model || process.env.MINIMAX_MODEL || "minimax/minimax-m2.7";
}

export async function getRemediationModel(): Promise<string> {
  const settings = await loadSettings();
  return settings.remediation_model || process.env.OPENAI_CHAT_MODEL || "openai/gpt-5.4";
}

export async function getSecondOpinionModel(): Promise<string> {
  const settings = await loadSettings();
  return settings.second_opinion_model || "anthropic/claude-sonnet-4";
}

export async function getExtractorModel(): Promise<string> {
  const settings = await loadSettings();
  return settings.extractor_model || settings.diagnosis_model || process.env.MINIMAX_MODEL || "minimax/minimax-m2.7";
}

export async function getClusterModel(): Promise<string> {
  const settings = await loadSettings();
  return settings.cluster_model || settings.diagnosis_model || process.env.MINIMAX_MODEL || "minimax/minimax-m2.7";
}

export async function getHypothesisModel(): Promise<string> {
  const settings = await loadSettings();
  return settings.hypothesis_model || settings.reasoner_model || settings.remediation_model || process.env.OPENAI_CHAT_MODEL || "openai/gpt-5.4";
}

export async function getPlannerModel(): Promise<string> {
  const settings = await loadSettings();
  return settings.planner_model || settings.reasoner_model || settings.remediation_model || process.env.OPENAI_CHAT_MODEL || "openai/gpt-5.4";
}

export async function getRemediationPlannerModel(): Promise<string> {
  const settings = await loadSettings();
  return settings.remediation_planner_model || settings.reasoner_model || settings.remediation_model || process.env.OPENAI_CHAT_MODEL || "openai/gpt-5.4";
}

export async function getExplainerModel(): Promise<string> {
  const settings = await loadSettings();
  return settings.explainer_model || settings.diagnosis_model || process.env.MINIMAX_MODEL || "minimax/minimax-m2.7";
}

export async function getVerifierModel(): Promise<string> {
  const settings = await loadSettings();
  return settings.verifier_model || settings.remediation_model || process.env.OPENAI_CHAT_MODEL || "openai/gpt-5.4";
}
