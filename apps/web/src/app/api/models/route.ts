import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Curated list of capable models available on OpenRouter that are suitable
// for diagnosis/remediation/second-opinion tasks.
const CURATED_IDS = new Set([
  "anthropic/claude-opus-4",
  "anthropic/claude-opus-4-5",
  "anthropic/claude-sonnet-4",
  "anthropic/claude-sonnet-4-5",
  "anthropic/claude-haiku-4-5",
  "anthropic/claude-3.5-sonnet",
  "anthropic/claude-3.5-haiku",
  "anthropic/claude-3-opus",
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  "openai/gpt-4.1",
  "openai/gpt-4.1-mini",
  "openai/gpt-4.1-nano",
  "openai/gpt-5.4",
  "openai/o3",
  "openai/o4-mini",
  "openai/o3-mini",
  "google/gemini-2.5-pro",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
  "google/gemini-2.0-flash-001",
  "google/gemini-pro-1.5",
  "meta-llama/llama-4-maverick",
  "meta-llama/llama-4-scout",
  "meta-llama/llama-3.3-70b-instruct",
  "mistralai/mistral-large",
  "mistralai/mistral-small-3.1-24b-instruct",
  "deepseek/deepseek-r1",
  "deepseek/deepseek-chat-v3-0324",
  "x-ai/grok-3",
  "x-ai/grok-3-mini",
  "qwen/qwen-2.5-72b-instruct",
]);

export async function GET() {
  // Require auth
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    // Return the curated list without live pricing/availability data
    return NextResponse.json({
      models: Array.from(CURATED_IDS).map((id) => ({ id, name: id })),
    });
  }

  try {
    const res = await fetch("https://openrouter.ai/api/v1/models/user", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      throw new Error(`OpenRouter returned ${res.status}`);
    }

    const data = await res.json() as { data?: Array<{ id: string; name: string }> };
    const all = data.data ?? [];

    // Filter to the curated set so the dropdown stays manageable
    const curated = all
      .filter((m) => CURATED_IDS.has(m.id))
      .map((m) => ({ id: m.id, name: m.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // If OpenRouter didn't return some of our curated IDs (not yet available in their
    // response), append them as stubs so they're still selectable.
    const returned = new Set(curated.map((m) => m.id));
    for (const id of CURATED_IDS) {
      if (!returned.has(id)) {
        curated.push({ id, name: id });
      }
    }

    curated.sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ models: curated });
  } catch (err) {
    // Fall back to the static curated list on any error
    return NextResponse.json({
      models: Array.from(CURATED_IDS)
        .map((id) => ({ id, name: id }))
        .sort((a, b) => a.localeCompare(b)),
      warning: err instanceof Error ? err.message : "Could not reach OpenRouter",
    });
  }
}
