import { buildBackendFindingsPromptContext } from "@/lib/server/backend-findings";
import { collectNasDiagnostics, executeNasCommand } from "@/lib/server/nas-api-client";
import { runOpenRouterResponse } from "@/lib/server/openrouter-client";
import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";
import { callMinimax, callMinimaxJSON } from "./minimax";
import { getRemediationModel } from "./ai-settings";
import {
  TOOL_DEFINITIONS,
  toolCatalogText,
  buildApprovalToken,
  verifyApprovalToken,
  randomId,
  type NasTarget,
  type CopilotToolName,
} from "./tools";
import type { CopilotRole, StoredEvidenceItem, StoredAction } from "@/lib/server/copilot-store";

export type ReasoningEffort = "high" | "xhigh";
export type CopilotMessageRole = "user" | "assistant" | "tool";
export type { NasTarget, CopilotToolName } from "./tools";
export type LookbackHours = 1 | 2 | 6 | 24;

export interface CopilotMessage {
  id: string;
  role: CopilotMessageRole;
  content: string;
}

interface ToolProposal {
  title: string;
  target: NasTarget;
  tool_name: CopilotToolName;
  reason: string;
  risk: "low" | "medium" | "high";
  lookback_hours?: number;
  filter?: string;
}

export interface ProposedAction extends StoredAction {}

function sanitizeJson(text: string) {
  return text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "").trim();
}

// TOOL_DEFINITIONS, toolCatalogText, buildApprovalToken, verifyApprovalToken, randomId
// are now imported from ./tools.ts

function buildEvidenceBundle(input: {
  alerts: Array<Record<string, unknown>>;
  driveLogs: Array<Record<string, unknown>>;
  diagnostics: Array<{ target: string; ok: boolean; stdout: string; stderr: string }>;
}) {
  const evidence: StoredEvidenceItem[] = [];

  for (const alert of input.alerts.slice(0, 5)) {
    evidence.push({
      id: randomId(),
      kind: "alert",
      title: `${alert.severity ?? "unknown"} alert: ${alert.title ?? "Untitled"}`,
      detail: String(alert.message ?? ""),
      timestamp: String(alert.created_at ?? ""),
    });
  }

  for (const row of input.driveLogs.slice(0, 8)) {
    const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
    const detailParts = [
      metadata.user ? `user=${metadata.user}` : null,
      metadata.action ? `action=${metadata.action}` : null,
      metadata.path ? `path=${metadata.path}` : null,
      row.message ? String(row.message) : null,
    ].filter(Boolean);

    evidence.push({
      id: randomId(),
      kind: "log",
      title: `${row.source ?? "log"} ${row.severity ?? "info"}`,
      detail: detailParts.join(" | "),
      timestamp: String(row.ingested_at ?? ""),
    });
  }

  for (const diagnostic of input.diagnostics) {
    evidence.push({
      id: randomId(),
      kind: "ssh",
      target: diagnostic.target,
      title: `${diagnostic.target} NAS diagnostics`,
      detail: diagnostic.ok ? diagnostic.stdout.slice(0, 1200) : diagnostic.stderr.slice(0, 1200),
    });
  }

  return evidence;
}

function buildSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      answer: { type: "string" },
      evidence_ids: {
        type: "array",
        items: { type: "string" },
      },
      proposed_actions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            target: {
              type: "string",
              enum: ["edgesynology1", "edgesynology2"],
            },
            tool_name: {
              type: "string",
              enum: Object.keys(TOOL_DEFINITIONS),
            },
            reason: { type: "string" },
            risk: {
              type: "string",
              enum: ["low", "medium", "high"],
            },
            lookback_hours: { type: ["number", "null"] },
            filter: { type: ["string", "null"] },
          },
          required: ["title", "target", "tool_name", "reason", "risk", "lookback_hours", "filter"],
        },
      },
    },
    required: ["answer", "evidence_ids", "proposed_actions"],
  } as const;
}

function coerceLookbackHours(value: number | undefined, fallback: LookbackHours): LookbackHours {
  if (value === 1 || value === 2 || value === 6 || value === 24) return value;
  return fallback;
}

// Two-model architecture: Minimax for fast diagnosis, GPT for detailed remediation
const MINIMAX_DIAGNOSIS_SYSTEM = `You are a Synology NAS diagnostic assistant. Analyze the user's question and the available system data to identify the root cause and affected components.

When process, disk I/O, sync task, or network connection data is present, use it to attribute I/O activity to specific processes, users, shares, or remote clients.

Respond ONLY with valid JSON:
{
  "diagnosis": "Brief diagnosis of what's happening (1-2 sentences)",
  "affected_nas": ["list of affected NAS names"],
  "affected_users": ["list of affected users"],
  "affected_files": ["list of affected file paths"],
  "affected_shares": ["list of affected shares"],
  "severity": "critical|warning|info",
  "recommended_tools": ["list of tool names that would help investigate/fix this"],
  "key_evidence": ["list of relevant evidence IDs that support this diagnosis"]
}`;

