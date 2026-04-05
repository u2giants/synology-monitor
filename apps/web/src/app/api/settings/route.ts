import { NextResponse } from "next/server";
import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";

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

    const { data } = await supabase.from("smon_ai_settings").select("key, value");

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

    const allowedKeys = ["diagnosis_model", "remediation_model"];
    if (!allowedKeys.includes(key)) {
      return NextResponse.json({ error: `Invalid setting key. Allowed: ${allowedKeys.join(", ")}` }, { status: 400 });
    }

    const { error } = await supabase.from("smon_ai_settings").upsert({
      key,
      value: value.trim(),
      updated_at: new Date().toISOString(),
    });

    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save setting." },
      { status: 500 }
    );
  }
}
