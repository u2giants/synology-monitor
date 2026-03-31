import { createHash } from "node:crypto";
import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

export type CopilotRole = "viewer" | "operator" | "admin";

export interface StoredEvidenceItem {
  id: string;
  kind: "alert" | "log" | "ssh";
  title: string;
  detail: string;
  timestamp?: string;
  target?: string;
}

export interface StoredAction {
  id: string;
  title: string;
  target: "edgesynology1" | "edgesynology2";
  toolName: string;
  commandPreview: string;
  reason: string;
  risk: "low" | "medium" | "high";
  approvalToken: string;
  status: "proposed" | "approved" | "rejected" | "executed" | "failed" | "expired";
  result?: string;
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
  evidence: StoredEvidenceItem[];
  actions?: StoredAction[];
}

export interface StoredSession {
  id: string;
  title: string;
  reasoningEffort: "high" | "xhigh";
  lookbackHours: 1 | 2 | 6 | 24;
  messages: StoredMessage[];
}

export interface StoredSessionSummary {
  id: string;
  title: string;
  reasoningEffort: "high" | "xhigh";
  lookbackHours: 1 | 2 | 6 | 24;
  updatedAt: string;
  createdAt: string;
}

function isMissingRelation(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const message = "message" in error ? String((error as { message: unknown }).message ?? "") : "";
  const code = "code" in error ? String((error as { code: unknown }).code ?? "") : "";
  return code === "42P01" || /relation .* does not exist/i.test(message);
}

function adminEmails() {
  return (process.env.COPILOT_ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export async function getCopilotRole(supabase: SupabaseClient, user: { id: string; email?: string | null }) {
  const normalizedEmail = user.email?.toLowerCase() ?? "";
  if (adminEmails().includes(normalizedEmail)) {
    return {
      role: "admin" as CopilotRole,
      persistenceEnabled: true,
      rolesTableAvailable: true,
    };
  }

  const { data, error } = await supabase
    .from("smon_user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    if (isMissingRelation(error)) {
      return {
        role: "admin" as CopilotRole,
        persistenceEnabled: false,
        rolesTableAvailable: false,
      };
    }
    throw error;
  }

  return {
    role: (data?.role ?? "viewer") as CopilotRole,
    persistenceEnabled: true,
    rolesTableAvailable: true,
  };
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function listSessions(
  supabase: SupabaseClient,
  userId: string
): Promise<{ persistenceEnabled: boolean; sessions: StoredSessionSummary[] }> {
  const { data, error } = await supabase
    .from("smon_copilot_sessions")
    .select("id, title, reasoning_effort, lookback_hours, updated_at, created_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(25);

  if (error) {
    if (isMissingRelation(error)) {
      return { persistenceEnabled: false, sessions: [] };
    }
    throw error;
  }

  return {
    persistenceEnabled: true,
    sessions: (data ?? []).map((session) => ({
      id: session.id,
      title: session.title,
      reasoningEffort: session.reasoning_effort,
      lookbackHours: session.lookback_hours,
      updatedAt: session.updated_at,
      createdAt: session.created_at,
    })),
  };
}

export async function loadSession(
  supabase: SupabaseClient,
  userId: string,
  sessionId?: string | null
): Promise<{
  persistenceEnabled: boolean;
  session: StoredSession | null;
}> {
  const sessionBaseQuery = supabase
    .from("smon_copilot_sessions")
    .select("id, title, reasoning_effort, lookback_hours");

  const sessionQuery = sessionId
    ? await sessionBaseQuery.eq("id", sessionId).eq("user_id", userId).maybeSingle()
    : await sessionBaseQuery.eq("user_id", userId).order("updated_at", { ascending: false }).limit(1).maybeSingle();

  if (sessionQuery.error) {
    if (isMissingRelation(sessionQuery.error)) {
      return { persistenceEnabled: false, session: null };
    }
    throw sessionQuery.error;
  }

  if (!sessionQuery.data) {
    return { persistenceEnabled: true, session: null };
  }

  const resolvedSessionId = sessionQuery.data.id;
  const [messagesQuery, actionsQuery] = await Promise.all([
    supabase
      .from("smon_copilot_messages")
      .select("id, role, content, evidence, created_at, message_order")
      .eq("session_id", resolvedSessionId)
      .eq("user_id", userId)
      .order("message_order", { ascending: true }),
    supabase
      .from("smon_copilot_actions")
      .select("id, assistant_message_id, title, target, tool_name, command_preview, reason, risk, status, result_text, metadata")
      .eq("session_id", resolvedSessionId)
      .eq("user_id", userId)
      .order("created_at", { ascending: true }),
  ]);

  if (messagesQuery.error) throw messagesQuery.error;
  if (actionsQuery.error) throw actionsQuery.error;

  const actionsByMessage = new Map<string, StoredAction[]>();
  for (const action of actionsQuery.data ?? []) {
    const key = action.assistant_message_id as string;
    const current = actionsByMessage.get(key) ?? [];
    current.push({
      id: action.id,
      title: action.title,
      target: action.target,
      toolName: action.tool_name,
      commandPreview: action.command_preview,
      reason: action.reason,
      risk: action.risk,
      approvalToken: String((action.metadata as Record<string, unknown> | null)?.approvalToken ?? ""),
      status: action.status,
      result: action.result_text ?? undefined,
    });
    actionsByMessage.set(key, current);
  }

  return {
    persistenceEnabled: true,
    session: {
      id: resolvedSessionId,
      title: sessionQuery.data.title,
      reasoningEffort: sessionQuery.data.reasoning_effort,
      lookbackHours: sessionQuery.data.lookback_hours,
      messages: (messagesQuery.data ?? []).map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.created_at,
        evidence: Array.isArray(message.evidence) ? (message.evidence as StoredEvidenceItem[]) : [],
        actions: actionsByMessage.get(message.id),
      })),
    },
  };
}

