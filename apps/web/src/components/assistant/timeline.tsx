"use client";

// apps/web/src/components/assistant/timeline.tsx
//
// The investigation thread: three visually distinct registers (narration cards,
// incoming chat bubbles, your right-aligned bubble) + composer + in-thread
// typing indicator + a "stay put" jump-to-latest pill.

import { useEffect, useRef, useState } from "react";
import {
  Activity, Bot, Check, CheckCircle2, ChevronDown, ChevronRight, Database,
  FileText, Lightbulb, Loader2, Microscope, Radar, Send, Terminal, Wrench,
} from "lucide-react";
import { cn, timeAgoET } from "@/lib/utils";
import type { TimelineItem, TimelineIcon, TimelineTone } from "@/lib/timeline-view";

const ICONS: Record<TimelineIcon, typeof Activity> = {
  radar: Radar, telemetry: Activity, forensic: Microscope,
  hypothesis: Lightbulb, result: Terminal, resolved: CheckCircle2, log: FileText,
};

const BADGE_TONE: Record<TimelineTone, string> = {
  blue: "text-primary bg-primary/10 border-primary/25",
  amber: "text-warning bg-warning/10 border-warning/25",
  green: "text-success bg-success/10 border-success/25",
  mute: "text-muted-foreground bg-muted border-border",
};

function TypingDots({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce"
          style={{ animationDelay: `${i * 0.18}s`, animationDuration: "1.1s" }}
        />
      ))}
    </span>
  );
}

