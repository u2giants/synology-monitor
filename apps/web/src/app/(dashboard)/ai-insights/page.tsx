"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { cn, timeAgo } from "@/lib/utils";
import { Brain, Lightbulb, AlertTriangle, CheckCircle, Activity, Clock, FileText, TrendingUp } from "lucide-react";

// Types matching actual smon_analysis_runs schema
interface AnalysisRun {
  id: string;
  summary: string;
  problem_count: number;
  model: string;
  tokens_used: number;
  lookback_minutes: number;
  created_at: string;
}

interface AnalyzedProblem {
  id: string;
  run_id: string;
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

export default function AiInsightsPage() {
  const [analysisRuns, setAnalysisRuns] = useState<AnalysisRun[]>([]);
  const [problems, setProblems] = useState<AnalyzedProblem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetch() {
      const supabase = createClient();
      
      // Fetch analysis runs from smon_analysis_runs
      const runsResult = await supabase
        .from("smon_analysis_runs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(20);

      if (!runsResult.error && runsResult.data) {
        setAnalysisRuns(runsResult.data as AnalysisRun[]);
      }

      // Fetch analyzed problems from smon_analyzed_problems
      const problemsResult = await supabase
        .from("smon_analyzed_problems")
        .select("*")
        .in("status", ["open", "investigating"])
        .order("created_at", { ascending: false })
        .limit(50);

      if (!problemsResult.error && problemsResult.data) {
        setProblems(problemsResult.data as AnalyzedProblem[]);
      }

      setLoading(false);
    }
    fetch();
  }, []);

  const severityConfig = {
    critical: {
      icon: AlertTriangle,
      color: "text-critical",
      bg: "bg-critical/10",
      border: "border-critical/30",
    },
    warning: {
      icon: AlertTriangle,
      color: "text-warning",
      bg: "bg-warning/10",
      border: "border-warning/30",
    },
    info: {
      icon: CheckCircle,
      color: "text-primary",
      bg: "bg-primary/10",
      border: "border-primary/30",
    },
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Brain className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold">AI Insights</h1>
      </div>

      <p className="text-sm text-muted-foreground">
        AI-powered analysis of your NAS logs and system events. Problems are automatically 
        identified and grouped by severity using MiniMax M2.7 for diagnosis and GPT-5.4-mini 
        for remediation suggestions.
      </p>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading analyses...</div>
      ) : analysisRuns.length === 0 && problems.length === 0 ? (
        <div className="rounded-lg border border-border p-8 text-center text-muted-foreground">
          <Brain className="mx-auto h-12 w-12 mb-3 opacity-50" />
          <p>No AI analyses yet. They will appear after the analysis agent starts running.</p>
          <p className="text-xs mt-2">The agent runs analysis every 15 minutes.</p>
        </div>
      ) : (
        <>
          {/* Recent Analysis Runs */}
          {analysisRuns.length > 0 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Activity className="h-5 w-5" />
                Recent Analysis Runs
              </h2>
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                {analysisRuns.map((run) => (
                  <div
                    key={run.id}
                    className="rounded-lg border border-border bg-card p-4"
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm font-medium">
                          {timeAgo(run.created_at)}
                        </span>
                      </div>
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-success/10 text-success">
                        {run.problem_count} problems found
                      </span>
                    </div>

                    {run.summary && (
                      <p className="text-sm text-muted-foreground line-clamp-3">{run.summary}</p>
                    )}

                    <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                      <span>Model: {run.model}</span>
                      <span>{run.tokens_used} tokens</span>
                      <span>{run.lookback_minutes}m lookback</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Analyzed Problems */}
          {problems.length > 0 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <TrendingUp className="h-5 w-5" />
                AI-Detected Problems ({problems.length})
              </h2>
              <div className="space-y-4">
                {problems.map((problem) => {
                  const config = severityConfig[problem.severity] || severityConfig.info;
                  const Icon = config.icon;

                  return (
                    <div
                      key={problem.id}
                      className={cn(
                        "rounded-lg border bg-card p-5",
                        config.border
                      )}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex items-start gap-3">
                          <div className={cn("rounded-lg p-2", config.bg)}>
                            <Icon className={cn("h-5 w-5", config.color)} />
                          </div>
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <h3 className="font-semibold">{problem.title}</h3>
                              <span className={cn(
                                "px-2 py-0.5 rounded-full text-xs font-medium capitalize",
                                config.bg,
                                config.color
                              )}>
                                {problem.severity}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {timeAgo(problem.created_at)}
                              </span>
                            </div>
                            
                            <p className="text-sm text-muted-foreground mt-2">
                              {problem.explanation}
                            </p>

                            {/* Affected Resources */}
                            {(problem.affected_nas?.length > 0 || 
                              problem.affected_users?.length > 0 || 
                              problem.affected_shares?.length > 0) && (
                              <div className="flex flex-wrap gap-2 mt-3">
                                {problem.affected_nas?.slice(0, 3).map((nas, i) => (
                                  <span key={`nas-${i}`} className="px-2 py-1 rounded-md bg-muted text-xs">
                                    NAS: {nas}
                                  </span>
                                ))}
                                {problem.affected_users?.slice(0, 3).map((user, i) => (
                                  <span key={`user-${i}`} className="px-2 py-1 rounded-md bg-emerald-500/10 text-xs text-emerald-700 dark:text-emerald-300">
                                    {user}
                                  </span>
                                ))}
                                {problem.affected_shares?.slice(0, 3).map((share, i) => (
                                  <span key={`share-${i}`} className="px-2 py-1 rounded-md bg-blue-500/10 text-xs text-blue-700 dark:text-blue-300">
                                    {share}
                                  </span>
                                ))}
                              </div>
                            )}

                            {/* Technical Diagnosis */}
                            {problem.technical_diagnosis && (
                              <div className="mt-3 rounded-md bg-muted/50 p-3">
                                <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-1">
                                  Technical Diagnosis
                                </h4>
                                <p className="text-sm">{problem.technical_diagnosis}</p>
                              </div>
                            )}

                            {/* Stats */}
                            <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
                              <span>{problem.raw_event_count} events</span>
                              <span>First seen: {timeAgo(problem.first_seen)}</span>
                              <span>Last seen: {timeAgo(problem.last_seen)}</span>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Resolution if available */}
                      {problem.resolution && (
                        <div className="mt-4 rounded-md bg-success/10 p-3 border border-success/20">
                          <h4 className="text-xs font-semibold uppercase text-success mb-1">
                            Resolution
                          </h4>
                          <p className="text-sm">{problem.resolution}</p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
