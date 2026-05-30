/**
 * Provider client contract (PLAN.md §9.1 — "wrap the plumbing; never normalize
 * the payload").
 *
 * A provider client standardizes only OPERATIONAL concerns — timeouts, retries,
 * error classification — and a common request wrapper (the compiled context +
 * messages). It must NOT flatten the request/response/usage shape: each client
 * applies its provider's NATIVE cache controls and returns the provider's NATIVE
 * usage object untouched (`rawUsage`) alongside the normalized struct. That is
 * what keeps per-provider cache observability alive.
 */

import type { AiProvider, CacheStyle } from "@synology-monitor/shared";
import type { CompiledContext } from "../context-compiler";
import type { ProviderEffort } from "../effort";
import type { NormalizedUsage } from "../usage";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ModelCallParams {
  model: string;
  /** Stable→dynamic content (system + schema + taxonomy + snapshot + evidence + instruction). */
  context: CompiledContext;
  /**
   * Prior multi-turn messages (Stage 2 resume). These are DYNAMIC — reconstructed
   * from the persisted transcript on every turn, never load-bearing on a warm
   * cache (§9.4). The compiled context's dynamic text becomes the final user turn.
   */
  messages?: ChatMessage[];
  effort: ProviderEffort;
  maxTokens: number;
  /** Request JSON-object output. */
  json?: boolean;
  signal?: AbortSignal;
  /** Qwen/DashScope multi-turn session continuity (§9.2) — persist + replay. */
  previousResponseId?: string;
}

export interface ModelCallResult {
  text: string;
  usage: NormalizedUsage;
  /** Native provider usage object — persisted raw, NEVER flattened (§9.1). */
  rawUsage: unknown;
  finishReason: string | null;
  cacheStyle: CacheStyle;
  /** Present for providers with a server-side session id to persist (Qwen). */
  responseId?: string;
}

export interface ProviderClient {
  provider: AiProvider;
  call(params: ModelCallParams): Promise<ModelCallResult>;
}

export type AiCallErrorKind =
  | "missing_key"
  | "auth"
  | "rate_limit"
  | "overloaded"
  | "timeout"
  | "bad_request"
  | "unknown";

/**
 * Inference-layer error. NOTE: this is distinct from the TOOL-layer
 * `nas_unreachable` result (PLAN.md §7) — that belongs to the NAS tool client,
 * not the model call. Do not conflate provider outages with NAS outages.
 */
export class AiCallError extends Error {
  readonly kind: AiCallErrorKind;
  readonly provider: AiProvider;
  readonly status?: number;
  readonly cause?: unknown;

  constructor(
    kind: AiCallErrorKind,
    provider: AiProvider,
    message: string,
    opts: { status?: number; cause?: unknown } = {},
  ) {
    super(`[${provider}/${kind}] ${message}`);
    this.name = "AiCallError";
    this.kind = kind;
    this.provider = provider;
    this.status = opts.status;
    this.cause = opts.cause;
  }
}

/** Map an HTTP-ish status to an error kind, shared across the OpenAI-compatible clients. */
export function classifyStatus(status: number | undefined): AiCallErrorKind {
  if (status === undefined) return "unknown";
  if (status === 401 || status === 403) return "auth";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limit";
  if (status === 529 || status === 503) return "overloaded";
  if (status >= 400 && status < 500) return "bad_request";
  return "unknown";
}
