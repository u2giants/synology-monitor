type OpenRouterPricing = object | null;

export interface OpenRouterModelInfo {
  id: string;
  name: string;
  context_length: number | null;
  pricing: OpenRouterPricing;
  supported_parameters: string[];
  supports_reasoning?: boolean;
}

let cachedModels: OpenRouterModelInfo[] | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60_000;

function getApiKey() {
  return process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
}

export async function fetchOpenRouterModels(force = false) {
  const apiKey = getApiKey();
  if (!apiKey) return [];

  if (!force && cachedModels && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedModels;
  }

  const res = await fetch("https://openrouter.ai/api/v1/models/user", {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`OpenRouter returned ${res.status}`);
  }

  const data = await res.json() as { data?: Array<Record<string, unknown>> };
  const models = (data.data ?? [])
    .map((m) => {
      const rawSupportedParameters = m.supported_parameters;
      const hasSupportedParameters = Array.isArray(rawSupportedParameters);
      const supportedParameters = hasSupportedParameters
        ? rawSupportedParameters.filter((value: unknown): value is string => typeof value === "string")
        : [];
      return {
        id: String(m.id ?? ""),
        name: String(m.name ?? m.id ?? ""),
        context_length: typeof m.context_length === "number" ? m.context_length : null,
        pricing: typeof m.pricing === "object" && m.pricing !== null ? (m.pricing as object) : null,
        supported_parameters: supportedParameters,
        supports_reasoning: hasSupportedParameters ? supportedParameters.includes("reasoning") : undefined,
      } satisfies OpenRouterModelInfo;
    })
    .filter((m) => m.id)
    .sort((a, b) => a.name.localeCompare(b.name));

  cachedModels = models;
  cachedAt = Date.now();
  return models;
}

export async function findOpenRouterModel(modelId: string) {
  const models = await fetchOpenRouterModels();
  return models.find((model) => model.id === modelId) ?? null;
}

function parsePrice(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function scoreOpenRouterModelCapability(model: OpenRouterModelInfo) {
  const id = model.id.toLowerCase();
  let score = 0;
  if (/gpt-5|claude|sonnet|opus|gemini-2\.5-pro|gemini-3|qwen3\.6-plus|deepseek-v3\.2|kimi-k2\.5|glm-5/.test(id)) score += 4;
  if (/haiku|flash|mini/.test(id)) score += 1;
  if (/opus|sonnet|gpt-5|gemini-2\.5-pro|deepseek-v3\.2-speciale/.test(id)) score += 2;
  if (model.supports_reasoning) score += 1;
  if ((model.context_length ?? 0) >= 100_000) score += 1;
  return score;
}

export function estimateOpenRouterCostUsd(
  pricing: OpenRouterPricing,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    reasoning_tokens?: number;
  },
) {
  if (!pricing) return null;
  const priceMap = pricing as Record<string, unknown>;

  const inputTokenPrice =
    parsePrice(priceMap.prompt)
    ?? parsePrice(priceMap.input)
    ?? parsePrice(priceMap.input_tokens)
    ?? parsePrice(priceMap.input_cost_per_token);
  const outputTokenPrice =
    parsePrice(priceMap.completion)
    ?? parsePrice(priceMap.output)
    ?? parsePrice(priceMap.output_tokens)
    ?? parsePrice(priceMap.output_cost_per_token);

  if (inputTokenPrice == null && outputTokenPrice == null) return null;

  const inputCost = (usage.input_tokens ?? 0) * (inputTokenPrice ?? 0);
  const outputCost = ((usage.output_tokens ?? 0) + (usage.reasoning_tokens ?? 0)) * (outputTokenPrice ?? 0);
  const total = inputCost + outputCost;
  return Number.isFinite(total) ? total : null;
}

export async function findBestOpenRouterModelUpgrade(input: {
  currentModelId: string;
  minCapabilityDelta?: number;
}) {
  const models = await fetchOpenRouterModels();
  const current = models.find((model) => model.id === input.currentModelId) ?? null;
  const currentScore = current ? scoreOpenRouterModelCapability(current) : 0;
  const minCapabilityDelta = input.minCapabilityDelta ?? 1;

  const candidates = models
    .map((model) => {
      const capability = scoreOpenRouterModelCapability(model);
      const estimated_full_million_cost = estimateOpenRouterCostUsd(model.pricing, {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }) ?? Number.POSITIVE_INFINITY;
      const value = capability / Math.max(estimated_full_million_cost, 0.000001);
      return { model, capability, estimated_full_million_cost, value };
    })
    .filter((entry) => entry.model.id !== input.currentModelId)
    .filter((entry) => entry.capability >= currentScore + minCapabilityDelta)
    .sort((a, b) => {
      if (b.value !== a.value) return b.value - a.value;
      if (b.capability !== a.capability) return b.capability - a.capability;
      return a.estimated_full_million_cost - b.estimated_full_million_cost;
    });

  return candidates[0] ?? null;
}

export async function recommendOpenRouterModels(input: {
  minCapabilityScore?: number;
  limit?: number;
  requireReasoning?: boolean;
  maxEstimatedFullMillionCost?: number;
}) {
  const models = await fetchOpenRouterModels();
  const minCapabilityScore = input.minCapabilityScore ?? 5;
  const limit = input.limit ?? 5;
  const requireReasoning = input.requireReasoning ?? false;
  const maxEstimatedFullMillionCost = input.maxEstimatedFullMillionCost ?? Number.POSITIVE_INFINITY;

  const ranked = models
    .map((model) => {
      const capability = scoreOpenRouterModelCapability(model);
      const cost = estimateOpenRouterCostUsd(model.pricing, {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }) ?? Number.POSITIVE_INFINITY;
      const value = capability / Math.max(cost, 0.000001);
      return { model, capability, estimated_full_million_cost: cost, value };
    })
    .filter((entry) => entry.capability >= minCapabilityScore)
    .filter((entry) => !requireReasoning || entry.model.supports_reasoning !== false)
    .filter((entry) => entry.estimated_full_million_cost <= maxEstimatedFullMillionCost)
    .sort((a, b) => {
      if (b.value !== a.value) return b.value - a.value;
      if (b.capability !== a.capability) return b.capability - a.capability;
      return a.estimated_full_million_cost - b.estimated_full_million_cost;
    })
    .slice(0, limit);

  return ranked;
}

export async function recommendOpenRouterModelsByBucket(limit = 5) {
  const [planner, deepInvestigation, explainer] = await Promise.all([
    recommendOpenRouterModels({
      limit,
      minCapabilityScore: 5,
      requireReasoning: true,
      maxEstimatedFullMillionCost: 8,
    }),
    recommendOpenRouterModels({
      limit,
      minCapabilityScore: 6,
      requireReasoning: true,
      maxEstimatedFullMillionCost: 14,
    }),
    recommendOpenRouterModels({
      limit,
      minCapabilityScore: 4,
      requireReasoning: false,
      maxEstimatedFullMillionCost: 6,
    }),
  ]);

  return {
    planner,
    deep_investigation: deepInvestigation,
    explainer,
  };
}
