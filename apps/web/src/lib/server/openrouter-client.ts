import OpenAI from "openai";
import type { ModelReasoningEffort } from "@/lib/server/ai-settings";

type SupportedReasoningEffort = ModelReasoningEffort | "xhigh";

export interface OpenRouterUsage {
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  total_tokens?: number;
}

export interface OpenRouterCallMetadata {
  provider?: string;
  model?: string;
  reasoning_effort?: SupportedReasoningEffort;
}

export interface OpenRouterCallResult<T> {
  response: T;
  usage: OpenRouterUsage;
  metadata: OpenRouterCallMetadata;
}

export function getOpenRouterClient() {
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY or OPENAI_API_KEY is not configured.");
  }

  return new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
  });
}

function extractUsage(usage: Record<string, unknown> | null | undefined): OpenRouterUsage {
  if (!usage) return {};

  const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
  const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;

  return {
    input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
    output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
    total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : undefined,
    reasoning_tokens:
      typeof outputDetails?.reasoning_tokens === "number"
        ? (outputDetails.reasoning_tokens as number)
        : typeof inputDetails?.reasoning_tokens === "number"
          ? (inputDetails.reasoning_tokens as number)
          : undefined,
  };
}

function buildReasoning(reasoningEffort?: SupportedReasoningEffort) {
  if (!reasoningEffort || reasoningEffort === "auto") return undefined;
  return { effort: reasoningEffort === "xhigh" ? "high" : reasoningEffort };
}

export async function runOpenRouterChatCompletion(input: {
  model: string;
  prompt: string;
  maxTokens?: number;
  reasoningEffort?: SupportedReasoningEffort;
}): Promise<OpenRouterCallResult<OpenAI.Chat.Completions.ChatCompletion> & { raw: string | null }> {
  const client = getOpenRouterClient();
  const response = await client.chat.completions.create({
    model: input.model,
    messages: [{ role: "user", content: input.prompt }],
    max_tokens: input.maxTokens ?? 8192,
    reasoning: buildReasoning(input.reasoningEffort),
  } as never);

  return {
    response,
    raw: response.choices[0]?.message?.content ?? null,
    usage: extractUsage(response.usage as Record<string, unknown> | undefined),
    metadata: {
      model: input.model,
      reasoning_effort: input.reasoningEffort ?? "auto",
    } satisfies OpenRouterCallMetadata,
  };
}

export async function runOpenRouterResponse(input: {
  model: string;
  reasoningEffort?: SupportedReasoningEffort;
  request: Parameters<OpenAI["responses"]["create"]>[0];
}): Promise<OpenRouterCallResult<OpenAI.Responses.Response>> {
  const client = getOpenRouterClient();
  const reasoning = buildReasoning(input.reasoningEffort);
  const response = await client.responses.create({
    ...input.request,
    model: input.model,
    reasoning,
  } as never);
  const nonStreamingResponse = response as OpenAI.Responses.Response;

  return {
    response: nonStreamingResponse,
    usage: extractUsage(nonStreamingResponse.usage as Record<string, unknown> | undefined),
    metadata: {
      model: input.model,
      reasoning_effort: input.reasoningEffort ?? "auto",
    } satisfies OpenRouterCallMetadata,
  };
}
