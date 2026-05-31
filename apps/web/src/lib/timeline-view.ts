// apps/web/src/lib/timeline-view.ts
//
// Derives the unified investigation timeline from the real ResolutionFull the
// useResolution() hook already returns. The page renders three registers:
//   - "message"   → conversation bubbles (user right, agent/system left)
//   - "activity"  → narration cards (what the agent did / found)
//   - "proposed"  → a pointer to the DecisionBar

import type { ResolutionFull, ResolutionStageRun } from "@/hooks/use-resolution";

export type TimelineTone = "blue" | "amber" | "green" | "mute";
export type TimelineIcon =
  | "radar" | "telemetry" | "forensic" | "hypothesis" | "result" | "resolved" | "log";

export type TimelineItem =
  | { kind: "message"; at: string; role: "user" | "agent" | "system"; body: string; isQuestion?: boolean }
  | {
      kind: "activity"; at: string; tone: TimelineTone; icon: TimelineIcon;
      title: string; detail?: string; chips?: string[]; running?: boolean; ok?: boolean;
    }
  | { kind: "proposed"; at: string; stepId: string };

const STAGE_LABELS: Record<ResolutionStageRun["stage_key"], string> = {
  capability_refresh: "Checked data sources",
  fact_refresh: "Refreshed findings",
  hypothesis_rank: "Formed hypothesis",
  next_step_plan: "Planned next step",
  operator_explanation: "Wrote explanation",
  verification: "Verified resolution",
};

function iconForSource(sourceKind: string): TimelineIcon {
  const s = sourceKind.toLowerCase();
  if (s.includes("forensic")) return "forensic";
  if (s.includes("detect")) return "radar";
  if (s.includes("telemetry") || s.includes("metric") || s.includes("smart")) return "telemetry";
  return "log";
}

export function buildTimeline(state: ResolutionFull): TimelineItem[] {
  const items: TimelineItem[] = [];
  const status = state.resolution.status;

  // (b/c) Conversation. The agent's latest message becomes the "question"
  // when the issue is waiting on the user.
  const lastAgentId = [...state.messages].reverse().find((m) => m.role === "agent")?.id;
  for (const m of state.messages) {
    items.push({
      kind: "message",
      at: m.created_at,
      role: m.role,
      body: m.content,
      isQuestion: status === "waiting_on_user" && m.role === "agent" && m.id === lastAgentId,
    });
  }

  // (a) Narration — system/agent log entries.
  for (const e of state.log) {
    items.push({
      kind: "activity",
      at: e.created_at,
      tone: "mute",
      icon: iconForSource(e.source_kind),
      title: e.title,
      detail: e.detail || undefined,
    });
  }

  // (a) Narration — analysis stage runs.
  for (const r of state.stage_runs) {
    const isHypothesis = r.stage_key === "hypothesis_rank";
    items.push({
      kind: "activity",
      at: r.created_at,
      tone: r.status === "failed" ? "amber" : isHypothesis ? "amber" : "blue",
      icon: isHypothesis ? "hypothesis" : "telemetry",
      title: STAGE_LABELS[r.stage_key] ?? r.stage_key.replaceAll("_", " "),
      detail: r.error_text || undefined,
      running: r.status === "running",
    });
  }

  // (a/proposed) Steps. Proposed steps drive the DecisionBar; executed ones
  // become result cards in the narrative.
  for (const s of state.steps) {
    if (s.status === "proposed") {
      items.push({ kind: "proposed", at: s.created_at, stepId: s.id });
    } else if (s.status === "completed" || s.status === "failed" || s.status === "running") {
      items.push({
        kind: "activity",
        at: s.completed_at ?? s.created_at,
        tone: s.status === "failed" ? "amber" : "green",
        icon: "result",
        title: s.summary,
        detail: s.result_text || undefined,
        running: s.status === "running",
        ok: s.status === "completed",
      });
    }
  }

  // Surface the resolved transition as a closing green card.
  const resolvedT = state.transitions.find((t) => t.to_status === "resolved");
  if (resolvedT) {
    items.push({
      kind: "activity",
      at: resolvedT.created_at,
      tone: "green",
      icon: "resolved",
      title: "Issue resolved",
      detail: resolvedT.reason || undefined,
    });
  }

  return items.sort((a, b) => +new Date(a.at) - +new Date(b.at));
}

// Whether the thread should show the in-line "agent is typing" indicator.
export function isAgentThinking(state: ResolutionFull, loading: boolean): boolean {
  const activeJob = state.jobs.some((j) => j.status === "queued" || j.status === "running");
  return loading || activeJob || state.resolution.status === "running";
}

export function thinkingLabel(state: ResolutionFull): string {
  switch (state.resolution.status) {
    case "waiting_on_user": return "Agent is reading your reply…";
    case "running": return "Agent is investigating…";
    default: return "Agent is working…";
  }
}
