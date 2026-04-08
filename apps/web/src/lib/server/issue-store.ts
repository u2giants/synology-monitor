import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";

export type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

export type IssueStatus =
  | "open"
  | "running"
  | "waiting_on_user"
  | "waiting_for_approval"
  | "resolved"
  | "stuck"
  | "cancelled";

export type IssueSeverity = "critical" | "warning" | "info";
export type IssueRole = "user" | "agent" | "system";
export type IssueActionKind = "diagnostic" | "remediation";
export type IssueActionStatus = "proposed" | "approved" | "rejected" | "running" | "completed" | "failed" | "skipped";
export type IssueConfidence = "high" | "medium" | "low";

export interface Issue {
  id: string;
  user_id: string;
  fingerprint: string | null;
  origin_type: "manual" | "alert" | "problem" | "detected";
  origin_id: string | null;
  title: string;
  summary: string;
  severity: IssueSeverity;
  status: IssueStatus;
  affected_nas: string[];
  current_hypothesis: string;
  hypothesis_confidence: IssueConfidence;
  next_step: string;
  conversation_summary: string;
  operator_constraints: string[];
  blocked_tools: string[];
  metadata: Record<string, unknown>;
  last_agent_message: string | null;
  last_user_message: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IssueMessage {
  id: string;
  issue_id: string;
  user_id: string;
  role: IssueRole;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface IssueEvidence {
  id: string;
  issue_id: string;
  user_id: string;
  source_kind: "telemetry" | "diagnostic" | "user_statement" | "analysis";
  title: string;
  detail: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface IssueAction {
  id: string;
  issue_id: string;
  user_id: string;
  kind: IssueActionKind;
  status: IssueActionStatus;
  target: string | null;
  tool_name: string;
  command_preview: string;
  summary: string;
  reason: string;
  expected_outcome: string;
  rollback_plan: string;
  risk: "low" | "medium" | "high";
  requires_approval: boolean;
  result_text: string | null;
  exit_code: number | null;
  approval_token: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface IssueFull {
  issue: Issue;
  messages: IssueMessage[];
  evidence: IssueEvidence[];
  actions: IssueAction[];
}

export interface IssueStateTransition {
  id: string;
  issue_id: string;
  user_id: string;
  from_status: IssueStatus | null;
  to_status: IssueStatus;
  reason: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface CreateIssueInput {
  originType: Issue["origin_type"];
  originId?: string | null;
  title: string;
  summary?: string;
  severity?: IssueSeverity;
  affectedNas?: string[];
  fingerprint?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ProposedIssueAction {
  kind: IssueActionKind;
  target: string | null;
  toolName: string;
  commandPreview: string;
  summary: string;
  reason: string;
  expectedOutcome: string;
  rollbackPlan: string;
  risk: "low" | "medium" | "high";
  requiresApproval: boolean;
  approvalToken?: string | null;
}

export async function createIssue(
  supabase: SupabaseClient,
  userId: string,
  input: CreateIssueInput
): Promise<string> {
  const payload = {
    user_id: userId,
    fingerprint: input.fingerprint ?? null,
    origin_type: input.originType,
    origin_id: input.originId ?? null,
    title: input.title,
    summary: input.summary ?? "",
    severity: input.severity ?? "warning",
    affected_nas: input.affectedNas ?? [],
    metadata: input.metadata ?? {},
  };

  if (input.fingerprint) {
    const { data: existing, error: existingError } = await supabase
      .from("smon_issues")
      .select("id")
      .eq("user_id", userId)
      .eq("fingerprint", input.fingerprint)
      .maybeSingle();

    if (existingError) {
      throw new Error(`Failed to look up existing issue: ${existingError.message}`);
    }

    if (existing?.id) {
      const { error: updateError } = await supabase
        .from("smon_issues")
        .update({
          title: payload.title,
          summary: payload.summary,
          severity: payload.severity,
          affected_nas: payload.affected_nas,
          metadata: payload.metadata,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
        .eq("user_id", userId);

      if (updateError) {
        throw new Error(`Failed to update existing issue: ${updateError.message}`);
      }

      return existing.id;
    }
  }

  const { data, error } = await supabase
    .from("smon_issues")
    .insert(payload)
    .select("id")
    .single();

  if (error || !data) throw new Error(`Failed to create issue: ${error?.message ?? "unknown error"}`);
  return data.id;
}

export async function loadIssue(
  supabase: SupabaseClient,
  userId: string,
  issueId: string
): Promise<IssueFull | null> {
  const [issueResult, messagesResult, evidenceResult, actionsResult] = await Promise.all([
    supabase.from("smon_issues").select("*").eq("id", issueId).eq("user_id", userId).single(),
    supabase.from("smon_issue_messages").select("*").eq("issue_id", issueId).eq("user_id", userId).order("created_at", { ascending: true }),
    supabase.from("smon_issue_evidence").select("*").eq("issue_id", issueId).eq("user_id", userId).order("created_at", { ascending: true }),
    supabase.from("smon_issue_actions").select("*").eq("issue_id", issueId).eq("user_id", userId).order("created_at", { ascending: true }),
  ]);

  if (issueResult.error || !issueResult.data) return null;

  return {
    issue: normalizeIssue(issueResult.data),
    messages: (messagesResult.data ?? []) as IssueMessage[],
    evidence: (evidenceResult.data ?? []) as IssueEvidence[],
    actions: (actionsResult.data ?? []) as IssueAction[],
  };
}

export async function listIssues(supabase: SupabaseClient, userId: string): Promise<Issue[]> {
  const { data, error } = await supabase
    .from("smon_issues")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(50);

  if (error) throw new Error(`Failed to list issues: ${error.message}`);
  return (data ?? []).map(normalizeIssue);
}

export async function updateIssue(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
  updates: Partial<{
    title: string;
    summary: string;
    severity: IssueSeverity;
    status: IssueStatus;
    affected_nas: string[];
    current_hypothesis: string;
    hypothesis_confidence: IssueConfidence;
    next_step: string;
    conversation_summary: string;
    operator_constraints: string[];
    blocked_tools: string[];
    metadata: Record<string, unknown>;
    last_agent_message: string | null;
    last_user_message: string | null;
    resolved_at: string | null;
  }>
) {
  let previousStatus: IssueStatus | null = null;
  if (updates.status) {
    const { data: current } = await supabase
      .from("smon_issues")
      .select("status")
      .eq("id", issueId)
      .eq("user_id", userId)
      .maybeSingle();
    previousStatus = (current?.status as IssueStatus | undefined) ?? null;
  }

  const { error } = await supabase
    .from("smon_issues")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", issueId)
    .eq("user_id", userId);

  if (error) throw new Error(`Failed to update issue: ${error.message}`);

  if (updates.status && previousStatus !== updates.status) {
    await recordIssueTransition(
      supabase,
      userId,
      issueId,
      previousStatus,
      updates.status,
      "issue_update",
      { changed_fields: Object.keys(updates) },
    );
  }
}

export async function appendIssueMessage(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
  role: IssueRole,
  content: string,
  metadata: Record<string, unknown> = {}
) {
  const { error } = await supabase.from("smon_issue_messages").insert({
    issue_id: issueId,
    user_id: userId,
    role,
    content,
    metadata,
  });

  if (error) throw new Error(`Failed to append issue message: ${error.message}`);

  await updateIssue(supabase, userId, issueId, role === "user"
    ? { last_user_message: content }
    : { last_agent_message: content });
}

export async function appendIssueEvidence(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
  evidence: Omit<IssueEvidence, "id" | "created_at" | "issue_id" | "user_id">
) {
  const { error } = await supabase.from("smon_issue_evidence").insert({
    issue_id: issueId,
    user_id: userId,
    source_kind: evidence.source_kind,
    title: evidence.title,
    detail: evidence.detail,
    metadata: evidence.metadata,
  });

  if (error) throw new Error(`Failed to append issue evidence: ${error.message}`);
}

export async function createIssueAction(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
  action: ProposedIssueAction
): Promise<string> {
  const { data, error } = await supabase
    .from("smon_issue_actions")
    .insert({
      issue_id: issueId,
      user_id: userId,
      kind: action.kind,
      target: action.target,
      tool_name: action.toolName,
      command_preview: action.commandPreview,
      summary: action.summary,
      reason: action.reason,
      expected_outcome: action.expectedOutcome,
      rollback_plan: action.rollbackPlan,
      risk: action.risk,
      requires_approval: action.requiresApproval,
      approval_token: action.approvalToken ?? null,
    })
    .select("id")
    .single();

  if (error || !data) throw new Error(`Failed to create issue action: ${error?.message ?? "unknown error"}`);
  return data.id;
}

export async function updateIssueAction(
  supabase: SupabaseClient,
  userId: string,
  actionId: string,
  updates: Partial<{
    status: IssueActionStatus;
    result_text: string | null;
    exit_code: number | null;
    completed_at: string | null;
  }>
) {
  const payload = { ...updates, updated_at: new Date().toISOString() };
  const { error } = await supabase
    .from("smon_issue_actions")
    .update(payload)
    .eq("id", actionId)
    .eq("user_id", userId);

  if (error) throw new Error(`Failed to update issue action: ${error.message}`);
}

export async function deleteIssue(supabase: SupabaseClient, userId: string, issueId: string) {
  const { error } = await supabase.from("smon_issues").delete().eq("id", issueId).eq("user_id", userId);
  if (error) throw new Error(`Failed to delete issue: ${error.message}`);
}

export async function recordIssueTransition(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
  fromStatus: IssueStatus | null,
  toStatus: IssueStatus,
  reason: string,
  metadata: Record<string, unknown> = {},
) {
  const { error } = await supabase.from("smon_issue_state_transitions").insert({
    issue_id: issueId,
    user_id: userId,
    from_status: fromStatus,
    to_status: toStatus,
    reason,
    metadata,
  });

  if (error) throw new Error(`Failed to record issue transition: ${error.message}`);
}

function normalizeIssue(row: Record<string, unknown>): Issue {
  return {
    ...(row as unknown as Issue),
    operator_constraints: Array.isArray(row.operator_constraints) ? row.operator_constraints as string[] : [],
    blocked_tools: Array.isArray(row.blocked_tools) ? row.blocked_tools as string[] : [],
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    affected_nas: Array.isArray(row.affected_nas) ? row.affected_nas as string[] : [],
  };
}
