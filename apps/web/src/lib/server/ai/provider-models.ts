/**
 * Live provider model lists (de-curation).
 *
 * The admin AI-stages dropdowns are populated from every CONNECTED provider's
 * "list models" endpoint — a provider counts as connected when its API key env
 * is present (same envs as the health probe). Each raw id is turned into a
 * ModelDescriptor via the shared derivation: catalog metadata wins, otherwise
 * the descriptor is derived from the provider's cache style + id-pattern effort.
 *
 * Results are cached in-process for a few minutes — the lists change rarely and
 * we don't want a provider round-trip on every settings page load. One provider
 * failing never blanks the others; on failure we fall back to that provider's
 * catalog rows so a connected provider is never empty in the dropdown.
 */

import {
  MODEL_CATALOG,
  deriveDescriptor,
  type AiProvider,
  type ModelDescriptor,
} from "@synology-monitor/shared";

export interface ProviderModelStatus {
  provider: AiProvider;
  keyPresent: boolean;
  ok: boolean;
  count: number;
  /** Where this provider's models came from this fetch. */
  source: "live" | "catalog" | "none";
  error?: string;
}

export interface ProviderModelsResult {
  models: ModelDescriptor[];
  providers: ProviderModelStatus[];
}

// Same key envs as the health probe (api/ai-health) — keep them in sync.
const KEY_ENVS: Record<AiProvider, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  qwen: ["DASHSCOPE_API_KEY"],
};

const PROVIDERS = Object.keys(KEY_ENVS) as AiProvider[];

const keyFor = (p: AiProvider): string | undefined =>
  KEY_ENVS[p].map((e) => process.env[e]).find(Boolean);

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache: { at: number; data: ProviderModelsResult } | null = null;

// --- Per-provider list-models fetchers (return raw provider-native ids) -------

async function listAnthropic(key: string): Promise<string[]> {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { data?: Array<{ id: string }> };
  return (json.data ?? []).map((m) => m.id);
}

// OpenAI's /models is a grab-bag (embeddings, tts, whisper, image, …). Keep only
// the chat/reasoning text models the pipeline can actually call.
function isOpenAITextModel(id: string): boolean {
  const s = id.toLowerCase();
  if (
    /(embedding|whisper|tts|audio|dall-e|image|moderation|realtime|transcribe|davinci|babbage|codex)/.test(
      s,
    )
  ) {
    return false;
  }
  return /^(gpt|chatgpt)/.test(s) || /^o\d/.test(s);
}

async function listOpenAI(key: string): Promise<string[]> {
  return (await listOpenAICompatible(key, "https://api.openai.com/v1")).filter(isOpenAITextModel);
}

// Shared shape for OpenAI-compatible /models endpoints (OpenAI, DeepSeek, Qwen).
async function listOpenAICompatible(key: string, base: string): Promise<string[]> {
  const res = await fetch(`${base.replace(/\/$/, "")}/models`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { data?: Array<{ id: string }> };
  return (json.data ?? []).map((m) => m.id);
}

async function listGemini(key: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken = "";
  for (let i = 0; i < 10; i += 1) {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("key", key);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as {
      models?: Array<{ name: string; supportedGenerationMethods?: string[] }>;
      nextPageToken?: string;
    };
    for (const m of json.models ?? []) {
      if (m.supportedGenerationMethods?.includes("generateContent")) {
        ids.push(m.name.replace(/^models\//, ""));
      }
    }
    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }
  return ids;
}

function listFor(provider: AiProvider, key: string): Promise<string[]> {
  switch (provider) {
    case "anthropic":
      return listAnthropic(key);
    case "openai":
      return listOpenAI(key);
    case "gemini":
      return listGemini(key);
    case "deepseek":
      return listOpenAICompatible(
        key,
        process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      );
    case "qwen":
      return listOpenAICompatible(
        key,
        process.env.DASHSCOPE_BASE_URL ??
          "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      );
    default:
      return Promise.resolve([]);
  }
}

const catalogFor = (provider: AiProvider): ModelDescriptor[] =>
  MODEL_CATALOG.filter((m) => m.provider === provider);

const sortModels = (models: ModelDescriptor[]): ModelDescriptor[] =>
  [...models].sort((a, b) => a.label.localeCompare(b.label));

/**
 * The full set of selectable models across connected providers. Cached in-process
 * for CACHE_TTL_MS; pass force=true to bypass (the route exposes ?refresh=1).
 */
export async function getProviderModels(force = false): Promise<ProviderModelsResult> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;

  const perProvider = await Promise.all(
    PROVIDERS.map(
      async (
        provider,
      ): Promise<{ status: ProviderModelStatus; models: ModelDescriptor[] }> => {
        const key = keyFor(provider);
        if (!key) {
          return {
            status: { provider, keyPresent: false, ok: false, count: 0, source: "none" },
            models: [],
          };
        }
        try {
          const ids = await listFor(provider, key);
          // Union live ids with this provider's catalog rows: curated metadata is
          // never lost, and a sparse list endpoint can't hide a known-good model.
          const byId = new Map<string, ModelDescriptor>();
          for (const c of catalogFor(provider)) byId.set(c.id, c);
          for (const id of ids) {
            if (byId.has(id)) continue;
            const d = deriveDescriptor(id, provider);
            if (d) byId.set(id, d);
          }
          const models = sortModels([...byId.values()]);
          return {
            status: { provider, keyPresent: true, ok: true, count: models.length, source: "live" },
            models,
          };
        } catch (err) {
          // Connected but the list call failed — fall back to catalog rows so the
          // provider isn't blank, and surface the error for the UI.
          const models = sortModels(catalogFor(provider));
          return {
            status: {
              provider,
              keyPresent: true,
              ok: false,
              count: models.length,
              source: "catalog",
              error: err instanceof Error ? err.message : String(err),
            },
            models,
          };
        }
      },
    ),
  );

  const data: ProviderModelsResult = {
    models: perProvider.flatMap((p) => p.models),
    providers: perProvider.map((p) => p.status),
  };
  cache = { at: Date.now(), data };
  return data;
}

/**
 * Recover a full descriptor for a model id from the live provider map — including
 * the correct provider for OFF-PATTERN ids (e.g. third-party models hosted on
 * DashScope) that the pure id-prefix inference in resolveModelDescriptor can't
 * place. callModel uses this as a last resort before failing, so any model the
 * dropdown can offer is actually routable. Returns null if the id isn't offered
 * by any connected provider.
 */
export async function resolveLiveDescriptor(id: string): Promise<ModelDescriptor | null> {
  const { models } = await getProviderModels();
  return models.find((m) => m.id === id) ?? null;
}