async function generateMinimaxDiagnosis(
  userQuestion: string,
  context: {
    backend_findings_summary?: string;
    nas_units: Array<{ id: string; name: string; status: string }>;
    active_alerts: Array<{ severity: string; title: string; message: string }>;
    recent_drive_logs: Array<Record<string, unknown>>;
    recent_security_events: Array<{ severity: string; title: string; user?: string }>;
    ssh_diagnostics: Array<{ target: string; ok: boolean; stdout: string }>;
    evidence_catalog: Array<{ id: string; kind: string; title: string; detail: string }>;
    top_processes?: Array<Record<string, unknown>>;
    disk_io_stats?: Array<Record<string, unknown>>;
    sync_task_snapshots?: Array<Record<string, unknown>>;
    net_connections?: Array<Record<string, unknown>>;
  }
): Promise<{
  diagnosis: string;
  affected_nas: string[];
  affected_users: string[];
  affected_files: string[];
  affected_shares: string[];
  severity: "critical" | "warning" | "info";
  recommended_tools: string[];
  key_evidence: string[];
}> {
  const { data, error } = await callMinimaxJSON<{
    diagnosis: string;
    affected_nas: string[];
    affected_users: string[];
    affected_files: string[];
    affected_shares: string[];
    severity: "critical" | "warning" | "info";
    recommended_tools: string[];
    key_evidence: string[];
  }>(
    MINIMAX_DIAGNOSIS_SYSTEM,
    `${context.backend_findings_summary ?? ""}\n\nUser question: ${userQuestion}\n\nAvailable data:\n${JSON.stringify(context, null, 2)}`
  );

  if (error || !data) {
    return {
      diagnosis: "Unable to generate diagnosis.",
      affected_nas: [],
      affected_users: [],
      affected_files: [],
      affected_shares: [],
      severity: "info",
      recommended_tools: [],
      key_evidence: [],
    };
  }

  return data;
}

function materializeAction(proposal: ToolProposal, defaultLookbackHours: LookbackHours): ProposedAction {
  const tool = TOOL_DEFINITIONS[proposal.tool_name];
  const preview = tool.buildPreview(proposal.target, {
    lookbackHours: coerceLookbackHours(proposal.lookback_hours, defaultLookbackHours),
    filter: proposal.filter,
  });

  return {
    id: randomId(),
    target: proposal.target,
    toolName: proposal.tool_name,
    commandPreview: preview,
    title: proposal.title,
    reason: proposal.reason,
    risk: proposal.risk,
    approvalToken: buildApprovalToken(proposal.target, preview),
    status: "proposed",
  };
}

