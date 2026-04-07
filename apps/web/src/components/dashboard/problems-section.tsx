"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { useAnalysis, type DetectedIssue } from "@/hooks/use-analysis";
import { cn, timeAgoET } from "@/lib/utils";

const LOOKBACK_OPTIONS = [
  { value: 60, label: "Last 1 hour" },
  { value: 360, label: "Last 6 hours" },
  { value: 1440, label: "Last 24 hours" },
  { value: 4320, label: "Last 3 days" },
  { value: 7200, label: "Last 5 days" },
];

const severityConfig = {
  critical: {
    icon: AlertTriangle,
    shell: "border-critical/30 bg-critical/5",
    badge: "bg-critical/10 text-critical",
  },
  warning: {
    icon: AlertTriangle,
    shell: "border-warning/30 bg-warning/5",
    badge: "bg-warning/10 text-warning",
  },
  info: {
    icon: CheckCircle2,
    shell: "border-primary/30 bg-primary/5",
    badge: "bg-primary/10 text-primary",
  },
};

export function ProblemsSection() {
  const { loading, analyzing, error, fetchLatestAnalysis, triggerAnalysis } = useAnalysis();
  const [issues, setIssues] = useState<DetectedIssue[]>([]);
  const [runSummary, setRunSummary] = useState<string | null>(null);
  const [lookbackMinutes, setLookbackMinutes] = useState(60);

  useEffect(() => {
    fetchLatestAnalysis().then((data) => {
      setIssues(data.problems);
      setRunSummary(data.run?.summary ?? null);
    });
  }, [fetchLatestAnalysis]);

  async function handleAnalyze() {
    const result = await triggerAnalysis(lookbackMinutes);
    if (!result.result) return;
    setRunSummary(result.result.summary);
    setIssues(result.result.issues ?? []);
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Detected Issue Threads</h2>
          <p className="text-sm text-muted-foreground">
            These are durable issue conversations created from recent telemetry. Open one to continue diagnosis and remediation.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={lookbackMinutes}
            onChange={(event) => setLookbackMinutes(Number(event.target.value))}
            className="rounded-md border border-border bg-card px-2 py-1.5 text-sm"
            disabled={analyzing}
          >
            {LOOKBACK_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <button
            onClick={handleAnalyze}
            disabled={analyzing}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {analyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {analyzing ? "Detecting..." : "Detect Issues"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-critical/30 bg-critical/5 p-3 text-sm text-critical">
          {error}
        </div>
      )}

      {runSummary && (
        <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm">
          {runSummary}
        </div>
      )}

      {loading && issues.length === 0 ? (
        <div className="rounded-lg border border-border p-6 text-center text-muted-foreground">
          <Loader2 className="mx-auto mb-2 h-6 w-6 animate-spin" />
          Loading detected issues...
        </div>
      ) : issues.length === 0 ? (
        <div className="rounded-lg border border-border p-6 text-center text-muted-foreground">
          No active issue threads yet. Run detection to create them from recent telemetry.
        </div>
      ) : (
        <div className="space-y-3">
          {issues.map((issue) => {
            const config = severityConfig[issue.severity];
            const Icon = config.icon;

            return (
              <div key={issue.id} className={cn("rounded-lg border p-4", config.shell)}>
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Icon className="h-4 w-4" />
                      <h3 className="text-sm font-semibold">{issue.title}</h3>
                      <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", config.badge)}>
                        {issue.severity}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground">{issue.summary}</p>
                    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                      {issue.affected_nas.map((nas) => (
                        <span key={nas} className="rounded-md bg-background/70 px-2 py-1">
                          {nas}
                        </span>
                      ))}
                      <span>Confidence: {issue.hypothesis_confidence}</span>
                      <span>Updated: {timeAgoET(issue.updated_at)}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Current hypothesis: {issue.current_hypothesis || "No stable hypothesis yet."}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Next step: {issue.next_step || "Open the issue thread to continue."}
                    </p>
                  </div>

                  <Link
                    href={`/assistant?resolutionId=${issue.id}`}
                    className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
                  >
                    Open thread
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
