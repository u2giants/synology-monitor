import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { appendLog, updateResolution } from "@/lib/server/resolution-store";
import { tick } from "@/lib/server/resolution-agent";
import { SupabaseClient } from "@supabase/supabase-js";

async function rejectPendingFixSteps(supabase: SupabaseClient, userId: string, resolutionId: string) {
  await supabase
    .from("smon_resolution_steps")
    .update({ status: "rejected" })
    .eq("resolution_id", resolutionId)
    .eq("user_id", userId)
    .eq("category", "fix")
    .eq("status", "planned");
}

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
      await appendLog(supabase, user.id, resolutionId, "analysis",
        `Got it. Incorporating your context and restarting the investigation: "${message.trim()}"`);
    } else if (res?.phase === "awaiting_fix_approval") {
      // User typed context while reviewing a fix — reject all pending fix steps so
      // handleProposingFix doesn't see them as "pending" and bounce back immediately,
      // then transition to proposing_fix so the AI creates a genuinely new proposal.
      await rejectPendingFixSteps(supabase, user.id, resolutionId);
      await updateResolution(supabase, user.id, resolutionId, { phase: "proposing_fix" });
      await supabase
        .from("smon_issue_resolutions")
        .update({
          description: `${res.description}\n\nUser constraint on fix: ${message.trim()}`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", resolutionId)
        .eq("user_id", user.id);
      await appendLog(supabase, user.id, resolutionId, "analysis",
        `Got it. Will take that into account and propose a different fix: "${message.trim()}"`);
    } else {
      // In any other active phase — acknowledge and the agent will incorporate it on next tick
      await appendLog(supabase, user.id, resolutionId, "analysis",
        `Noted: "${message.trim()}" — will incorporate this into the current investigation.`);
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
