"use client";

import { cn } from "@/lib/utils";
import { Wrench, Loader2, Check, X } from "lucide-react";
import type { ResolutionStep } from "@/hooks/use-resolution";

interface PendingActionsProps {
  steps: ResolutionStep[];
  loading: boolean;
  onApprove: (stepIds: string[]) => void;
  onReject: (stepIds: string[]) => void;
}

const riskColors = {
  low: "text-muted-foreground",
  medium: "text-warning",
  high: "text-critical",
};

function statusBadge(status: string) {
  switch (status) {
    case "planned": return { label: "Pending", className: "bg-muted text-muted-foreground" };
    case "approved": return { label: "Queued", className: "bg-primary/10 text-primary" };
    case "running": return { label: "Running", className: "bg-warning/10 text-warning" };
    case "completed": return { label: "Done", className: "bg-success/10 text-success" };
    case "failed": return { label: "Failed", className: "bg-critical/10 text-critical" };
    case "rejected": return { label: "Rejected", className: "bg-muted text-muted-foreground line-through" };
    case "skipped": return { label: "Skipped", className: "bg-muted text-muted-foreground" };
    default: return { label: status, className: "bg-muted text-muted-foreground" };
  }
}

export function PendingActions({ steps, loading, onApprove, onReject }: PendingActionsProps) {
  const pending = steps.filter((s) => s.status === "planned");
  const pendingIds = pending.map((s) => s.id);
  const hasPending = pending.length > 0;
  const category = steps[0]?.category ?? "diagnostic";
  const categoryLabel = category === "fix" ? "Fix Actions" : category === "verification" ? "Verification" : "Diagnostics";

  return (
    <div className="space-y-3">
      {/* Bulk approve/reject header */}
      {hasPending && pending.length > 1 && (
        <div className="flex items-center justify-between rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
          <div>
            <span className="text-sm font-medium">{pending.length} {categoryLabel} pending approval</span>
            <p className="text-xs text-muted-foreground mt-0.5">
              {category === "fix"
                ? "These will make changes to your NAS. You can approve individually or all at once."
                : "These are read-only diagnostic commands."}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => onApprove(pendingIds)}
              disabled={loading}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Approve All ({pending.length})
            </button>
            <button
              onClick={() => onReject(pendingIds)}
              disabled={loading}
              className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              Reject All
            </button>
          </div>
        </div>
      )}

      {/* Step cards — numbered */}
      <div className="space-y-2">
        {steps.map((step, index) => {
          const badge = statusBadge(step.status);
          const isPending = step.status === "planned";
          return (
            <div key={step.id} className={cn(
              "rounded-lg border p-3",
              step.status === "running" ? "border-warning/30 bg-warning/5" :
              step.status === "completed" ? "border-primary/20 bg-card" :
              step.status === "failed" ? "border-critical/20 bg-critical/5" :
              "border-border bg-card"
            )}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2">
                  <span className="text-xs font-mono text-muted-foreground mt-1 w-5 shrink-0 text-right">
                    {index + 1}.
                  </span>
                  {step.status === "running" ? (
                    <Loader2 className="h-4 w-4 mt-0.5 animate-spin text-warning shrink-0" />
                  ) : step.status === "completed" ? (
                    <Check className="h-4 w-4 mt-0.5 text-primary shrink-0" />
                  ) : step.status === "failed" ? (
                    <X className="h-4 w-4 mt-0.5 text-critical shrink-0" />
                  ) : (
                    <Wrench className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                  )}
                  <div>
                    <div className="text-sm font-medium">{step.title}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {step.target} · {step.tool_name} · <span className={riskColors[step.risk]}>risk {step.risk}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{step.reason}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={cn("text-xs px-2 py-0.5 rounded-full whitespace-nowrap", badge.className)}>
                    {step.status === "running" && <Loader2 className="h-3 w-3 inline animate-spin mr-1" />}
                    {badge.label}
                  </span>
                </div>
              </div>

              {/* Per-step approve/reject — only for pending steps */}
              {isPending && (
                <div className="flex gap-2 mt-2 ml-11">
                  <button
                    onClick={() => onApprove([step.id])}
                    disabled={loading}
                    className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => onReject([step.id])}
                    disabled={loading}
                    className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    Reject
                  </button>
                </div>
              )}

              {/* Command preview */}
              <details className="mt-2 ml-11">
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                  Command preview
                </summary>
                <pre className="mt-1 whitespace-pre-wrap break-words rounded-md bg-black/80 p-2 text-xs text-white/80">
                  {step.command_preview}
                </pre>
              </details>

              {/* Result (collapsible) */}
              {step.result_text && (
                <details className="mt-1 ml-11">
                  <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                    Output ({step.result_text.length > 500 ? `${(step.result_text.length / 1000).toFixed(1)}KB` : `${step.result_text.length} chars`})
                  </summary>
                  <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs">
                    {step.result_text}
                  </pre>
                </details>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
