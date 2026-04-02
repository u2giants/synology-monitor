"use client";

import { useCallback, useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface AnalyzedProblem {
  id: string;
  slug: string;
  title: string;
  explanation: string;
  severity: "critical" | "warning" | "info";
  affected_nas: string[];
  affected_shares: string[];
  affected_users: string[];
  affected_files: { path: string; detail: string }[];
  raw_event_count: number;
  raw_event_ids: string[];
  technical_diagnosis: string;
  first_seen: string;
  last_seen: string;
  status: "open" | "investigating" | "resolved";
  resolution?: string;
  created_at: string;
}

interface AnalysisRun {
  id: string;
  summary: string;
  problem_count: number;
  model: string;
  tokens_used: number;
  lookback_minutes: number;
  created_at: string;
}

export function useAnalysis() {
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supabase = createClient();

  const fetchLatestAnalysis = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/analysis");
      const data = await response.json();
      return {
        run: data.run as AnalysisRun | null,
        problems: (data.problems || []) as AnalyzedProblem[],
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch analysis");
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
        throw new Error(data.error || "Analysis failed");
      }
      return {
        runId: data.runId,
        result: data.result,
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
      return { runId: null, result: null };
    } finally {
      setAnalyzing(false);
    }
  }, []);

  const updateProblemStatus = useCallback(
    async (problemId: string, status: "open" | "investigating" | "resolved", resolution?: string) => {
      const { error } = await supabase
        .from("smon_analyzed_problems")
        .update({ status, resolution })
        .eq("id", problemId);

      if (error) {
        setError(error.message);
        return false;
      }
      return true;
    },
    [supabase]
  );

  return {
    loading,
    analyzing,
    error,
    fetchLatestAnalysis,
    triggerAnalysis,
    updateProblemStatus,
  };
}
