"use client";

import { useCallback, useState } from "react";

export interface Resolution {
  id: string;
  origin_type: "manual" | "alert" | "problem" | "detected";
  title: string;
  summary: string;
  severity: "critical" | "warning" | "info";
  status: "open" | "running" | "waiting_on_user" | "waiting_for_approval" | "waiting_on_issue" | "resolved" | "stuck" | "cancelled";
  depends_on_issue_id: string | null;
  affected_nas: string[];
  current_hypothesis: string;
  hypothesis_confidence: "high" | "medium" | "low";
  next_step: string;
  conversation_summary: string;
  operator_constraints: string[];
  blocked_tools: string[];
  last_agent_message: string | null;
  last_user_message: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface ResolutionMessage {
  id: string;
  resolution_id?: string;
  issue_id?: string;
  role: "user" | "agent" | "system";
  content: string;
  created_at: string;
}

export interface ResolutionStep {
  id: string;
  issue_id: string;
  kind: "diagnostic" | "remediation";
  status: "proposed" | "approved" | "rejected" | "running" | "completed" | "failed" | "skipped";
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
  approval_token: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface ResolutionLogEntry {
  id: string;
  source_kind: string;
  title: string;
  detail: string;
  created_at: string;
}

export interface ResolutionFact {
  id: string;
  fact_type: string;
  severity: "info" | "warning" | "critical";
  status: "active" | "resolved" | "expired";
  title: string;
  detail: string;
  observed_at: string;
  value?: Record<string, unknown>;
}

export interface ResolutionCapability {
  id: string;
  nas_id: string;
  capability_key: string;
  state: "supported" | "unsupported" | "unverified" | "degraded";
  evidence: string;
  raw_error: string | null;
  checked_at: string;
}

export interface ResolutionJob {
  id: string;
  job_type: "run_issue" | "user_message" | "approval_decision" | "detect_issue";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResolutionTransition {
  id: string;
  from_status: Resolution["status"] | null;
  to_status: Resolution["status"];
  reason: string;
  created_at: string;
}

export interface ResolutionStageRun {
  id: string;
  stage_key:
    | "capability_refresh"
    | "fact_refresh"
    | "hypothesis_rank"
    | "next_step_plan"
    | "operator_explanation"
    | "verification";
  status: "running" | "completed" | "failed" | "skipped";
  model_name: string | null;
  model_tier: string | null;
  input_summary: Record<string, unknown>;
  output: Record<string, unknown>;
  error_text: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface ResolutionWorkingSession {
  id: string;
  issue_id: string;
  user_id: string;
  mode: "guided" | "deep";
  status: "active" | "closed" | "rebased";
  rebase_from_session_id: string | null;
  started_at: string;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResolutionInvestigationBrief {
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

export interface ResolutionEscalationEvent {
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

export interface ResolutionTokenUsage {
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

export interface ResolutionFull {
  resolution: Resolution;
  messages: ResolutionMessage[];
  steps: ResolutionStep[];
  log: ResolutionLogEntry[];
  facts: ResolutionFact[];
  capabilities: ResolutionCapability[];
  jobs: ResolutionJob[];
  transitions: ResolutionTransition[];
  stage_runs: ResolutionStageRun[];
  working_sessions: ResolutionWorkingSession[];
  investigation_briefs: ResolutionInvestigationBrief[];
  escalation_events: ResolutionEscalationEvent[];
  token_usage: ResolutionTokenUsage[];
}

function normalizeState(payload: any): ResolutionFull {
  return {
    resolution: payload.issue ?? payload.resolution,
    messages: payload.messages ?? [],
    steps: payload.actions ?? payload.steps ?? [],
    log: payload.evidence ?? payload.log ?? [],
    facts: payload.facts ?? [],
    capabilities: payload.capabilities ?? [],
    jobs: payload.jobs ?? [],
    transitions: payload.transitions ?? [],
    stage_runs: payload.stage_runs ?? [],
    working_sessions: payload.working_sessions ?? [],
    investigation_briefs: payload.investigation_briefs ?? [],
    escalation_events: payload.escalation_events ?? [],
    token_usage: payload.token_usage ?? [],
  };
}

export function useResolution() {
  const [resolutions, setResolutions] = useState<Resolution[]>([]);
  const [current, setCurrent] = useState<ResolutionFull | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchList = useCallback(async () => {
    try {
      const res = await fetch("/api/resolution/list");
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to load issues");
      const data = await res.json();
      setResolutions(data.resolutions ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load issues");
    }
  }, []);

  const loadResolution = useCallback(async (resolutionId: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/resolution/${resolutionId}`);
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to load issue");
      const data = await res.json();
      setCurrent(normalizeState(data));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load issue");
    } finally {
      setLoading(false);
    }
  }, []);

  const createResolution = useCallback(async (input: {
    originType: "manual" | "alert" | "problem";
    originId?: string;
    title?: string;
    description?: string;
    importCurrentFindings?: boolean;
  }) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/resolution/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to create issue");
      const data = await res.json();
      const state = normalizeState(data.state);
      setCurrent(state);
      return data.resolutionId as string;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create issue");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const approveSteps = useCallback(async (stepIds: string[], decision: "approve" | "reject" = "approve") => {
    if (!current) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/resolution/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resolutionId: current.resolution.id,
          stepIds,
          decision,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to update action");
      const data = await res.json();
      setCurrent(normalizeState(data));
      await fetchList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update action");
    } finally {
      setLoading(false);
    }
  }, [current, fetchList]);

  const sendMessage = useCallback(async (message: string) => {
    if (!current) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/resolution/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolutionId: current.resolution.id, message }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to send message");
      const data = await res.json();
      setCurrent(normalizeState(data));
      await fetchList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setLoading(false);
    }
  }, [current, fetchList]);

  const continueResolution = useCallback(async () => {
    if (!current) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/resolution/tick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolutionId: current.resolution.id }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to continue issue");
      const data = await res.json();
      setCurrent(normalizeState(data));
      await fetchList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to continue issue");
    } finally {
      setLoading(false);
    }
  }, [current, fetchList]);

  const setResolutionMode = useCallback(async (mode: "guided" | "deep") => {
    if (!current) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/resolution/mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolutionId: current.resolution.id, mode }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to update mode");
      const data = await res.json();
      setCurrent(normalizeState(data));
      await fetchList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update mode");
    } finally {
      setLoading(false);
    }
  }, [current, fetchList]);

  const rebaseResolutionContext = useCallback(async (reason = "manual_context_rebase") => {
    if (!current) return;
    setLoading(true);
    setError(null);
    try {
      const activeSession = current.working_sessions.find((session) => session.status === "active");
      const res = await fetch("/api/resolution/rebase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resolutionId: current.resolution.id,
          reason,
          mode: activeSession?.mode ?? "guided",
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to rebase context");
      const data = await res.json();
      setCurrent(normalizeState(data));
      await fetchList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rebase context");
    } finally {
      setLoading(false);
    }
  }, [current, fetchList]);

  const approveResolutionEscalation = useCallback(async (escalation: ResolutionEscalationEvent) => {
    if (!current) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/resolution/escalate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resolutionId: current.resolution.id,
          escalationId: escalation.id,
          kind: escalation.kind,
          toModel: escalation.to_model,
          toReasoning: escalation.to_reasoning,
          approvedByUser: true,
          decisionReason: "Approved from assistant UI",
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to approve escalation");
      const data = await res.json();
      setCurrent(normalizeState(data));
      await fetchList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to approve escalation");
    } finally {
      setLoading(false);
    }
  }, [current, fetchList]);

  const cancelResolution = useCallback(async () => {
    if (!current) return;
    setLoading(true);
    try {
      await fetch(`/api/resolution/${current.resolution.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "cancelled" }),
      });
      setCurrent((prev) => prev ? {
        ...prev,
        resolution: { ...prev.resolution, status: "cancelled" },
      } : null);
      await fetchList();
    } finally {
      setLoading(false);
    }
  }, [current, fetchList]);

  const deleteResolution = useCallback(async (resolutionId: string) => {
    setLoading(true);
    try {
      await fetch(`/api/resolution/${resolutionId}`, { method: "DELETE" });
      setResolutions((prev) => prev.filter((item) => item.id !== resolutionId));
      setCurrent((prev) => prev?.resolution.id === resolutionId ? null : prev);
    } finally {
      setLoading(false);
    }
  }, []);

  const toggleAutoApprove = useCallback(async () => {
    // Kept for API compatibility with the old page. No-op in the new issue agent.
  }, []);

  return {
    resolutions,
    current,
    loading,
    error,
    fetchList,
    loadResolution,
    createResolution,
    approveSteps,
    sendMessage,
    continueResolution,
    setResolutionMode,
    rebaseResolutionContext,
    approveResolutionEscalation,
    cancelResolution,
    toggleAutoApprove,
    deleteResolution,
  };
}
