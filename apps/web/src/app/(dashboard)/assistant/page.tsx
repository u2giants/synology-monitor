"use client";

// apps/web/src/app/(dashboard)/assistant/page.tsx — redesigned Issue Investigator.
//
// Drop-in replacement for the existing page. Wires the new components to the
// SAME useResolution() hook and API routes. See the handoff README §6 for the
// frontend-vs-backend split (reject-reason, agent alternatives, reopen).

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Bot, HardDrive, Loader2, Play, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useResolution, type ResolutionFull } from "@/hooks/use-resolution";
import { buildTimeline, hasActiveIssueJob, isAgentThinking, thinkingLabel } from "@/lib/timeline-view";
import { IssueQueue } from "@/components/assistant/issue-queue";
import { DecisionBar } from "@/components/assistant/decision-bar";
import { Timeline } from "@/components/assistant/timeline";
import { DiagnosisRail } from "@/components/assistant/diagnosis-rail";
import { StatusDot, SevBadge, STATUS_META } from "@/components/assistant/shared";
import { ForensicIncidentPanel } from "@/components/assistant/forensic-panel";

export default function AssistantPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const createdOnce = useRef(false);
  const {
    resolutions, current, loading,
    fetchList, loadResolution, createResolution,
    approveSteps, sendMessage, continueResolution,
  } = useResolution();

  const [draft, setDraft] = useState("");
  const [executing, setExecuting] = useState(false);
  const [newIssue, setNewIssue] = useState<{ title: string; desc: string } | null>(null);
  const [creatingIssue, setCreatingIssue] = useState(false);
  const [newIssueError, setNewIssueError] = useState<string | null>(null);

  useEffect(() => { fetchList(); }, [fetchList]);

  // Resolve / create from URL params (same contract as the original page).
  useEffect(() => {
    if (createdOnce.current || loading) return;

    const resolutionId = searchParams.get("resolutionId");
    const problemId = searchParams.get("problemId");
    const alertId = searchParams.get("alertId") ?? searchParams.get("alert_id");
    const title = searchParams.get("title");
    const message = searchParams.get("message");

    if (resolutionId) {
      createdOnce.current = true;
      loadResolution(resolutionId);
      return;
    }

    if (problemId) {
      createdOnce.current = true;
      createResolution({ originType: "problem", originId: problemId }).then((id) => {
        if (id) { fetchList(); router.replace(`/assistant?resolutionId=${id}`); }
      });
      return;
    }

    if (alertId) {
      createdOnce.current = true;
      createResolution({ originType: "alert", originId: alertId }).then((id) => {
        if (id) { fetchList(); router.replace(`/assistant?resolutionId=${id}`); }
      });
      return;
    }

    if (title || message) {
      createdOnce.current = true;
      createResolution({
        originType: "manual",
        title: title ?? "Imported issue",
        description: message ?? title ?? "Imported issue context",
      }).then((id) => {
        if (id) { fetchList(); router.replace(`/assistant?resolutionId=${id}`); }
      });
    }
  }, [createResolution, fetchList, loadResolution, loading, router, searchParams]);

  // Live polling while background jobs run (unchanged behavior).
  useEffect(() => {
    if (!current) return;
    const active = hasActiveIssueJob(current);
    if (!active) return;
    const t = window.setInterval(() => loadResolution(current.resolution.id), 3000);
    return () => window.clearInterval(t);
  }, [current, loadResolution]);

  const proposedStep = useMemo(
    () => current?.steps.find((s) => s.status === "proposed") ?? null,
    [current],
  );
  const timeline = useMemo(() => (current ? buildTimeline(current) : []), [current]);
  const thinking = current ? isAgentThinking(current, loading) : false;
  const activeJob = current ? hasActiveIssueJob(current) : false;
  const canResume = current ? current.resolution.status === "running" && !activeJob && !loading : false;

  const onApprove = useCallback(async (stepId: string) => {
    setExecuting(true);
    try { await approveSteps([stepId], "approve"); } finally { setExecuting(false); }
  }, [approveSteps]);

  // Quick-win reject-with-reason: drop the reason into the thread, then reject.
  // (Proper version: extend the approve route + approveSteps to accept `reason`.)
  const onReject = useCallback(async (stepId: string, reason: string) => {
    await sendMessage(reason);
    await approveSteps([stepId], "reject");
  }, [sendMessage, approveSteps]);

  const onSend = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    await sendMessage(text);
  }, [draft, sendMessage]);

  const focusComposer = useCallback(() => {
    document.querySelector<HTMLTextAreaElement>("[data-composer] textarea")?.focus();
  }, []);

  const onSubmitNewIssue = useCallback(async (title: string, desc: string) => {
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setNewIssueError("Add a title before creating the issue.");
      return;
    }

    setCreatingIssue(true);
    setNewIssueError(null);
    try {
      const id = await createResolution({
        originType: "manual",
        title: cleanTitle,
        description: desc.trim(),
      });
      if (id) {
        setNewIssue(null);
        fetchList();
        router.replace(`/assistant?resolutionId=${id}`);
      } else {
        setNewIssueError("Could not create the issue. Try again.");
      }
    } finally {
      setCreatingIssue(false);
    }
  }, [createResolution, fetchList, router]);

  return (
    <div className="grid gap-4 lg:grid-cols-[288px_1fr]">
      <IssueQueue
        items={resolutions}
        activeId={current?.resolution.id ?? null}
        onSelect={(id) => { loadResolution(id); router.replace(`/assistant?resolutionId=${id}`); }}
        onNew={() => { setNewIssueError(null); setNewIssue({ title: "", desc: "" }); }}
        onImport={() => createResolution({ originType: "manual", importCurrentFindings: true }).then((id) => id && router.replace(`/assistant?resolutionId=${id}`))}
        importing={loading}
      />

      {!current ? (
        <div className="flex flex-col items-center justify-center rounded-[14px] border border-dashed border-border p-12 text-center text-muted-foreground">
          <Bot className="mb-3 h-10 w-10 opacity-40" />
          <p className="text-sm">Select an issue or create one to start investigating.</p>
        </div>
      ) : (
        <main className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="flex flex-col gap-4">
            <IssueHeader state={current} loading={loading} canResume={canResume} onPrimary={continueResolution} />
            <DecisionBar
              status={current.resolution.status}
              step={proposedStep}
              busy={loading}
              executing={executing}
              onApprove={onApprove}
              onReject={onReject}
              onAnswer={focusComposer}
            />
            <div data-composer="">
              <Timeline
                items={timeline}
                thinking={thinking}
                thinkingText={thinkingLabel(current)}
                draft={draft}
                setDraft={setDraft}
                onSend={onSend}
                sending={loading}
                waitingOnUser={current.resolution.status === "waiting_on_user"}
              />
            </div>
          </div>
          <DiagnosisRail
            state={current}
            forensicSlot={<ForensicIncidentPanel facts={current.facts} />}
          />
        </main>
      )}
      {newIssue !== null && (
        <NewIssueDialog
          value={newIssue}
          onChange={setNewIssue}
          onSubmit={onSubmitNewIssue}
          onCancel={() => { if (!creatingIssue) setNewIssue(null); }}
          submitting={creatingIssue}
          error={newIssueError}
        />
      )}
    </div>
  );
}

