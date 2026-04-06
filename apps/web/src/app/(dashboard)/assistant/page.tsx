"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  Bot,
  Loader2,
  Plus,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Send,
  ToggleLeft,
  ToggleRight,
  Trash2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";
import {
  useResolution,
  type Resolution,
  type ResolutionFull,
  type ResolutionMessage,
} from "@/hooks/use-resolution";
import { PhaseStepper } from "@/components/resolution/phase-stepper";
import { PendingActions } from "@/components/resolution/pending-actions";
import { ActivityLog } from "@/components/resolution/activity-log";

const severityConfig = {
  critical: { icon: AlertTriangle, className: "text-critical" },
  warning: { icon: AlertTriangle, className: "text-warning" },
  info: { icon: CheckCircle2, className: "text-primary" },
};

export default function AssistantPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const autoCreateDone = useRef(false);

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
    cancelResolution,
    toggleAutoApprove,
    deleteResolution,
  } = useResolution();

  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [contextMessage, setContextMessage] = useState("");
  const [showNewForm, setShowNewForm] = useState(false);
  const [showActivityLog, setShowActivityLog] = useState(false);

  // Load list on mount
  useEffect(() => {
    fetchList();
  }, [fetchList]);

  // Handle URL params for auto-creation
  useEffect(() => {
    if (autoCreateDone.current || loading) return;

    const resolutionId = searchParams.get("resolutionId");
    const problemId = searchParams.get("problemId");
    const alertId = searchParams.get("alertId");

    if (resolutionId) {
      autoCreateDone.current = true;
      loadResolution(resolutionId);
      return;
    }

    if (problemId) {
      autoCreateDone.current = true;
      createResolution({ originType: "problem", originId: problemId }).then((id) => {
        if (id) {
          fetchList();
          router.replace(`/assistant?resolutionId=${id}`);
        }
      });
      return;
    }

    if (alertId) {
      autoCreateDone.current = true;
      createResolution({ originType: "alert", originId: alertId }).then((id) => {
        if (id) {
          fetchList();
          router.replace(`/assistant?resolutionId=${id}`);
        }
      });
    }
  }, [searchParams, loading]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleCreate() {
    if (!newTitle.trim()) return;
    const id = await createResolution({
      originType: "manual",
      title: newTitle.trim(),
      description: newDescription.trim() || newTitle.trim(),
    });
    if (id) {
      setNewTitle("");
      setNewDescription("");
      setShowNewForm(false);
      fetchList();
      router.replace(`/assistant?resolutionId=${id}`);
    }
  }

  async function handleSendContext() {
    if (!contextMessage.trim()) return;
    await sendMessage(contextMessage.trim());
    setContextMessage("");
  }

  const pendingDiagnosticSteps = current?.steps.filter(
    (s) => s.category === "diagnostic" && ["planned", "approved", "running", "completed", "failed"].includes(s.status)
  ) ?? [];

  const pendingFixSteps = current?.steps.filter((s) => s.category === "fix") ?? [];
  const verificationSteps = current?.steps.filter((s) => s.category === "verification") ?? [];
  const phase = current?.resolution.phase ?? "";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">NAS Issue Resolution</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            AI agent that diagnoses and fixes NAS problems end-to-end.
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-critical/30 bg-critical/5 p-3 text-sm text-critical">
          {error}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
        {/* Left sidebar */}
        <aside className="space-y-3">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h2 className="text-sm font-semibold">Issues</h2>
              <button
                onClick={() => setShowNewForm(!showNewForm)}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
                New
              </button>
            </div>

            {showNewForm && (
              <div className="space-y-2 mb-3 p-3 rounded-lg border border-border bg-background">
                <input
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="What's the problem?"
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none"
                />
                <textarea
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder="More details (optional)..."
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm min-h-16 focus:border-primary focus:outline-none"
                />
                <button
                  onClick={handleCreate}
                  disabled={loading || !newTitle.trim()}
                  className="w-full rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin mx-auto" /> : "Start Resolution"}
                </button>
              </div>
            )}

            {resolutions.length === 0 ? (
              <div className="text-xs text-muted-foreground">
                No issues yet. Click New to report a problem, or use "Fix this" on the dashboard.
              </div>
            ) : (
              <div className="space-y-1.5 max-h-[60vh] overflow-y-auto">
                {resolutions.map((r) => (
                  <ResolutionListItem
                    key={r.id}
                    resolution={r}
                    active={current?.resolution.id === r.id}
                    onClick={() => {
                      loadResolution(r.id);
                      router.replace(`/assistant?resolutionId=${r.id}`);
                    }}
                    onDelete={() => {
                      deleteResolution(r.id);
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
              <Bot className="h-10 w-10 mx-auto mb-3 opacity-40" />
              <p className="text-sm">Select an issue from the sidebar, or create a new one.</p>
              <p className="text-xs mt-1">You can also click "Fix this" on the dashboard problems list.</p>
            </div>
          ) : (
            <>
              {/* Header: title + controls */}
              <div className="rounded-xl border border-border bg-card p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      {(() => {
                        const sev = severityConfig[current.resolution.severity];
                        const Icon = sev.icon;
                        return <Icon className={cn("h-5 w-5", sev.className)} />;
                      })()}
                      <h2 className="text-lg font-semibold">{current.resolution.title}</h2>
                    </div>
                    {current.resolution.affected_nas.length > 0 && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Affects: {current.resolution.affected_nas.join(", ")}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => toggleAutoApprove(!current.resolution.auto_approve_reads)}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      title="Auto-approve read-only diagnostics"
                    >
                      {current.resolution.auto_approve_reads ? (
                        <ToggleRight className="h-4 w-4 text-primary" />
                      ) : (
                        <ToggleLeft className="h-4 w-4" />
                      )}
                      Auto-diag
                    </button>
                    {phase !== "resolved" && phase !== "cancelled" && (
                      <button
                        onClick={cancelResolution}
                        className="text-xs text-muted-foreground hover:text-critical"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
                <PhaseStepper currentPhase={phase} />
              </div>

              {/* Chat thread — the primary interface */}
              <ChatThread
                current={current}
                loading={loading}
                contextMessage={contextMessage}
                onContextMessageChange={setContextMessage}
                onSend={handleSendContext}
                phase={phase}
              />

              {/* Pending actions */}
              {(phase === "diagnosing" || phase === "analyzing") && pendingDiagnosticSteps.length > 0 && (
                <div className="rounded-xl border border-border bg-card p-4">
                  <h3 className="text-sm font-semibold mb-3">Diagnostic Steps</h3>
                  <PendingActions
                    steps={pendingDiagnosticSteps}
                    loading={loading}
                    onApprove={(ids) => approveSteps(ids, "approve")}
                    onReject={(ids) => approveSteps(ids, "reject")}
                  />
                </div>
              )}

              {(phase === "awaiting_fix_approval" || phase === "applying_fix") && pendingFixSteps.length > 0 && (
                <div className="rounded-xl border border-border bg-card p-4">
                  <h3 className="text-sm font-semibold mb-3">Fix Actions</h3>
                  <PendingActions
                    steps={pendingFixSteps}
                    loading={loading}
                    onApprove={(ids) => approveSteps(ids, "approve")}
                    onReject={(ids) => approveSteps(ids, "reject")}
                  />
                </div>
              )}

              {phase === "verifying" && verificationSteps.length > 0 && (
                <div className="rounded-xl border border-border bg-card p-4">
                  <h3 className="text-sm font-semibold mb-3">Verification</h3>
                  <PendingActions
                    steps={verificationSteps}
                    loading={loading}
                    onApprove={(ids) => approveSteps(ids, "approve")}
                    onReject={(ids) => approveSteps(ids, "reject")}
                  />
                </div>
              )}

              {/* Activity log — collapsed by default */}
              <div className="rounded-xl border border-border bg-card">
                <button
                  onClick={() => setShowActivityLog(!showActivityLog)}
                  className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold hover:bg-muted/30 rounded-xl"
                >
                  <span>Technical Details</span>
                  {showActivityLog ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                </button>
                {showActivityLog && (
                  <div className="px-4 pb-4">
                    <ActivityLog entries={current.log} />
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function ChatThread({
  current,
  loading,
  contextMessage,
  onContextMessageChange,
  onSend,
  phase,
}: {
  current: ResolutionFull;
  loading: boolean;
  contextMessage: string;
  onContextMessageChange: (v: string) => void;
  onSend: () => void;
  phase: string;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const messages = current.messages ?? [];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const isFinished = phase === "resolved" || phase === "cancelled";
  const isWorking = ["planning", "diagnosing", "analyzing", "proposing_fix", "applying_fix", "verifying"].includes(phase);

  return (
    <div className="rounded-xl border border-border bg-card flex flex-col">
      {/* Message list */}
      <div className="flex flex-col gap-3 p-4 min-h-[200px] max-h-[520px] overflow-y-auto">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-24 text-sm text-muted-foreground">
            {isWorking ? (
              <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Agent is working...</span>
            ) : (
              <span>Conversation will appear here as the agent works through the issue.</span>
            )}
          </div>
        ) : (
          messages.map((msg) => (
            <ChatBubble key={msg.id} message={msg} />
          ))
        )}
        {/* Typing indicator when agent is actively working */}
        {isWorking && messages.length > 0 && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>Agent is working...</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Message input */}
      {!isFinished && (
        <div className="border-t border-border p-3 flex gap-2">
          <input
            value={contextMessage}
            onChange={(e) => onContextMessageChange(e.target.value)}
            placeholder={
              phase === "stuck"
                ? "Provide additional info to help the agent try again..."
                : phase === "awaiting_fix_approval"
                ? "Reject the fix above, or type to redirect the agent..."
                : "Ask a question, push back, or add context..."
            }
            className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } }}
            disabled={loading}
          />
          <button
            onClick={onSend}
            disabled={loading || !contextMessage.trim()}
            className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

function ChatBubble({ message }: { message: ResolutionMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      {!isUser && (
        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center mr-2 mt-0.5">
          <Bot className="h-4 w-4 text-primary" />
        </div>
      )}
      <div className={cn(
        "max-w-[80%] rounded-2xl px-4 py-2.5 text-sm",
        isUser
          ? "bg-primary text-primary-foreground rounded-tr-sm"
          : "bg-muted text-foreground rounded-tl-sm"
      )}>
        <p className="whitespace-pre-wrap leading-relaxed">{message.content}</p>
        <p className={cn(
          "text-[10px] mt-1",
          isUser ? "text-primary-foreground/60 text-right" : "text-muted-foreground"
        )}>
          {timeAgo(message.created_at)}
        </p>
      </div>
    </div>
  );
}

function ResolutionListItem({
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
  const phase = resolution.phase;
  const isTerminal = phase === "resolved" || phase === "cancelled";

  return (
    <div className={cn(
      "group relative rounded-lg border transition-colors",
      active
        ? "border-primary bg-primary/5"
        : "border-border bg-background hover:bg-muted/40",
      isTerminal && "opacity-60"
    )}>
      <button
        onClick={onClick}
        className="w-full px-3 py-2 text-left"
      >
        <div className="flex items-center gap-1.5 pr-5">
          {phase === "resolved" ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-primary shrink-0" />
          ) : phase === "stuck" ? (
            <AlertTriangle className="h-3.5 w-3.5 text-critical shrink-0" />
          ) : phase === "cancelled" ? (
            <XCircle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          ) : (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
          )}
          <span className="text-sm font-medium truncate">{resolution.title}</span>
        </div>
        <div className="text-[11px] text-muted-foreground mt-1">
          {phase} · {timeAgo(resolution.updated_at)}
        </div>
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-critical transition-opacity"
        title="Delete issue"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
