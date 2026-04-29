import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createIssueEscalationEvent,
  ensureIssueWorkingSession,
  getActiveIssueWorkingSession,
  updateIssueEscalationEvent,
  updateIssueWorkingSession,
} from "@/lib/server/issue-investigation-store";
import { loadIssue } from "@/lib/server/issue-store";
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
      escalationId?: string;
      kind: "higher_reasoning" | "stronger_model" | "expanded_context" | "deep_mode_switch";
      fromModel?: string | null;
      toModel?: string | null;
      fromReasoning?: string | null;
      toReasoning?: string | null;
      estimatedCost?: number | null;
      approvedByUser?: boolean;
      decisionReason?: string | null;
    };

    if (!body.resolutionId || !body.kind) {
      return NextResponse.json({ error: "resolutionId and kind are required." }, { status: 400 });
    }

    const state = await loadIssue(supabase, user.id, body.resolutionId);
    if (!state) return NextResponse.json({ error: "Issue not found." }, { status: 404 });

    const session = await getActiveIssueWorkingSession(supabase, user.id, body.resolutionId)
      ?? await ensureIssueWorkingSession(supabase, user.id, body.resolutionId, "guided");

    if (body.escalationId) {
      await updateIssueEscalationEvent(supabase, user.id, body.escalationId, {
        approved_by_user: body.approvedByUser ?? false,
        decision_reason: body.decisionReason ?? null,
        to_model: body.toModel,
        to_reasoning: body.toReasoning,
      });
    } else {
      await createIssueEscalationEvent(supabase, user.id, {
        issue_id: body.resolutionId,
        session_id: session.id,
        kind: body.kind,
        from_model: body.fromModel ?? null,
        to_model: body.toModel ?? null,
        from_reasoning: body.fromReasoning ?? null,
        to_reasoning: body.toReasoning ?? null,
        estimated_cost: body.estimatedCost ?? null,
        approved_by_user: body.approvedByUser ?? false,
        decision_reason: body.decisionReason ?? null,
      });
    }

    if (body.kind === "deep_mode_switch" && body.approvedByUser) {
      await updateIssueWorkingSession(supabase, user.id, session.id, { mode: "deep" });
    }

    const updated = await loadIssue(supabase, user.id, body.resolutionId);
    return NextResponse.json(updated ? await loadIssueViewState(supabase, user.id, updated) : null);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to record escalation." },
      { status: 500 },
    );
  }
}
