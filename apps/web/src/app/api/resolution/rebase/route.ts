import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  ensureIssueWorkingSession,
  getActiveIssueWorkingSession,
  listIssueEscalationEvents,
} from "@/lib/server/issue-investigation-store";
import { loadIssue } from "@/lib/server/issue-store";
import { executeIssueContextRebase } from "@/lib/server/investigation-rebase";
import { loadIssueViewState } from "@/lib/server/issue-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const body = await request.json() as {
      resolutionId: string;
      reason?: string;
      mode?: "guided" | "deep";
    };

    if (!body.resolutionId) {
      return NextResponse.json({ error: "resolutionId is required." }, { status: 400 });
    }

    const state = await loadIssue(supabase, user.id, body.resolutionId);
    if (!state) return NextResponse.json({ error: "Issue not found." }, { status: 404 });

    const activeSession = await getActiveIssueWorkingSession(supabase, user.id, body.resolutionId)
      ?? await ensureIssueWorkingSession(supabase, user.id, body.resolutionId, body.mode ?? "guided");
    const triggerReason = body.reason?.trim() || "manual_context_rebase";

    const escalations = await listIssueEscalationEvents(supabase, user.id, body.resolutionId);
    const pendingExpanded = escalations.find((event) => event.kind === "expanded_context" && !event.approved_by_user);
    await executeIssueContextRebase({
      supabase,
      userId: user.id,
      state,
      activeSession,
      reason: triggerReason,
      mode: body.mode ?? activeSession.mode,
      pendingEscalationId: pendingExpanded?.id ?? null,
      decisionReason: triggerReason,
    });

    const updated = await loadIssue(supabase, user.id, body.resolutionId);
    return NextResponse.json(updated ? await loadIssueViewState(supabase, user.id, updated) : null);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to rebase investigation context." },
      { status: 500 },
    );
  }
}
