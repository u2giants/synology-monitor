"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
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
  type ResolutionStep,
} from "@/hooks/use-resolution";

const severityConfig = {
  critical: { icon: AlertTriangle, className: "text-critical", badge: "bg-critical/10 text-critical border-critical/20" },
  warning: { icon: AlertTriangle, className: "text-warning", badge: "bg-warning/10 text-warning border-warning/20" },
  info: { icon: CheckCircle2, className: "text-primary", badge: "bg-primary/10 text-primary border-primary/20" },
};

const statusLabels: Record<Resolution["status"], string> = {
  open: "Open",
  running: "Working",
  waiting_on_user: "Waiting on you",
  waiting_for_approval: "Awaiting approval",
  resolved: "Resolved",
  stuck: "Blocked",
  cancelled: "Cancelled",
};

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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Issue Agent</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          One persistent conversation per issue. The agent owns the diagnosis, remembers every result, and asks for approval only when it has one exact action to run.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-critical/30 bg-critical/5 p-3 text-sm text-critical">
          {error}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <aside className="space-y-3">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Issue Threads</h2>
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
                  placeholder="Issue title"
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none"
                />
                <textarea
                  value={newDescription}
                  onChange={(event) => setNewDescription(event.target.value)}
                  placeholder="What do you know so far?"
                  className="min-h-20 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none"
                />
                <button
                  onClick={handleCreate}
                  disabled={loading || !newTitle.trim()}
                  className="w-full rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  Start issue
                </button>
              </div>
            )}

            {resolutions.length === 0 ? (
              <div className="text-xs text-muted-foreground">
                No issue threads yet. Create one manually or run issue detection from the dashboard.
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

        <section className="space-y-4">
          {!current ? (
            <div className="rounded-xl border border-dashed border-border p-12 text-center text-muted-foreground">
              <Bot className="mx-auto mb-3 h-10 w-10 opacity-40" />
              <p className="text-sm">Select an issue thread or create a new one.</p>
            </div>
          ) : (
            <>
              <IssueHeader
                state={current}
                loading={loading}
                onContinue={continueResolution}
                onCancel={cancelResolution}
              />

              {pendingActions.length > 0 && (
                <ActionPanel
                  steps={pendingActions}
                  loading={loading}
                  onApprove={(ids) => approveSteps(ids, "approve")}
                  onReject={(ids) => approveSteps(ids, "reject")}
                />
              )}

              <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
                <div className="rounded-xl border border-border bg-card p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <MessageSquare className="h-4 w-4 text-muted-foreground" />
                    <h2 className="text-sm font-semibold">Conversation</h2>
                  </div>

                  <div className="space-y-3">
                    {current.messages.map((message) => (
                      <MessageBubble key={message.id} message={message} />
                    ))}
                  </div>

                  <div className="mt-4 flex gap-2">
                    <textarea
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      placeholder="Reply to this issue thread..."
                      className="min-h-24 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
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

                <IssueSidebar state={current} />
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

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
  const config = severityConfig[state.resolution.severity];
  const Icon = config.icon;

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Icon className={cn("h-5 w-5", config.className)} />
            <h2 className="text-lg font-semibold">{state.resolution.title}</h2>
            <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", config.badge)}>
              {state.resolution.severity}
            </span>
            <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
              {statusLabels[state.resolution.status]}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">{state.resolution.summary}</p>
          {state.resolution.affected_nas.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Affects: {state.resolution.affected_nas.join(", ")}
            </p>
          )}
        </div>

        <div className="flex gap-2">
          <button
            onClick={onContinue}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <Play className="h-4 w-4" />
            Continue
          </button>
          {state.resolution.status !== "resolved" && state.resolution.status !== "cancelled" && (
            <button
              onClick={onCancel}
              disabled={loading}
              className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground hover:text-critical disabled:opacity-50"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function IssueSidebar({ state }: { state: ResolutionFull }) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="text-sm font-semibold">Working Theory</h3>
        <p className="mt-2 text-sm">{state.resolution.current_hypothesis || "No stable hypothesis yet."}</p>
        <div className="mt-3 text-xs text-muted-foreground">
          Confidence: {state.resolution.hypothesis_confidence}
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          Next step: {state.resolution.next_step || "Awaiting next agent step."}
        </div>
      </div>

      {state.resolution.operator_constraints.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">Operator Constraints</h3>
          <div className="mt-2 space-y-2">
            {state.resolution.operator_constraints.map((constraint) => (
              <div key={constraint} className="rounded-md bg-muted px-3 py-2 text-xs">
                {constraint}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="text-sm font-semibold">Normalized Facts</h3>
        <div className="mt-3 space-y-2">
          {state.facts.length === 0 ? (
            <div className="text-xs text-muted-foreground">No normalized facts attached yet.</div>
          ) : (
            state.facts.slice(0, 8).map((fact) => (
              <FactCard key={fact.id} fact={fact} />
            ))
          )}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="text-sm font-semibold">Capability Gaps</h3>
        <div className="mt-3 space-y-2">
          {state.capabilities.filter((capability) => capability.state !== "supported").length === 0 ? (
            <div className="text-xs text-muted-foreground">No known telemetry capability gaps for this issue.</div>
          ) : (
            state.capabilities
              .filter((capability) => capability.state !== "supported")
              .slice(0, 8)
              .map((capability) => (
                <CapabilityCard key={capability.id} capability={capability} />
              ))
          )}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="text-sm font-semibold">Workflow State</h3>
        <div className="mt-3 space-y-2">
          {state.jobs.length === 0 ? (
            <div className="text-xs text-muted-foreground">No queued workflow jobs yet.</div>
          ) : (
            state.jobs.slice(0, 6).map((job) => (
              <JobCard key={job.id} job={job} />
            ))
          )}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <h3 className="text-sm font-semibold">Evidence Timeline</h3>
        <div className="mt-3 space-y-2">
          {state.log.length === 0 ? (
            <div className="text-xs text-muted-foreground">No evidence captured yet.</div>
          ) : (
            state.log.slice(-8).reverse().map((entry) => (
              <div key={entry.id} className="rounded-lg border border-border bg-background p-3">
                <div className="text-xs font-medium">{entry.title}</div>
                <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">{entry.detail}</p>
                <div className="mt-2 text-[11px] text-muted-foreground">{timeAgo(entry.created_at)}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function FactCard({ fact }: { fact: ResolutionFact }) {
  const severityClass = fact.severity === "critical"
    ? "border-critical/20 bg-critical/5"
    : fact.severity === "warning"
      ? "border-warning/20 bg-warning/5"
      : "border-primary/20 bg-primary/5";

  return (
    <div className={cn("rounded-lg border p-3", severityClass)}>
      <div className="text-xs font-medium">{fact.title}</div>
      <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">{fact.detail}</p>
      <div className="mt-2 text-[11px] text-muted-foreground">
        {fact.fact_type} · {timeAgo(fact.observed_at)}
      </div>
    </div>
  );
}

function CapabilityCard({ capability }: { capability: ResolutionCapability }) {
  const stateClass = capability.state === "unsupported"
    ? "border-critical/20 bg-critical/5"
    : "border-warning/20 bg-warning/5";

  return (
    <div className={cn("rounded-lg border p-3", stateClass)}>
      <div className="text-xs font-medium">{capability.capability_key}</div>
      <p className="mt-1 text-xs text-muted-foreground">{capability.state}</p>
      <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">{capability.raw_error || capability.evidence}</p>
      <div className="mt-2 text-[11px] text-muted-foreground">{timeAgo(capability.checked_at)}</div>
    </div>
  );
}

function JobCard({ job }: { job: ResolutionJob }) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="text-xs font-medium">{job.job_type}</div>
      <div className="mt-1 text-xs text-muted-foreground">
        {job.status} · attempt {job.attempts}
      </div>
      {job.last_error && (
        <p className="mt-1 text-xs text-critical whitespace-pre-wrap">{job.last_error}</p>
      )}
      <div className="mt-2 text-[11px] text-muted-foreground">{timeAgo(job.updated_at)}</div>
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
        <h3 className="text-sm font-semibold">Pending approval</h3>
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
                <p className="text-xs text-muted-foreground">Expected outcome: {step.expected_outcome}</p>
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
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {isUser ? "You" : isSystem ? "System" : "Agent"}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {formatETFull(message.created_at)}
        </span>
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
  const config = severityConfig[resolution.severity];
  const Icon = config.icon;

  return (
    <div
      className={cn(
        "group rounded-lg border p-3 transition-colors",
        active ? "border-primary/30 bg-primary/5" : "border-border bg-background hover:border-primary/20"
      )}
    >
      <button onClick={onClick} className="w-full text-left">
        <div className="flex items-start gap-2">
          <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", config.className)} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{resolution.title}</span>
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            </div>
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{resolution.summary}</p>
            <div className="mt-2 text-[11px] text-muted-foreground">
              {statusLabels[resolution.status]} · {timeAgo(resolution.updated_at)}
            </div>
          </div>
        </div>
      </button>
      <button
        onClick={onDelete}
        className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-critical"
      >
        <Trash2 className="h-3 w-3" />
        Delete
      </button>
    </div>
  );
}
