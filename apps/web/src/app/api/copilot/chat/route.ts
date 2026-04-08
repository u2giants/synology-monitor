import { NextResponse } from "next/server";
import {
  type CopilotMessage,
  type ReasoningEffort,
  type LookbackHours,
} from "@/lib/server/copilot";
import { getCopilotRole } from "@/lib/server/copilot-store";
import { runIssueBackedCopilotChat } from "@/lib/server/copilot-issues";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Simple in-memory rate limiter: 20 requests per minute per IP
const rateLimiter = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 20;
const WINDOW_MS = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimiter.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimiter.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT) {
    return false;
  }

  entry.count++;
  return true;
}

export async function POST(request: Request) {
  // Get client IP for rate limiting
  const forwardedFor = request.headers.get("x-forwarded-for");
  const clientIp = forwardedFor?.split(",")[0]?.trim() || "unknown";

  // Check rate limit
  if (!checkRateLimit(clientIp)) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Please wait before sending more requests." },
      { status: 429 }
    );
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

    const body = (await request.json()) as {
      sessionId?: string | null;
      messages: CopilotMessage[];
      reasoningEffort?: ReasoningEffort;
      lookbackHours?: LookbackHours;
    };

    const roleInfo = await getCopilotRole(supabase, user);
    const reasoningEffort = body.reasoningEffort === "xhigh" ? "xhigh" : "high";
    const lookbackHours = body.lookbackHours === 1 || body.lookbackHours === 6 || body.lookbackHours === 24 ? body.lookbackHours : 2;

    const response = await runIssueBackedCopilotChat(supabase, user.id, roleInfo.role, {
      sessionId: body.sessionId,
      messages: body.messages ?? [],
      reasoningEffort,
      lookbackHours,
    });

    return NextResponse.json({
      ...response,
      role: roleInfo.role,
      persistenceEnabled: roleInfo.persistenceEnabled,
      lookbackHours,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to generate copilot response.",
      },
      { status: 500 }
    );
  }
}
