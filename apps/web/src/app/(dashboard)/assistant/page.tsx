"use client";

import { useEffect, useMemo, useState } from "react";
import { Bot, LoaderCircle, MessageSquareText, ShieldAlert, Sparkles, Terminal, Wrench } from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";

type ReasoningEffort = "high" | "xhigh";
type Target = "edgesynology1" | "edgesynology2";
type MessageRole = "user" | "assistant" | "tool";
type ActionStatus = "proposed" | "approved" | "running" | "executed" | "failed" | "rejected";

interface ProposedAction {
  id: string;
  title: string;
  target: Target;
  command: string;
  reason: string;
  risk: "low" | "medium" | "high";
  approvalToken: string;
  status?: ActionStatus;
  result?: string;
}

interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  actions?: ProposedAction[];
}

const STORAGE_KEY = "smon-copilot-chat-v1";

function messageTone(role: MessageRole) {
  switch (role) {
    case "assistant":
      return "border-primary/20 bg-primary/5";
    case "tool":
      return "border-amber-500/30 bg-amber-500/5";
    default:
      return "border-border bg-card";
  }
}

function roleIcon(role: MessageRole) {
  switch (role) {
    case "assistant":
      return Bot;
    case "tool":
      return Terminal;
    default:
      return MessageSquareText;
  }
}