// ── Register (a): narration / activity card ──────────────────────────────────
function ActivityCard({ item }: { item: Extract<TimelineItem, { kind: "activity" }> }) {
  const Icon = ICONS[item.icon];
  return (
    <div className="flex items-start gap-3">
      <span className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border", BADGE_TONE[item.tone])}>
        {item.running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className={cn("text-[12.5px] font-bold", item.tone === "amber" && item.icon === "hypothesis" && "text-warning")}>
            {item.title}
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{timeAgoET(item.at)}</span>
        </div>
        {item.detail && <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-muted-foreground">{item.detail}</p>}
        {item.chips && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {item.chips.map((c) => (
              <span key={c} className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">{c}</span>
            ))}
          </div>
        )}
        {item.ok && <div className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-success"><Check className="h-3.5 w-3.5" /> Completed</div>}
        {item.running && item.icon === "result" && (
          <div className="mt-2 inline-flex items-center gap-2 text-xs font-semibold text-warning"><TypingDots /> Executing…</div>
        )}
      </div>
    </div>
  );
}

// ── Registers (b) incoming + (c) your message ────────────────────────────────
function ChatMessage({ item }: { item: Extract<TimelineItem, { kind: "message" }> }) {
  if (item.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-[15px] rounded-tr-[5px] bg-user-bubble px-3.5 py-2.5 text-user-bubble-foreground shadow-sm">
          <div className="mb-0.5 flex items-center justify-between gap-3.5 text-[11px]">
            <span className="font-bold">You</span>
            <span className="opacity-60">{timeAgoET(item.at)}</span>
          </div>
          <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed">{item.body}</p>
        </div>
      </div>
    );
  }
  const isSystem = item.role === "system";
  return (
    <div className="flex items-start gap-2.5">
      <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border border-primary/25 bg-primary/10 text-primary">
        {isSystem ? <Database className="h-3.5 w-3.5" /> : <Bot className="h-4 w-4" />}
      </span>
      <div className={cn(
        "max-w-[80%] rounded-[15px] rounded-tl-[5px] border px-3.5 py-2.5",
        item.isQuestion ? "border-primary/30 bg-primary/[0.07]" : "border-border bg-card",
      )}>
        <div className="mb-0.5 flex items-center justify-between gap-3.5 text-[11px] text-muted-foreground">
          <span className="font-bold text-foreground">{isSystem ? "System" : "Agent"}{item.isQuestion ? " · asking you" : ""}</span>
          <span>{timeAgoET(item.at)}</span>
        </div>
        <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed">{item.body}</p>
      </div>
    </div>
  );
}

function ProposedMarker() {
  return (
    <a href="#decision" className="inline-block rounded-lg border border-dashed border-warning/40 bg-warning/[0.07] px-3 py-2.5 text-[12.5px] leading-snug text-warning no-underline">
      <strong className="font-bold">Proposed a remediation</strong> — review &amp; approve it in the panel above
    </a>
  );
}

function ThinkingRow({ label }: { label: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border border-primary/25 bg-primary/10 text-primary ring-4 ring-primary/15">
        <Bot className="h-4 w-4" />
      </span>
      <div className="inline-flex items-center gap-2.5 rounded-[15px] rounded-tl-[5px] border border-border bg-card px-3.5 py-2.5">
        <TypingDots />
        <span className="text-[13px] italic text-muted-foreground">{label}</span>
      </div>
    </div>
  );
}

export function Timeline({
  items, thinking, thinkingText, draft, setDraft, onSend, sending, waitingOnUser,
}: {
  items: TimelineItem[];
  thinking: boolean;
  thinkingText: string;
  draft: string;
  setDraft: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  waitingOnUser: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const prevLen = useRef(items.length);
  const [hasNew, setHasNew] = useState(false);

  // Stay put — never auto-scroll. Flag new replies that land below the fold.
  useEffect(() => {
    if (items.length > prevLen.current) {
      const el = endRef.current;
      if (el && el.getBoundingClientRect().top > window.innerHeight) setHasNew(true);
    }
    prevLen.current = items.length;
  }, [items.length]);

  useEffect(() => {
    const onScroll = () => {
      const el = endRef.current;
      if (el && el.getBoundingClientRect().top <= window.innerHeight + 60) setHasNew(false);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="rounded-[14px] border border-border bg-card p-[18px]">
      <div className="mb-4 flex items-center justify-between">
        <span className="inline-flex items-center gap-2 text-sm font-bold"><Activity className="h-4 w-4" /> Investigation</span>
        <span className="text-[11px] font-semibold text-muted-foreground">{items.length} events</span>
      </div>

      <div className="flex flex-col gap-3.5">
        {items.map((item, i) =>
          item.kind === "message" ? <ChatMessage key={i} item={item} />
          : item.kind === "proposed" ? <ProposedMarker key={i} />
          : <ActivityCard key={i} item={item} />
        )}
        {thinking && <ThinkingRow label={thinkingText} />}
        <div ref={endRef} />
      </div>

      {hasNew && (
        <button
          onClick={() => { window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }); setHasNew(false); }}
          className="fixed bottom-8 left-1/2 z-[60] inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-primary/30 bg-primary px-4 py-2 text-[12.5px] font-semibold text-primary-foreground shadow-lg"
        >
          <Bot className="h-3.5 w-3.5" /> New reply from the agent <ChevronDown className="h-3.5 w-3.5" />
        </button>
      )}

      <div className={cn("mt-4 border-t border-border pt-4", waitingOnUser && !thinking && "-mx-[18px] -mb-[18px] rounded-b-[14px] border-t-primary/25 bg-primary/[0.06] px-[18px] pb-[18px]")}>
        {waitingOnUser && !thinking && (
          <div className="mb-2.5 inline-flex items-center gap-1.5 text-xs font-semibold text-primary">
            <Wrench className="h-3.5 w-3.5" /> The agent is waiting for your reply
          </div>
        )}
        {thinking && (
          <div className="mb-2.5 inline-flex items-center gap-2 text-xs italic text-muted-foreground"><TypingDots /> {thinkingText}</div>
        )}
        <div className="flex items-stretch gap-2.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSend(); }}
            disabled={thinking}
            rows={2}
            placeholder={thinking ? "Agent is responding…" : "Add context, answer the agent, or steer the investigation…"}
            className="flex-1 resize-none rounded-[10px] border border-border bg-background px-3.5 py-2.5 text-[13.5px] leading-normal outline-none focus:border-primary disabled:opacity-60"
          />
          <button
            onClick={onSend}
            disabled={sending || thinking || !draft.trim()}
            className="inline-flex items-center gap-2 self-end rounded-[10px] bg-primary px-4 py-2.5 text-[13.5px] font-semibold text-primary-foreground hover:brightness-110 disabled:opacity-50"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send
          </button>
        </div>
      </div>
    </div>
  );
}
