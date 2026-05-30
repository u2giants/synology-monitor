/**
 * Anthropic provider client (PLAN.md §9.2 — explicit cache_control).
 *
 * Caching: the stable+semi-stable prefix goes into `system` as text blocks with
 * an ephemeral cache_control breakpoint on the LAST block, so the whole prefix
 * caches. For multi-turn (Stage 2) we add a second breakpoint on the penultimate
 * message so prior turns cache while the latest turn stays dynamic. Min cacheable
 * size and temperature=1-with-thinking caveats are handled here. Native usage
 * (input/output/cache_creation/cache_read) passes through untouched.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { CompiledContext } from "../context-compiler";
import { addUsage, emptyUsage, normalizeAnthropic } from "../usage";
import {
  AiCallError,
  type ModelCallParams,
  type ModelCallResult,
  type ProviderClient,
  type ToolCallRecord,
} from "./types";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AiCallError("missing_key", "anthropic", "ANTHROPIC_API_KEY is not configured.");
  }
  client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  return client;
}

// Below this the cache write is not worth a breakpoint (§9.2: ~1024 Sonnet / ~2048 Haiku).
const MIN_CACHEABLE_CHARS = 4_000; // ~1k tokens, char-approx; conservative.

const EPHEMERAL = { type: "ephemeral" as const };

/**
 * Build the Anthropic `system` blocks for the cacheable stable prefix.
 * Pure — exported for the §9.7 caching CI guard.
 */
export function buildAnthropicSystem(context: CompiledContext): Anthropic.TextBlockParam[] {
  const cachePrefix = context.stableText.length >= MIN_CACHEABLE_CHARS;
  return [
    {
      type: "text",
      text: context.stableText,
      ...(cachePrefix ? { cache_control: EPHEMERAL } : {}),
    },
  ];
}

/**
 * Build the Anthropic message list: every prior turn (rebuilt from the persisted
 * transcript) IN ORDER, plus the latest dynamic instruction turn. The penultimate
 * message gets a cache breakpoint so prior turns cache while the newest stays
 * dynamic — but no prior turn is ever dropped or merged (§9.6). Pure — exported
 * for the §9.7 "multi-turn history preserved" CI guard.
 */
export function buildAnthropicMessages(
  context: CompiledContext,
  priorMessages: { role: "user" | "assistant"; content: string }[],
): Anthropic.MessageParam[] {
  const canCache = context.stableText.length >= MIN_CACHEABLE_CHARS;
  const messages: Anthropic.MessageParam[] = priorMessages.map((m, i) => {
    const isPenultimate = i === priorMessages.length - 1 && canCache;
    return {
      role: m.role,
      content: isPenultimate
        ? [{ type: "text" as const, text: m.content, cache_control: EPHEMERAL }]
        : m.content,
    };
  });
  messages.push({ role: "user", content: context.dynamicText });
  return messages;
}

export const anthropicClient: ProviderClient = {
  provider: "anthropic",
  async call(params: ModelCallParams): Promise<ModelCallResult> {
    const anthropic = getClient();
    const { context, effort } = params;

    const system = buildAnthropicSystem(context);
    const messages = buildAnthropicMessages(context, params.messages ?? []);

    const thinkingOn = effort.kind === "anthropic" && effort.thinkingBudgetTokens !== undefined;
    const budget = effort.kind === "anthropic" ? effort.thinkingBudgetTokens ?? 0 : 0;
    // max_tokens must exceed the thinking budget.
    const maxTokens = thinkingOn ? Math.max(params.maxTokens, budget + 1_024) : params.maxTokens;

    const tools: Anthropic.Tool[] | undefined = params.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    }));
    const maxIterations = params.maxToolIterations ?? 8;

    const toolCalls: ToolCallRecord[] = [];
    let usage = emptyUsage();
    let rawUsage: unknown = null;
    let finishReason: string | null = null;
    let toolIterationsExhausted = false;

    try {
      // In-turn agentic loop: the model may call read-only tools, get results,
      // and loop, until it produces a final answer (or hits the iteration cap).
      for (let iter = 0; ; iter += 1) {
        const response = await anthropic.messages.create(
          {
            model: params.model,
            max_tokens: maxTokens,
            system,
            messages,
            ...(tools ? { tools } : {}),
            ...(thinkingOn
              ? { temperature: 1, thinking: { type: "enabled", budget_tokens: budget } }
              : {}),
          },
          { signal: params.signal },
        );

        usage = addUsage(usage, normalizeAnthropic(response.usage));
        rawUsage = response.usage;
        finishReason = response.stop_reason ?? null;

        const toolUses = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
        );

        if (response.stop_reason !== "tool_use" || toolUses.length === 0 || !params.executeTool) {
          const text = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("");
          return {
            text,
            usage,
            rawUsage,
            finishReason,
            cacheStyle: "explicit_cache_control",
            toolCalls,
            toolIterationsExhausted,
          };
        }

        // Execute each requested tool and feed results back as a user turn.
        messages.push({ role: "assistant", content: response.content });
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const use of toolUses) {
          const input = (use.input ?? {}) as Record<string, unknown>;
          const out = await params.executeTool({ id: use.id, name: use.name, input });
          toolCalls.push({ id: use.id, name: use.name, input, result: out.content, isError: !!out.isError });
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: out.content,
            ...(out.isError ? { is_error: true } : {}),
          });
        }
        messages.push({ role: "user", content: results });

        if (iter + 1 >= maxIterations) {
          // Force a final answer with no further tool use.
          toolIterationsExhausted = true;
          const final = await anthropic.messages.create(
            {
              model: params.model,
              max_tokens: maxTokens,
              system,
              messages,
              tool_choice: { type: "none" },
              ...(tools ? { tools } : {}),
              ...(thinkingOn
                ? { temperature: 1, thinking: { type: "enabled", budget_tokens: budget } }
                : {}),
            },
            { signal: params.signal },
          );
          usage = addUsage(usage, normalizeAnthropic(final.usage));
          rawUsage = final.usage;
          finishReason = final.stop_reason ?? null;
          const text = final.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("");
          return {
            text,
            usage,
            rawUsage,
            finishReason,
            cacheStyle: "explicit_cache_control",
            toolCalls,
            toolIterationsExhausted,
          };
        }
      }
    } catch (err) {
      throw toAiError(err);
    }
  },
};

function toAiError(err: unknown): AiCallError {
  if (err instanceof AiCallError) return err;
  const status = err instanceof Anthropic.APIError ? err.status : undefined;
  let kind: "auth" | "rate_limit" | "overloaded" | "timeout" | "bad_request" | "unknown" = "unknown";
  if (status === 401 || status === 403) kind = "auth";
  else if (status === 429) kind = "rate_limit";
  else if (status === 529 || status === 503) kind = "overloaded";
  else if (status === 408 || status === 504) kind = "timeout";
  else if (typeof status === "number" && status >= 400 && status < 500) kind = "bad_request";
  return new AiCallError(kind, "anthropic", err instanceof Error ? err.message : String(err), {
    status,
    cause: err,
  });
}