export default function AssistantPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("high");

  useEffect(() => {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { messages: ChatMessage[]; reasoningEffort: ReasoningEffort };
      setMessages(parsed.messages ?? []);
      setReasoningEffort(parsed.reasoningEffort ?? "high");
    } catch {
      // ignore corrupt local storage
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ messages, reasoningEffort })
    );
  }, [messages, reasoningEffort]);

  const hasActions = useMemo(
    () => messages.some((message) => (message.actions ?? []).length > 0),
    [messages]
  );

  async function handleSend() {
    if (!prompt.trim() || loading) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt.trim(),
      createdAt: new Date().toISOString(),
    };

    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setPrompt("");
    setLoading(true);

    try {
      const response = await fetch("/api/copilot/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages.map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
          })),
          reasoningEffort,
        }),
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "Copilot request failed.");
      }

      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: payload.answer,
        actions: (payload.proposedActions ?? []).map((action: ProposedAction) => ({
          ...action,
          status: "proposed",
        })),
        createdAt: new Date().toISOString(),
      };

      setMessages((current) => [...current, assistantMessage]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "tool",
          content: error instanceof Error ? error.message : "Failed to reach copilot.",
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function handleAction(messageId: string, actionId: string, decision: "approve" | "reject") {
    setMessages((current) =>
      current.map((message) => {
        if (message.id !== messageId) return message;
        return {
          ...message,
          actions: message.actions?.map((action) =>
            action.id === actionId
              ? {
                  ...action,
                  status: (decision === "reject" ? "rejected" : "running") as ActionStatus,
                }
              : action
          ),
        };
      })
    );

    if (decision === "reject") return;

    const message = messages.find((item) => item.id === messageId);
    const action = message?.actions?.find((item) => item.id === actionId);
    if (!action) return;

    try {
      const response = await fetch("/api/copilot/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: action.target,
          command: action.command,
          approvalToken: action.approvalToken,
        }),
      });

      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? payload.content ?? "Action execution failed.");
      }

      setMessages((current) => {
        const updated = current.map((item) => {
          if (item.id !== messageId) return item;
          return {
            ...item,
            actions: item.actions?.map((candidate) =>
              candidate.id === actionId
                ? {
                    ...candidate,
                    status: "executed" as ActionStatus,
                    result: payload.content,
                  }
                : candidate
            ),
          };
        });

        return [
          ...updated,
          {
            id: crypto.randomUUID(),
            role: "tool",
            content: `Approved action ran on ${action.target}.\n\n${payload.content}`,
            createdAt: new Date().toISOString(),
          },
        ];
      });
    } catch (error) {
      setMessages((current) => {
        const updated = current.map((item) => {
          if (item.id !== messageId) return item;
          return {
            ...item,
            actions: item.actions?.map((candidate) =>
              candidate.id === actionId
                ? {
                    ...candidate,
                    status: "failed" as ActionStatus,
                    result: error instanceof Error ? error.message : "Unknown action failure.",
                  }
                : candidate
            ),
          };
        });

        return [
          ...updated,
          {
            id: crypto.randomUUID(),
            role: "tool",
            content: error instanceof Error ? error.message : "Unknown action failure.",
            createdAt: new Date().toISOString(),
          },
        ];
      });
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">NAS Copilot</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Chat with GPT-5.4 about the two NAS units, inspect current state over Tailscale SSH, and approve individual repair commands when needed.
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5" />
          {hasActions ? "Action approval enabled" : "Read-only until an action is proposed"}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <section className="rounded-xl border border-border bg-card p-4">
          <div className="space-y-3">
            {messages.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                Ask what is happening on the NASes, investigate Drive issues, or request a proposed fix.
              </div>
            ) : (
              messages.map((message) => {
                const Icon = roleIcon(message.role);
                return (
                  <article
                    key={message.id}
                    className={cn("rounded-xl border p-4", messageTone(message.role))}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3">
                        <div className="rounded-lg bg-background/70 p-2">
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="space-y-3">
                          <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">
                            {message.content}
                          </p>

                          {message.actions?.length ? (
                            <div className="space-y-3">
                              {message.actions.map((action) => (
                                <div key={action.id} className="rounded-lg border border-border bg-background/60 p-3">
                                  <div className="flex items-start justify-between gap-3">
                                    <div>
                                      <div className="flex items-center gap-2 text-sm font-medium">
                                        <Wrench className="h-4 w-4 text-primary" />
                                        <span>{action.title}</span>
                                      </div>
                                      <div className="mt-1 text-xs text-muted-foreground">
                                        {action.target} · risk {action.risk}
                                      </div>
                                    </div>
                                    <span className="rounded-full bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                                      {action.status ?? "proposed"}
                                    </span>
                                  </div>
                                  <p className="mt-2 text-sm text-muted-foreground">{action.reason}</p>
                                  <pre className="mt-3 overflow-x-auto rounded-md bg-black/80 p-3 text-xs text-white">
                                    {action.command}
                                  </pre>

                                  {action.result && (
                                    <pre className="mt-3 overflow-x-auto rounded-md bg-muted p-3 text-xs text-foreground">
                                      {action.result}
                                    </pre>
                                  )}

                                  {action.status === "proposed" && (
                                    <div className="mt-3 flex gap-2">
                                      <button
                                        onClick={() => handleAction(message.id, action.id, "approve")}
                                        className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                                      >
                                        Approve
                                      </button>
                                      <button
                                        onClick={() => handleAction(message.id, action.id, "reject")}
                                        className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
                                      >
                                        Reject
                                      </button>
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>

                      <div className="text-right text-xs text-muted-foreground">
                        {timeAgo(message.createdAt)}
                      </div>
                    </div>
                  </article>
                );
              })
            )}
          </div>

          <div className="mt-4 space-y-3 border-t border-border pt-4">
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Ask what is happening on the NASes, request diagnosis, or ask for a proposed fix..."
              className="min-h-28 w-full rounded-lg border border-border bg-background px-3 py-3 text-sm focus:border-primary focus:outline-none"
            />
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <ShieldAlert className="h-4 w-4" />
                Write actions require one-by-one approval.
              </div>
              <button
                onClick={handleSend}
                disabled={loading || !prompt.trim()}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
                Ask Copilot
              </button>
            </div>
          </div>
        </section>

        <aside className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">Reasoning</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              `high` is the normal default. `xhigh` is slower and usually more expensive.
            </p>
            <select
              value={reasoningEffort}
              onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort)}
              className="mt-3 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="high">High</option>
              <option value="xhigh">XHigh</option>
            </select>
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">What It Can Do</h2>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li>Inspect recent Drive and ShareSync issues from Supabase.</li>
              <li>Run read-only diagnostics on both NASes over Tailscale SSH.</li>
              <li>Propose exact repair commands instead of free-form vague advice.</li>
              <li>Wait for your approval before executing any write action.</li>
            </ul>
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <button
              onClick={() => setMessages([])}
              className="w-full rounded-md border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
            >
              Clear Local Chat
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
