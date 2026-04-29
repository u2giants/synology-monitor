import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchOpenRouterModels } from "@/lib/server/openrouter-models";

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
    const models = await fetchOpenRouterModels();
    return NextResponse.json({ models });
  } catch (err) {
    return NextResponse.json({
      models: [],
      warning: err instanceof Error ? err.message : "Could not reach OpenRouter",
    });
  }
}
