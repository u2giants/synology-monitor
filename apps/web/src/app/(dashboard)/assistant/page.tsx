"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  MessageSquare,
  Play,
  Plus,
  Radar,
  Send,
  Trash2,
  Wrench,
  XCircle,
  Layers3,
  Coins,
} from "lucide-react";
import { cn, formatETFull, timeAgoET } from "@/lib/utils";
import {
  useResolution,
  type Resolution,
  type ResolutionCapability,
  type ResolutionEscalationEvent,
  type ResolutionFact,
  type ResolutionFull,
  type ResolutionJob,
  type ResolutionMessage,
  type ResolutionStageRun,
  type ResolutionStep,
} from "@/hooks/use-resolution";

// Status dot vocabulary: consistent color + label across all views
const statusDotConfig: Record<Resolution["status"], { color: string; pulse: boolean; label: string }> = {
  open:                 { color: "bg-muted-foreground/50", pulse: false, label: "Not yet investigated" },
  running:              { color: "bg-blue-500",            pulse: true,  label: "Investigating" },
  waiting_on_user:      { color: "bg-primary",             pulse: false, label: "Needs your input" },
  waiting_for_approval: { color: "bg-amber-500",           pulse: false, label: "Needs your approval" },
  waiting_on_issue:     { color: "bg-muted-foreground/50", pulse: false, label: "Waiting on another issue" },
  resolved:             { color: "bg-success",             pulse: false, label: "Resolved" },
  stuck:                { color: "bg-amber-500",           pulse: false, label: "Stuck — needs attention" },
  cancelled:            { color: "bg-muted-foreground/30", pulse: false, label: "Cancelled" },
};

const severityConfig = {
  critical: { className: "text-critical", badge: "bg-critical/10 text-critical border-critical/20" },
  warning:  { className: "text-warning",  badge: "bg-warning/10 text-warning border-warning/20" },
  info:     { className: "text-primary",  badge: "bg-primary/10 text-primary border-primary/20" },
};

const capabilityKeyLabels: Record<string, string> = {
  smart_data:    "Disk health data (SMART)",
  ssh_access:    "SSH command access",
  synology_api:  "Synology management API",
  nas_api:       "NAS API connection",
  log_access:    "System log access",
  snmp:          "SNMP monitoring",
};

const stageKeyLabels: Record<string, string> = {
  gather_telemetry: "Gather telemetry",
  hypothesize:      "Form hypothesis",
  plan:             "Plan next action",
  diagnose:         "Run diagnostics",
  remediate:        "Apply fix",
  verify:           "Verify resolution",
  detect_issue:     "Detect issues",
};

const jobTypeLabels: Record<string, string> = {
  detect_issue:      "Initial detection",
  run_agent:         "Agent investigation",
  gather_telemetry:  "Gather data",
};

function confidenceLabel(confidence: "high" | "medium" | "low" | null | undefined): string | null {
  if (!confidence) return null;
  if (confidence === "high") return "High confidence";
  if (confidence === "medium") return "Medium confidence";
  return "Low confidence";
}

function confidenceBadgeClass(confidence: "high" | "medium" | "low" | null | undefined): string {
  if (!confidence) return "";
  if (confidence === "high") return "bg-success/10 text-success border-success/20";
  if (confidence === "medium") return "bg-warning/10 text-warning border-warning/20";
  return "bg-muted text-muted-foreground border-border";
}

