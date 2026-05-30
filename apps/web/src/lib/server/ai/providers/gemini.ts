/**
 * Google Gemini provider client (PLAN.md §9.2).
 *
 * Caching: Gemini caches the prefix IMPLICITLY when it stays stable, so we put
 * the stable+semi-stable prefix in `systemInstruction` and keep it byte-stable
 * across calls. EXPLICIT `cachedContent` (billed hourly while alive) is deferred
 * — it's only worth it for big+reused prefixes and needs the
 * provider_cached_content lifecycle table (§9.5/§13); add it when Stage 2's real
 * reuse counts justify it. Native usageMetadata
 * (promptTokenCount/candidatesTokenCount/cachedContentTokenCount/thoughtsTokenCount)
 * passes through untouched.
 */

import { GoogleGenAI, type Content } from "@google/genai";
import type { CompiledContext } from "../context-compiler";
import { normalizeGemini } from "../usage";
import {
  AiCallError,
  type ChatMessage,
  type ModelCallParams,
  type ModelCallResult,
  type ProviderClient,
} from "./types";

/**
 * Build Gemini `contents`: every prior turn IN ORDER (mapping assistant→model)
 * plus the latest dynamic user turn; the stable prefix rides in systemInstruction.
 * Prior turns are never dropped or merged (§9.6). Pure — exported for the §9.7
 * "multi-turn history preserved" CI guard.
 */
export function buildGeminiContents(context: CompiledContext, priorMessages: ChatMessage[]): Content[] {
  return [
    ...priorMessages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    { role: "user", parts: [{ text: context.dynamicText }] },
  ];
}

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (client) return client;
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new AiCallError("missing_key", "gemini", "GEMINI_API_KEY is not configured.");
  }
  client = new GoogleGenAI({ apiKey });
  return client;
}

export const geminiClient: ProviderClient = {
  provider: "gemini",
  async call(params: ModelCallParams): Promise<ModelCallResult> {
    const ai = getClient();
    const { context, effort } = params;

    // Gemini uses role "model" (not "assistant"); the dynamic text is the final user turn.
    const contents = buildGeminiContents(context, params.messages ?? []);

    const thinkingBudget = effort.kind === "gemini" ? effort.thinkingBudgetTokens : undefined;

    try {
      const response = await ai.models.generateContent({
        model: params.model,
        contents,
        config: {
          systemInstruction: context.stableText,
          maxOutputTokens: params.maxTokens,
          abortSignal: params.signal,
          ...(params.json ? { responseMimeType: "application/json" } : {}),
          ...(thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget } } : {}),
        },
      });

      const text = response.text ?? "";
      const finishReason = response.candidates?.[0]?.finishReason ?? null;
      if (!text) {
        throw new AiCallError("unknown", "gemini", `empty content (finish_reason=${finishReason ?? "unknown"})`);
      }

      return {
        text,
        usage: normalizeGemini(response.usageMetadata),
        rawUsage: response.usageMetadata,
        finishReason,
        cacheStyle: "implicit_plus_explicit",
      };
    } catch (err) {
      throw toAiError(err);
    }
  },
};

function toAiError(err: unknown): AiCallError {
  if (err instanceof AiCallError) return err;
  const status =
    err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number"
      ? (err as { status: number }).status
      : undefined;
  let kind: "auth" | "rate_limit" | "overloaded" | "timeout" | "bad_request" | "unknown" = "unknown";
  if (status === 401 || status === 403) kind = "auth";
  else if (status === 429) kind = "rate_limit";
  else if (status === 503) kind = "overloaded";
  else if (status === 408 || status === 504) kind = "timeout";
  else if (typeof status === "number" && status >= 400 && status < 500) kind = "bad_request";
  return new AiCallError(kind, "gemini", err instanceof Error ? err.message : String(err), { status, cause: err });
}
