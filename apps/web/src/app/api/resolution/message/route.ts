import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { appendLog, appendMessage, safeAppendMessage, updateResolution } from "@/lib/server/resolution-store";
import { tick } from "@/lib/server/resolution-agent";
import { callMinimax } from "@/lib/server/minimax";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function rejectPendingFixSteps(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  resolutionId: string
) {
  await supabase
    .from("smon_resolution_steps")
    .update({ status: "rejected" })
    .eq("resolution_id", resolutionId)
    .eq("user_id", userId)
    .eq("category", "fix")
    .eq("status", "planned");
}

async function generateAgentAck(
  phase: string,
  title: string,
  diagnosisSummary: string | null,
  fixSummary: string | null,
  stuckReason: string | null,
  recentMessages: Array<{ role: string; content: string }>,
  userMessage: string
): Promise<string | null> {
  const contextParts: string[] = [
    `Issue: ${title}`,
    `Current phase: ${phase}`,
  ];
  if (diagnosisSummary) contextParts.push(`Diagnosis: ${diagnosisSummary.slice(0, 300)}`);
  if (fixSummary) contextParts.push(`Proposed fix: ${fixSummary.slice(0, 200)}`);
  if (stuckReason) contextParts.push(`Stuck reason: ${stuckReason.slice(0, 200)}`);

  const historyText = recentMessages.slice(-5).map(m =>
    `${m.role === "user" ? "User" : "Agent"}: ${m.content}`
  ).join("\n");

  const userPrompt = `${contextParts.join("\n")}

${historyText ? `Recent conversation:\n${historyText}\n` : ""}
The user just said: "${userMessage}"

Write a 1-3 sentence direct response. Acknowledge what they said and tell them what you will do next. Be a driver, not a passenger.`;

  const result = await callMinimax(
    "You are an AI assistant helping resolve a NAS infrastructure problem. Respond in plain conversational English. No markdown. 1-3 sentences max.",
    userPrompt,
    { maxTokens: 150 }
  );

  return result.content ?? null;
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const { resolutionId, message } = await request.json() as {
      resolutionId: string;
      message: string;
    };

    if (!resolutionId || !message?.trim()) {
      return NextResponse.json({ error: "resolutionId and message required." }, { status: 400 });
    }

    const trimmed = message.trim();

    // Write user message to conversation table
    await appendMessage(supabase, user.id, resolutionId, "user", trimmed);

    // Also keep the log entry for backward compat with prompts
    await appendLog(supabase, user.id, resolutionId, "user_input", trimmed);

    // Load current resolution state for context
    const [resResult, messagesResult] = await Promise.all([
      supabase
        .from("smon_issue_resolutions")
        .select("phase, description, title, diagnosis_summary, fix_summary, stuck_reason")
        .eq("id", resolutionId)
        .eq("user_id", user.id)
        .single(),
      supabase
        .from("smon_resolution_messages")
        .select("role, content")
        .eq("resolution_id", resolutionId)
        .eq("user_id", user.id)
        .order("created_at", { ascending: true })
        .limit(10),
    ]);

    const res = resResult.data;
    const recentMessages = (messagesResult.data ?? []) as Array<{ role: string; content: string }>;

    // Generate an AI acknowledgment of the user's message
    const ackPromise = res ? generateAgentAck(
      res.phase,
      res.title ?? "this issue",
      res.diagnosis_summary,
      res.fix_summary,
      res.stuck_reason,
      recentMessages,
      trimmed
    ) : Promise.resolve(null);

    // Phase-specific state transitions
    if (res?.phase === "stuck") {
      await updateResolution(supabase, user.id, resolutionId, {
        phase: "planning",
        stuck_reason: undefined as unknown as string,
      });
      await supabase
        .from("smon_issue_resolutions")
        .update({
          description: `${res.description}\n\nAdditional context from user: ${trimmed}`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", resolutionId)
        .eq("user_id", user.id);
      await appendLog(supabase, user.id, resolutionId, "analysis",
        `Got it. Incorporating your context and restarting the investigation: "${trimmed}"`);
    } else if (res?.phase === "awaiting_fix_approval") {
      await rejectPendingFixSteps(supabase, user.id, resolutionId);
      await updateResolution(supabase, user.id, resolutionId, { phase: "proposing_fix" });
      await supabase
        .from("smon_issue_resolutions")
        .update({
          description: `${res.description}\n\nUser constraint on fix: ${trimmed}`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", resolutionId)
        .eq("user_id", user.id);
      await appendLog(supabase, user.id, resolutionId, "analysis",
        `Got it. Will take that into account and propose a different fix: "${trimmed}"`);
    } else {
      await appendLog(supabase, user.id, resolutionId, "analysis",
        `Noted: "${trimmed}" — will incorporate this into the current investigation.`);
    }

    // Write the AI acknowledgment to the conversation table
    const ack = await ackPromise;
    if (ack) {
      await safeAppendMessage(supabase, user.id, resolutionId, "agent", ack);
    }

    const state = await tick(supabase, user.id, resolutionId);
    return NextResponse.json(state);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Message failed." },
      { status: 500 }
    );
  }
}
