"use client";

import { useState, useEffect } from "react";
import { useAnalysis } from "@/hooks/use-analysis";
import { formatET, timeAgoET } from "@/lib/utils";
import { AlertTriangle, XCircle, Clock, User, FolderSync, Loader2, RefreshCw, Wrench } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

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
}

interface ProblemsSectionProps {
  initialProblems?: AnalyzedProblem[];
  initialRun?: {
    id: string;
    created_at: string;
    summary: string;
  } | null;
}

const LOOKBACK_OPTIONS = [
  { value: 60, label: "Last 1 hour" },
  { value: 360, label: "Last 6 hours" },
  { value: 1440, label: "Last 24 hours" },
  { value: 4320, label: "Last 3 days" },
  { value: 7200, label: "Last 5 days" },
];

export function ProblemsSection({ initialProblems = [], initialRun = null }: ProblemsSectionProps) {
  const { loading, analyzing, error: analysisError, fetchLatestAnalysis, triggerAnalysis } = useAnalysis();
  const [problems, setProblems] = useState<AnalyzedProblem[]>(initialProblems);
  const [run, setRun] = useState(initialRun);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [lookbackMinutes, setLookbackMinutes] = useState(60);

  useEffect(() => {
    fetchLatestAnalysis().then((data) => {
      if (data.problems.length > 0 || data.run) {
        setProblems(data.problems);
        setRun(data.run);
      }
    });
  }, [fetchLatestAnalysis]);

  const handleAnalyze = async () => {
    const result = await triggerAnalysis(lookbackMinutes);
    if (result.runId && result.result) {
      const refreshed = await fetchLatestAnalysis();
      setProblems(refreshed.problems);
      setRun(refreshed.run);
    }
  };

  const openProblems = problems.filter((p) => p.status === "open");
  const resolvedProblems = problems.filter((p) => p.status === "resolved");

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">AI-Analyzed Problems</h2>
          {run && (
            <span className="text-xs text-muted-foreground">
              Last run: {timeAgoET(run.created_at)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={lookbackMinutes}
            onChange={(e) => setLookbackMinutes(Number(e.target.value))}
            disabled={analyzing}
            className="rounded-md border border-border bg-card px-2 py-1.5 text-sm disabled:opacity-50"
          >
            {LOOKBACK_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <button
            onClick={handleAnalyze}
            disabled={analyzing}
            className="flex items-center gap-2 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
          >
            {analyzing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {analyzing ? "Analyzing..." : "Run Analysis"}
          </button>
        </div>
      </div>

      {analysisError && (
        <div className="rounded-lg border border-critical/30 bg-critical/5 p-3 text-sm text-critical">
          Analysis error: {analysisError}
        </div>
      )}

      {loading && problems.length === 0 ? (
        <div className="rounded-lg border border-border p-6 text-center text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" />
          Loading analysis...
        </div>
      ) : problems.length === 0 ? (
        <div className="rounded-lg border border-border p-6 text-center">
          <p className="text-muted-foreground">No problems detected.</p>
          <p className="text-sm text-muted-foreground mt-1">
            Click "Run Analysis Now" to analyze recent events.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Summary */}
          {run?.summary && (
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
              <p className="text-sm">{run.summary}</p>
            </div>
          )}

          {/* Open Problems */}
          {openProblems.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground">
                Open Problems ({openProblems.length})
              </h3>
              {openProblems.map((problem) => (
                <ProblemCard
                  key={problem.id}
                  problem={problem}
                  expanded={expandedId === problem.id}
                  onToggle={() => setExpandedId(expandedId === problem.id ? null : problem.id)}
                />
              ))}
            </div>
          )}

          {/* Resolved Problems */}
          {resolvedProblems.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
                Resolved ({resolvedProblems.length})
              </summary>
              <div className="mt-2 space-y-2">
                {resolvedProblems.map((problem) => (
                  <ProblemCard
                    key={problem.id}
                    problem={problem}
                    expanded={expandedId === problem.id}
                    onToggle={() => setExpandedId(expandedId === problem.id ? null : problem.id)}
                  />
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

function ProblemCard({
  problem,
  expanded,
  onToggle,
}: {
  problem: AnalyzedProblem;
  expanded: boolean;
  onToggle: () => void;
}) {
  const severityConfig = {
    critical: {
      icon: AlertTriangle,
      class: "border-critical/30 bg-critical/5 text-critical",
      badge: "bg-critical/20 text-critical",
    },
    warning: {
      icon: AlertTriangle,
      class: "border-warning/30 bg-warning/5 text-warning",
      badge: "bg-warning/20 text-warning",
    },
    info: {
      icon: XCircle,
      class: "border-primary/30 bg-primary/5 text-primary",
      badge: "bg-primary/20 text-primary",
    },
  };

  const config = severityConfig[problem.severity];
  const Icon = config.icon;

  return (
    <div className={cn("rounded-lg border p-4 transition-colors", config.class)}>
      <div className="flex items-start gap-3" onClick={onToggle}>
        <div className={cn("rounded-lg p-2 shrink-0", config.badge)}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h4 className="font-medium text-sm">{problem.title}</h4>
            <span className={cn("text-xs px-2 py-0.5 rounded-full", config.badge)}>
              {problem.severity}
            </span>
          </div>
          <p className="text-sm text-muted-foreground line-clamp-2">
            {problem.explanation}
          </p>
          <div className="flex flex-wrap items-center gap-2 mt-2 text-xs text-muted-foreground">
            {problem.affected_nas.length > 0 && (
              <span className="flex items-center gap-1">
                <FolderSync className="h-3 w-3" />
                {problem.affected_nas.join(", ")}
              </span>
            )}
            {problem.affected_users.length > 0 && (
              <span className="flex items-center gap-1">
                <User className="h-3 w-3" />
                {problem.affected_users.join(", ")}
              </span>
            )}
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {timeAgoET(problem.first_seen)} — {timeAgoET(problem.last_seen)}
            </span>
            <span>{problem.raw_event_count} events</span>
          </div>
        </div>
      </div>

      {/* Expanded Details */}
      {expanded && (
        <div className="mt-4 pt-4 border-t space-y-3">
          {/* Affected Files */}
          {problem.affected_files.length > 0 && (
            <div>
              <h5 className="text-xs font-semibold text-muted-foreground mb-2">
                Affected Files
              </h5>
              <div className="space-y-1">
                {problem.affected_files.map((file, i) => (
                  <div key={i} className="text-sm">
                    <code className="text-xs bg-muted px-1 py-0.5 rounded">
                      {file.path}
                    </code>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {file.detail}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Affected Shares */}
          {problem.affected_shares.length > 0 && (
            <div>
              <h5 className="text-xs font-semibold text-muted-foreground mb-1">
                Affected Shares
              </h5>
              <div className="flex flex-wrap gap-1">
                {problem.affected_shares.map((share) => (
                  <span
                    key={share}
                    className="text-xs bg-muted px-2 py-0.5 rounded"
                  >
                    {share}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Technical Diagnosis */}
          <div>
            <h5 className="text-xs font-semibold text-muted-foreground mb-1">
              Technical Diagnosis
            </h5>
            <p className="text-sm whitespace-pre-wrap">{problem.technical_diagnosis}</p>
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-2">
            <Link
              href={`/assistant?problemId=${problem.id}`}
              className="flex items-center gap-1 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
            >
              <Wrench className="h-3 w-3" />
              Fix in Copilot
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