function NewIssueDialog({
  value, onChange, onSubmit, onCancel, submitting, error,
}: {
  value: { title: string; desc: string };
  onChange: (v: { title: string; desc: string }) => void;
  onSubmit: (title: string, desc: string) => void;
  onCancel: () => void;
  submitting: boolean;
  error: string | null;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!submitting) onSubmit(value.title, value.desc);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onCancel}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-issue-title"
        onSubmit={submit}
        className="w-full max-w-md rounded-[14px] border border-border bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="new-issue-title" className="text-base font-bold">New issue</h2>
          <button type="button" onClick={onCancel} disabled={submitting} className="rounded-lg p-1 text-muted-foreground hover:text-foreground disabled:opacity-50"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex flex-col gap-3">
          <input
            autoFocus
            placeholder="Issue title"
            value={value.title}
            onChange={(e) => onChange({ ...value, title: e.target.value })}
            disabled={submitting}
            className="w-full rounded-[9px] border border-border bg-muted px-3 py-2 text-sm outline-none focus:border-primary"
          />
          <textarea
            placeholder="Describe the issue (optional)"
            value={value.desc}
            onChange={(e) => onChange({ ...value, desc: e.target.value })}
            disabled={submitting}
            rows={3}
            className="w-full resize-none rounded-[9px] border border-border bg-muted px-3 py-2 text-sm outline-none focus:border-primary"
          />
          {error && <p className="text-xs font-medium text-critical">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onCancel} disabled={submitting} className="rounded-[9px] px-4 py-2 text-sm font-semibold text-muted-foreground hover:text-foreground disabled:opacity-50">Cancel</button>
            <button
              type="submit"
              disabled={!value.title.trim() || submitting}
              className="rounded-[9px] bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:brightness-110 disabled:opacity-40"
            >
              {submitting ? "Creating..." : "Create"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function IssueHeader({ state, loading, canResume, onPrimary }: { state: ResolutionFull; loading: boolean; canResume: boolean; onPrimary: () => void }) {
  const r = state.resolution;
  const isOpen = r.status === "open" || r.status === "stuck" || canResume;
  return (
    <header className="flex items-start justify-between gap-5 rounded-[14px] border border-border bg-card p-[18px]">
      <div className="min-w-0">
        <div className="mb-2.5 flex flex-wrap items-center gap-2.5">
          <SevBadge severity={r.severity} />
          <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-muted-foreground">
            <StatusDot status={r.status} /> {STATUS_META[r.status].label}
          </span>
          {r.affected_nas.length > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><HardDrive className="h-3 w-3" /> {r.affected_nas.join(", ")}</span>
          )}
        </div>
        <h1 className="text-[21px] font-bold leading-tight tracking-tight">{r.title}</h1>
        {r.summary && <p className="mt-1.5 max-w-[60ch] text-[13.5px] leading-relaxed text-muted-foreground">{r.summary}</p>}
      </div>
      {isOpen && (
        <button onClick={onPrimary} disabled={loading} className="inline-flex shrink-0 items-center gap-2 rounded-[10px] bg-primary px-4 py-2.5 text-[13.5px] font-semibold text-primary-foreground hover:brightness-110 disabled:opacity-50">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {r.status === "open" ? "Start investigation" : "Resume"}
        </button>
      )}
      {r.status === "running" && !canResume && (
        <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-[12.5px] font-semibold text-muted-foreground")}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Live
        </span>
      )}
    </header>
  );
}
