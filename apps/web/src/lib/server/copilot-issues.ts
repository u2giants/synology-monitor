import type { CopilotMessage, LookbackHours, ReasoningEffort } from "@/lib/server/copilot";
import { randomId } from "@/lib/server/tools";
import { createIssue, loadIssue, updateIssue, updateIssueAction } from "@/lib/server/issue-store";
import { loadIssueViewState } from "@/lib/server/issue-view";
import { drainIssueQueue, queueIssueRun, shouldInlineDrain } from "@/lib/server/issue-workflow";
import type { CopilotRole, StoredEvidenceItem, StoredSession, StoredSessionSummary } from "@/lib/server/copilot-store";
import type { SupabaseClient } from "@/lib/server/issue-store";
import { executeApprovedCommand } from "@/lib/server/nas";
import { verifyApprovalToken, type NasTarget } from "@/lib/server/tools";

function buildIssueTitle(content: string) {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return "Issue conversation";
  return normalized.length > 72 ? `${normalized.slice(0, 69)}...` : normalized;
}

function toStoredEvidence(
  state: Awaited<ReturnType<typeof loadIssueViewState>>,
) {
  const evidence = state.evidence.slice(-8).map((entry) => ({
    id: entry.id,
    kind: (entry.source_kind === "diagnostic" ? "ssh" : "log") as StoredEvidenceItem["kind"],
    title: entry.title,
    detail: entry.detail,
    timestamp: entry.created_at,
  }));

  for (const fact of state.facts.slice(0, 8)) {
    evidence.push({
      id: `fact-${fact.id}`,
      kind: "log",
      title: fact.title,
      detail: fact.detail,
      timestamp: fact.observed_at,
    });
  }

  return evidence;
}

function toStoredSession(state: Awaited<ReturnType<typeof loadIssueViewState>>): StoredSession {
  return {
    id: state.issue.id,
    title: state.issue.title,
    reasoningEffort: "high",
    lookbackHours: 2,
    messages: state.messages.map((message) => ({
      id: message.id,
      role: message.role === "agent" ? "assistant" : message.role === "system" ? "tool" : "user",
      content: message.content,
      createdAt: message.created_at,
      evidence: message.role === "agent" ? toStoredEvidence(state) : [],
      actions: message.role === "agent"
        ? state.actions
            .filter((action) => action.created_at >= message.created_at)
            .slice(0, 5)
            .map((action) => ({
              id: action.id,
              title: action.summary,
              target: (action.target as "edgesynology1" | "edgesynology2") ?? "edgesynology1",
              toolName: action.tool_name,
              commandPreview: action.command_preview,
              reason: action.reason,
              risk: action.risk,
              approvalToken: action.approval_token ?? "",
              status: action.status === "completed"
                ? "executed"
                : action.status === "failed"
                  ? "failed"
                  : action.status === "running"
                    ? "approved"
                    : action.status === "skipped"
                      ? "expired"
                      : action.status,
              result: action.result_text ?? undefined,
            }))
        : undefined,
    })),
  };
}

