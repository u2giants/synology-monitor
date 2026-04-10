import { NextResponse } from "next/server";
import { getCopilotRole } from "@/lib/server/copilot-store";
import { executeIssueBackedCopilotAction } from "@/lib/server/copilot-issues";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

    const roleInfo = await getCopilotRole(supabase, user);
    if (roleInfo.role === "viewer") {
      return NextResponse.json({ ok: false, error: "Your role is not allowed to execute NAS actions." }, { status: 403 });
    }

    const body = (await request.json()) as {
      actionId?: string;
      target: "edgesynology1" | "edgesynology2";
      commandPreview: string;
      approvalToken: string;
      decision?: "approve" | "reject";
    };

    if (body.decision === "reject") {
      return NextResponse.json(await executeIssueBackedCopilotAction(supabase, user.id, body));
    }

    return NextResponse.json(await executeIssueBackedCopilotAction(supabase, user.id, body));
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to execute approved action.",
      },
      { status: 500 }
    );
  }
}
