import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  ensureIssueWorkingSession,
  getActiveIssueWorkingSession,
  listIssueEscalationEvents,
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
      mode: "guided" | "deep";
    };

    if (!body.resolutionId || (body.mode !== "guided" && body.mode !== "deep")) {
      return NextResponse.json({ error: "resolutionId and valid mode are required." }, { status: 400 });
    }

    const state = await loadIssue(supabase, user.id, body.resolutionId);
    if (!state) return NextResponse.json({ error: "Issue not found." }, { status: 404 });

    const active = await getActiveIssueWorkingSession(supabase, user.id, body.resolutionId);
    if (active) {
      await updateIssueWorkingSession(supabase, user.id, active.id, { mode: body.mode });
    } else {
      await ensureIssueWorkingSession(supabase, user.id, body.resolutionId, body.mode);
    }

    if (body.mode === "deep") {
      const escalations = await listIssueEscalationEvents(supabase, user.id, body.resolutionId);
      const pendingDeep = escalations.find((event) => event.kind === "deep_mode_switch" && !event.approved_by_user);
      if (pendingDeep) {
        await updateIssueEscalationEvent(supabase, user.id, pendingDeep.id, {
          approved_by_user: true,
          decision_reason: "Approved via mode switch",
          to_reasoning: "deep",
        });
      }
    }

    const updated = await loadIssue(supabase, user.id, body.resolutionId);
    return NextResponse.json(updated ? await loadIssueViewState(supabase, user.id, updated) : null);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to switch investigation mode." },
      { status: 500 },
    );
  }
}
