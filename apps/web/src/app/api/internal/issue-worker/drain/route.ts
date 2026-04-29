import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { drainIssueQueueGlobal } from "@/lib/server/issue-workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function isAuthorized(request: Request) {
  const expected = process.env.ISSUE_WORKER_TOKEN;
  if (!expected) return false;

  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(expected);
  if (tokenBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(tokenBuf, expectedBuf);
}

export async function POST(request: Request) {
  try {
    if (!isAuthorized(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const requestedLimit = Number(body.limit ?? 10);
    const limit = Math.min(Math.max(requestedLimit, 1), 50);

    const supabase = createAdminClient();
    const processed = await drainIssueQueueGlobal(supabase as never, { limit });

    return NextResponse.json({
      ok: true,
      processed,
      worker_mode: process.env.ISSUE_WORKER_MODE ?? "inline",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Issue worker drain failed.",
      },
      { status: 500 },
    );
  }
}
