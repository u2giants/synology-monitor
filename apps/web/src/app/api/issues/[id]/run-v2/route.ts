import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { appendIssueMessage, loadIssue, updateIssue, type SupabaseClient } from "@/lib/server/issue-store";
import { runIssueAgentV2 } from "@/lib/server/ai/pipeline-v2";

const RUNNABLE = new Set(["open", "running", "waiting_on_issue"]);

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
    // Authenticate with the session client...
    const session = await createClient();
    const {
      data: { user },
    } = await session.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    // ...but run the pipeline with the service-role client, exactly like the
    // worker does: the 3-stage pipeline writes to RLS-protected tables
    // (issue_evidence_items has no INSERT policy), so the session/authenticated
    // role would be denied. Reads/writes stay scoped by the user.id filter.
    const supabase = createAdminClient() as unknown as SupabaseClient;

    const { id } = await params;
    const state = await loadIssue(supabase, user.id, id);
    if (!state) return NextResponse.json({ error: "Not found." }, { status: 404 });

    // Persist the per-issue opt-in so enqueued continuation turns also use v2.
    const metadata = { ...(state.issue.metadata ?? {}), pipeline: "v2" };
    await updateIssue(supabase, user.id, id, { metadata });

    // Explicit operator validation: if the issue is parked (waiting_*/resolved/
    // stuck), nudge it into a single turn so the button always exercises v2.
    let forcedFrom: string | null = null;
    if (!RUNNABLE.has(state.issue.status)) {
      forcedFrom = state.issue.status;
      await updateIssue(supabase, user.id, id, { status: "running" });
      await appendIssueMessage(
        supabase,
        user.id,
        id,
        "system",
        `Manual v2 validation run started (was: ${forcedFrom}).`,
        { trigger: "v2_validation_run", previous_status: forcedFrom },
      );
    }

    const turn = await runIssueAgentV2(supabase, user.id, id);
    const after = await loadIssue(supabase, user.id, id);

    return NextResponse.json({
      ok: true,
      ranTurn: !!turn,
      forcedFrom,
      turn: turn ?? null,
      status: after?.issue.status ?? state.issue.status,
    });
  } catch (error) {
    return NextResponse.json({ error: describeError(error) }, { status: 500 });
  }
}

/** Surface the real cause — Supabase throws plain PostgrestError objects, not Errors. */
function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    const parts = [e.message, e.code && `code=${e.code}`, e.details && `details=${e.details}`, e.hint && `hint=${e.hint}`]
      .filter(Boolean)
      .map(String);
    if (parts.length) return parts.join(" · ");
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}
