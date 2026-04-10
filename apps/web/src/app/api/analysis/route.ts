import { NextRequest, NextResponse } from "next/server";
<<<<<<< HEAD
import {
  analyzeRecentLogs,
  getLatestAnalysis,
  getAnalysisById,
  type AnalysisFailureReason,
} from "@/lib/server/log-analyzer";

function getUserMessage(failureReason: AnalysisFailureReason | undefined): string {
  switch (failureReason) {
    case "minimax_error":
      return "The AI model could not be reached. Check server logs for details.";
    case "parse_error":
      return "The AI model returned an unexpected response format. Check server logs for details.";
    case "db_error":
      return "Analysis completed but could not be saved. Check server logs for details.";
    default:
      return "An unexpected error occurred. Check server logs for details.";
  }
=======
import { createClient } from "@/lib/supabase/server";
import { listIssues, loadIssue } from "@/lib/server/issue-store";
import { runIssueDetection } from "@/lib/server/issue-detector";
import { drainIssueQueue, queueIssueRun, shouldInlineDrain } from "@/lib/server/issue-workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function fetchDetectedIssues(userId: string) {
  const supabase = await createClient();
  const issues = await listIssues(supabase, userId);
  return issues.filter((issue) => issue.origin_type === "detected").slice(0, 20);
>>>>>>> e2a762a1685477c3b37aad1cdfb7112b8bc8349e
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const body = await request.json().catch(() => ({}));
<<<<<<< HEAD
    const lookbackMinutes = (body as { lookbackMinutes?: number }).lookbackMinutes || 60;

    const result = await analyzeRecentLogs(lookbackMinutes);

    // No events is a normal/expected condition — return 200
    if (result.failureReason === "no_events") {
      return NextResponse.json({
        runId: null,
        result: { problems: [], summary: "No events found in the specified time range." },
        noEvents: true,
      });
    }

    // Real failures — return 500 with structured error info
    if (result.error) {
      return NextResponse.json(
        {
          error: result.error,
          failureReason: result.failureReason ?? "unknown",
          userMessage: getUserMessage(result.failureReason),
        },
        { status: 500 }
      );
=======
    const requested = Number(body.lookbackMinutes) || 10080;
    const lookbackMinutes = Math.min(Math.max(requested, 15), 20160);

    const issueIds = await runIssueDetection(supabase, user.id, lookbackMinutes);
    for (const issueId of issueIds.slice(0, 5)) {
      await queueIssueRun(supabase, user.id, issueId, "detect_issue", { lookback_minutes: lookbackMinutes });
    }
    if (shouldInlineDrain()) {
      await drainIssueQueue(supabase, user.id, { limit: 5 });
>>>>>>> e2a762a1685477c3b37aad1cdfb7112b8bc8349e
    }

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
<<<<<<< HEAD
      {
        error: "Internal server error",
        failureReason: "unknown",
        userMessage: "An unexpected error occurred. Check server logs for details.",
      },
=======
      { error: error instanceof Error ? error.message : "Issue detection failed." },
>>>>>>> e2a762a1685477c3b37aad1cdfb7112b8bc8349e
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

<<<<<<< HEAD
    const result = await getLatestAnalysis();
    return NextResponse.json(result);
=======
    const issues = await fetchDetectedIssues(user.id);
    return NextResponse.json({
      run: issues[0] ? { id: issues[0].id, created_at: issues[0].updated_at, summary: `Showing ${issues.length} detected issue threads.` } : null,
      problems: issues,
    });
>>>>>>> e2a762a1685477c3b37aad1cdfb7112b8bc8349e
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load issues." },
      { status: 500 }
    );
  }
}
