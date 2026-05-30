/**
 * Load AI model settings from ai_settings table.
 * Falls back to env vars, then hardcoded defaults.
 *
 * Uses the service-role admin client so settings are readable from any
 * context — including background issue-worker runs that have no user session.
 * The session-based client would silently return {} there (RLS requires
 * authenticated role), causing all getters to fall back to hardcoded defaults
 * and ignoring whatever the operator set in Settings.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import {
  STAGE_DESCRIPTORS,
  isEffortLevel,
  type AiStage,
  type EffortLevel,
} from "@synology-monitor/shared";

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
    const { data } = await supabase.from("ai_settings").select("key, value");

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

export async function getClusterModel(): Promise<string> {
  const settings = await loadSettings();
  return settings.cluster_model || settings.diagnosis_model || process.env.MINIMAX_MODEL || "minimax/minimax-m2.7";
}

// === 3-stage issue-agent rebuild config (PLAN.md §8.1/§8.2) ===
//
// The rebuild consolidates the seven stage keys above into three stages, each
// with a (model, abstract effort level) pair. The operator's runtime choice
// always overrides, but every stage keeps a hardcoded final-fallback (from the
// shared capability matrix) so a cold/empty ai_settings still boots instead of
// crashing — read via the same admin client so the background worker sees it.
//
// These getters are NOT yet consumed by the live pipeline; the 7-stage path
// above keeps running until Stages 1–3 are wired in (build steps 3–6). Keeping
// this additive means step 1 cannot regress the running pipeline.

export interface StageModelConfig {
  model: string;
  effort: EffortLevel;
}

export async function getStageConfig(stage: AiStage): Promise<StageModelConfig> {
  const settings = await loadSettings();
  const desc = STAGE_DESCRIPTORS[stage];
  const model = settings[desc.modelKey]?.trim() || desc.fallbackModel;
  const rawEffort = settings[desc.effortKey]?.trim();
  const effort: EffortLevel =
    rawEffort && isEffortLevel(rawEffort) ? rawEffort : desc.fallbackEffort;
  return { model, effort };
}

export function getStructurerConfig(): Promise<StageModelConfig> {
  return getStageConfig("structurer");
}

export function getReasoningConfig(): Promise<StageModelConfig> {
  return getStageConfig("reasoning");
}

export function getExplainerConfig(): Promise<StageModelConfig> {
  return getStageConfig("explainer");
}
