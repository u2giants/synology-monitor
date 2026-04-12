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
  Send,
  Trash2,
  Wrench,
  XCircle,
} from "lucide-react";
import { cn, formatETFull, timeAgo } from "@/lib/utils";
import {
  useResolution,
  type Resolution,
  type ResolutionCapability,
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Issue Investigator</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The AI agent diagnoses NAS problems, gathers evidence, and asks for your approval before making any changes.
        </p>
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
                onCancel={cancelResolution}
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
  onCancel,
}: {
  state: ResolutionFull;
  loading: boolean;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const status = state.resolution.status;
  const dotConfig = statusDotConfig[status];
  const sevConfig = severityConfig[state.resolution.severity];

  const isOpenOrStuck = status === "open" || status === "stuck";
  const isTerminal = status === "resolved" || status === "cancelled";

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
          </div>
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
    state.transitions.length > 0;

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
                <div className="mt-1 text-[11px] text-muted-foreground">{timeAgo(entry.created_at)}</div>
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
                          {timeAgo(transition.created_at)}
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
        {fact.fact_type} · {timeAgo(fact.observed_at)}
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
      <div className="mt-2 text-[11px] text-muted-foreground">{timeAgo(capability.checked_at)}</div>
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
      <div className="mt-2 text-[11px] text-muted-foreground">{timeAgo(job.updated_at)}</div>
    </div>
  );
}

function StageRunCard({ run }: { run: ResolutionStageRun }) {
  const stateClass =
    run.status === "failed"
      ? "border-critical/20 bg-critical/5"
      : run.status === "running"
        ? "border-primary/20 bg-primary/5"
        : "border-border bg-background";
  const label = stageKeyLabels[run.stage_key] ?? run.stage_key.replaceAll("_", " ");

  return (
    <div className={cn("rounded-lg border p-3", stateClass)}>
      <div className="text-xs font-medium">{label}</div>
      <div className="mt-1 text-xs text-muted-foreground">
        {run.status}
        {run.model_tier ? ` · ${run.model_tier}` : ""}
        {run.model_name ? ` · ${run.model_name}` : ""}
      </div>
      {run.error_text && (
        <p className="mt-1 whitespace-pre-wrap text-xs text-critical">{run.error_text}</p>
      )}
      <div className="mt-2 text-[11px] text-muted-foreground">{timeAgo(run.created_at)}</div>
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
              {dotConfig.label} · {timeAgo(resolution.updated_at)}
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
