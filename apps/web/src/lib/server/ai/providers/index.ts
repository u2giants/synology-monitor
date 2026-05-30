/**
 * Provider registry. Exactly one client per AiProvider; the CI guard (§9.7)
 * asserts the registry is complete so adding a provider without a client (or a
 * usage normalizer) fails the build.
 */

import type { AiProvider } from "@synology-monitor/shared";
import { anthropicClient } from "./anthropic";
import { geminiClient } from "./gemini";
import { deepseekClient, openaiClient, qwenClient } from "./openai-compatible";
import { AiCallError, type ProviderClient } from "./types";

export const PROVIDER_CLIENTS: Record<AiProvider, ProviderClient> = {
  anthropic: anthropicClient,
  openai: openaiClient,
  gemini: geminiClient,
  deepseek: deepseekClient,
  qwen: qwenClient,
};

export function getProviderClient(provider: AiProvider): ProviderClient {
  const client = PROVIDER_CLIENTS[provider];
  if (!client) {
    throw new AiCallError("unknown", provider, `No client registered for provider "${provider}".`);
  }
  return client;
}

export * from "./types";
