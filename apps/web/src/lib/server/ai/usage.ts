/**
 * Normalized usage accounting (PLAN.md §9.5).
 *
 * Each provider reports token usage in a DIFFERENT shape (DeepSeek and Gemini in
 * particular use non-OpenAI field names). We normalize every provider into one
 * struct so cache observability survives — an un-normalized provider silently
 * reads 0% cache-hit and you can't tune what you can't see (§9.6). We persist
 * BOTH this normalized struct and the raw native usage object (never flatten the
 * raw — §9.1).
 *
 * Definition: `inputTokens` is the TOTAL prompt token count INCLUDING cached
 * reads, so `cacheHitRatio = cachedInputTokens / inputTokens` is meaningful
 * across providers even though Anthropic reports cached reads as separate fields.
 */

import type { AiProvider } from "@synology-monitor/shared";

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export function emptyUsage(): NormalizedUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
}

export function cacheHitRatio(u: NormalizedUsage): number {
  return u.inputTokens > 0 ? u.cachedInputTokens / u.inputTokens : 0;
}

/** Sum usage across multiple model rounds (e.g. an in-turn tool loop). */
export function addUsage(a: NormalizedUsage, b: NormalizedUsage): NormalizedUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

// Defensive readers — provider SDKs type usage loosely / fields can be absent.
function num(obj: unknown, ...path: string[]): number {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur && typeof cur === "object" && key in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return 0;
    }
  }
  return typeof cur === "number" && Number.isFinite(cur) ? cur : 0;
}

/**
 * Anthropic: input_tokens EXCLUDES cache reads/writes (they are separate fields),
 * so total input = input_tokens + cache_read + cache_creation.
 * Thinking tokens are folded into output_tokens (not separately reported).
 */
export function normalizeAnthropic(raw: unknown): NormalizedUsage {
  const cacheRead = num(raw, "cache_read_input_tokens");
  const cacheWrite = num(raw, "cache_creation_input_tokens");
  const uncachedInput = num(raw, "input_tokens");
  return {
    inputTokens: uncachedInput + cacheRead + cacheWrite,
    outputTokens: num(raw, "output_tokens"),
    cachedInputTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: 0,
  };
}

/** OpenAI (and Qwen/DashScope, which is OpenAI-compatible): prompt_tokens INCLUDES cached. */
export function normalizeOpenAI(raw: unknown): NormalizedUsage {
  return {
    inputTokens: num(raw, "prompt_tokens"),
    outputTokens: num(raw, "completion_tokens"),
    cachedInputTokens: num(raw, "prompt_tokens_details", "cached_tokens"),
    cacheWriteTokens: 0, // automatic prefix cache — writes are not billed/reported
    reasoningTokens: num(raw, "completion_tokens_details", "reasoning_tokens"),
  };
}

export const normalizeQwen = normalizeOpenAI;

/** DeepSeek: prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens (non-OpenAI shape). */
export function normalizeDeepSeek(raw: unknown): NormalizedUsage {
  const hit = num(raw, "prompt_cache_hit_tokens");
  const miss = num(raw, "prompt_cache_miss_tokens");
  const prompt = num(raw, "prompt_tokens") || hit + miss;
  return {
    inputTokens: prompt,
    outputTokens: num(raw, "completion_tokens"),
    cachedInputTokens: hit,
    cacheWriteTokens: 0,
    reasoningTokens: num(raw, "completion_tokens_details", "reasoning_tokens"),
  };
}

/** Gemini: usageMetadata with promptTokenCount / candidatesTokenCount / cachedContentTokenCount / thoughtsTokenCount. */
export function normalizeGemini(raw: unknown): NormalizedUsage {
  return {
    inputTokens: num(raw, "promptTokenCount"),
    outputTokens: num(raw, "candidatesTokenCount"),
    cachedInputTokens: num(raw, "cachedContentTokenCount"),
    cacheWriteTokens: 0, // explicit cachedContent creation billed separately, not in usage
    reasoningTokens: num(raw, "thoughtsTokenCount"),
  };
}

/**
 * Registry — exactly one normalizer per provider. The CI guard (§9.7 #3) asserts
 * every AiProvider has an entry, so adding a provider without a normalizer fails
 * the build instead of silently reporting 0% cache usage.
 */
export const USAGE_NORMALIZERS: Record<AiProvider, (raw: unknown) => NormalizedUsage> = {
  anthropic: normalizeAnthropic,
  openai: normalizeOpenAI,
  gemini: normalizeGemini,
  deepseek: normalizeDeepSeek,
  qwen: normalizeQwen,
};

export function normalizeUsage(provider: AiProvider, raw: unknown): NormalizedUsage {
  return (USAGE_NORMALIZERS[provider] ?? (() => emptyUsage()))(raw);
}
