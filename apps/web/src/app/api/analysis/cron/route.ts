import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runIssueDetection } from "@/lib/server/issue-detector";
import { queueIssueRun } from "@/lib/server/issue-workflow";
import type { SupabaseClient } from "@/lib/server/issue-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// 20-minute lookback gives a 5-minute overlap buffer for a 15-minute cron cadence.
const LOOKBACK_MINUTES = 20;

function isAuthorized(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const { searchParams } = new URL(request.url);
  return searchParams.get("secret") === expected;
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const adminClient = createAdminClient();

  const { data, error: listError } = await adminClient.auth.admin.listUsers({ perPage: 1000 });
  if (listError) {
    return NextResponse.json({ ok: false, error: listError.message }, { status: 500 });
  }

  const results: { userId: string; detected: number; error?: string }[] = [];

  for (const user of data.users) {
    try {
      const issueIds = await runIssueDetection(
        adminClient as unknown as SupabaseClient,
        user.id,
        LOOKBACK_MINUTES,
      );
      for (const issueId of issueIds) {
        await queueIssueRun(
          adminClient as unknown as SupabaseClient,
          user.id,
          issueId,
          "detect_issue",
          { lookback_minutes: LOOKBACK_MINUTES },
        );
      }
      results.push({ userId: user.id, detected: issueIds.length });
    } catch (err) {
      results.push({
        userId: user.id,
        detected: 0,
        error: err instanceof Error ? err.message : "Detection failed",
      });
    }
  }

  const totalDetected = results.reduce((sum, r) => sum + r.detected, 0);
  return NextResponse.json({
    ok: true,
    users: data.users.length,
    detected: totalDetected,
    timestamp: new Date().toISOString(),
    results,
  });
}
