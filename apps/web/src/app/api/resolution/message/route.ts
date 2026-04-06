import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { appendLog, updateResolution } from "@/lib/server/resolution-store";
import { tick } from "@/lib/server/resolution-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const { resolutionId, message } = await request.json() as {
      resolutionId: string;
      message: string;
    };

    if (!resolutionId || !message?.trim()) {
      return NextResponse.json({ error: "resolutionId and message required." }, { status: 400 });
    }

    // Append user context to the log
    await appendLog(supabase, user.id, resolutionId, "user_input", message.trim());

    // If stuck, restart planning with the new context
    const { data: res } = await supabase
      .from("smon_issue_resolutions")
      .select("phase, description")
      .eq("id", resolutionId)
      .eq("user_id", user.id)
      .single();

    if (res?.phase === "stuck") {
      await updateResolution(supabase, user.id, resolutionId, {
        phase: "planning",
        stuck_reason: undefined as unknown as string,
      });
      await supabase
        .from("smon_issue_resolutions")
        .update({
          description: `${res.description}\n\nAdditional context from user: ${message.trim()}`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", resolutionId)
        .eq("user_id", user.id);
    } else if (res?.phase === "awaiting_fix_approval") {
      // User typed context while reviewing a fix — treat as rejection + guidance for re-proposal
      await updateResolution(supabase, user.id, resolutionId, { phase: "proposing_fix" });
      await supabase
        .from("smon_issue_resolutions")
        .update({
          description: `${res.description}\n\nUser guidance on fix: ${message.trim()}`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", resolutionId)
        .eq("user_id", user.id);
    }

    const state = await tick(supabase, user.id, resolutionId);
    return NextResponse.json(state);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Message failed." },
      { status: 500 }
    );
  }
}
