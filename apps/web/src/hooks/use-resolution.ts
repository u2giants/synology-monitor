"use client";

import { useState, useEffect, useCallback, useRef } from "react";

// Types matching the server-side resolution-store
export interface Resolution {
  id: string;
  origin_type: string;
  title: string;
  description: string;
  severity: "critical" | "warning" | "info";
  affected_nas: string[];
  phase: string;
  diagnosis_summary: string | null;
  root_cause: string | null;
  fix_summary: string | null;
  verification_result: string | null;
  stuck_reason: string | null;
  attempt_count: number;
  max_attempts: number;
  auto_approve_reads: boolean;
  lookback_hours: number;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface ResolutionStep {
  id: string;
  resolution_id: string;
  step_order: number;
  batch: number;
  category: "diagnostic" | "fix" | "verification";
  title: string;
  target: string;
  tool_name: string;
  command_preview: string;
  reason: string;
  risk: "low" | "medium" | "high";
  requires_approval: boolean;
  status: string;
  result_text: string | null;
  created_at: string;
}

export interface ResolutionLogEntry {
  id: string;
  entry_type: string;
  content: string;
  technical_detail: string | null;
  created_at: string;
}

export interface ResolutionFull {
  resolution: Resolution;
  steps: ResolutionStep[];
  log: ResolutionLogEntry[];
}

// Phases where the agent is actively working (should poll)
const ACTIVE_PHASES = new Set([
  "planning", "diagnosing", "analyzing", "proposing_fix", "applying_fix", "verifying",
]);

// Phases where the agent is waiting for the user
const WAITING_PHASES = new Set([
  "awaiting_fix_approval",
]);

// Phases that are finished (diagnosing also stops when steps need approval)
const TERMINAL_PHASES = new Set(["resolved", "stuck", "cancelled"]);

export function useResolution() {
  const [resolutions, setResolutions] = useState<Resolution[]>([]);
  const [current, setCurrent] = useState<ResolutionFull | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentIdRef = useRef<string | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Determine if we should poll based on the current phase and step statuses
  const shouldPoll = useCallback((state: ResolutionFull): boolean => {
    const phase = state.resolution.phase;
    if (TERMINAL_PHASES.has(phase) || WAITING_PHASES.has(phase)) return false;

    // In diagnosing phase, poll only if there are approved or running steps (not just planned)
    if (phase === "diagnosing") {
      const diagSteps = state.steps.filter(s => s.category === "diagnostic");
      const hasApprovedOrRunning = diagSteps.some(s => s.status === "approved" || s.status === "running");
      const hasPending = diagSteps.some(s => s.status === "planned");
      if (hasPending && !hasApprovedOrRunning) return false; // Waiting for user approval
    }

    return ACTIVE_PHASES.has(phase);
  }, []);

  const doTick = useCallback(async (resolutionId: string): Promise<ResolutionFull | null> => {
    try {
      const res = await fetch("/api/resolution/tick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolutionId }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Tick failed");
      return await res.json() as ResolutionFull;
    } catch {
      return null;
    }
  }, []);

  const startPolling = useCallback((resolutionId: string) => {
    stopPolling();
    currentIdRef.current = resolutionId;

    const poll = async () => {
      if (currentIdRef.current !== resolutionId) return;
      const state = await doTick(resolutionId);
      if (!state || currentIdRef.current !== resolutionId) return;

      setCurrent(state);
      if (!shouldPoll(state)) stopPolling();
    };

    pollRef.current = setInterval(poll, 2500);
  }, [stopPolling, doTick, shouldPoll]);

  // Cleanup on unmount
  useEffect(() => stopPolling, [stopPolling]);

  // --- Actions ---

  const fetchList = useCallback(async () => {
    try {
      const res = await fetch("/api/resolution/list");
      if (res.ok) {
        const data = await res.json();
        setResolutions(data.resolutions ?? []);
      }
    } catch {
      // ignore
    }
  }, []);

  const loadResolution = useCallback(async (resolutionId: string) => {
    setLoading(true);
    setError(null);
    stopPolling();
    currentIdRef.current = resolutionId;
    try {
      const res = await fetch(`/api/resolution/${resolutionId}`);
      if (!res.ok) throw new Error((await res.json()).error);
      const state = await res.json() as ResolutionFull;
      setCurrent(state);

      if (shouldPoll(state)) {
        startPolling(resolutionId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [stopPolling, startPolling, shouldPoll]);

  const createResolution = useCallback(async (input: {
    originType: "problem" | "alert" | "manual";
    originId?: string;
    title?: string;
    description?: string;
    lookbackHours?: number;
  }) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/resolution/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      const data = await res.json();
      const resolutionId = data.resolutionId as string;
      setCurrent(data.state as ResolutionFull);
      currentIdRef.current = resolutionId;

      if (data.state && shouldPoll(data.state)) {
        startPolling(resolutionId);
      }

      return resolutionId;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
      return null;
    } finally {
      setLoading(false);
    }
  }, [startPolling, shouldPoll]);

  const approveSteps = useCallback(async (stepIds: string[], decision: "approve" | "reject" = "approve") => {
    if (!current) return;
    setLoading(true);
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
      if (!res.ok) throw new Error((await res.json()).error);
      const state = await res.json() as ResolutionFull;
      setCurrent(state);

      if (shouldPoll(state)) {
        startPolling(current.resolution.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Approve failed");
    } finally {
      setLoading(false);
    }
  }, [current, startPolling, shouldPoll]);

  const sendMessage = useCallback(async (message: string) => {
    if (!current) return;
    setLoading(true);
    try {
      const res = await fetch("/api/resolution/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolutionId: current.resolution.id, message }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      const state = await res.json() as ResolutionFull;
      setCurrent(state);

      if (shouldPoll(state)) {
        startPolling(current.resolution.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Message failed");
    } finally {
      setLoading(false);
    }
  }, [current, startPolling, shouldPoll]);

  const cancelResolution = useCallback(async () => {
    if (!current) return;
    stopPolling();
    try {
      await fetch(`/api/resolution/${current.resolution.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phase: "cancelled" }),
      });
      setCurrent((prev) =>
        prev ? { ...prev, resolution: { ...prev.resolution, phase: "cancelled" } } : null
      );
    } catch {
      // ignore
    }
  }, [current, stopPolling]);

  const deleteResolution = useCallback(async (resolutionId: string) => {
    try {
      await fetch(`/api/resolution/${resolutionId}`, { method: "DELETE" });
      setResolutions((prev) => prev.filter((r) => r.id !== resolutionId));
      if (currentIdRef.current === resolutionId) {
        stopPolling();
        setCurrent(null);
        currentIdRef.current = null;
      }
    } catch {
      // ignore
    }
  }, [stopPolling]);

  const toggleAutoApprove = useCallback(async (value: boolean) => {
    if (!current) return;
    try {
      await fetch(`/api/resolution/${current.resolution.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto_approve_reads: value }),
      });
      setCurrent((prev) =>
        prev ? { ...prev, resolution: { ...prev.resolution, auto_approve_reads: value } } : null
      );
    } catch {
      // ignore
    }
  }, [current]);

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
    cancelResolution,
    toggleAutoApprove,
    deleteResolution,
  };
}
