import { NextResponse } from "next/server";
import { runApprovedAction } from "@/lib/server/copilot";
import { getCopilotRole, updateActionStatus } from "@/lib/server/copilot-store";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
      if (body.actionId) {
        await updateActionStatus(supabase, user.id, body.actionId, { status: "rejected" });
      }
      return NextResponse.json({ ok: true, content: "Action rejected." });
    }

    if (body.actionId) {
      await updateActionStatus(supabase, user.id, body.actionId, { status: "approved" });
    }

    const result = await runApprovedAction(body.target, body.commandPreview, body.approvalToken);

    if (body.actionId) {
      await updateActionStatus(supabase, user.id, body.actionId, {
        status: result.ok ? "executed" : "failed",
        result: result.content,
      });
    }

    return NextResponse.json(result);
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
