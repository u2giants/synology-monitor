import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCopilotRole, listSessions, loadSession } from "@/lib/server/copilot-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get("sessionId");

    const [roleInfo, sessionInfo, sessionsInfo] = await Promise.all([
      getCopilotRole(supabase, user),
      loadSession(supabase, user.id, sessionId),
      listSessions(supabase, user.id),
    ]);

    return NextResponse.json({
      role: roleInfo.role,
      persistenceEnabled:
        roleInfo.persistenceEnabled &&
        sessionInfo.persistenceEnabled &&
        sessionsInfo.persistenceEnabled,
      session: sessionInfo.session,
      sessions: sessionsInfo.sessions,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to load copilot session.",
      },
      { status: 500 }
    );
  }
}
