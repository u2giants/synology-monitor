"use client";

// apps/web/src/components/assistant/shared.tsx
// Small primitives shared across the assistant components.

import { cn } from "@/lib/utils";
import type { Resolution } from "@/hooks/use-resolution";

export const STATUS_META: Record<Resolution["status"], { dot: string; pulse: boolean; label: string }> = {
  open:                 { dot: "bg-muted-foreground/50", pulse: false, label: "Not investigated" },
  running:              { dot: "bg-primary",             pulse: true,  label: "Investigating" },
  waiting_on_user:      { dot: "bg-primary",             pulse: true,  label: "Needs your input" },
  waiting_for_approval: { dot: "bg-warning",             pulse: true,  label: "Needs approval" },
  waiting_on_issue:     { dot: "bg-muted-foreground/50", pulse: false, label: "Waiting on issue" },
  resolved:             { dot: "bg-success",             pulse: false, label: "Resolved" },
  stuck:                { dot: "bg-warning",             pulse: false, label: "Stuck" },
  cancelled:            { dot: "bg-muted-foreground/30", pulse: false, label: "Cancelled" },
};

const SEV_META: Record<Resolution["severity"], string> = {
  critical: "text-critical bg-critical/10 border-critical/20",
  warning: "text-warning bg-warning/10 border-warning/20",
  info: "text-primary bg-primary/10 border-primary/20",
};

export function StatusDot({ status, size = 8 }: { status: Resolution["status"]; size?: number }) {
  const m = STATUS_META[status];
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      {m.pulse && <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60", m.dot)} />}
      <span className={cn("relative rounded-full", m.dot)} style={{ width: size, height: size }} />
    </span>
  );
}

export function SevBadge({ severity, small }: { severity: Resolution["severity"]; small?: boolean }) {
  return (
    <span className={cn(
      "inline-flex items-center rounded-full border font-bold uppercase tracking-wide",
      small ? "px-1.5 py-0.5 text-[9.5px]" : "px-2 py-0.5 text-[11px]",
      SEV_META[severity],
    )}>
      {severity}
    </span>
  );
}

export function ConfidenceMeter({ level }: { level: Resolution["hypothesis_confidence"] | null }) {
  if (!level) return null;
  const n = level === "high" ? 3 : level === "medium" ? 2 : 1;
  const tone = level === "high" ? "bg-success" : level === "medium" ? "bg-warning" : "bg-muted-foreground";
  const text = level === "high" ? "text-success" : level === "medium" ? "text-warning" : "text-muted-foreground";
  return (
    <div className="mt-3 flex items-center gap-2.5">
      <div className="flex gap-0.5">
        {[1, 2, 3].map((i) => <span key={i} className={cn("h-[5px] w-5 rounded", i <= n ? tone : "bg-border")} />)}
      </div>
      <span className={cn("text-xs font-semibold capitalize", text)}>{level} confidence</span>
    </div>
  );
}
