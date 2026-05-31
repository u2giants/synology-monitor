"use client";

// apps/web/src/components/assistant/diagnosis-rail.tsx — right rail.
// Reuse the existing <ForensicIncidentPanel> from the old page by passing it
// in via `forensicSlot` so its logic isn't duplicated.

import { useState } from "react";
import { Activity, ChevronDown, ChevronRight, CornerDownRight, Database, Lightbulb, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";
import type { ResolutionFull } from "@/hooks/use-resolution";
import { ConfidenceMeter } from "./shared";

const CAP_LABELS: Record<string, string> = {
  smart_data: "SMART data", ssh_access: "SSH access", synology_api: "Synology API",
  nas_api: "NAS API", log_access: "Log access", snmp: "SNMP",
};

function Section({ icon, title, accent, children }: { icon: ReactNode; title: string; accent?: boolean; children: ReactNode }) {
  return (
    <section className={cn("rounded-[14px] border border-border p-[18px]", accent ? "bg-gradient-to-b from-primary/[0.06] to-card" : "bg-card")}>
      <div className="mb-3 flex items-center gap-2 text-muted-foreground">
        {icon}
        <h3 className="text-[13px] font-bold uppercase tracking-wide text-foreground">{title}</h3>
      </div>
      {children}
    </section>
  );
}

export function DiagnosisRail({ state, forensicSlot }: { state: ResolutionFull; forensicSlot?: ReactNode }) {
  const r = state.resolution;
  const [showTech, setShowTech] = useState(false);

  return (
    <aside className="sticky top-6 flex flex-col gap-4">
      <Section icon={<Lightbulb className="h-[15px] w-[15px]" />} title="Likely cause" accent>
        {r.current_hypothesis ? (
          <p className="text-[13.5px] leading-relaxed">{r.current_hypothesis}</p>
        ) : (
          <p className="text-[13.5px] text-muted-foreground">{r.status === "open" ? "Start the investigation to identify the likely cause." : "Still gathering data…"}</p>
        )}
        <ConfidenceMeter level={r.hypothesis_confidence} />
        {r.next_step && (
          <div className="mt-3.5 flex items-start gap-2 rounded-[9px] border border-border bg-background px-3 py-2.5 text-[12.5px] leading-normal text-muted-foreground">
            <CornerDownRight className="mt-0.5 h-3 w-3 shrink-0 text-primary" />
            <span><strong className="font-bold text-foreground">Next</strong> — {r.next_step}</span>
          </div>
        )}
      </Section>

      {forensicSlot}

      {state.facts.length > 0 && (
        <Section icon={<Activity className="h-[15px] w-[15px]" />} title="Key findings">
          <div className="flex flex-col gap-2.5">
            {state.facts.slice(0, 6).map((f) => (
              <div key={f.id} className="flex gap-2.5 rounded-[10px] border border-border bg-background p-3">
                <span className={cn("w-[3px] shrink-0 rounded", f.severity === "critical" ? "bg-critical" : f.severity === "warning" ? "bg-warning" : "bg-primary")} />
                <div className="min-w-0">
                  <div className="text-[12.5px] font-bold leading-snug">{f.title}</div>
                  <p className="mt-0.5 text-xs leading-normal text-muted-foreground">{f.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {r.operator_constraints.length > 0 && (
        <Section icon={<Lock className="h-[15px] w-[15px]" />} title="Restrictions">
          <ul className="flex flex-col gap-2">
            {r.operator_constraints.map((c, i) => (
              <li key={i} className="relative rounded-[9px] bg-muted py-2.5 pl-7 pr-3 text-[12.5px] leading-snug before:absolute before:left-3 before:top-3.5 before:h-1.5 before:w-1.5 before:rounded-full before:bg-muted-foreground">{c}</li>
            ))}
          </ul>
        </Section>
      )}

      {(state.capabilities.length > 0 || state.jobs.length > 0 || state.stage_runs.length > 0) && (
        <section className="rounded-[14px] border border-border bg-card p-[18px]">
          <button onClick={() => setShowTech((v) => !v)} className="flex w-full items-center justify-between text-[13px] font-bold">
            <span className="inline-flex items-center gap-2"><Database className="h-3.5 w-3.5" /> Data sources &amp; technical detail</span>
            {showTech ? <ChevronDown className="h-[15px] w-[15px] text-muted-foreground" /> : <ChevronRight className="h-[15px] w-[15px] text-muted-foreground" />}
          </button>
          {showTech && (
            <div className="mt-3.5 flex flex-col gap-2 border-t border-border pt-3.5">
              {state.capabilities.map((c) => (
                <div key={c.id} className="flex items-center gap-2.5 text-xs">
                  <span className={cn("h-[7px] w-[7px] shrink-0 rounded-full", c.state === "supported" ? "bg-success" : c.state === "degraded" ? "bg-warning" : "bg-critical")} />
                  <span className="min-w-[96px] shrink-0 font-semibold">{CAP_LABELS[c.capability_key] ?? c.capability_key}</span>
                  <span className="truncate text-[11.5px] text-muted-foreground">{c.evidence || c.raw_error || c.state}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </aside>
  );
}
