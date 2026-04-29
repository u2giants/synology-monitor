import type { IssueFull, SupabaseClient } from "@/lib/server/issue-store";
import {
  createIssueEscalationEvent,
  createIssueInvestigationBrief,
  rebaseIssueWorkingSession,
  updateIssueEscalationEvent,
  type IssueWorkingSession,
} from "@/lib/server/issue-investigation-store";
import { appendIssueMessage } from "@/lib/server/issue-store";

type BriefSummaryEntry = {
  id: string;
  created_at: string;
  content?: string;
  title?: string;
  detail?: string;
};

export type InvestigationBriefContent = {
  issue_title: string;
  issue_summary: string;
  conversation_summary: string;
  current_hypothesis: string;
  hypothesis_confidence: string;
  next_step: string;
  operator_constraints: string[];
  blocked_tools: string[];
  unresolved_questions: string[];
  failed_or_rejected_actions: Array<{
    id: string;
    kind: string;
    status: string;
    summary: string;
    command_preview: string;
    result_text: string | null;
    created_at: string;
  }>;
  recent_agent_messages: Array<{ id: string; content: string; created_at: string }>;
  recent_user_messages: Array<{ id: string; content: string; created_at: string }>;
  pinned_evidence: Array<{
    id: string;
    source_kind: string;
    title: string;
    detail: string;
    created_at: string;
  }>;
  session_metrics: {
    active_session_id: string | null;
    active_session_mode: string | null;
    started_at: string | null;
    message_count_since_session_start: number;
    evidence_count_since_session_start: number;
    action_count_since_session_start: number;
  };
};

export type InvestigationSessionPressure = {
  promptPressurePct: number;
  sessionPressurePct: number;
  sessionAgeHours: number;
  shouldRebase: boolean;
  reasons: string[];
};

function trimEntries<T extends BriefSummaryEntry>(entries: T[], limit: number) {
  return entries.slice(-limit);
}

function truncate(value: string, max = 800) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

export function buildInvestigationBriefContent(
  state: IssueFull,
  session: IssueWorkingSession | null,
): InvestigationBriefContent {
  const sessionStartedAt = session ? Date.parse(session.started_at) : Number.NaN;
  const inSessionMessages = Number.isFinite(sessionStartedAt)
    ? state.messages.filter((message) => Date.parse(message.created_at) >= sessionStartedAt)
    : state.messages;
  const inSessionEvidence = Number.isFinite(sessionStartedAt)
    ? state.evidence.filter((entry) => Date.parse(entry.created_at) >= sessionStartedAt)
    : state.evidence;
  const inSessionActions = Number.isFinite(sessionStartedAt)
    ? state.actions.filter((action) => Date.parse(action.created_at) >= sessionStartedAt)
    : state.actions;

  const unresolvedQuestions = new Set<string>();
  if (state.issue.status === "waiting_on_user" && state.issue.next_step.trim()) {
    unresolvedQuestions.add(state.issue.next_step.trim());
  }
  for (const message of state.messages.slice(-12)) {
    if (message.role === "agent" && message.content.includes("?")) {
      unresolvedQuestions.add(truncate(message.content, 260));
    }
  }

  const failedOrRejectedActions = state.actions
    .filter((action) => action.status === "failed" || action.status === "rejected")
    .slice(-8)
    .map((action) => ({
      id: action.id,
      kind: action.kind,
      status: action.status,
      summary: action.summary,
      command_preview: action.command_preview,
      result_text: action.result_text ? truncate(action.result_text, 1200) : null,
      created_at: action.created_at,
    }));

  const pinnedEvidence = [
    ...state.evidence.filter((entry) => entry.source_kind === "analysis").slice(-8),
    ...state.evidence.filter((entry) => entry.source_kind !== "analysis").slice(-16),
  ]
    .slice(-20)
    .map((entry) => ({
      id: entry.id,
      source_kind: entry.source_kind,
      title: entry.title,
      detail: truncate(entry.detail, 900),
      created_at: entry.created_at,
    }));

  return {
    issue_title: state.issue.title,
    issue_summary: state.issue.summary,
    conversation_summary: state.issue.conversation_summary,
    current_hypothesis: state.issue.current_hypothesis,
    hypothesis_confidence: state.issue.hypothesis_confidence,
    next_step: state.issue.next_step,
    operator_constraints: state.issue.operator_constraints,
    blocked_tools: state.issue.blocked_tools,
    unresolved_questions: Array.from(unresolvedQuestions).slice(0, 6),
    failed_or_rejected_actions: failedOrRejectedActions,
    recent_agent_messages: trimEntries(
      state.messages
        .filter((message) => message.role === "agent")
        .map((message) => ({ id: message.id, content: truncate(message.content, 700), created_at: message.created_at })),
      6,
    ),
    recent_user_messages: trimEntries(
      state.messages
        .filter((message) => message.role === "user")
        .map((message) => ({ id: message.id, content: truncate(message.content, 700), created_at: message.created_at })),
      6,
    ),
    pinned_evidence: pinnedEvidence,
    session_metrics: {
      active_session_id: session?.id ?? null,
      active_session_mode: session?.mode ?? null,
      started_at: session?.started_at ?? null,
      message_count_since_session_start: inSessionMessages.length,
      evidence_count_since_session_start: inSessionEvidence.length,
      action_count_since_session_start: inSessionActions.length,
    },
  };
}

