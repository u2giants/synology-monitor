"use client";

// apps/web/src/components/assistant/decision-bar.tsx
//
// The anchored "what do I do now" panel. A pure function of resolution.status:
//   waiting_for_approval → approval card (+ reject-with-reason form)
//   waiting_on_user      → answer prompt (focuses composer)
//   running              → ambient "investigating"
//   executing (local)    → "running the approved command…"
//   resolved             → resolved summary

import { useState } from "react";
import {
  Check, CheckCircle2, ChevronDown, ChevronRight, Loader2, MessageSquare, Send, Terminal, Wrench, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Resolution, ResolutionStep } from "@/hooks/use-resolution";

const RISK_PILL: Record<ResolutionStep["risk"], string> = {
  low: "text-success bg-success/15",
  medium: "text-warning bg-warning/15",
  high: "text-critical bg-critical/15",
};

const REJECT_CHIPS = [
  "This feels too risky right now",
  "I'm not convinced that's the root cause",
  "I'd rather handle this myself in DSM",
];

export function DecisionBar({
  status, step, busy, executing, onApprove, onReject, onAnswer,
}: {
  status: Resolution["status"];
  step: ResolutionStep | null;
  busy: boolean;
  executing: boolean;
  onApprove: (stepId: string) => void;
  onReject: (stepId: string, reason: string) => void;
  onAnswer: () => void;
}) {
  const [showCmd, setShowCmd] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  if (executing) {
    return (
      <div id="decision" className="flex items-center gap-3.5 rounded-[14px] border border-warning/30 bg-warning/[0.08] px-4 py-4">
        <Loader2 className="h-[18px] w-[18px] shrink-0 animate-spin text-warning" />
        <div className="flex-1">
          <div className="text-sm font-bold">Running the approved command on your NAS…</div>
          <div className="mt-0.5 text-[12.5px] text-muted-foreground">Follow along in the thread below.</div>
        </div>
      </div>
    );
  }

  if (status === "waiting_for_approval" && step) {
    return (
      <div id="decision" className="relative overflow-hidden rounded-[14px] border border-warning/30 bg-warning/[0.06]">
        <span className="absolute inset-y-0 left-0 w-1 bg-warning" />
        <div className="py-[18px] pl-6 pr-[18px]">
          <div className="mb-3 flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-warning">
              <Wrench className="h-3.5 w-3.5" /> Action needs your approval
            </span>
            <span className={cn("rounded-full px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-wide", RISK_PILL[step.risk])}>
              {step.risk} risk
            </span>
          </div>

          <h2 className="text-[17px] font-bold leading-snug">{step.summary}</h2>
          <p className="mb-4 mt-2 max-w-[68ch] text-[13.5px] leading-relaxed text-muted-foreground">{step.reason}</p>

          <div className="mb-3.5 grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-border bg-border">
            <Cell k="Target" v={step.target ?? "—"} />
            <Cell k="Tool" v={step.tool_name} mono />
            <Cell k="Expected result" v={step.expected_outcome} />
            <Cell k="Rollback" v={step.rollback_plan} />
          </div>

          {step.command_preview && (
            <>
              <button onClick={() => setShowCmd((v) => !v)} className="mb-3 inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground">
                <Terminal className="h-3.5 w-3.5" /> {showCmd ? "Hide" : "Show"} exact command
                {showCmd ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
              {showCmd && <pre className="mb-3.5 overflow-x-auto whitespace-pre-wrap rounded-[9px] border border-black/40 bg-[#0c0f14] p-3.5 font-mono text-[11.5px] leading-relaxed text-white/85">{step.command_preview}</pre>}
            </>
          )}

          {!rejecting ? (
            <div className="flex flex-wrap items-center gap-2.5">
              <button onClick={() => onApprove(step.id)} disabled={busy} className="inline-flex items-center gap-2 rounded-[10px] bg-primary px-5 py-2.5 text-[14.5px] font-semibold text-primary-foreground hover:brightness-110 disabled:opacity-50">
                <Check className="h-4 w-4" /> Approve &amp; run
              </button>
              <button onClick={() => setRejecting(true)} disabled={busy} className="inline-flex items-center gap-2 rounded-[10px] border border-border bg-card px-5 py-2.5 text-[14.5px] font-semibold hover:bg-muted disabled:opacity-50">
                <X className="h-4 w-4" /> Reject
              </button>
              <span className="text-[11.5px] text-muted-foreground">Nothing runs on your NAS until you approve.</span>
            </div>
          ) : (
            <div className="flex flex-col gap-3 rounded-[11px] border border-border bg-card p-3.5">
              <div className="inline-flex items-center gap-1.5 text-[13px] font-semibold"><MessageSquare className="h-3.5 w-3.5 text-primary" /> Why are you rejecting this? It helps the agent propose a better route.</div>
              <div className="flex flex-wrap gap-2">
                {REJECT_CHIPS.map((c) => (
                  <button key={c} onClick={() => setReason(c)} className={cn("rounded-full border px-3 py-1.5 text-[12.5px]", reason === c ? "border-primary bg-primary/10 font-semibold text-primary" : "border-border bg-background hover:border-primary")}>{c}</button>
                ))}
              </div>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Add your own reason (optional)…" className="resize-none rounded-[9px] border border-border bg-background px-3 py-2 text-[13px] leading-normal outline-none focus:border-primary" />
              <div className="flex items-center gap-2.5">
                <button onClick={() => onReject(step.id, reason.trim() || "Rejected without a specific reason.")} disabled={busy} className="inline-flex items-center gap-2 rounded-[9px] bg-primary px-4 py-2 text-[13.5px] font-semibold text-primary-foreground hover:brightness-110 disabled:opacity-50">
                  <Send className="h-4 w-4" /> Send reason
                </button>
                <button onClick={() => { setRejecting(false); setReason(""); }} className="rounded-[9px] border border-border bg-card px-4 py-2 text-[13.5px] font-semibold hover:bg-muted">Back</button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (status === "waiting_on_user") {
    return (
      <div id="decision" className="relative overflow-hidden rounded-[14px] border border-primary/30 bg-primary/[0.06]">
        <span className="absolute inset-y-0 left-0 w-1 bg-primary" />
        <div className="py-[18px] pl-6 pr-[18px]">
          <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-primary"><MessageSquare className="h-3.5 w-3.5" /> The agent has a question</span>
          <h2 className="mt-2 text-[17px] font-bold">Answer below to continue</h2>
          <p className="mb-4 mt-1 text-[13.5px] text-muted-foreground">The investigation is paused until you reply. Your answer goes straight into the thread.</p>
          <button onClick={onAnswer} className="inline-flex items-center gap-2 rounded-[10px] bg-primary px-5 py-2.5 text-[14.5px] font-semibold text-primary-foreground hover:brightness-110">
            <Send className="h-4 w-4" /> Jump to reply
          </button>
        </div>
      </div>
    );
  }

  if (status === "running") {
    return (
      <div id="decision" className="flex items-center gap-3.5 rounded-[14px] border border-primary/25 bg-primary/[0.06] px-4 py-4">
        <Loader2 className="h-[18px] w-[18px] shrink-0 animate-spin text-primary" />
        <div className="flex-1">
          <div className="text-sm font-bold">Agent is investigating</div>
          <div className="mt-0.5 text-[12.5px] text-muted-foreground">This page updates live — no action needed from you right now.</div>
        </div>
      </div>
    );
  }

  if (status === "resolved") {
    return (
      <div id="decision" className="flex items-center gap-3.5 rounded-[14px] border border-success/30 bg-success/[0.08] px-4 py-4">
        <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-success/15 text-success"><CheckCircle2 className="h-[18px] w-[18px]" /></span>
        <div>
          <div className="text-sm font-bold">Issue resolved</div>
          <div className="mt-0.5 text-[12.5px] text-muted-foreground">The agent confirmed the fix held. See the recap in the thread.</div>
        </div>
      </div>
    );
  }

  return null;
}

function Cell({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1 bg-card px-3.5 py-3">
      <span className="text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground">{k}</span>
      <span className={cn("text-[12.5px] leading-snug", mono && "break-all font-mono text-[11.5px]")}>{v}</span>
    </div>
  );
}
