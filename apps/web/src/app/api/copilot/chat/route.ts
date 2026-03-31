import { NextResponse } from "next/server";
import { generateCopilotResponse, type CopilotMessage, type ReasoningEffort } from "@/lib/server/copilot";
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
      messages: CopilotMessage[];
      reasoningEffort?: ReasoningEffort;
    };

    const response = await generateCopilotResponse(
      body.messages ?? [],
      body.reasoningEffort === "xhigh" ? "xhigh" : "high"
    );

    return NextResponse.json(response);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to generate copilot response.",
      },
      { status: 500 }
    );
  }
}