export async function generateCopilotResponse(
  messages: CopilotMessage[],
  reasoningEffort: ReasoningEffort,
  lookbackHours: LookbackHours,
  role: CopilotRole
) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error("Authentication required.");
  }

  const lookbackCutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();
  // Short window for high-frequency resource data (last 15 min regardless of lookback)
  const resourceCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  const [
    backendFindings,
    nasUnits,
    alerts,
    driveLogs,
    diagnostics,
    securityEvents,
    processSnapshots,
    diskIOStats,
    syncTaskSnapshots,
    netConnections,
  ] = await Promise.all([
    buildBackendFindingsPromptContext(supabase),
    supabase.from("nas_units").select("id, name, hostname, model, status, last_seen").order("name"),
    supabase
      .from("alerts")
      .select("severity, status, source, title, message, created_at")
      .or(`status.eq.active,created_at.gte.${lookbackCutoff}`)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("nas_logs")
      .select("source, severity, message, metadata, ingested_at")
      .in("source", ["drive", "drive_server", "drive_sharesync"])
      .gte("ingested_at", lookbackCutoff)
      .order("ingested_at", { ascending: false })
      .limit(60),
    collectNasDiagnostics(lookbackHours),
    supabase
      .from("security_events")
      .select("severity, type, title, description, file_path, user, detected_at")
      .gte("detected_at", lookbackCutoff)
      .order("detected_at", { ascending: false })
      .limit(20),
    // --- new resource attribution tables ---
    supabase
      .from("process_snapshots")
      .select("nas_id, captured_at, snapshot_grp, pid, name, username, state, cpu_pct, mem_rss_kb, mem_pct, read_bps, write_bps, parent_service")
      .gte("captured_at", resourceCutoff)
      .order("captured_at", { ascending: false })
      .order("write_bps", { ascending: false })
      .limit(60),
    supabase
      .from("disk_io_stats")
      .select("nas_id, captured_at, device, volume_path, reads_ps, writes_ps, read_bps, write_bps, await_ms, util_pct, queue_depth")
      .gte("captured_at", resourceCutoff)
      .order("captured_at", { ascending: false })
      .limit(40),
    supabase
      .from("sync_task_snapshots")
      .select("nas_id, captured_at, task_id, task_name, task_type, status, backlog_count, current_file, current_folder, retry_count, last_error, speed_bps, indexing_queue")
      .gte("captured_at", resourceCutoff)
      .order("captured_at", { ascending: false })
      .limit(30),
    supabase
      .from("net_connections")
      .select("nas_id, captured_at, remote_ip, local_port, protocol, conn_count, username")
      .gte("captured_at", resourceCutoff)
      .order("conn_count", { ascending: false })
      .limit(30),
  ]);

  const evidenceCatalog = buildEvidenceBundle({
    alerts: alerts.data ?? [],
    driveLogs: [
      ...(driveLogs.data ?? []),
      ...((securityEvents.data ?? []).map((event) => ({
        source: "security",
        severity: event.severity,
        message: event.title,
        metadata: { user: event.user, path: event.file_path, action: event.type },
        ingested_at: event.detected_at,
      })) as Record<string, unknown>[]),
    ],
    diagnostics,
  });

  const context = {
    authenticated_user: user.email,
    copilot_role: role,
    lookback_hours: lookbackHours,
    backend_findings_summary: backendFindings,
    nas_units: nasUnits.data ?? [],
    active_alerts: alerts.data ?? [],
    recent_drive_logs: driveLogs.data ?? [],
    recent_security_events: securityEvents.data ?? [],
    ssh_diagnostics: diagnostics,
    evidence_catalog: evidenceCatalog,
    allowed_tools: toolCatalogText(),
    // Resource attribution data (last 15 min)
    top_processes: processSnapshots.data ?? [],
    disk_io_stats: diskIOStats.data ?? [],
    sync_task_snapshots: syncTaskSnapshots.data ?? [],
    net_connections: netConnections.data ?? [],
  };

  // Step 1: Get user's latest question
  const userMessage = [...messages].reverse().find((m) => m.role === "user");

  // Step 2: Use Minimax for fast diagnosis (parallel call for speed)
  const [minimaxDiagnosis] = await Promise.all([
    userMessage
      ? generateMinimaxDiagnosis(userMessage.content, {
          ...context,
          top_processes: processSnapshots.data ?? [],
          disk_io_stats: diskIOStats.data ?? [],
          sync_task_snapshots: syncTaskSnapshots.data ?? [],
          net_connections: netConnections.data ?? [],
        })
      : Promise.resolve({
          diagnosis: "No question detected.",
          affected_nas: [],
          affected_users: [],
          affected_files: [],
          affected_shares: [],
          severity: "info" as const,
          recommended_tools: [],
          key_evidence: [],
        }),
  ]);

  // Step 3: Use GPT for detailed remediation response
  const model = await getRemediationModel();

  const aiDiagnosisContext = `
## AI Diagnosis (from MiniMax-M2.7)
**Diagnosis:** ${minimaxDiagnosis.diagnosis}
**Severity:** ${minimaxDiagnosis.severity}
**Affected NAS:** ${minimaxDiagnosis.affected_nas.join(", ") || "None"}
**Affected Users:** ${minimaxDiagnosis.affected_users.join(", ") || "None"}
**Affected Files:** ${minimaxDiagnosis.affected_files.join(", ") || "None"}
**Affected Shares:** ${minimaxDiagnosis.affected_shares.join(", ") || "None"}
**Recommended Tools:** ${minimaxDiagnosis.recommended_tools.join(", ") || "None"}
**Key Evidence IDs:** ${minimaxDiagnosis.key_evidence.join(", ") || "None"}
`;

  const input = [
    {
      type: "message" as const,
      role: "system" as const,
      content: [
        {
          type: "input_text" as const,
          text:
            "You are the Synology Monitor Copilot — an end-to-end error resolution assistant, not a one-shot query answerer. " +
            "Your goal is to guide the user all the way to a resolved problem, not just describe it. " +
            "\n\n" +
            "WHEN DIAGNOSTIC RESULTS ARE IN THE CONVERSATION: Your primary job is to synthesize them into actionable findings. " +
            "Explain in plain English what the results reveal. Identify the root cause clearly. " +
            "Give specific numbered steps to fix the problem. Do NOT just acknowledge output or repeat it back — interpret it. " +
            "Write for a non-technical business owner who needs to understand what went wrong and what to do. " +
            "\n\n" +
            "WHEN PROPOSING ACTIONS: Group related diagnostics into one response rather than scattering them. " +
            "Prefer proposing all relevant read-only diagnostics at once so the user can approve them together, " +
            "then synthesize all results before proposing any write/fix actions. " +
            "\n\n" +
            "Focus on filesystem, Synology Drive, ShareSync, user-attributed operations, and NAS state. " +
            "Use only the allowed tools when proposing actions. Never invent shell commands outside the tool catalog. " +
            `The human's current role is ${role}. If the role is viewer, do not propose write actions. ` +
            "Cite the most relevant evidence IDs from the provided catalog.",
        },
      ],
    },
    {
      type: "message" as const,
      role: "system" as const,
      content: [
        {
          type: "input_text" as const,
          text: backendFindings,
        },
      ],
    },
    {
      type: "message" as const,
      role: "system" as const,
      content: [
        {
          type: "input_text" as const,
          text: `Current system context:\n${JSON.stringify(context, null, 2)}`,
        },
      ],
    },
    {
      type: "message" as const,
      role: "system" as const,
      content: [
        {
          type: "input_text" as const,
          text: aiDiagnosisContext,
        },
      ],
    },
    ...messages.map((message) => ({
      type: "message" as const,
      role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: [
        {
          type: (message.role === "assistant" ? "output_text" : "input_text") as
            | "input_text"
            | "output_text",
          text: message.content,
        },
      ],
    })),
  ];

  const { response } = await runOpenRouterResponse({
    model,
    reasoningEffort,
    request: {
      input: input as never,
      text: {
        format: {
          type: "json_schema",
          name: "nas_copilot_response",
          schema: buildSchema(),
          strict: true,
        },
      },
    },
  });

  const outputText = sanitizeJson(response.output_text ?? "");
  const parsed = JSON.parse(outputText) as {
    answer: string;
    evidence_ids: string[];
    proposed_actions: ToolProposal[];
  };

  // Combine Minimax diagnosis with GPT answer
  const combinedAnswer = minimaxDiagnosis.diagnosis !== "No question detected."
    ? `**Quick Diagnosis:** ${minimaxDiagnosis.diagnosis}\n\n${parsed.answer}`
    : parsed.answer;

  const evidence = evidenceCatalog.filter((item) => parsed.evidence_ids.includes(item.id));
  const proposedActions =
    role === "viewer"
      ? []
      : parsed.proposed_actions.map((proposal) => materializeAction(proposal, lookbackHours));

  return {
    answer: combinedAnswer,
    evidence,
    proposedActions,
  };
}

