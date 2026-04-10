import { NextRequest, NextResponse } from "next/server";
import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";
import { getCopilotRole } from "@/lib/server/copilot-store";
import { deleteIssueBackedSession, loadIssueBackedSession, listIssueBackedSessions } from "@/lib/server/copilot-issues";

// GET /api/copilot/session - Load session list and optionally a specific session
export async function GET(request: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get("sessionId");

    const [roleResult, sessions, session] = await Promise.all([
      getCopilotRole(supabase, user),
      listIssueBackedSessions(supabase, user.id),
      loadIssueBackedSession(supabase, user.id, sessionId),
    ]);

    return NextResponse.json({
      role: roleResult.role,
      persistenceEnabled: roleResult.persistenceEnabled,
      sessions,
      session,
    });
  } catch (error) {
    console.error("[GET /api/copilot/session] Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { sessionId } = body;

    if (!sessionId) {
      return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    }

    await deleteIssueBackedSession(supabase, user.id, sessionId);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[DELETE /api/copilot/session] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
