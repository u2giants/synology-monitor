import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lightweight issue list for the admin v2-validation picker. Returns recent
 * non-terminal issues so the operator can choose one to run through the new
 * 3-stage pipeline (POST /api/issues/[id]/run-v2).
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const { data, error } = await supabase
    .from("issues")
    .select("id, title, status, severity, metadata, updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false })
    .limit(40);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const issues = (data ?? []).map((i: Record<string, unknown>) => ({
    id: i.id,
    title: i.title,
    status: i.status,
    severity: i.severity,
    pipeline: (i.metadata as Record<string, unknown> | null)?.pipeline ?? "v1",
  }));

  return NextResponse.json({ issues });
}
