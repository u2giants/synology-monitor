import { NextRequest, NextResponse } from "next/server";
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
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
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
    }

    return NextResponse.json({
      runId: result.runId,
      result: result.result,
    });
  } catch (error) {
    console.error("[POST /api/analysis] Error:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        failureReason: "unknown",
        userMessage: "An unexpected error occurred. Check server logs for details.",
      },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (id) {
      const result = await getAnalysisById(id);
      if (!result.run) {
        return NextResponse.json(
          { error: "Analysis not found" },
          { status: 404 }
        );
      }
      return NextResponse.json(result);
    }

    const result = await getLatestAnalysis();
    return NextResponse.json(result);
  } catch (error) {
    console.error("[GET /api/analysis] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
