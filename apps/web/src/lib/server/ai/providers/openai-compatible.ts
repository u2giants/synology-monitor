/**
 * OpenAI-compatible provider clients (PLAN.md §9.2).
 *
 * One factory serves three providers that all speak the OpenAI Chat Completions
 * wire format but differ in base URL, API key, usage shape, and cache style:
 *   - OpenAI    — automatic prefix cache; reasoning_effort enum
 *   - DeepSeek  — automatic disk-backed prefix cache; DeepSeek-specific usage
 *                 fields (prompt_cache_hit_tokens / _miss_tokens)
 *   - Qwen/DashScope — markers + session id; OpenAI-style usage
 *
 * Prefix caching is automatic for these providers, so the client just keeps the
 * stable prefix first (the system message) and resends multi-turn history as
 * messages. Native usage passes through untouched; the per-provider normalizer
 * is injected so DeepSeek's non-OpenAI fields are read correctly (§9.5/§9.6).
 */

import OpenAI from "openai";
import type { AiProvider, CacheStyle } from "@synology-monitor/shared";
import type { NormalizedUsage } from "../usage";
import { normalizeDeepSeek, normalizeOpenAI, normalizeQwen } from "../usage";
import type { CompiledContext } from "../context-compiler";
import {
  AiCallError,
  classifyStatus,
  type ChatMessage,
  type ModelCallParams,
  type ModelCallResult,
  type ProviderClient,
} from "./types";

/**
 * Build the OpenAI-style message list: system (stable prefix) → every prior turn
 * IN ORDER → the latest dynamic instruction. Prior turns are never dropped or
 * merged (§9.6). Pure — exported for the §9.7 "multi-turn history preserved" CI guard.
 */
export function buildOpenAIMessages(
  context: CompiledContext,
  priorMessages: ChatMessage[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  return [
    { role: "system", content: context.stableText },
    ...priorMessages.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: context.dynamicText },
  ];
}

interface OpenAICompatConfig {
  provider: AiProvider;
  keyEnv: string;
  /** Extra fallback env vars for the key. */
  keyEnvFallbacks?: string[];
  baseURL?: string;
  baseUrlEnv?: string;
  cacheStyle: CacheStyle;
  normalize: (raw: unknown) => NormalizedUsage;
  /** Reasoning models want max_completion_tokens; classic chat wants max_tokens. */
  maxTokensField: "max_tokens" | "max_completion_tokens";
}

function makeClient(config: OpenAICompatConfig): ProviderClient {
  let sdk: OpenAI | null = null;

  const getSdk = (): OpenAI => {
    if (sdk) return sdk;
    const key =
      process.env[config.keyEnv] ??
      config.keyEnvFallbacks?.map((e) => process.env[e]).find(Boolean);
    if (!key) {
      throw new AiCallError(
        "missing_key",
        config.provider,
        `${config.keyEnv} is not configured.`,
      );
    }
    const baseURL = (config.baseUrlEnv && process.env[config.baseUrlEnv]) || config.baseURL;
    sdk = new OpenAI({ apiKey: key, baseURL, maxRetries: 2, timeout: 120_000 });
    return sdk;
  };

  return {
    provider: config.provider,
    async call(params: ModelCallParams): Promise<ModelCallResult> {
      const openai = getSdk();
      const { context, effort } = params;

      const messages = buildOpenAIMessages(context, params.messages ?? []);

      const body: Record<string, unknown> = {
        model: params.model,
        messages,
        [config.maxTokensField]: params.maxTokens,
      };
      if (params.json) body.response_format = { type: "json_object" };
      if (effort.kind === "openai") body.reasoning_effort = effort.reasoningEffort;

      try {
        const response = (await openai.chat.completions.create(
          body as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
          { signal: params.signal },
        )) as OpenAI.Chat.ChatCompletion;

        const choice = response.choices[0];
        const text = choice?.message?.content ?? "";
        if (!text) {
          throw new AiCallError(
            "unknown",
            config.provider,
            `empty content (finish_reason=${choice?.finish_reason ?? "unknown"}, model=${params.model})`,
          );
        }

        return {
          text,
          usage: config.normalize(response.usage),
          rawUsage: response.usage,
          finishReason: choice?.finish_reason ?? null,
          cacheStyle: config.cacheStyle,
          responseId: response.id,
        };
      } catch (err) {
        throw toAiError(err, config.provider);
      }
    },
  };
}

function toAiError(err: unknown, provider: AiProvider): AiCallError {
  if (err instanceof AiCallError) return err;
  const status = err instanceof OpenAI.APIError ? err.status : undefined;
  return new AiCallError(classifyStatus(status), provider, err instanceof Error ? err.message : String(err), {
    status,
    cause: err,
  });
}

export const openaiClient = makeClient({
  provider: "openai",
  keyEnv: "OPENAI_API_KEY",
  cacheStyle: "automatic_prefix",
  normalize: normalizeOpenAI,
  maxTokensField: "max_completion_tokens",
});

export const deepseekClient = makeClient({
  provider: "deepseek",
  keyEnv: "DEEPSEEK_API_KEY",
  baseURL: "https://api.deepseek.com",
  baseUrlEnv: "DEEPSEEK_BASE_URL",
  cacheStyle: "automatic_prefix",
  normalize: normalizeDeepSeek,
  maxTokensField: "max_tokens",
});

export const qwenClient = makeClient({
  provider: "qwen",
  keyEnv: "DASHSCOPE_API_KEY",
  baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  baseUrlEnv: "DASHSCOPE_BASE_URL",
  cacheStyle: "markers_session",
  normalize: normalizeQwen,
  maxTokensField: "max_tokens",
});
