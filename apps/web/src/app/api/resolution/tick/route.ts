import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { runIssueAgent } from "@/lib/server/issue-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const { resolutionId } = await request.json() as { resolutionId: string };
    if (!resolutionId) return NextResponse.json({ error: "resolutionId required." }, { status: 400 });

    const state = await runIssueAgent(supabase, user.id, resolutionId);
    if (!state) return NextResponse.json({ error: "Issue not found." }, { status: 404 });

    return NextResponse.json(state);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent run failed." },
      { status: 500 }
    );
  }
}
