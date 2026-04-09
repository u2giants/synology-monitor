import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { appendIssueEvidence, appendIssueMessage, loadIssue, updateIssue } from "@/lib/server/issue-store";
import { drainIssueQueue, queueIssueRun, shouldInlineDrain } from "@/lib/server/issue-workflow";
import { loadIssueViewState } from "@/lib/server/issue-view";

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

    const trimmed = message?.trim();
    if (!resolutionId || !trimmed) {
      return NextResponse.json({ error: "resolutionId and message required." }, { status: 400 });
    }

    await appendIssueMessage(supabase, user.id, resolutionId, "user", trimmed);
    await appendIssueEvidence(supabase, user.id, resolutionId, {
      source_kind: "user_statement",
      title: "Operator response",
      detail: trimmed,
      metadata: {},
    });

    await updateIssue(supabase, user.id, resolutionId, { status: "running" });

    await queueIssueRun(supabase, user.id, resolutionId, "user_message", { message: trimmed });
    if (shouldInlineDrain()) {
      await drainIssueQueue(supabase, user.id, { limit: 1 });
    }
    const state = await loadIssue(supabase, user.id, resolutionId);
    return NextResponse.json(state ? await loadIssueViewState(supabase, user.id, state) : null);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Message failed." },
      { status: 500 }
    );
  }
}
