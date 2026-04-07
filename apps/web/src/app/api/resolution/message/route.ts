import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { appendIssueEvidence, appendIssueMessage, updateIssue } from "@/lib/server/issue-store";
import { runIssueAgent } from "@/lib/server/issue-agent";

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

    await supabase
      .from("smon_issue_actions")
      .update({ status: "rejected", updated_at: new Date().toISOString() })
      .eq("issue_id", resolutionId)
      .eq("user_id", user.id)
      .eq("status", "proposed");

    await updateIssue(supabase, user.id, resolutionId, { status: "running" });

    const state = await runIssueAgent(supabase, user.id, resolutionId);
    return NextResponse.json(state);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Message failed." },
      { status: 500 }
    );
  }
}
