import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { recommendOpenRouterModels, recommendOpenRouterModelsByBucket } from "@/lib/server/openrouter-models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const limit = Number.parseInt(searchParams.get("limit") ?? "5", 10);
  const minCapabilityScore = Number.parseInt(searchParams.get("minCapabilityScore") ?? "5", 10);
  const bucketed = searchParams.get("bucketed") === "true";

  try {
    if (bucketed) {
      const buckets = await recommendOpenRouterModelsByBucket(Number.isFinite(limit) ? limit : 5);
      return NextResponse.json({ buckets });
    }
    const recommendations = await recommendOpenRouterModels({
      limit: Number.isFinite(limit) ? limit : 5,
      minCapabilityScore: Number.isFinite(minCapabilityScore) ? minCapabilityScore : 5,
    });
    return NextResponse.json({ recommendations });
  } catch (error) {
    return NextResponse.json(
      { recommendations: [], warning: error instanceof Error ? error.message : "Could not build recommendations." },
      { status: 200 },
    );
  }
}
