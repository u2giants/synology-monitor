"use client";

import { cn } from "@/lib/utils";
import { Check, Loader2 } from "lucide-react";

const PHASES = [
  { key: "planning", label: "Plan" },
  { key: "diagnosing", label: "Diagnose" },
  { key: "analyzing", label: "Analyze" },
  { key: "proposing_fix", label: "Propose Fix" },
  { key: "awaiting_fix_approval", label: "Approve Fix" },
  { key: "applying_fix", label: "Apply Fix" },
  { key: "verifying", label: "Verify" },
  { key: "resolved", label: "Resolved" },
];

const PHASE_ORDER = Object.fromEntries(PHASES.map((p, i) => [p.key, i]));

export function PhaseStepper({ currentPhase }: { currentPhase: string }) {
  if (currentPhase === "stuck" || currentPhase === "cancelled") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-critical/30 bg-critical/5 px-3 py-2 text-sm text-critical">
        {currentPhase === "stuck" ? "Stuck — needs your input" : "Cancelled"}
      </div>
    );
  }

  const currentIndex = PHASE_ORDER[currentPhase] ?? 0;

  return (
    <div className="flex items-center gap-1 overflow-x-auto">
      {PHASES.map((phase, i) => {
        const isDone = i < currentIndex;
        const isCurrent = i === currentIndex;

        return (
          <div key={phase.key} className="flex items-center gap-1">
            {i > 0 && (
              <div className={cn("h-px w-3", isDone ? "bg-primary" : "bg-border")} />
            )}
            <div
              className={cn(
                "flex items-center gap-1 rounded-full px-2 py-1 text-xs whitespace-nowrap",
                isDone && "bg-primary/10 text-primary",
                isCurrent && "bg-primary text-primary-foreground",
                !isDone && !isCurrent && "bg-muted text-muted-foreground"
              )}
            >
              {isDone ? (
                <Check className="h-3 w-3" />
              ) : isCurrent ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : null}
              {phase.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}
