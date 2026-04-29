import { NextResponse } from "next/server";
import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";
import { AI_SETTINGS_KEYS, clearAiSettingsCache } from "@/lib/server/ai-settings";

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

    if (!key || typeof key !== "string" || typeof value !== "string") {
      return NextResponse.json({ error: "key and value are required strings." }, { status: 400 });
    }

    const allowedKeys = [...AI_SETTINGS_KEYS];
    if (!allowedKeys.includes(key as typeof allowedKeys[number])) {
      return NextResponse.json({ error: `Invalid setting key. Allowed: ${allowedKeys.join(", ")}` }, { status: 400 });
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
