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
import { addUsage, emptyUsage, normalizeDeepSeek, normalizeOpenAI, normalizeQwen } from "../usage";
import type { CompiledContext } from "../context-compiler";
import {
  AiCallError,
  classifyStatus,
  type ChatMessage,
  type ModelCallParams,
  type ModelCallResult,
  type ProviderClient,
  type ToolCallRecord,
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
  /**
   * Send OpenAI's `prompt_cache_key` routing hint. Native OpenAI only — other
   * OpenAI-compatible servers (DeepSeek, Qwen) may reject the unknown field, and
   * their prefix caches don't use it.
   */
  sendPromptCacheKey?: boolean;
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

      const messages = buildOpenAIMessages(
        context,
        params.messages ?? [],
      ) as OpenAI.Chat.ChatCompletionMessageParam[];

      const tools: OpenAI.Chat.ChatCompletionTool[] | undefined = params.tools?.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
      const maxIterations = params.maxToolIterations ?? 8;

      const toolCalls: ToolCallRecord[] = [];
      let usage = emptyUsage();
      let rawUsage: unknown = null;
      let finishReason: string | null = null;
      let responseId: string | undefined;
      let toolIterationsExhausted = false;

      try {
        for (let iter = 0; ; iter += 1) {
          const forceFinal = tools && iter + 1 >= maxIterations;
          const body: Record<string, unknown> = {
            model: params.model,
            messages,
            [config.maxTokensField]: params.maxTokens,
          };
          if (params.json) body.response_format = { type: "json_object" };
          if (effort.kind === "openai") body.reasoning_effort = effort.reasoningEffort;
          if (config.sendPromptCacheKey && params.cacheKey) body.prompt_cache_key = params.cacheKey;
          if (tools) {
            body.tools = tools;
            body.tool_choice = forceFinal ? "none" : "auto";
          }

          const response = (await openai.chat.completions.create(
            body as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
            { signal: params.signal },
          )) as OpenAI.Chat.ChatCompletion;

          usage = addUsage(usage, config.normalize(response.usage));
          rawUsage = response.usage;
          responseId = response.id;
          const choice = response.choices[0];
          finishReason = choice?.finish_reason ?? null;
          const requested = choice?.message?.tool_calls ?? [];

          if (!tools || !params.executeTool || requested.length === 0) {
            const text = choice?.message?.content ?? "";
            if (!text) {
              throw new AiCallError(
                "unknown",
                config.provider,
                `empty content (finish_reason=${finishReason ?? "unknown"}, model=${params.model})`,
              );
            }
            return {
              text,
              usage,
              rawUsage,
              finishReason,
              cacheStyle: config.cacheStyle,
              responseId,
              toolCalls,
              toolIterationsExhausted,
            };
          }

          // Echo the assistant tool-call turn, then append each tool result.
          messages.push(choice.message as OpenAI.Chat.ChatCompletionMessageParam);
          for (const call of requested) {
            if (call.type !== "function") continue;
            const input = safeParseArgs(call.function.arguments);
            const out = await params.executeTool({ id: call.id, name: call.function.name, input });
            toolCalls.push({
              id: call.id,
              name: call.function.name,
              input,
              result: out.content,
              isError: !!out.isError,
            });
            messages.push({ role: "tool", tool_call_id: call.id, content: out.content });
          }
          if (forceFinal) toolIterationsExhausted = true;
        }
      } catch (err) {
        throw toAiError(err, config.provider);
      }
    },
  };
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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
  sendPromptCacheKey: true,
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