export async function listIssueBackedSessions(
  supabase: SupabaseClient,
  userId: string,
): Promise<StoredSessionSummary[]> {
  const { data, error } = await supabase
    .from("issues")
    .select("id, title, updated_at, created_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(25);

  if (error) {
    throw new Error(`Failed to list issue-backed sessions: ${error.message}`);
  }

  return (data ?? []).map((issue) => ({
    id: issue.id,
    title: issue.title,
    reasoningEffort: "high",
    lookbackHours: 2,
    updatedAt: issue.updated_at,
    createdAt: issue.created_at,
  }));
}

export async function loadIssueBackedSession(
  supabase: SupabaseClient,
  userId: string,
  issueId?: string | null,
) {
  if (!issueId) return null;
  const state = await loadIssue(supabase, userId, issueId);
  if (!state) return null;
  return toStoredSession(await loadIssueViewState(supabase, userId, state));
}

export async function deleteIssueBackedSession(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
) {
  const { error } = await supabase
    .from("issues")
    .delete()
    .eq("id", issueId)
    .eq("user_id", userId);

  if (error) {
    throw new Error(`Failed to delete issue-backed session: ${error.message}`);
  }
}

export async function runIssueBackedCopilotChat(
  supabase: SupabaseClient,
  userId: string,
  role: CopilotRole,
  input: {
    sessionId?: string | null;
    messages: CopilotMessage[];
    reasoningEffort?: ReasoningEffort;
    lookbackHours?: LookbackHours;
  },
) {
  const userMessage = [...(input.messages ?? [])].reverse().find((message) => message.role === "user");
  if (!userMessage?.content?.trim()) {
    throw new Error("A user message is required.");
  }

  let issueId = input.sessionId ?? null;
  if (!issueId) {
    issueId = await createIssue(supabase, userId, {
      originType: "manual",
      title: buildIssueTitle(userMessage.content),
      summary: userMessage.content,
      severity: "warning",
      metadata: {
        entrypoint: "copilot",
        reasoning_effort: input.reasoningEffort ?? "high",
        lookback_hours: input.lookbackHours ?? 2,
      },
    });
  }

  const current = await loadIssue(supabase, userId, issueId);
  if (!current) {
    throw new Error("Issue session not found.");
  }

  const shouldAppendUserMessage = current.issue.last_user_message !== userMessage.content;
  if (shouldAppendUserMessage) {
    const { appendIssueEvidence, appendIssueMessage } = await import("@/lib/server/issue-store");
    await appendIssueMessage(supabase, userId, issueId, "user", userMessage.content, {
      source: "copilot",
      client_message_id: userMessage.id,
    });
    await appendIssueEvidence(supabase, userId, issueId, {
      source_kind: "user_statement",
      title: "Copilot user message",
      detail: userMessage.content,
      metadata: {},
    });
    await updateIssue(supabase, userId, issueId, { status: "running" });
  }

  await queueIssueRun(supabase, userId, issueId, "user_message", {
    source: "copilot",
    reasoning_effort: input.reasoningEffort ?? "high",
    lookback_hours: input.lookbackHours ?? 2,
  });
  const inlineDrain = shouldInlineDrain();
  if (inlineDrain) {
    await drainIssueQueue(supabase, userId, { limit: 1 });
  }

  const next = await loadIssue(supabase, userId, issueId);
  if (!next) {
    throw new Error("Issue session disappeared.");
  }

  const view = await loadIssueViewState(supabase, userId, next);
  const answer = inlineDrain
    ? view.messages.filter((message) => message.role === "agent").slice(-1)[0]?.content
      ?? view.issue.last_agent_message
      ?? "No agent response was generated."
    : "Your issue has been queued for the backend worker. Refresh in a moment or keep this thread open while the worker processes it.";

  return {
    sessionId: issueId,
    assistantMessageId: view.messages.filter((message) => message.role === "agent").slice(-1)[0]?.id ?? randomId(),
    answer,
    evidence: toStoredEvidence(view),
    proposedActions: role === "viewer"
      ? []
      : view.actions
          .filter((action) => action.status === "proposed")
          .map((action) => ({
            id: action.id,
            title: action.summary,
            target: (action.target as "edgesynology1" | "edgesynology2") ?? "edgesynology1",
            toolName: action.tool_name,
            commandPreview: action.command_preview,
            reason: action.reason,
            risk: action.risk,
            approvalToken: action.approval_token ?? "",
            status: "proposed" as const,
          })),
  };
}

export async function executeIssueBackedCopilotAction(
  supabase: SupabaseClient,
  userId: string,
  input: {
    actionId?: string;
    target: "edgesynology1" | "edgesynology2";
    commandPreview: string;
    approvalToken: string;
    decision?: "approve" | "reject";
  },
) {
  if (input.decision === "reject") {
    if (input.actionId) {
      await updateIssueAction(supabase, userId, input.actionId, {
        status: "rejected",
        completed_at: new Date().toISOString(),
      });
    }
    return { ok: true, content: "Action rejected." };
  }

  verifyApprovalToken(input.target as NasTarget, input.commandPreview, input.approvalToken);

  if (input.actionId) {
    await updateIssueAction(supabase, userId, input.actionId, { status: "approved" });
    const { data: issueAction, error } = await supabase
      .from("issue_actions")
      .select("issue_id")
      .eq("id", input.actionId)
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to resolve issue action: ${error.message}`);
    }

    if (issueAction?.issue_id) {
      await queueIssueRun(supabase, userId, issueAction.issue_id, "approval_decision", { action_id: input.actionId, source: "copilot" });
      if (shouldInlineDrain()) {
        await drainIssueQueue(supabase, userId, { limit: 1 });
      } else {
        return {
          ok: true,
          content: "Approval recorded. The backend worker will execute this action shortly.",
          exitCode: null,
        };
      }
      const refreshed = await supabase
        .from("issue_actions")
        .select("result_text, exit_code, status")
        .eq("id", input.actionId)
        .eq("user_id", userId)
        .maybeSingle();

      return {
        ok: refreshed.data?.status === "completed",
        content: refreshed.data?.result_text ?? "Action completed.",
        exitCode: refreshed.data?.exit_code ?? null,
      };
    }
  }

  const result = await executeApprovedCommand(input.target as NasTarget, input.commandPreview);
  const chunks = [result.stdout, result.stderr].filter(Boolean);
  return {
    ok: result.exitCode === 0,
    content: chunks.length > 0 ? chunks.join("\n\n") : "Command completed with no output.",
    exitCode: result.exitCode,
  };
}
