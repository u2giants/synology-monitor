/**
 * callModel — the one entry point for the 3-stage rebuild's inference (PLAN.md
 * §9). It ties the pieces together:
 *   1. resolve the provider from the (provider-native) model id via the matrix,
 *   2. compile the prompt blocks stable→dynamic (THROWS on bad ordering — §9.1.2),
 *   3. map the abstract effort level to the provider's native shape,
 *   4. call the native provider client (native cache controls + raw usage),
 *   5. normalize + persist usage (normalized AND raw) for cache observability.
 *
 * The cache is never load-bearing (§9.4): callers rebuild `blocks`/`messages`
 * from the persisted transcript on every turn/resume; a cache hit only saves
 * money. Usage persistence is best-effort — a logging failure never fails the
 * model call.
 */

import { resolveModelDescriptor, type AiStage, type EffortLevel } from "@synology-monitor/shared";
import { createAdminClient } from "@/lib/supabase/admin";
import { compileContext, type PromptBlock } from "./context-compiler";
import { mapEffort } from "./effort";
import { resolveLiveDescriptor } from "./provider-models";
import { cacheHitRatio } from "./usage";
import {
  getProviderClient,
  type ChatMessage,
  type ModelCallResult,
  type ToolExecutor,
  type ToolSchema,
} from "./providers";

export interface CallModelOptions {
  model: string;
  effort: EffortLevel;
  blocks: PromptBlock[];
  messages?: ChatMessage[];
  maxTokens?: number;
  json?: boolean;
  signal?: AbortSignal;
  previousResponseId?: string;
  /** Tools the model may call this turn (read-only ones executed inline). */
  tools?: ToolSchema[];
  executeTool?: ToolExecutor;
  maxToolIterations?: number;
  /** Optional observability context. */
  stage?: AiStage;
  issueId?: string;
}

export interface CallModelResult extends ModelCallResult {
  stablePrefixHash: string;
}

export async function callModel(opts: CallModelOptions): Promise<CallModelResult> {
  // Catalog entries carry hand-verified metadata; catalog-miss ids are derived
  // from the provider-native id (the dropdowns are live, not curated). When even
  // that fails — an off-pattern id like a third-party model hosted on DashScope —
  // recover the provider from the live provider-model map, which was built keyed
  // by the endpoint that returned each id. We only fail when no connected
  // provider offers the id at all, so the call genuinely can't be routed.
  const descriptor =
    resolveModelDescriptor(opts.model) ?? (await resolveLiveDescriptor(opts.model));
  if (!descriptor) {
    throw new Error(
      `callModel: "${opts.model}" is not offered by any connected provider. ` +
        `Pick a model from the AI-stages dropdown, or confirm the provider's API key is set.`,
    );
  }

  const context = compileContext(opts.blocks); // throws ContextOrderingError on bad ordering
  const effort = mapEffort(opts.model, opts.effort);
  const client = getProviderClient(descriptor.provider);

  const result = await client.call({
    model: opts.model,
    context,
    messages: opts.messages,
    effort,
    maxTokens: opts.maxTokens ?? 8_192,
    json: opts.json,
    signal: opts.signal,
    previousResponseId: opts.previousResponseId,
    tools: opts.tools,
    executeTool: opts.executeTool,
    maxToolIterations: opts.maxToolIterations,
    // Key by stage (not turn/issue): every call for a stage shares the same
    // stable prefix, so they should route to the same OpenAI prompt cache.
    cacheKey: opts.stage ? `synmon-${opts.stage}` : undefined,
  });

  await recordUsage(opts, descriptor.provider, context.stablePrefixHash, result);

  return { ...result, stablePrefixHash: context.stablePrefixHash };
}

async function recordUsage(
  opts: CallModelOptions,
  provider: string,
  stablePrefixHash: string,
  result: ModelCallResult,
): Promise<void> {
  try {
    const supabase = createAdminClient();
    const u = result.usage;
    await supabase.from("ai_model_calls").insert({
      issue_id: opts.issueId ?? null,
      stage: opts.stage ?? null,
      provider,
      model: opts.model,
      effort: opts.effort,
      stable_prefix_hash: stablePrefixHash,
      input_tokens: u.inputTokens,
      output_tokens: u.outputTokens,
      cached_input_tokens: u.cachedInputTokens,
      cache_write_tokens: u.cacheWriteTokens,
      reasoning_tokens: u.reasoningTokens,
      cache_hit_ratio: cacheHitRatio(u),
      finish_reason: result.finishReason,
      raw_usage: result.rawUsage ?? null,
    });
  } catch {
    // Observability must never break inference (§9.4). Swallow logging errors.
  }
}
