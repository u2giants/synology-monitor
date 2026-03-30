"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { cn, timeAgo } from "@/lib/utils";
import { Brain, Lightbulb, AlertTriangle, CheckCircle } from "lucide-react";
import type { AiAnalysis } from "@synology-monitor/shared";

export default function AiInsightsPage() {
  const [analyses, setAnalyses] = useState<AiAnalysis[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetch() {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("smon_ai_analyses")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(20);

      if (!error && data) {
        setAnalyses(data as AiAnalysis[]);
      }
      setLoading(false);
    }
    fetch();
  }, []);

  const typeLabels: Record<string, string> = {
    anomaly_detection: "Anomaly Detection",
    daily_health: "Daily Health Report",
    security_review: "Security Review",
    storage_prediction: "Storage Prediction",
  };

  const typeColors: Record<string, string> = {
    anomaly_detection: "text-warning",
    daily_health: "text-primary",
    security_review: "text-critical",
    storage_prediction: "text-success",
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Brain className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold">AI Insights</h1>
      </div>

      <p className="text-sm text-muted-foreground">
        Automated analysis powered by GPT-5.4-mini. Anomaly detection runs every 15 minutes,
        health reports daily at 7 AM ET.
      </p>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading analyses...</div>
      ) : analyses.length === 0 ? (
        <div className="rounded-lg border border-border p-8 text-center text-muted-foreground">
          <Brain className="mx-auto h-12 w-12 mb-3 opacity-50" />
          <p>No AI analyses yet. They will appear after the agent starts sending data.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {analyses.map((analysis) => (
            <div key={analysis.id} className="rounded-lg border border-border bg-card p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className={cn("text-sm font-semibold", typeColors[analysis.type] || "text-foreground")}>
                    {typeLabels[analysis.type] || analysis.type}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {timeAgo(analysis.created_at)}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {analysis.tokens_used} tokens
                </span>
              </div>

              <p className="text-sm mb-4">{analysis.summary}</p>

              {/* Findings */}
              {Array.isArray(analysis.findings) && analysis.findings.length > 0 && (
                <div className="mb-4 space-y-2">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase">Findings</h4>
                  {(analysis.findings as any[]).map((finding, i) => (
                    <div key={i} className="flex items-start gap-2 text-sm">
                      {finding.severity === "critical" ? (
                        <AlertTriangle className="h-4 w-4 text-critical mt-0.5" />
                      ) : finding.severity === "warning" ? (
                        <AlertTriangle className="h-4 w-4 text-warning mt-0.5" />
                      ) : (
                        <CheckCircle className="h-4 w-4 text-success mt-0.5" />
                      )}
                      <span>{finding.description || finding.category}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Recommendations */}
              {Array.isArray(analysis.recommendations) && analysis.recommendations.length > 0 && (
                <div className="space-y-1">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase">Recommendations</h4>
                  {(analysis.recommendations as string[]).map((rec, i) => (
                    <div key={i} className="flex items-start gap-2 text-sm">
                      <Lightbulb className="h-4 w-4 text-primary mt-0.5" />
                      <span>{rec}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
