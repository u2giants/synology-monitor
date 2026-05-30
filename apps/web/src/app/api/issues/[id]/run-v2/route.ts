import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadIssue, updateIssue } from "@/lib/server/issue-store";
import { runIssueAgentV2 } from "@/lib/server/ai/pipeline-v2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Validation trigger for the 3-stage v2 pipeline (PLAN.md §8). Opts this single
 * issue into v2 (metadata.pipeline = "v2") and runs one turn synchronously so
 * the operator can watch the new pipeline end-to-end on a chosen issue before
 * flipping the global ISSUE_PIPELINE_V2 flag. Continuation turns are enqueued
 * and the worker keeps using v2 for this issue (the metadata flag persists).
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const { id } = await params;
    const state = await loadIssue(supabase, user.id, id);
    if (!state) return NextResponse.json({ error: "Not found." }, { status: 404 });

    // Persist the per-issue opt-in so enqueued continuation turns also use v2.
    const metadata = { ...(state.issue.metadata ?? {}), pipeline: "v2" };
    await updateIssue(supabase, user.id, id, { metadata });

    const turn = await runIssueAgentV2(supabase, user.id, id);
    const after = await loadIssue(supabase, user.id, id);

    return NextResponse.json({
      ok: true,
      ranTurn: !!turn,
      turn: turn ?? null,
      status: after?.issue.status ?? state.issue.status,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "v2 run failed." },
      { status: 500 },
    );
  }
}