export function scoreInvestigationBrief(content: InvestigationBriefContent) {
  let score = 0;
  if (content.issue_summary.trim()) score += 15;
  if (content.conversation_summary.trim()) score += 20;
  if (content.current_hypothesis.trim()) score += 20;
  if (content.unresolved_questions.length > 0) score += 10;
  if (content.pinned_evidence.length >= 8) score += 15;
  else if (content.pinned_evidence.length >= 4) score += 10;
  if (content.failed_or_rejected_actions.length > 0) score += 10;
  if (content.operator_constraints.length > 0 || content.blocked_tools.length > 0) score += 10;
  return Math.min(score, 100);
}

export function estimateInvestigationSessionPressure(input: {
  state: IssueFull;
  session: IssueWorkingSession;
  profile: { messages: number; evidence: number; actions: number };
  rebaseThresholdPct: number;
}) {
  const sessionStartedAt = Date.parse(input.session.started_at);
  const sessionMessageCount = Number.isFinite(sessionStartedAt)
    ? input.state.messages.filter((message) => Date.parse(message.created_at) >= sessionStartedAt).length
    : input.state.messages.length;
  const sessionEvidenceCount = Number.isFinite(sessionStartedAt)
    ? input.state.evidence.filter((entry) => Date.parse(entry.created_at) >= sessionStartedAt).length
    : input.state.evidence.length;
  const sessionActionCount = Number.isFinite(sessionStartedAt)
    ? input.state.actions.filter((action) => Date.parse(action.created_at) >= sessionStartedAt).length
    : input.state.actions.length;

  const promptPressurePct = Math.round(
    Math.max(
      (input.state.messages.length / Math.max(input.profile.messages, 1)) * 100,
      (input.state.evidence.length / Math.max(input.profile.evidence, 1)) * 100,
      (input.state.actions.length / Math.max(input.profile.actions, 1)) * 100,
    ),
  );
  const sessionPressurePct = Math.round(
    Math.max(
      (sessionMessageCount / Math.max(input.profile.messages, 1)) * 100,
      (sessionEvidenceCount / Math.max(input.profile.evidence, 1)) * 100,
      (sessionActionCount / Math.max(input.profile.actions, 1)) * 100,
    ),
  );
  const sessionAgeHours = Math.max((Date.now() - sessionStartedAt) / 3_600_000, 0);

  const reasons: string[] = [];
  if (promptPressurePct >= input.rebaseThresholdPct) {
    reasons.push(`overall prompt pressure is ${promptPressurePct}%`);
  }
  if (sessionPressurePct >= Math.max(input.rebaseThresholdPct - 10, 70)) {
    reasons.push(`current working session alone is carrying ${sessionPressurePct}% of the profile`);
  }
  if (sessionAgeHours >= 2 && input.state.issue.hypothesis_confidence === "low") {
    reasons.push(`the session is ${sessionAgeHours.toFixed(1)} hours old and confidence is still low`);
  }
  if (sessionActionCount >= 4 && input.state.issue.hypothesis_confidence === "low") {
    reasons.push(`multiple actions have accumulated in the same session without clarity improving`);
  }

  return {
    promptPressurePct,
    sessionPressurePct,
    sessionAgeHours,
    shouldRebase: reasons.length > 0,
    reasons,
  } satisfies InvestigationSessionPressure;
}

export async function executeIssueContextRebase(input: {
  supabase: SupabaseClient;
  userId: string;
  state: IssueFull;
  activeSession: IssueWorkingSession;
  reason: string;
  mode?: "guided" | "deep";
  pendingEscalationId?: string | null;
  decisionReason?: string | null;
}) {
  const content = buildInvestigationBriefContent(input.state, input.activeSession);
  const qualityScore = scoreInvestigationBrief(content);
  const brief = await createIssueInvestigationBrief(input.supabase, input.userId, {
    issue_id: input.state.issue.id,
    source_session_id: input.activeSession.id,
    trigger_reason: input.reason,
    content_json: content,
    quality_score: qualityScore,
  });

  const nextSession = await rebaseIssueWorkingSession(input.supabase, input.userId, {
    issueId: input.state.issue.id,
    fromSessionId: input.activeSession.id,
    mode: input.mode ?? input.activeSession.mode,
  });

  if (input.pendingEscalationId) {
    await updateIssueEscalationEvent(input.supabase, input.userId, input.pendingEscalationId, {
      approved_by_user: true,
      decision_reason: input.decisionReason ?? input.reason,
    });
  }

  await appendIssueMessage(
    input.supabase,
    input.userId,
    input.state.issue.id,
    "system",
    `The investigation context was rebased into a fresh working session to keep the active prompt focused. Brief ${brief.id.slice(0, 8)} scored ${qualityScore}/100 and now anchors the new session ${nextSession.id.slice(0, 8)}.`,
  );

  await createIssueEscalationEvent(input.supabase, input.userId, {
    issue_id: input.state.issue.id,
    session_id: nextSession.id,
    kind: "expanded_context",
    from_model: null,
    to_model: null,
    from_reasoning: null,
    to_reasoning: null,
    estimated_cost: null,
    approved_by_user: true,
    decision_reason: input.decisionReason ?? input.reason,
  });

  return { brief, nextSession, qualityScore };
}
