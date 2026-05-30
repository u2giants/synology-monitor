import { NextResponse } from "next/server";
import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";
import { clearAiSettingsCache } from "@/lib/server/ai-settings";
import { STAGE_SETTING_KEYS, isEffortLevel } from "@synology-monitor/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

    const { data } = await supabase.from("ai_settings").select("key, value");

    const settings: Record<string, string> = {};
    for (const row of data ?? []) {
      settings[row.key] = row.value;
    }

    return NextResponse.json({ settings });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load settings." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

    const body = await request.json();
    const { key, value } = body;

    if (!key || !value || typeof key !== "string" || typeof value !== "string") {
      return NextResponse.json({ error: "key and value are required strings." }, { status: 400 });
    }

    const allowedKeys = [
      // 3-stage rebuild config (PLAN.md §8.2): stage_{structurer,reasoning,explainer}_{model,effort}
      ...STAGE_SETTING_KEYS,
      // Legacy 7-stage keys — kept writable until the old pipeline is removed (build step 8).
      "diagnosis_model",
      "remediation_model",
      "second_opinion_model",
      "extractor_model",
      "cluster_model",
      "hypothesis_model",
      "planner_model",
      "remediation_planner_model",
      "explainer_model",
      "verifier_model",
    ];
    if (!allowedKeys.includes(key)) {
      return NextResponse.json({ error: `Invalid setting key. Allowed: ${allowedKeys.join(", ")}` }, { status: 400 });
    }

    // Effort keys carry an abstract level, not a model id — validate against the matrix (§8.3).
    if (key.endsWith("_effort") && !isEffortLevel(value.trim())) {
      return NextResponse.json(
        { error: "Invalid effort level. Allowed: minimal, low, medium, high." },
        { status: 400 },
      );
    }

    const { error } = await supabase.from("ai_settings").upsert(
      { key, value: value.trim(), updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );

    if (error) throw error;

    clearAiSettingsCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save setting." },
      { status: 500 }
    );
  }
}
