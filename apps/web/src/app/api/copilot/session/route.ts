import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCopilotRole, loadLatestSession } from "@/lib/server/copilot-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

    const [roleInfo, sessionInfo] = await Promise.all([
      getCopilotRole(supabase, user),
      loadLatestSession(supabase, user.id),
    ]);

    return NextResponse.json({
      role: roleInfo.role,
      persistenceEnabled: roleInfo.persistenceEnabled && sessionInfo.persistenceEnabled,
      session: sessionInfo.session,
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
