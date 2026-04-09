/**
 * Load AI model settings from smon_ai_settings table.
 * Falls back to env vars, then hardcoded defaults.
 */

import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";

let cachedSettings: Record<string, string> | null = null;
let cacheTime = 0;
const CACHE_TTL = 60_000; // 1 minute

async function loadSettings(): Promise<Record<string, string>> {
  if (cachedSettings && Date.now() - cacheTime < CACHE_TTL) {
    return cachedSettings;
  }

  try {
    const supabase = await createSupabaseServerClient();
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

export async function getReasonerModel(): Promise<string> {
  const settings = await loadSettings();
  return settings.reasoner_model || settings.remediation_model || process.env.OPENAI_CHAT_MODEL || "openai/gpt-5.4";
}

export async function getExplainerModel(): Promise<string> {
  const settings = await loadSettings();
  return settings.explainer_model || settings.diagnosis_model || process.env.MINIMAX_MODEL || "minimax/minimax-m2.7";
}

export async function getVerifierModel(): Promise<string> {
  const settings = await loadSettings();
  return settings.verifier_model || settings.remediation_model || process.env.OPENAI_CHAT_MODEL || "openai/gpt-5.4";
}
