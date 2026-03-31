import { NextResponse } from "next/server";
import {
  generateCopilotResponse,
  type CopilotMessage,
  type ReasoningEffort,
  type LookbackHours,
} from "@/lib/server/copilot";
import {
  ensureSession,
  getCopilotRole,
  persistTurn,
} from "@/lib/server/copilot-store";
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
      sessionId?: string | null;
      messages: CopilotMessage[];
      reasoningEffort?: ReasoningEffort;
      lookbackHours?: LookbackHours;
    };

    const roleInfo = await getCopilotRole(supabase, user);
    const reasoningEffort = body.reasoningEffort === "xhigh" ? "xhigh" : "high";
    const lookbackHours = body.lookbackHours === 1 || body.lookbackHours === 6 || body.lookbackHours === 24 ? body.lookbackHours : 2;

    const sessionState = await ensureSession(
      supabase,
      user.id,
      body.sessionId,
      reasoningEffort,
      lookbackHours
    );

    const response = await generateCopilotResponse(
      body.messages ?? [],
      reasoningEffort,
      lookbackHours,
      roleInfo.role
    );

    const userMessage = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
    const assistantMessageId = crypto.randomUUID();
    const persistedUserMessageId = crypto.randomUUID();
    if (sessionState.persistenceEnabled && sessionState.sessionId && userMessage) {
      await persistTurn(supabase, user.id, {
        sessionId: sessionState.sessionId,
        userMessage: {
          id: persistedUserMessageId,
          content: userMessage.content,
          createdAt: new Date().toISOString(),
        },
        assistantMessage: {
          id: assistantMessageId,
          content: response.answer,
          createdAt: new Date().toISOString(),
          evidence: response.evidence,
        },
        actions: response.proposedActions,
      });
    }

    return NextResponse.json({
      ...response,
      sessionId: sessionState.sessionId,
      assistantMessageId,
      role: roleInfo.role,
      persistenceEnabled: sessionState.persistenceEnabled && roleInfo.persistenceEnabled,
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
