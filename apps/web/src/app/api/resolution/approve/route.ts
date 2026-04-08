import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadIssue, updateIssue, updateIssueAction } from "@/lib/server/issue-store";
import { drainIssueQueue, queueIssueRun } from "@/lib/server/issue-workflow";
import { loadIssueViewState } from "@/lib/server/issue-view";
import { verifyApprovalToken, type NasTarget } from "@/lib/server/tools";

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

    const state = await loadIssue(supabase, user.id, body.resolutionId);
    if (!state) return NextResponse.json({ error: "Issue not found." }, { status: 404 });

    const actions = state.actions.filter((action) => body.stepIds.includes(action.id));
    if (actions.length === 0) {
      return NextResponse.json({ error: "No matching actions found." }, { status: 404 });
    }

    for (const action of actions) {
      if (body.decision === "approve") {
        if (action.approval_token) {
          verifyApprovalToken(action.target as NasTarget, action.command_preview, action.approval_token);
        }
        await updateIssueAction(supabase, user.id, action.id, { status: "approved" });
      } else {
        await updateIssueAction(supabase, user.id, action.id, { status: "rejected", completed_at: new Date().toISOString() });
      }
    }

    await updateIssue(supabase, user.id, body.resolutionId, {
      status: body.decision === "approve" ? "running" : "waiting_on_user",
    });

    await queueIssueRun(supabase, user.id, body.resolutionId, "approval_decision", { decision: body.decision, step_ids: body.stepIds });
    await drainIssueQueue(supabase, user.id, { limit: 1 });
    const updated = await loadIssue(supabase, user.id, body.resolutionId);
    return NextResponse.json(updated ? await loadIssueViewState(supabase, user.id, updated) : null);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Action decision failed." },
      { status: 500 }
    );
  }
}
