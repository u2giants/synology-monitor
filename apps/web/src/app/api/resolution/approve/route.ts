import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { approveSteps, rejectSteps } from "@/lib/server/resolution-store";
import { tick } from "@/lib/server/resolution-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const body = await request.json() as {
      resolutionId: string;
      stepIds: string[];
      decision: "approve" | "reject";
    };

    if (!body.resolutionId || !body.stepIds?.length) {
      return NextResponse.json({ error: "resolutionId and stepIds required." }, { status: 400 });
    }

    if (body.decision === "reject") {
      await rejectSteps(supabase, user.id, body.stepIds);
    } else {
      await approveSteps(supabase, user.id, body.stepIds);
    }

    // If approving fix steps, also transition phase from awaiting_fix_approval to applying_fix
    const { data: res } = await supabase
      .from("smon_issue_resolutions")
      .select("phase")
      .eq("id", body.resolutionId)
      .eq("user_id", user.id)
      .single();

    if (res?.phase === "awaiting_fix_approval" && body.decision === "approve") {
      await supabase
        .from("smon_issue_resolutions")
        .update({ phase: "applying_fix", updated_at: new Date().toISOString() })
        .eq("id", body.resolutionId)
        .eq("user_id", user.id);
    }

    // Run a tick to continue
    const state = await tick(supabase, user.id, body.resolutionId);
    return NextResponse.json(state);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Approve failed." },
      { status: 500 }
    );
  }
}
