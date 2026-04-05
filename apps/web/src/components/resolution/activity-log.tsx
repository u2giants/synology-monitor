"use client";

import { cn, timeAgo } from "@/lib/utils";
import {
  ClipboardList, Search, Lightbulb, Wrench, CheckCircle2,
  AlertTriangle, MessageSquare, XCircle, Zap,
} from "lucide-react";
import type { ResolutionLogEntry } from "@/hooks/use-resolution";

const ICON_MAP: Record<string, typeof ClipboardList> = {
  phase_change: Zap,
  plan: ClipboardList,
  diagnosis: Search,
  analysis: Search,
  fix_proposal: Wrench,
  step_result: Lightbulb,
  verification: CheckCircle2,
  stuck: AlertTriangle,
  user_input: MessageSquare,
  error: XCircle,
};

const STYLE_MAP: Record<string, string> = {
  stuck: "border-critical/20 bg-critical/5",
  error: "border-critical/20 bg-critical/5",
  verification: "border-primary/20 bg-primary/5",
  user_input: "border-border bg-card",
};

export function ActivityLog({ entries }: { entries: ResolutionLogEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="text-sm text-muted-foreground text-center py-4">
        Agent activity will appear here as it works.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {entries.map((entry) => {
        const Icon = ICON_MAP[entry.entry_type] ?? Zap;
        const style = STYLE_MAP[entry.entry_type] ?? "border-border bg-card/50";

        return (
          <div key={entry.id} className={cn("rounded-lg border p-3", style)}>
            <div className="flex items-start gap-2">
              <Icon className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-sm whitespace-pre-wrap">{entry.content}</p>
                {entry.technical_detail && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                      Technical detail
                    </summary>
                    <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-xs text-muted-foreground bg-muted rounded p-2">
                      {entry.technical_detail}
                    </pre>
                  </details>
                )}
                <div className="text-[11px] text-muted-foreground mt-1">
                  {timeAgo(entry.created_at)}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
