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

import { getModelDescriptor, type AiStage, type EffortLevel } from "@synology-monitor/shared";
import { createAdminClient } from "@/lib/supabase/admin";
import { compileContext, type PromptBlock } from "./context-compiler";
import { mapEffort } from "./effort";
import { cacheHitRatio } from "./usage";
import { getProviderClient, type ChatMessage, type ModelCallResult } from "./providers";

export interface CallModelOptions {
  model: string;
  effort: EffortLevel;
  blocks: PromptBlock[];
  messages?: ChatMessage[];
  maxTokens?: number;
  json?: boolean;
  signal?: AbortSignal;
  previousResponseId?: string;
  /** Optional observability context. */
  stage?: AiStage;
  issueId?: string;
}

export interface CallModelResult extends ModelCallResult {
  stablePrefixHash: string;
}

export async function callModel(opts: CallModelOptions): Promise<CallModelResult> {
  const descriptor = getModelDescriptor(opts.model);
  if (!descriptor) {
    throw new Error(
      `callModel: unknown model "${opts.model}". Add it to the capability matrix ` +
        `(packages/shared/src/ai-capabilities.ts) before selecting it.`,
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
