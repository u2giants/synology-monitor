import { NextResponse } from "next/server";
import { runApprovedAction } from "@/lib/server/copilot";
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

    const body = (await request.json()) as {
      target: "edgesynology1" | "edgesynology2";
      command: string;
      approvalToken: string;
    };

    const result = await runApprovedAction(body.target, body.command, body.approvalToken);

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