export async function runApprovedAction(
  target: NasTarget,
  commandPreview: string,
  approvalToken: string
) {
  verifyApprovalToken(target, commandPreview, approvalToken);
  const result = await executeNasCommand(target, commandPreview);
  const chunks = [];

  if (result.stdout) {
    chunks.push(`stdout:\n${result.stdout}`);
  }
  if (result.stderr) {
    chunks.push(`stderr:\n${result.stderr}`);
  }
  if (chunks.length === 0) {
    chunks.push("Command completed with no output.");
  }

  return {
    ok: result.exitCode === 0,
    content: chunks.join("\n\n"),
    exitCode: result.exitCode,
  };
}

/**
 * Load an analyzed problem by ID and build a copilot prompt from it.
 */
export async function buildProblemPrompt(problemId: string): Promise<string | null> {
  const supabase = await createSupabaseServerClient();

  const { data: problem } = await supabase
    .from("analyzed_problems")
    .select("title, explanation, severity, affected_nas, affected_shares, affected_users, affected_files, raw_event_count, technical_diagnosis, first_seen, last_seen")
    .eq("id", problemId)
    .maybeSingle();

  if (!problem) return null;

  const files = Array.isArray(problem.affected_files)
    ? (problem.affected_files as { path: string; detail: string }[])
        .map((f) => `  - ${f.path}: ${f.detail}`)
        .join("\n")
    : "";

  return (
    `I need help fixing this diagnosed problem:\n\n` +
    `**${problem.title}** (${problem.severity})\n\n` +
    `${problem.explanation}\n\n` +
    `Affected NAS: ${(problem.affected_nas as string[]).join(", ") || "unknown"}\n` +
    `Affected shares: ${(problem.affected_shares as string[]).join(", ") || "none"}\n` +
    `Affected users: ${(problem.affected_users as string[]).join(", ") || "none"}\n` +
    (files ? `Affected files:\n${files}\n` : "") +
    `${problem.raw_event_count} related events\n\n` +
    `**Technical diagnosis from the analysis AI:**\n${problem.technical_diagnosis}\n\n` +
    `What specific steps should I take to fix this? Propose the exact commands if applicable.`
  );
}
