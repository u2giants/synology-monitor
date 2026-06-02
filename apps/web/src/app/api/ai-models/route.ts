import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProviderModels } from "@/lib/server/ai/provider-models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Selectable models for the AI-stages dropdowns — the live union of every
 * connected provider's catalog (de-curation). Auth-gated; cached in-process by
 * getProviderModels. Pass ?refresh=1 to force a re-fetch from the providers.
 */
export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const force = new URL(req.url).searchParams.get("refresh") === "1";
  const data = await getProviderModels(force);
  return NextResponse.json(data);
}
