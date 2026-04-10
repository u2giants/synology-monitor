import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listIssues } from "@/lib/server/issue-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const resolutions = await listIssues(supabase, user.id);
    return NextResponse.json({ resolutions });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list issues." },
      { status: 500 }
    );
  }
}
