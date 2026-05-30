/**
 * Abstract effort level → provider-native reasoning control (PLAN.md §8.3, §9.2).
 *
 * The operator picks an abstract level (minimal | low | medium | high); each
 * provider shapes reasoning differently, so we map the abstract level onto the
 * concrete control here — or omit it entirely when the selected model has no
 * effort knob (DeepSeek's reasoner is a separate model, Qwen has none). The
 * provider client applies whatever this returns and nothing else, so an
 * unsupported parameter is never sent.
 */

import { getModelDescriptor, type EffortLevel } from "@synology-monitor/shared";

export interface AnthropicEffort {
  kind: "anthropic";
  /** Extended-thinking budget; omitted (undefined) when thinking is off. */
  thinkingBudgetTokens?: number;
  /** Anthropic requires temperature = 1 whenever extended thinking is enabled (§9.2). */
  temperature?: number;
}

export interface OpenAIEffort {
  kind: "openai";
  reasoningEffort: EffortLevel;
}

export interface GeminiEffort {
  kind: "gemini";
  /** thinkingConfig.thinkingBudget; 0 disables thinking. */
  thinkingBudgetTokens: number;
}

export interface NoEffort {
  kind: "none";
}

export type ProviderEffort = AnthropicEffort | OpenAIEffort | GeminiEffort | NoEffort;

// Token budgets for the graded-budget providers. Conservative defaults — re-tune
// against real pricing/quality once Stage 2 is exercised (PLAN.md §13).
const THINKING_BUDGET: Record<EffortLevel, number> = {
  minimal: 0,
  low: 4_000,
  medium: 8_000,
  high: 16_000,
};

export function mapEffort(modelId: string, level: EffortLevel): ProviderEffort {
  const descriptor = getModelDescriptor(modelId);
  if (!descriptor) return { kind: "none" };

  switch (descriptor.effortControl) {
    case "anthropic_budget": {
      const budget = THINKING_BUDGET[level];
      return budget > 0
        ? { kind: "anthropic", thinkingBudgetTokens: budget, temperature: 1 }
        : { kind: "anthropic" };
    }
    case "openai_enum":
      return { kind: "openai", reasoningEffort: level };
    case "gemini_thinking":
      return { kind: "gemini", thinkingBudgetTokens: THINKING_BUDGET[level] };
    case "separate_model":
    case "none":
    default:
      return { kind: "none" };
  }
}
