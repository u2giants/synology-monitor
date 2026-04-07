"use client";

import { useEffect, useState } from "react";
import { Brain, Loader2 } from "lucide-react";
import { useAnalysis, type DetectedIssue } from "@/hooks/use-analysis";
import { timeAgoET } from "@/lib/utils";

export default function AiInsightsPage() {
  const { loading, fetchLatestAnalysis } = useAnalysis();
  const [issues, setIssues] = useState<DetectedIssue[]>([]);

  useEffect(() => {
    fetchLatestAnalysis().then((data) => setIssues(data.problems));
  }, [fetchLatestAnalysis]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Brain className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold">Issue Insights</h1>
      </div>

      <p className="text-sm text-muted-foreground">
        The system now creates persistent issue threads instead of disposable one-off analyses. Each thread maintains a working hypothesis, remembers constraints, and carries the operator conversation through diagnosis and remediation.
      </p>

      {loading && issues.length === 0 ? (
        <div className="rounded-lg border border-border p-8 text-center text-muted-foreground">
          <Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin" />
          Loading issue threads...
        </div>
      ) : issues.length === 0 ? (
        <div className="rounded-lg border border-border p-8 text-center text-muted-foreground">
          No detected issue threads yet. Run issue detection from the dashboard to populate this view.
        </div>
      ) : (
        <div className="space-y-4">
          {issues.map((issue) => (
            <div key={issue.id} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">{issue.title}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{issue.summary}</p>
                </div>
                <div className="text-xs text-muted-foreground">
                  Updated {timeAgoET(issue.updated_at)}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
                <span>Severity: {issue.severity}</span>
                <span>Confidence: {issue.hypothesis_confidence}</span>
                <span>Status: {issue.status}</span>
                {issue.affected_nas.map((nas) => (
                  <span key={nas}>{nas}</span>
                ))}
              </div>
              <div className="mt-3 text-sm">
                <strong>Current hypothesis:</strong> {issue.current_hypothesis || "Not established yet."}
              </div>
              <div className="mt-2 text-sm text-muted-foreground">
                <strong>Next step:</strong> {issue.next_step || "Open the issue thread to continue."}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
