import type { SupabaseClient } from "@/lib/server/issue-store";

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

export async function getCopilotRole(
  supabase: SupabaseClient,
  user: { id: string; email?: string | null },
) {
  const normalizedEmail = user.email?.toLowerCase() ?? "";
  if (adminEmails().includes(normalizedEmail)) {
    return {
      role: "admin" as CopilotRole,
      persistenceEnabled: true,
      rolesTableAvailable: true,
    };
  }

  const { data, error } = await supabase
    .from("user_roles")
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
