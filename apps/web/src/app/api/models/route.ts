import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Require auth
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ models: [] });
  }

  try {
    const res = await fetch("https://openrouter.ai/api/v1/models/user", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      throw new Error(`OpenRouter returned ${res.status}`);
    }

    const data = await res.json() as { data?: Array<{ id: string; name: string }> };
    const models = (data.data ?? [])
      .map((m) => ({ id: m.id, name: m.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ models });
  } catch (err) {
    return NextResponse.json({
      models: [],
      warning: err instanceof Error ? err.message : "Could not reach OpenRouter",
    });
  }
}
