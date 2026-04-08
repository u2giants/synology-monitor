import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listIssues, loadIssue } from "@/lib/server/issue-store";
import { runIssueDetection } from "@/lib/server/issue-detector";
import { drainIssueQueue, queueIssueRun } from "@/lib/server/issue-workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function fetchDetectedIssues(userId: string) {
  const supabase = await createClient();
  const issues = await listIssues(supabase, userId);
  return issues.filter((issue) => issue.origin_type === "detected").slice(0, 20);
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const requested = Number(body.lookbackMinutes) || 10080;
    const lookbackMinutes = Math.min(Math.max(requested, 15), 20160);

    const issueIds = await runIssueDetection(supabase, user.id, lookbackMinutes);
    for (const issueId of issueIds.slice(0, 5)) {
      await queueIssueRun(supabase, user.id, issueId, "detect_issue", { lookback_minutes: lookbackMinutes });
    }
    await drainIssueQueue(supabase, user.id, { limit: 5 });

    const issues = await fetchDetectedIssues(user.id);
    return NextResponse.json({
      runId: new Date().toISOString(),
      result: {
        issues,
        summary: issues.length === 0
          ? "No active issue threads were detected in the selected lookback window."
          : `Detected ${issues.length} issue thread${issues.length === 1 ? "" : "s"} from recent telemetry.`,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Issue detection failed." },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (id) {
      const state = await loadIssue(supabase, user.id, id);
      if (!state) return NextResponse.json({ error: "Issue not found" }, { status: 404 });
      return NextResponse.json(state);
    }

    const issues = await fetchDetectedIssues(user.id);
    return NextResponse.json({
      run: issues[0] ? { id: issues[0].id, created_at: issues[0].updated_at, summary: `Showing ${issues.length} detected issue threads.` } : null,
      problems: issues,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load issues." },
      { status: 500 }
    );
  }
}
