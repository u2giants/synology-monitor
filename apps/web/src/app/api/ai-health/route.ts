import { NextResponse } from "next/server";
import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";
import type { AiProvider, EffortLevel } from "@synology-monitor/shared";
import { callModel } from "@/lib/server/ai/call-model";
import { block } from "@/lib/server/ai/context-compiler";
import { AiCallError } from "@/lib/server/ai/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Provider smoke-test — confirms the net-new provider keys actually work in the
 * running container before the step-8 cutover. For each provider it reports
 * whether the key env var is present and the result of a minimal live ping
 * (a representative cheap model, "reply OK"). Auth-gated; safe to run anytime.
 */

const PING_MODEL: Record<AiProvider, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-5.4-mini",
  gemini: "gemini-2.5-flash",
  deepseek: "deepseek-chat",
  qwen: "qwen3.6-plus",
};

// OpenAI rejects 'minimal'; everyone else uses 'minimal' to skip thinking so the
// short reply fits the probe's token budget (reasoning tokens count against it).
const PROBE_EFFORT: Record<AiProvider, EffortLevel> = {
  anthropic: "minimal",
  openai: "low",
  gemini: "minimal",
  deepseek: "minimal",
  qwen: "minimal",
};

const KEY_ENVS: Record<AiProvider, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  qwen: ["DASHSCOPE_API_KEY"],
};

const PROVIDERS = Object.keys(PING_MODEL) as AiProvider[];

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const results = await Promise.all(
    PROVIDERS.map(async (provider) => {
      const keyPresent = KEY_ENVS[provider].some((e) => !!process.env[e]);
      if (!keyPresent) {
        return { provider, model: PING_MODEL[provider], keyPresent: false, ok: false, keyValid: false, error: "key env var not set" };
      }
      const started = Date.now();
      try {
        const r = await callModel({
          model: PING_MODEL[provider],
          effort: PROBE_EFFORT[provider],
          // Generous so reasoning models don't exhaust the budget before emitting
          // visible text (a tiny cap yields finish_reason=length with empty output).
          maxTokens: 2048,
          blocks: [
            block.stable("system", "You are a connectivity probe. Reply with the single word OK."),
            block.dynamic("instruction", "Reply now."),
          ],
        });
        return {
          provider,
          model: PING_MODEL[provider],
          keyPresent: true,
          ok: true,
          keyValid: true,
          latencyMs: Date.now() - started,
          sample: r.text.slice(0, 40),
          cacheStyle: r.cacheStyle,
        };
      } catch (err) {
        // A non-auth error (e.g. a 400 about a parameter, or an unavailable model)
        // still proves the key authenticated — report keyValid so a model/param
        // quirk isn't mistaken for a bad key.
        const kind = err instanceof AiCallError ? err.kind : "unknown";
        const keyValid = kind !== "missing_key" && kind !== "auth";
        return {
          provider,
          model: PING_MODEL[provider],
          keyPresent: true,
          ok: false,
          keyValid,
          latencyMs: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  return NextResponse.json({
    ok: results.every((r) => r.ok),
    // Defaults (Stage 2→Anthropic, Stages 1&3→Gemini) only need these two:
    defaultsReady: results.filter((r) => r.provider === "anthropic" || r.provider === "gemini").every((r) => r.ok),
    results,
  });
}