export default function AssistantPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const createdOnce = useRef(false);
  const {
    resolutions,
    current,
    loading,
    error,
    fetchList,
    loadResolution,
    createResolution,
    approveSteps,
    sendMessage,
    continueResolution,
    setResolutionMode,
    rebaseResolutionContext,
    approveResolutionEscalation,
    cancelResolution,
    deleteResolution,
  } = useResolution();

  const [showNewForm, setShowNewForm] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [draft, setDraft] = useState("");

  useEffect(() => {
    fetchList();
  }, [fetchList]);

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
        if (id) {
          fetchList();
          router.replace(`/assistant?resolutionId=${id}`);
        }
      });
      return;
    }

    if (alertId) {
      createdOnce.current = true;
      createResolution({ originType: "alert", originId: alertId }).then((id) => {
        if (id) {
          fetchList();
          router.replace(`/assistant?resolutionId=${id}`);
        }
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
        if (id) {
          fetchList();
          router.replace(`/assistant?resolutionId=${id}`);
        }
      });
    }
  }, [createResolution, fetchList, loadResolution, loading, router, searchParams]);

  useEffect(() => {
    if (!current) return;
    const hasActiveJobs = current.jobs.some((job) => job.status === "queued" || job.status === "running");
    if (!hasActiveJobs) return;

    const timer = window.setInterval(() => {
      loadResolution(current.resolution.id);
    }, 3000);

    return () => window.clearInterval(timer);
  }, [current, loadResolution]);

  async function handleCreate() {
    if (!newTitle.trim()) return;
    const id = await createResolution({
      originType: "manual",
      title: newTitle.trim(),
      description: newDescription.trim() || newTitle.trim(),
    });
    if (!id) return;
    setNewTitle("");
    setNewDescription("");
    setShowNewForm(false);
    await fetchList();
    router.replace(`/assistant?resolutionId=${id}`);
  }

  async function handleImportCurrentFindings() {
    const id = await createResolution({
      originType: "manual",
      importCurrentFindings: true,
    });
    if (!id) return;
    await fetchList();
    router.replace(`/assistant?resolutionId=${id}`);
  }

  async function handleExportTranscript() {
    if (!current) return;
    try {
      const res = await fetch(`/api/resolution/${current.resolution.id}/transcript`);
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to export transcript");
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `issue-${current.resolution.id}-transcript.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleExportTranscriptVariant(variant: "raw" | "llm" | "audit") {
    if (!current) return;
    try {
      const res = await fetch(`/api/resolution/${current.resolution.id}/transcript?variant=${variant}`);
      if (!res.ok) throw new Error("Failed to export transcript");
      const contentType = res.headers.get("content-type") ?? "application/octet-stream";
      const blob = await res.blob();
      const url = URL.createObjectURL(new Blob([blob], { type: contentType }));
      const link = document.createElement("a");
      link.href = url;
      link.download =
        variant === "audit"
          ? `issue-${current.resolution.id}-audit.txt`
          : variant === "llm"
            ? `issue-${current.resolution.id}-llm-handoff.json`
            : `issue-${current.resolution.id}-transcript.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleExportFixture() {
    if (!current) return;
    try {
      const res = await fetch(`/api/resolution/${current.resolution.id}/transcript?variant=fixture`);
      if (!res.ok) throw new Error("Failed to export eval fixture");
      const blob = await res.blob();
      const url = URL.createObjectURL(new Blob([blob], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `issue-${current.resolution.id}-eval-fixture.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleSend() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setDraft("");
    await sendMessage(trimmed);
    await fetchList();
  }

  const pendingActions = useMemo(
    () => current?.steps.filter((step) => step.status === "proposed") ?? [],
    [current]
  );
  const primaryPendingAction = pendingActions[0] ?? null;
  const latestAgentMessage = useMemo(
    () => [...(current?.messages ?? [])].reverse().find((message) => message.role === "agent") ?? null,
    [current]
  );
  const activeJobs = useMemo(
    () => current?.jobs.filter((job) => job.status === "queued" || job.status === "running") ?? [],
    [current]
  );
  const failedJobs = useMemo(
    () => current?.jobs.filter((job) => job.status === "failed").slice(0, 3) ?? [],
    [current]
  );
  const capabilityGaps = useMemo(
    () => current?.capabilities.filter((capability) => capability.state !== "supported") ?? [],
    [current]
  );
  const pendingEscalations = useMemo(
    () => current?.escalation_events.filter((event) => !event.approved_by_user) ?? [],
    [current]
  );
  const primaryEscalation = pendingEscalations[0] ?? null;
  const activeSession = useMemo(
    () => current?.working_sessions.find((session) => session.status === "active") ?? null,
    [current]
  );
  const activeSessionMetrics = useMemo(() => {
    if (!current || !activeSession) return null;
    const startedAt = new Date(activeSession.started_at).getTime();
    const inSessionMessages = current.messages.filter((message) => new Date(message.created_at).getTime() >= startedAt).length;
    const inSessionEvidence = current.log.filter((entry) => new Date(entry.created_at).getTime() >= startedAt).length;
    const inSessionActions = current.steps.filter((action) => new Date(action.created_at).getTime() >= startedAt).length;
    return {
      messages: inSessionMessages,
      evidence: inSessionEvidence,
      actions: inSessionActions,
      ageHours: Math.max((Date.now() - startedAt) / 3_600_000, 0),
    };
  }, [activeSession, current]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Issue Investigator</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The AI agent diagnoses NAS problems, gathers evidence, and asks for your approval before making any changes.
        </p>
        <div className="mt-3">
          <button
            onClick={handleImportCurrentFindings}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radar className="h-4 w-4" />}
            Import current backend findings
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-critical/30 bg-critical/5 p-3 text-sm text-critical">
          {error}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        {/* Left sidebar: issue list */}
        <aside className="space-y-3">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Open Issues</h2>
              <button
                onClick={() => setShowNewForm((value) => !value)}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
                New
              </button>
            </div>

            {showNewForm && (
              <div className="mb-3 space-y-2 rounded-lg border border-border bg-background p-3">
                <input
                  value={newTitle}
                  onChange={(event) => setNewTitle(event.target.value)}
                  placeholder="Describe the issue"
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none"
                />
                <textarea
                  value={newDescription}
                  onChange={(event) => setNewDescription(event.target.value)}
                  placeholder="What are you seeing? (optional)"
                  className="min-h-20 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none"
                />
                <button
                  onClick={handleCreate}
                  disabled={loading || !newTitle.trim()}
                  className="w-full rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  Start investigation
                </button>
              </div>
            )}

            {resolutions.length === 0 ? (
              <div className="text-xs text-muted-foreground">
                No issues yet. Create one manually or run issue detection from the dashboard.
              </div>
            ) : (
              <div className="space-y-1.5">
                {resolutions.map((resolution) => (
                  <IssueListItem
                    key={resolution.id}
                    resolution={resolution}
                    active={current?.resolution.id === resolution.id}
                    onClick={() => {
                      loadResolution(resolution.id);
                      router.replace(`/assistant?resolutionId=${resolution.id}`);
                    }}
                    onDelete={() => {
                      deleteResolution(resolution.id);
                      router.replace("/assistant");
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* Main area */}
        <section className="space-y-4">
          {!current ? (
            <div className="rounded-xl border border-dashed border-border p-12 text-center text-muted-foreground">
              <Bot className="mx-auto mb-3 h-10 w-10 opacity-40" />
              <p className="text-sm">Select an issue or create a new one to start investigating.</p>
            </div>
          ) : (
            <>
              {/* Issue header */}
            <IssueHeader
              state={current}
              loading={loading}
              onContinue={continueResolution}
              onSetMode={setResolutionMode}
              onRebase={rebaseResolutionContext}
              onExportTranscript={handleExportTranscript}
              onExportTranscriptVariant={handleExportTranscriptVariant}
              onExportFixture={handleExportFixture}
              onCancel={cancelResolution}
              resolutions={resolutions}
            />

              {/* Agent actively running — slim ambient indicator */}
              {activeJobs.length > 0 && (
                <div className="flex items-center gap-2 rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-2.5 text-sm text-blue-700 dark:text-blue-300">
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  Agent is actively investigating — this page updates automatically.
                </div>
              )}

              {/* Failed jobs — only show when not running */}
              {activeJobs.length === 0 && failedJobs.length > 0 && (
                <div className="flex items-center gap-2 rounded-lg border border-critical/20 bg-critical/5 px-4 py-2.5 text-sm text-critical">
                  <XCircle className="h-3.5 w-3.5 shrink-0" />
                  {failedJobs.length} background job{failedJobs.length === 1 ? "" : "s"} failed. Use Continue to retry.
                </div>
              )}

              {/* Action approval banner */}
              {primaryPendingAction && (
                <ActionRequiredBanner
                  step={primaryPendingAction}
                  latestAgentMessage={latestAgentMessage?.content ?? null}
                  loading={loading}
                  onApprove={() => approveSteps([primaryPendingAction.id], "approve")}
                  onReject={() => approveSteps([primaryPendingAction.id], "reject")}
                />
              )}

              {primaryEscalation && (
                <EscalationBanner
                  escalation={primaryEscalation}
                  activeSessionMetrics={activeSessionMetrics}
                  loading={loading}
                  onApprove={() => {
                    if (primaryEscalation.kind === "deep_mode_switch") {
                      return setResolutionMode("deep");
                    }
                    if (primaryEscalation.kind === "expanded_context") {
                      return rebaseResolutionContext("agent_requested_context_rebase");
                    }
                    return approveResolutionEscalation(primaryEscalation);
                  }}
                />
              )}

              {/* Agent needs input */}
              {current.resolution.status === "waiting_on_user" && (
                <NeedsInputPanel
                  nextStep={current.resolution.next_step}
                  latestAgentMessage={latestAgentMessage?.content ?? null}
                />
              )}

              {/* Approval state mismatch */}
              {current.resolution.status === "waiting_for_approval" && pendingActions.length === 0 && (
                <ApprovalMismatchPanel onContinue={continueResolution} loading={loading} />
              )}

              {/* Multiple pending actions */}
              {pendingActions.length > 1 && (
                <ActionPanel
                  steps={pendingActions}
                  loading={loading}
                  onApprove={(ids) => approveSteps(ids, "approve")}
                  onReject={(ids) => approveSteps(ids, "reject")}
                />
              )}

              {/* Conversation + sidebar */}
              <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
                <div className="rounded-xl border border-border bg-card p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <MessageSquare className="h-4 w-4 text-muted-foreground" />
                    <h2 className="text-sm font-semibold">Investigation Thread</h2>
                  </div>

                  {current.messages.length === 0 ? (
                    <div className="py-8 text-center text-sm text-muted-foreground">
                      The agent will post its findings here as the investigation progresses.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {current.messages.map((message) => (
                        <MessageBubble key={message.id} message={message} />
                      ))}
                    </div>
                  )}

                  <div className="mt-4 flex gap-2">
                    <textarea
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      placeholder="Add context or answer the agent's question..."
                      className="min-h-20 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
                    />
                    <button
                      onClick={handleSend}
                      disabled={loading || !draft.trim()}
                      className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    >
                      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      Send
                    </button>
                  </div>
                </div>

                <IssueSidebar state={current} capabilityGaps={capabilityGaps} />
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

// ─── Issue header ─────────────────────────────────────────────────────────────

function IssueHeader({
  state,
  loading,
  onContinue,
  onSetMode,
  onRebase,
  onExportTranscript,
  onExportTranscriptVariant,
  onExportFixture,
  onCancel,
  resolutions,
}: {
  state: ResolutionFull;
  loading: boolean;
  onContinue: () => void;
  onSetMode: (mode: "guided" | "deep") => void;
  onRebase: (reason?: string) => void;
  onExportTranscript: () => void;
  onExportTranscriptVariant: (variant: "raw" | "llm" | "audit") => void;
  onExportFixture: () => void;
  onCancel: () => void;
  resolutions: Resolution[];
}) {
  const status = state.resolution.status;
  const dotConfig = statusDotConfig[status];
  const sevConfig = severityConfig[state.resolution.severity];
  const activeSession = state.working_sessions.find((session) => session.status === "active") ?? state.working_sessions[0] ?? null;
  const totalEstimatedCost = state.token_usage.reduce((sum, entry) => sum + (entry.estimated_cost ?? 0), 0);
  const activeSessionStartedAt = activeSession ? new Date(activeSession.started_at).getTime() : null;
  const sessionMessageCount = activeSessionStartedAt == null
    ? 0
    : state.messages.filter((message) => new Date(message.created_at).getTime() >= activeSessionStartedAt).length;
  const sessionEvidenceCount = activeSessionStartedAt == null
    ? 0
    : state.log.filter((entry) => new Date(entry.created_at).getTime() >= activeSessionStartedAt).length;
  const sessionActionCount = activeSessionStartedAt == null
    ? 0
    : state.steps.filter((action) => new Date(action.created_at).getTime() >= activeSessionStartedAt).length;
  const sessionAgeHours = activeSessionStartedAt == null
    ? 0
    : Math.max((Date.now() - activeSessionStartedAt) / 3_600_000, 0);
  const activeApprovedOverrides = activeSession
    ? state.escalation_events.filter((event) => event.approved_by_user && event.session_id === activeSession.id)
    : [];
  const activeReasoningOverride = activeApprovedOverrides.find((event) => event.kind === "higher_reasoning" && event.to_reasoning)?.to_reasoning ?? null;
  const activeModelOverride = activeApprovedOverrides.find((event) => event.kind === "stronger_model" && event.to_model)?.to_model ?? null;

  const isOpenOrStuck = status === "open" || status === "stuck";
  const isTerminal = status === "resolved" || status === "cancelled" || status === "waiting_on_issue";

  // Resolve the title of the issue this one is waiting on, if any
  const blockingIssue = state.resolution.depends_on_issue_id
    ? resolutions.find((r) => r.id === state.resolution.depends_on_issue_id)
    : null;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", sevConfig.badge)}>
              {state.resolution.severity}
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={cn("h-2 w-2 shrink-0 rounded-full", dotConfig.color, dotConfig.pulse && "animate-pulse")} />
              {dotConfig.label}
            </span>
            {activeSession && (
              <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                <Layers3 className="h-3 w-3" />
                {activeSession.mode === "deep" ? "Deep investigation" : "Guided resolution"}
              </span>
            )}
            {totalEstimatedCost > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                <Coins className="h-3 w-3" />
                ${totalEstimatedCost.toFixed(2)} est.
              </span>
            )}
          </div>
          {activeSession && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => onSetMode("guided")}
                disabled={loading || activeSession.mode === "guided"}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs",
                  activeSession.mode === "guided" ? "border-primary text-primary" : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                Guided
              </button>
              <button
                onClick={() => onSetMode("deep")}
                disabled={loading || activeSession.mode === "deep"}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs",
                  activeSession.mode === "deep" ? "border-primary text-primary" : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                Deep
              </button>
              <button
                onClick={() => onRebase("manual_context_rebase")}
                disabled={loading}
                className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                Rebase context
              </button>
              <button
                onClick={onExportTranscript}
                disabled={loading}
                className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                Export raw
              </button>
              <button
                onClick={() => onExportTranscriptVariant("llm")}
                disabled={loading}
                className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                Export LLM
              </button>
              <button
                onClick={() => onExportTranscriptVariant("audit")}
                disabled={loading}
                className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                Export audit
              </button>
              <button
                onClick={onExportFixture}
                disabled={loading}
                className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                Export fixture
              </button>
            </div>
          )}
          {activeSession && (
            <div className="grid gap-2 pt-1 sm:grid-cols-2">
              <div className="rounded-lg border border-border bg-background px-3 py-2">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Session health
                </div>
                <div className="mt-1 text-sm">
                  {sessionMessageCount} messages · {sessionEvidenceCount} evidence · {sessionActionCount} actions
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  Age {sessionAgeHours.toFixed(1)}h in {activeSession.mode === "deep" ? "Deep" : "Guided"} mode
                </div>
              </div>
              <div className="rounded-lg border border-border bg-background px-3 py-2">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Active overrides
                </div>
                {(activeModelOverride || activeReasoningOverride) ? (
                  <>
                    <div className="mt-1 text-sm">
                      {activeModelOverride ? `Model: ${activeModelOverride}` : "No model override"}
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {activeReasoningOverride ? `Reasoning: ${activeReasoningOverride}` : "No reasoning override"}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="mt-1 text-sm">Stage defaults active</div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      No approved model or reasoning overrides are currently applied.
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
          <h2 className="text-lg font-semibold leading-snug">{state.resolution.title}</h2>
          {state.resolution.summary && (
            <p className="text-sm text-muted-foreground">{state.resolution.summary}</p>
          )}
          {state.resolution.affected_nas.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Device{state.resolution.affected_nas.length > 1 ? "s" : ""}:{" "}
              {state.resolution.affected_nas.join(", ")}
            </p>
          )}
          {status === "waiting_on_issue" && (
            <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 shrink-0" />
              Paused — waiting for{" "}
              {blockingIssue ? (
                <button
                  className="font-medium text-foreground underline-offset-2 hover:underline"
                  onClick={() => {
                    /* parent handles selection via resolutionId */
                  }}
                >
                  {blockingIssue.title}
                </button>
              ) : (
                <span className="font-medium text-foreground">another issue</span>
              )}{" "}
              to resolve first.
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          {isOpenOrStuck ? (
            <button
              onClick={onContinue}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {status === "open" ? "Start Investigation" : "Resume Investigation"}
            </button>
          ) : !isTerminal ? (
            <button
              onClick={onContinue}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Continue
            </button>
          ) : null}
          {!isTerminal && (
            <button
              onClick={onCancel}
              disabled={loading}
              className="text-xs text-muted-foreground hover:text-critical disabled:opacity-50"
            >
              Dismiss issue
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Issue sidebar ─────────────────────────────────────────────────────────────

function IssueSidebar({
  state,
  capabilityGaps,
}: {
  state: ResolutionFull;
  capabilityGaps: ResolutionCapability[];
}) {
  const [showTechDetails, setShowTechDetails] = useState(false);

  const confLabel = confidenceLabel(state.resolution.hypothesis_confidence);
  const confBadge = confidenceBadgeClass(state.resolution.hypothesis_confidence);

  const hasActivity = state.log.length > 0;
  const hasTechData =
    capabilityGaps.length > 0 ||
    state.jobs.length > 0 ||
    state.stage_runs.length > 0 ||
    state.transitions.length > 0 ||
    state.working_sessions.length > 0 ||
    state.escalation_events.length > 0 ||
    state.token_usage.length > 0;
  const escalationTriggerById = useMemo(() => {
    const byId: Record<string, string> = {};
    for (const event of state.escalation_events) {
      const eventTs = new Date(event.created_at).getTime();
      const relatedRuns = state.stage_runs
        .filter((run) => new Date(run.created_at).getTime() <= eventTs)
        .slice()
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      const failedRun = relatedRuns.find((run) => run.status === "failed");
      const lowConfidenceRun = relatedRuns.find((run) => {
        const inputConfidence = typeof run.input_summary?.hypothesis_confidence === "string" ? run.input_summary.hypothesis_confidence : null;
        const outputConfidence = typeof run.output?.hypothesis_confidence === "string" ? run.output.hypothesis_confidence : null;
        return inputConfidence === "low" || outputConfidence === "low";
      });
      const sourceRun = failedRun ?? lowConfidenceRun ?? relatedRuns[0] ?? null;
      if (!sourceRun) continue;
      const sourceLabel = stageKeyLabels[sourceRun.stage_key] ?? sourceRun.stage_key.replaceAll("_", " ");
      if (failedRun) {
        byId[event.id] = `Triggered after ${sourceLabel} failed.`;
      } else if (lowConfidenceRun) {
        byId[event.id] = `Triggered after ${sourceLabel} still reported low confidence.`;
      } else {
        byId[event.id] = `Triggered after ${sourceLabel}.`;
      }
    }
    return byId;
  }, [state.escalation_events, state.stage_runs]);
  const sessionRollups = useMemo(() => {
    return state.working_sessions.map((session) => {
      const sessionCost = state.token_usage
        .filter((usage) => usage.session_id === session.id)
        .reduce((sum, usage) => sum + (usage.estimated_cost ?? 0), 0);
      const approvedOverrides = state.escalation_events.filter((event) => event.approved_by_user && event.session_id === session.id);
      const latestModelOverride = approvedOverrides.find((event) => event.kind === "stronger_model" && event.to_model)?.to_model ?? null;
      const latestReasoningOverride = approvedOverrides.find((event) => event.kind === "higher_reasoning" && event.to_reasoning)?.to_reasoning ?? null;
      return {
        session,
        sessionCost,
        latestModelOverride,
        latestReasoningOverride,
      };
    });
  }, [state.escalation_events, state.token_usage, state.working_sessions]);
  const costBreakdown = useMemo(() => {
    const byStage: Array<{ key: string; cost: number }> = [];
    const stageMap = new Map<string, number>();
    for (const usage of state.token_usage) {
      stageMap.set(usage.stage_key, (stageMap.get(usage.stage_key) ?? 0) + (usage.estimated_cost ?? 0));
    }
    for (const [key, cost] of stageMap.entries()) {
      byStage.push({ key, cost });
    }

    const byModel: Array<{ key: string; cost: number }> = [];
    const modelMap = new Map<string, number>();
    for (const usage of state.token_usage) {
      modelMap.set(usage.model_name, (modelMap.get(usage.model_name) ?? 0) + (usage.estimated_cost ?? 0));
    }
    for (const [key, cost] of modelMap.entries()) {
      byModel.push({ key, cost });
    }

    return {
      total: state.token_usage.reduce((sum, usage) => sum + (usage.estimated_cost ?? 0), 0),
      byStage: byStage.sort((a, b) => b.cost - a.cost).slice(0, 6),
      byModel: byModel.sort((a, b) => b.cost - a.cost).slice(0, 6),
      bySession: sessionRollups
        .map(({ session, sessionCost }) => ({ key: session.id.slice(0, 8), label: session.mode, cost: sessionCost }))
        .sort((a, b) => b.cost - a.cost)
        .slice(0, 6),
    };
  }, [sessionRollups, state.token_usage]);

  return (
    <div className="space-y-4">
      {/* Likely cause */}
      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="text-sm font-semibold">Likely Cause</h3>
        {state.resolution.current_hypothesis ? (
          <>
            <p className="mt-2 text-sm">{state.resolution.current_hypothesis}</p>
            {confLabel && (
              <span className={cn("mt-2 inline-block rounded-full border px-2 py-0.5 text-xs font-medium", confBadge)}>
                {confLabel}
              </span>
            )}
          </>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            {state.resolution.status === "open"
              ? "Start the investigation to identify the likely cause."
              : "Still gathering data..."}
          </p>
        )}
        {state.resolution.next_step && (
          <div className="mt-3 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium">Next: </span>
            {state.resolution.next_step}
          </div>
        )}
      </div>

      {/* Forensic incident explainer — shown when Drive/Backup forensic facts exist */}
      <ForensicIncidentPanel facts={state.facts} />

      {/* Key findings (facts) */}
      {state.facts.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">Key Findings</h3>
          <div className="mt-3 space-y-2">
            {state.facts.slice(0, 8).map((fact) => (
              <FactCard key={fact.id} fact={fact} />
            ))}
          </div>
        </div>
      )}

      {/* Operator constraints */}
      {state.resolution.operator_constraints.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">Restrictions</h3>
          <div className="mt-2 space-y-2">
            {state.resolution.operator_constraints.map((constraint) => (
              <div key={constraint} className="rounded-md bg-muted px-3 py-2 text-xs">
                {constraint}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Activity log */}
      {hasActivity && (
        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">Activity</h3>
          <div className="mt-3 space-y-3">
            {state.log.slice(-8).reverse().map((entry) => (
              <div key={entry.id} className="border-l-2 border-border pl-3">
                <div className="text-xs font-medium">{entry.title}</div>
                {entry.detail && (
                  <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">{entry.detail}</p>
                )}
                <div className="mt-1 text-[11px] text-muted-foreground">{timeAgoET(entry.created_at)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Technical details — collapsed by default */}
      {hasTechData && (
        <div className="rounded-xl border border-border bg-card">
          <button
            onClick={() => setShowTechDetails(!showTechDetails)}
            className="flex w-full items-center justify-between px-4 py-3 text-sm text-muted-foreground hover:text-foreground"
          >
            <span className="font-medium text-sm">Technical details</span>
            {showTechDetails ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          {showTechDetails && (
            <div className="space-y-4 border-t border-border px-4 pb-4 pt-3">
              {capabilityGaps.length > 0 && (
                <div>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Limited data sources
                  </h4>
                  <div className="space-y-1.5">
                    {capabilityGaps.map((cap) => (
                      <CapabilityCard key={cap.id} capability={cap} />
                    ))}
                  </div>
                </div>
              )}

              {state.jobs.length > 0 && (
                <div>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Background jobs
                  </h4>
                  <div className="space-y-1.5">
                    {state.jobs.slice(0, 6).map((job) => (
                      <JobCard key={job.id} job={job} />
                    ))}
                  </div>
                </div>
              )}

              {state.stage_runs.length > 0 && (
                <div>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Analysis steps
                  </h4>
                  <div className="space-y-1.5">
                    {state.stage_runs.slice(0, 8).map((run) => (
                      <StageRunCard key={run.id} run={run} />
                    ))}
                  </div>
                </div>
              )}

              {state.token_usage.length > 0 && (
                <div>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Cost breakdown
                  </h4>
                  <div className="rounded-lg border border-border bg-background p-3">
                    <div className="text-xs font-medium">Total estimated cost</div>
                    <div className="mt-1 text-sm">${costBreakdown.total.toFixed(3)}</div>
                    {costBreakdown.bySession.length > 0 && (
                      <div className="mt-3">
                        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">By session</div>
                        <div className="mt-1 space-y-1">
                          {costBreakdown.bySession.map((entry) => (
                            <div key={entry.key} className="flex items-center justify-between text-[11px] text-muted-foreground">
                              <span>{entry.key} · {entry.label}</span>
                              <span>${entry.cost.toFixed(3)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {costBreakdown.byStage.length > 0 && (
                      <div className="mt-3">
                        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">By stage</div>
                        <div className="mt-1 space-y-1">
                          {costBreakdown.byStage.map((entry) => (
                            <div key={entry.key} className="flex items-center justify-between text-[11px] text-muted-foreground">
                              <span>{stageKeyLabels[entry.key] ?? entry.key}</span>
                              <span>${entry.cost.toFixed(3)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {costBreakdown.byModel.length > 0 && (
                      <div className="mt-3">
                        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">By model</div>
                        <div className="mt-1 space-y-1">
                          {costBreakdown.byModel.map((entry) => (
                            <div key={entry.key} className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                              <span className="truncate">{entry.key}</span>
                              <span>${entry.cost.toFixed(3)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {state.working_sessions.length > 0 && (
                <div>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Working sessions
                  </h4>
                  <div className="space-y-1.5">
                    {sessionRollups.slice(0, 6).map(({ session, sessionCost, latestModelOverride, latestReasoningOverride }) => (
                      <div key={session.id} className="rounded-lg border border-border bg-background p-3">
                        <div className="text-xs font-medium">
                          {session.mode === "deep" ? "Deep investigation" : "Guided resolution"}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {session.status} · started {timeAgoET(session.started_at)}
                        </div>
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          Est. cost ${sessionCost.toFixed(3)}
                        </div>
                        {(latestModelOverride || latestReasoningOverride) && (
                          <div className="mt-1 text-[11px] text-muted-foreground">
                            {latestModelOverride ? `Model ${latestModelOverride}` : ""}
                            {latestModelOverride && latestReasoningOverride ? " · " : ""}
                            {latestReasoningOverride ? `Reasoning ${latestReasoningOverride}` : ""}
                          </div>
                        )}
                        {session.rebase_from_session_id && (
                          <div className="mt-1 text-[11px] text-muted-foreground">
                            Rebases from {session.rebase_from_session_id.slice(0, 8)}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {state.investigation_briefs.length > 0 && (
                <div>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Investigation briefs
                  </h4>
                  <div className="space-y-1.5">
                    {state.investigation_briefs.slice(0, 4).map((brief) => (
                      <div key={brief.id} className="rounded-lg border border-border bg-background p-3">
                        <div className="text-xs font-medium">{brief.trigger_reason}</div>
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {timeAgoET(brief.created_at)}
                        </div>
                        {brief.quality_score != null && (
                          <div className="mt-1 text-[11px] text-muted-foreground">
                            Quality score: {brief.quality_score}/100
                          </div>
                        )}
                        {typeof brief.content_json?.current_hypothesis === "string" && brief.content_json.current_hypothesis && (
                          <div className="mt-1 text-[11px] text-muted-foreground">
                            Hypothesis: {String(brief.content_json.current_hypothesis).slice(0, 120)}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {state.escalation_events.length > 0 && (
                <div>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Escalation history
                  </h4>
                  <div className="space-y-1.5">
                    {state.escalation_events.slice(0, 6).map((event) => (
                      <div key={event.id} className="rounded-lg border border-border bg-background p-3">
                        <div className="text-xs font-medium">{event.kind.replaceAll("_", " ")}</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {event.approved_by_user ? "Approved" : "Pending/denied"} · {timeAgoET(event.created_at)}
                        </div>
                        {escalationTriggerById[event.id] && (
                          <div className="mt-1 text-[11px] text-muted-foreground">
                            {escalationTriggerById[event.id]}
                          </div>
                        )}
                        {(event.to_model || event.to_reasoning) && (
                          <div className="mt-1 text-[11px] text-muted-foreground">
                            {event.to_model ? `Model: ${event.to_model}` : ""}
                            {event.to_model && event.to_reasoning ? " · " : ""}
                            {event.to_reasoning ? `Reasoning: ${event.to_reasoning}` : ""}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {state.token_usage.length > 0 && (
                <div>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Token usage
                  </h4>
                  <div className="space-y-1.5">
                    {state.token_usage.slice(0, 8).map((usage) => (
                      <div key={usage.id} className="rounded-lg border border-border bg-background p-3">
                        <div className="text-xs font-medium">{usage.stage_key}</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {usage.model_name}
                        </div>
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          in {usage.input_tokens ?? 0} · out {usage.output_tokens ?? 0} · reasoning {usage.reasoning_tokens ?? 0}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {state.transitions.length > 0 && (
                <div>
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Status history
                  </h4>
                  <div className="space-y-1.5">
                    {state.transitions.slice(0, 6).map((transition) => (
                      <div key={transition.id} className="rounded-lg border border-border bg-background p-3">
                        <div className="text-xs font-medium">
                          {(transition.from_status ?? "none").replaceAll("_", " ")}
                          <ChevronRight className="mx-1 inline h-3 w-3" />
                          {transition.to_status.replaceAll("_", " ")}
                        </div>
                        {transition.reason && (
                          <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                            {transition.reason}
                          </p>
                        )}
                        <div className="mt-2 text-[11px] text-muted-foreground">
                          {timeAgoET(transition.created_at)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function FactCard({ fact }: { fact: ResolutionFact }) {
  const severityClass =
    fact.severity === "critical"
      ? "border-critical/20 bg-critical/5"
      : fact.severity === "warning"
        ? "border-warning/20 bg-warning/5"
        : "border-primary/20 bg-primary/5";

  return (
    <div className={cn("rounded-lg border p-3", severityClass)}>
      <div className="text-xs font-medium">{fact.title}</div>
      <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{fact.detail}</p>
      <div className="mt-2 text-[11px] text-muted-foreground">
        {fact.fact_type} · {timeAgoET(fact.observed_at)}
      </div>
    </div>
  );
}

function CapabilityCard({ capability }: { capability: ResolutionCapability }) {
  const stateClass =
    capability.state === "unsupported"
      ? "border-critical/20 bg-critical/5"
      : "border-warning/20 bg-warning/5";
  const label = capabilityKeyLabels[capability.capability_key] ?? capability.capability_key.replaceAll("_", " ");

  return (
    <div className={cn("rounded-lg border p-3", stateClass)}>
      <div className="text-xs font-medium">{label}</div>
      <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
        {capability.raw_error || capability.evidence || capability.state}
      </p>
      <div className="mt-2 text-[11px] text-muted-foreground">{timeAgoET(capability.checked_at)}</div>
    </div>
  );
}

function JobCard({ job }: { job: ResolutionJob }) {
  const label = jobTypeLabels[job.job_type] ?? job.job_type.replaceAll("_", " ");
  const statusClass =
    job.status === "failed"
      ? "text-critical"
      : job.status === "running" || job.status === "queued"
        ? "text-blue-500"
        : "text-muted-foreground";

  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="text-xs font-medium">{label}</div>
      <div className={cn("mt-1 text-xs", statusClass)}>
        {job.status}
        {job.attempts > 1 ? ` · attempt ${job.attempts}` : ""}
      </div>
      {job.last_error && (
        <p className="mt-1 whitespace-pre-wrap text-xs text-critical">{job.last_error}</p>
      )}
      <div className="mt-2 text-[11px] text-muted-foreground">{timeAgoET(job.updated_at)}</div>
    </div>
  );
}

function StageRunCard({ run }: { run: ResolutionStageRun }) {
  const [expanded, setExpanded] = useState(false);
  const stateClass =
    run.status === "failed"
      ? "border-critical/20 bg-critical/5"
      : run.status === "running"
        ? "border-primary/20 bg-primary/5"
        : "border-border bg-background";
  const label = stageKeyLabels[run.stage_key] ?? run.stage_key.replaceAll("_", " ");
  const effectiveReasoning =
    typeof run.input_summary?.effective_reasoning === "string"
      ? run.input_summary.effective_reasoning
      : null;
  const sessionMode =
    typeof run.input_summary?.session_mode === "string"
      ? run.input_summary.session_mode
      : null;
  const overrideModel =
    typeof run.input_summary?.override_model === "string"
      ? run.input_summary.override_model
      : null;
  const overrideReasoning =
    typeof run.input_summary?.override_reasoning === "string"
      ? run.input_summary.override_reasoning
      : null;
  const overrideModelActive = Boolean(run.input_summary?.override_model_active);
  const overrideReasoningActive = Boolean(run.input_summary?.override_reasoning_active);
  const inputEntries = Object.entries(run.input_summary ?? {}).slice(0, 8);
  const outputEntries = Object.entries(run.output ?? {}).slice(0, 8);

  return (
    <div className={cn("rounded-lg border p-3", stateClass)}>
      <div className="flex items-start justify-between gap-3">
        <div className="text-xs font-medium">{label}</div>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="text-[11px] text-muted-foreground hover:text-foreground"
        >
          {expanded ? "Hide details" : "Show details"}
        </button>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {run.status}
        {run.model_tier ? ` · ${run.model_tier}` : ""}
        {run.model_name ? ` · ${run.model_name}` : ""}
      </div>
      {(sessionMode || effectiveReasoning || overrideModelActive || overrideReasoningActive) && (
        <div className="mt-1 text-[11px] text-muted-foreground">
          {sessionMode ? `mode ${sessionMode}` : ""}
          {sessionMode && effectiveReasoning ? " · " : ""}
          {effectiveReasoning ? `reasoning ${effectiveReasoning}` : ""}
          {(sessionMode || effectiveReasoning) && (overrideModelActive || overrideReasoningActive) ? " · " : ""}
          {overrideModelActive ? `model override ${overrideModel ?? "active"}` : ""}
          {overrideModelActive && overrideReasoningActive ? " · " : ""}
          {overrideReasoningActive ? `reasoning override ${overrideReasoning ?? "active"}` : ""}
        </div>
      )}
      {run.error_text && (
        <p className="mt-1 whitespace-pre-wrap text-xs text-critical">{run.error_text}</p>
      )}
      {expanded && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-border/70 bg-background p-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Input summary</div>
            <div className="mt-2 space-y-1">
              {inputEntries.length === 0 ? (
                <div className="text-[11px] text-muted-foreground">No recorded summary.</div>
              ) : (
                inputEntries.map(([key, value]) => (
                  <div key={key} className="text-[11px] text-muted-foreground">
                    <span className="font-medium text-foreground">{key}:</span> {typeof value === "string" ? value : JSON.stringify(value)}
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="rounded-md border border-border/70 bg-background p-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Output summary</div>
            <div className="mt-2 space-y-1">
              {outputEntries.length === 0 ? (
                <div className="text-[11px] text-muted-foreground">No recorded output.</div>
              ) : (
                outputEntries.map(([key, value]) => (
                  <div key={key} className="text-[11px] text-muted-foreground">
                    <span className="font-medium text-foreground">{key}:</span> {typeof value === "string" ? value : JSON.stringify(value)}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
      <div className="mt-2 text-[11px] text-muted-foreground">{timeAgoET(run.created_at)}</div>
    </div>
  );
}

function ActionPanel({
  steps,
  loading,
  onApprove,
  onReject,
}: {
  steps: ResolutionStep[];
  loading: boolean;
  onApprove: (ids: string[]) => void;
  onReject: (ids: string[]) => void;
}) {
  return (
    <div className="rounded-xl border border-warning/20 bg-warning/5 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Wrench className="h-4 w-4 text-warning" />
        <h3 className="text-sm font-semibold">Actions pending your approval</h3>
      </div>
      <div className="space-y-3">
        {steps.map((step) => (
          <div key={step.id} className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="text-sm font-medium">{step.summary}</div>
                <div className="text-xs text-muted-foreground">
                  {step.target} · {step.tool_name} · risk {step.risk}
                </div>
                <p className="text-sm text-muted-foreground">{step.reason}</p>
                <p className="text-xs text-muted-foreground">
                  Expected outcome: {step.expected_outcome}
                </p>
                {step.rollback_plan && (
                  <p className="text-xs text-muted-foreground">Rollback: {step.rollback_plan}</p>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => onApprove([step.id])}
                  disabled={loading}
                  className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  Approve
                </button>
                <button
                  onClick={() => onReject([step.id])}
                  disabled={loading}
                  className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            </div>
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                Exact command
              </summary>
              <pre className="mt-2 whitespace-pre-wrap rounded-md bg-black/90 p-3 text-xs text-white/85">
                {step.command_preview}
              </pre>
            </details>
          </div>
        ))}
      </div>
    </div>
  );
}

function ActionRequiredBanner({
  step,
  latestAgentMessage,
  loading,
  onApprove,
  onReject,
}: {
  step: ResolutionStep;
  latestAgentMessage: string | null;
  loading: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="rounded-xl border border-warning/30 bg-warning/5 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-3">
          <div className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-warning" />
            <h3 className="text-sm font-semibold">Your approval needed</h3>
          </div>
          <div className="rounded-lg border border-warning/20 bg-warning/10 p-3">
            <p className="text-sm font-semibold">{step.summary}</p>
            <p className="mt-2 text-sm text-muted-foreground">{step.reason}</p>
            <div className="mt-2 text-xs text-muted-foreground">
              {step.target} · {step.tool_name} · risk {step.risk}
            </div>
          </div>
          {latestAgentMessage && (
            <div className="rounded-lg border border-border bg-card p-3">
              <p className="whitespace-pre-wrap text-sm">{latestAgentMessage}</p>
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          <button
            onClick={onApprove}
            disabled={loading}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Approve
          </button>
          <button
            onClick={onReject}
            disabled={loading}
            className="rounded-md border border-border bg-card px-4 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}

function NeedsInputPanel({
  nextStep,
  latestAgentMessage,
}: {
  nextStep: string;
  latestAgentMessage: string | null;
}) {
  return (
    <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
      <div className="mb-2 flex items-center gap-2">
        <MessageSquare className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">Agent has a question for you</h3>
      </div>
      <p className="text-sm text-muted-foreground">
        {nextStep || "The agent needs more information before it can continue. Reply below."}
      </p>
      {latestAgentMessage && (
        <div className="mt-3 rounded-lg border border-border bg-card p-3">
          <p className="whitespace-pre-wrap text-sm">{latestAgentMessage}</p>
        </div>
      )}
    </div>
  );
}

function EscalationBanner({
  escalation,
  activeSessionMetrics,
  loading,
  onApprove,
}: {
  escalation: ResolutionEscalationEvent;
  activeSessionMetrics: {
    messages: number;
    evidence: number;
    actions: number;
    ageHours: number;
  } | null;
  loading: boolean;
  onApprove: () => void;
}) {
  const title =
    escalation.kind === "deep_mode_switch"
      ? "Agent requests Deep investigation mode"
      : escalation.kind === "expanded_context"
        ? "Agent requests a context rebase"
        : escalation.kind === "higher_reasoning"
          ? "Agent requests higher reasoning effort"
          : escalation.kind === "stronger_model"
            ? "Agent requests a stronger model"
        : "Agent requests escalation";

  const description =
    escalation.kind === "deep_mode_switch"
      ? "This issue now looks ambiguous enough that a larger context and stronger reasoning budget should help."
      : escalation.kind === "expanded_context"
        ? "The active working context is crowded enough that a fresh session would likely improve accuracy."
        : escalation.kind === "higher_reasoning"
          ? `The current reasoning level looks too low for this ambiguity${escalation.estimated_cost != null ? ` and should cost about $${escalation.estimated_cost.toFixed(3)} extra for the next turn.` : "."}`
          : escalation.kind === "stronger_model"
            ? `The current model is probably the limiting factor now${escalation.estimated_cost != null ? ` and the proposed upgrade should cost about $${escalation.estimated_cost.toFixed(3)} extra for the next turn.` : "."}`
        : escalation.decision_reason ?? "The agent requested a runtime escalation.";

  const buttonLabel =
    escalation.kind === "deep_mode_switch"
      ? "Switch To Deep Mode"
      : escalation.kind === "expanded_context"
        ? "Rebase Context"
        : escalation.kind === "higher_reasoning"
          ? "Raise Reasoning"
          : escalation.kind === "stronger_model"
            ? "Approve Model Upgrade"
        : "Approve Escalation";

  return (
    <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <h3 className="text-sm font-semibold">{title}</h3>
          </div>
          <p className="text-sm text-muted-foreground">{description}</p>
          {escalation.decision_reason && (
            <p className="mt-2 text-xs text-muted-foreground">{escalation.decision_reason}</p>
          )}
          {activeSessionMetrics && escalation.kind === "expanded_context" && (
            <p className="mt-2 text-xs text-muted-foreground">
              Current session: {activeSessionMetrics.messages} messages, {activeSessionMetrics.evidence} evidence items, {activeSessionMetrics.actions} actions, age {activeSessionMetrics.ageHours.toFixed(1)}h.
            </p>
          )}
          {(escalation.to_model || escalation.to_reasoning) && escalation.kind !== "expanded_context" && (
            <p className="mt-2 text-xs text-muted-foreground">
              {escalation.to_model ? `Target model: ${escalation.to_model}` : ""}
              {escalation.to_model && escalation.to_reasoning ? " · " : ""}
              {escalation.to_reasoning ? `Target reasoning: ${escalation.to_reasoning}` : ""}
            </p>
          )}
        </div>
        <button
          onClick={onApprove}
          disabled={loading}
          className="shrink-0 inline-flex items-center gap-2 rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50"
        >
          {buttonLabel}
        </button>
      </div>
    </div>
  );
}

function ApprovalMismatchPanel({
  onContinue,
  loading,
}: {
  onContinue: () => void;
  loading: boolean;
}) {
  return (
    <div className="rounded-xl border border-warning/20 bg-warning/5 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-warning" />
            <h3 className="text-sm font-semibold">Investigation paused</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            The agent stopped before completing its recommendation. Click Continue to resume.
          </p>
        </div>
        <button
          onClick={onContinue}
          disabled={loading}
          className="shrink-0 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Continue
        </button>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ResolutionMessage }) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  return (
    <div
      className={cn(
        "rounded-xl border p-3",
        isUser
          ? "ml-8 border-primary/20 bg-primary/5"
          : isSystem
            ? "border-border bg-muted/40"
            : "mr-8 border-border bg-background"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {isUser ? "You" : isSystem ? "System" : "Agent"}
        </span>
        <span className="text-[11px] text-muted-foreground">{formatETFull(message.created_at)}</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm">{message.content}</p>
    </div>
  );
}

function IssueListItem({
  resolution,
  active,
  onClick,
  onDelete,
}: {
  resolution: Resolution;
  active: boolean;
  onClick: () => void;
  onDelete: () => void;
}) {
  const dotConfig = statusDotConfig[resolution.status];
  const sevConfig = severityConfig[resolution.severity];

  return (
    <div
      className={cn(
        "group rounded-lg border p-3 transition-colors",
        active ? "border-primary/30 bg-primary/5" : "border-border bg-background hover:border-primary/20"
      )}
    >
      <button onClick={onClick} className="w-full text-left">
        <div className="flex items-start gap-2">
          <span
            className={cn(
              "mt-1.5 h-2 w-2 shrink-0 rounded-full",
              dotConfig.color,
              dotConfig.pulse && "animate-pulse"
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-1">
              <span className="text-sm font-medium leading-snug">{resolution.title}</span>
              <span className={cn("shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium", sevConfig.badge)}>
                {resolution.severity}
              </span>
            </div>
            {resolution.summary && (
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{resolution.summary}</p>
            )}
            <div className="mt-1.5 text-[11px] text-muted-foreground">
              {dotConfig.label} · {timeAgoET(resolution.updated_at)}
            </div>
          </div>
        </div>
      </button>
      <button
        onClick={onDelete}
        className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:text-critical group-hover:opacity-100"
      >
        <Trash2 className="h-3 w-3" />
        Delete
      </button>
    </div>
  );
}

// ─── Forensic Incident Explainer Panel ────────────────────────────────────────

/**
 * Shown when Drive / Backup forensic facts are present.
 * Provides a unified plain-English incident explanation without requiring
 * the operator to read raw logs.
 */
function ForensicIncidentPanel({ facts }: { facts: ResolutionFact[] }) {
  const [expanded, setExpanded] = useState(false);

  const attribution = facts.find((f) => f.fact_type === "forensic_drive_attribution");
  const classification = facts.find((f) => f.fact_type === "forensic_drive_classification");
  const backupTimeline = facts.find((f) => f.fact_type === "forensic_backup_timeline");

  if (!attribution && !classification && !backupTimeline) return null;

  const devices = (attribution?.value?.devices as string[] | undefined) ?? [];
  const users = (attribution?.value?.users as string[] | undefined) ?? [];
  const matchRate = (classification?.value?.match_rate as number | undefined) ?? null;
  const classificationKind = (classification?.value?.classification as string | undefined) ?? null;
  const backupSucceededButCleanupFailed =
    (backupTimeline?.value?.cleanup_unhealthy as boolean | undefined) ?? false;

  const incidentClassification = (() => {
    if (backupTimeline && classification) return "Hyper Backup cleanup failure driven by Drive reorganization";
    if (backupTimeline) return "Hyper Backup cleanup failure";
    if (classification) return "Synology Drive reorganization";
    return "Drive / storage incident";
  })();

  const likelyCause = (() => {
    const parts: string[] = [];
    if (classificationKind === "restructure_likely") {
      parts.push(
        `A large Synology Drive reorganization caused ${
          matchRate !== null ? `${Math.round(matchRate * 100)}%` : "most"
        } of the observed deletes to be moves or replacements, not true deletions.`,
      );
    } else if (classificationKind === "destructive_delete_likely") {
      parts.push("A significant portion of the observed deletes appear to be true deletions without matching replacements.");
    } else if (classificationKind) {
      parts.push("The observed deletes are a mix of moves/replacements and true deletions.");
    }
    if (backupSucceededButCleanupFailed) {
      parts.push(
        "Hyper Backup finished the backup itself, but got stuck deleting old versions after the Drive reorganization.",
      );
    }
    return parts.join(" ");
  })();

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
      <button
        className="flex w-full items-start justify-between gap-2 text-left"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
              Forensic Analysis
            </span>
          </div>
          <h3 className="mt-2 text-sm font-semibold">{incidentClassification}</h3>
          {!expanded && likelyCause && (
            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{likelyCause}</p>
          )}
        </div>
        {expanded ? (
          <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <div className="mt-4 space-y-3 border-t border-amber-500/20 pt-3">
          {/* Likely cause explanation */}
          {likelyCause && (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                What likely happened
              </div>
              <p className="text-xs leading-relaxed">{likelyCause}</p>
            </div>
          )}

          {/* Drive churn summary */}
          {(attribution || classification) && (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Drive churn summary
              </div>
              {devices.length > 0 && (
                <p className="text-xs">
                  <span className="font-medium">Clients involved: </span>
                  {devices.slice(0, 6).join(", ")}
                  {devices.length > 6 ? ` +${devices.length - 6} more` : ""}
                </p>
              )}
              {users.length > 0 && (
                <p className="mt-0.5 text-xs">
                  <span className="font-medium">Users: </span>
                  {users.join(", ")}
                </p>
              )}
              {classification && (
                <p className="mt-0.5 text-xs text-muted-foreground">{classification.title}</p>
              )}
            </div>
          )}

          {/* Backup cleanup state */}
          {backupTimeline && (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Backup cleanup state
              </div>
              <p className="text-xs">{backupTimeline.title}</p>
              <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                {backupTimeline.detail}
              </p>
            </div>
          )}

          {/* Restructure clarification */}
          {classificationKind === "restructure_likely" && (
            <div className="rounded-md bg-background px-3 py-2">
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Not a one-way wipe: </span>
                Most of the delete activity matches moves or replacements, so this does not look
                like random corruption or destructive data loss.
              </p>
            </div>
          )}

          {/* Recommended next step */}
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Recommended next step
            </div>
            <p className="text-xs text-muted-foreground">
              {backupSucceededButCleanupFailed
                ? "Wait for Hyper Backup cleanup to complete naturally, or use DSM to cancel and restart the stuck task. High I/O should subside once version cleanup finishes."
                : classification
                  ? "Verify Drive sync is now idle and no further reorganization is in progress. Check whether any conflict files need manual resolution."
                  : "Investigate the storage pressure source and monitor iowait as the activity subsides."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
