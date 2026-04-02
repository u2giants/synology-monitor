import { NextRequest, NextResponse } from "next/server";
import { analyzeRecentLogs, getLatestAnalysis, getAnalysisById } from "@/lib/server/log-analyzer";

// POST /api/analysis - Trigger a new analysis run
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const lookbackMinutes = body.lookbackMinutes || 60;

    const result = await analyzeRecentLogs(lookbackMinutes);

    if (result.error) {
      return NextResponse.json(
        { error: result.error },
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
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// GET /api/analysis - Get the latest analysis or a specific one
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

    // Return latest analysis
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
