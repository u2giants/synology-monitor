"use client";

import { useCallback, useState } from "react";

export interface DetectedIssue {
  id: string;
  title: string;
  summary: string;
  severity: "critical" | "warning" | "info";
  status: string;
  affected_nas: string[];
  current_hypothesis: string;
  hypothesis_confidence: "high" | "medium" | "low";
  next_step: string;
  updated_at: string;
}

export function useAnalysis() {
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLatestAnalysis = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/analysis");
      const data = await response.json();
      return {
        run: data.run ?? null,
        problems: (data.problems || []) as DetectedIssue[],
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load detected issues");
      return { run: null, problems: [] };
    } finally {
      setLoading(false);
    }
  }, []);

  const triggerAnalysis = useCallback(async (lookbackMinutes: number = 60) => {
    setAnalyzing(true);
    setError(null);
    try {
      const response = await fetch("/api/analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lookbackMinutes }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Issue detection failed");
      }
      return {
        runId: data.runId,
        result: data.result as { issues: DetectedIssue[]; summary: string },
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Issue detection failed");
      return { runId: null, result: null };
    } finally {
      setAnalyzing(false);
    }
  }, []);

  return {
    loading,
    analyzing,
    error,
    fetchLatestAnalysis,
    triggerAnalysis,
  };
}