function buildSessionTitle(content: string) {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return "NAS Copilot Session";
  return normalized.length > 72 ? `${normalized.slice(0, 69)}...` : normalized;
}

export async function ensureSession(
  supabase: SupabaseClient,
  userId: string,
  sessionId: string | null | undefined,
  reasoningEffort: "high" | "xhigh",
  lookbackHours: 1 | 2 | 6 | 24
) {
  if (sessionId) {
    const { error } = await supabase
      .from("smon_copilot_sessions")
      .update({ reasoning_effort: reasoningEffort, lookback_hours: lookbackHours, updated_at: new Date().toISOString() })
      .eq("id", sessionId)
      .eq("user_id", userId);

    if (error) {
      if (isMissingRelation(error)) return { persistenceEnabled: false, sessionId: null };
      throw error;
    }

    return { persistenceEnabled: true, sessionId };
  }

  const { data, error } = await supabase
    .from("smon_copilot_sessions")
    .insert({
      user_id: userId,
      reasoning_effort: reasoningEffort,
      lookback_hours: lookbackHours,
      updated_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    if (isMissingRelation(error)) return { persistenceEnabled: false, sessionId: null };
    throw error;
  }

  return { persistenceEnabled: true, sessionId: data.id as string };
}

export async function persistTurn(
  supabase: SupabaseClient,
  userId: string,
  input: {
    sessionId: string;
    userMessage: { id: string; content: string; createdAt: string };
    assistantMessage: { id: string; content: string; createdAt: string; evidence: StoredEvidenceItem[] };
    actions: StoredAction[];
  }
) {
  const orderQuery = await supabase
    .from("smon_copilot_messages")
    .select("message_order")
    .eq("session_id", input.sessionId)
    .eq("user_id", userId)
    .order("message_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (orderQuery.error) {
    if (isMissingRelation(orderQuery.error)) return { persistenceEnabled: false };
    throw orderQuery.error;
  }

  const baseOrder = (orderQuery.data?.message_order ?? -1) + 1;

  const messageInsert = await supabase.from("smon_copilot_messages").insert([
    {
      id: input.userMessage.id,
      session_id: input.sessionId,
      user_id: userId,
      role: "user",
      content: input.userMessage.content,
      evidence: [],
      message_order: baseOrder,
      created_at: input.userMessage.createdAt,
    },
    {
      id: input.assistantMessage.id,
      session_id: input.sessionId,
      user_id: userId,
      role: "assistant",
      content: input.assistantMessage.content,
      evidence: input.assistantMessage.evidence,
      message_order: baseOrder + 1,
      created_at: input.assistantMessage.createdAt,
    },
  ]);

  if (messageInsert.error) {
    if (isMissingRelation(messageInsert.error)) return { persistenceEnabled: false };
    throw messageInsert.error;
  }

  if (input.actions.length > 0) {
    const actionInsert = await supabase.from("smon_copilot_actions").insert(
      input.actions.map((action) => ({
        id: action.id,
        session_id: input.sessionId,
        assistant_message_id: input.assistantMessage.id,
        user_id: userId,
        target: action.target,
        title: action.title,
        tool_name: action.toolName,
        command_preview: action.commandPreview,
        reason: action.reason,
        risk: action.risk,
        status: action.status,
        approval_token_hash: hashToken(action.approvalToken),
        metadata: {
          approvalToken: action.approvalToken,
        },
      }))
    );

    if (actionInsert.error) throw actionInsert.error;
  }

  await supabase
    .from("smon_copilot_sessions")
    .update({
      updated_at: new Date().toISOString(),
      ...(baseOrder === 0 ? { title: buildSessionTitle(input.userMessage.content) } : {}),
    })
    .eq("id", input.sessionId)
    .eq("user_id", userId);

  return { persistenceEnabled: true };
}

export async function updateActionStatus(
  supabase: SupabaseClient,
  userId: string,
  actionId: string,
  input: {
    status: "approved" | "rejected" | "executed" | "failed" | "expired";
    result?: string;
  }
) {
  const { error } = await supabase
    .from("smon_copilot_actions")
    .update({
      status: input.status,
      result_text: input.result ?? null,
      approved_by: input.status === "approved" || input.status === "executed" ? userId : null,
      approved_at:
        input.status === "approved" || input.status === "executed" ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", actionId)
    .eq("user_id", userId);

  if (error) {
    if (isMissingRelation(error)) return { persistenceEnabled: false };
    throw error;
  }

  return { persistenceEnabled: true };
}
