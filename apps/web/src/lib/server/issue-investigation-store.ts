import type { InvestigationMode } from "@/lib/server/ai-settings";
import type { SupabaseClient } from "@/lib/server/issue-store";

export type IssueWorkingSessionStatus = "active" | "closed" | "rebased";

export interface IssueWorkingSession {
  id: string;
  issue_id: string;
  user_id: string;
  mode: InvestigationMode;
  status: IssueWorkingSessionStatus;
  rebase_from_session_id: string | null;
  started_at: string;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IssueInvestigationBrief {
  id: string;
  issue_id: string;
  user_id: string;
  source_session_id: string | null;
  trigger_reason: string;
  content_json: Record<string, unknown>;
  quality_score: number | null;
  created_at: string;
  updated_at: string;
}

export interface IssueEscalationEvent {
  id: string;
  issue_id: string;
  user_id: string;
  session_id: string | null;
  kind: "higher_reasoning" | "stronger_model" | "expanded_context" | "deep_mode_switch";
  from_model: string | null;
  to_model: string | null;
  from_reasoning: string | null;
  to_reasoning: string | null;
  estimated_cost: number | null;
  approved_by_user: boolean;
  decision_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface IssueTokenUsage {
  id: string;
  issue_id: string;
  user_id: string;
  session_id: string | null;
  stage_key: string;
  model_name: string;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  estimated_cost: number | null;
  created_at: string;
}

export async function ensureIssueWorkingSession(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
  mode: InvestigationMode = "guided",
) {
  const { data: existing, error: existingError } = await supabase
    .from("issue_working_sessions")
    .select("*")
    .eq("issue_id", issueId)
    .eq("user_id", userId)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingError) {
    throw new Error(`Failed to load issue working session: ${existingError.message}`);
  }

  if (existing) return existing as IssueWorkingSession;

  const { data, error } = await supabase
    .from("issue_working_sessions")
    .insert({
      issue_id: issueId,
      user_id: userId,
      mode,
      status: "active",
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Failed to create issue working session: ${error?.message ?? "unknown error"}`);
  }

  return data as IssueWorkingSession;
}

export async function getActiveIssueWorkingSession(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
) {
  const { data, error } = await supabase
    .from("issue_working_sessions")
    .select("*")
    .eq("issue_id", issueId)
    .eq("user_id", userId)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to get active issue working session: ${error.message}`);
  }

  return (data ?? null) as IssueWorkingSession | null;
}

export async function updateIssueWorkingSession(
  supabase: SupabaseClient,
  userId: string,
  sessionId: string,
  updates: Partial<Pick<IssueWorkingSession, "mode" | "status" | "ended_at">>,
) {
  const payload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (updates.mode) payload.mode = updates.mode;
  if (updates.status) payload.status = updates.status;
  if (updates.ended_at !== undefined) payload.ended_at = updates.ended_at;

  const { data, error } = await supabase
    .from("issue_working_sessions")
    .update(payload)
    .eq("id", sessionId)
    .eq("user_id", userId)
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Failed to update issue working session: ${error?.message ?? "unknown error"}`);
  }

  return data as IssueWorkingSession;
}

export async function listIssueWorkingSessions(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
) {
  const { data, error } = await supabase
    .from("issue_working_sessions")
    .select("*")
    .eq("issue_id", issueId)
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(20);

  if (error) {
    throw new Error(`Failed to list issue working sessions: ${error.message}`);
  }

  return (data ?? []) as IssueWorkingSession[];
}

export async function listIssueInvestigationBriefs(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
) {
  const { data, error } = await supabase
    .from("issue_investigation_briefs")
    .select("*")
    .eq("issue_id", issueId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    throw new Error(`Failed to list issue investigation briefs: ${error.message}`);
  }

  return (data ?? []) as IssueInvestigationBrief[];
}

export async function createIssueInvestigationBrief(
  supabase: SupabaseClient,
  userId: string,
  input: Omit<IssueInvestigationBrief, "id" | "user_id" | "created_at" | "updated_at">,
) {
  const { data, error } = await supabase
    .from("issue_investigation_briefs")
    .insert({
      ...input,
      user_id: userId,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Failed to create issue investigation brief: ${error?.message ?? "unknown error"}`);
  }

  return data as IssueInvestigationBrief;
}

export async function rebaseIssueWorkingSession(
  supabase: SupabaseClient,
  userId: string,
  input: {
    issueId: string;
    fromSessionId: string | null;
    mode: InvestigationMode;
  },
) {
  if (input.fromSessionId) {
    await updateIssueWorkingSession(supabase, userId, input.fromSessionId, {
      status: "rebased",
      ended_at: new Date().toISOString(),
    });
  }

  const { data, error } = await supabase
    .from("issue_working_sessions")
    .insert({
      issue_id: input.issueId,
      user_id: userId,
      mode: input.mode,
      status: "active",
      rebase_from_session_id: input.fromSessionId,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Failed to rebase issue working session: ${error?.message ?? "unknown error"}`);
  }

  return data as IssueWorkingSession;
}

export async function listIssueEscalationEvents(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
) {
  const { data, error } = await supabase
    .from("issue_escalation_events")
    .select("*")
    .eq("issue_id", issueId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    throw new Error(`Failed to list issue escalation events: ${error.message}`);
  }

  return (data ?? []) as IssueEscalationEvent[];
}

export async function createIssueEscalationEvent(
  supabase: SupabaseClient,
  userId: string,
  input: Omit<IssueEscalationEvent, "id" | "user_id" | "created_at" | "updated_at">,
) {
  const { data, error } = await supabase
    .from("issue_escalation_events")
    .insert({
      ...input,
      user_id: userId,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Failed to create issue escalation event: ${error?.message ?? "unknown error"}`);
  }

  return data as IssueEscalationEvent;
}

export async function updateIssueEscalationEvent(
  supabase: SupabaseClient,
  userId: string,
  escalationId: string,
  updates: Partial<Pick<IssueEscalationEvent, "approved_by_user" | "decision_reason" | "to_model" | "to_reasoning">>,
) {
  const payload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (updates.approved_by_user !== undefined) payload.approved_by_user = updates.approved_by_user;
  if (updates.decision_reason !== undefined) payload.decision_reason = updates.decision_reason;
  if (updates.to_model !== undefined) payload.to_model = updates.to_model;
  if (updates.to_reasoning !== undefined) payload.to_reasoning = updates.to_reasoning;

  const { data, error } = await supabase
    .from("issue_escalation_events")
    .update(payload)
    .eq("id", escalationId)
    .eq("user_id", userId)
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Failed to update issue escalation event: ${error?.message ?? "unknown error"}`);
  }

  return data as IssueEscalationEvent;
}

export async function listIssueTokenUsage(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
) {
  const { data, error } = await supabase
    .from("issue_token_usage")
    .select("*")
    .eq("issue_id", issueId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    throw new Error(`Failed to list issue token usage: ${error.message}`);
  }

  return (data ?? []) as IssueTokenUsage[];
}

export async function recordIssueTokenUsage(
  supabase: SupabaseClient,
  userId: string,
  input: Omit<IssueTokenUsage, "id" | "user_id" | "created_at">,
) {
  const { error } = await supabase
    .from("issue_token_usage")
    .insert({
      ...input,
      user_id: userId,
    });

  if (error) {
    throw new Error(`Failed to record issue token usage: ${error.message}`);
  }
}
