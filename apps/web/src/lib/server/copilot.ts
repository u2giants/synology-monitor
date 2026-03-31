import { createHmac, randomUUID } from "node:crypto";
import OpenAI from "openai";
import { collectNasDiagnostics, executeApprovedCommand } from "@/lib/server/nas";
import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";
import type { CopilotRole, StoredEvidenceItem, StoredAction } from "@/lib/server/copilot-store";

export type ReasoningEffort = "high" | "xhigh";
export type CopilotMessageRole = "user" | "assistant" | "tool";
export type NasTarget = "edgesynology1" | "edgesynology2";
export type LookbackHours = 1 | 2 | 6 | 24;
export type CopilotToolName =
  | "check_disk_space"
  | "check_agent_container"
  | "tail_drive_server_log"
  | "search_drive_server_log"
  | "tail_sharesync_log"
  | "restart_monitor_agent"
  | "restart_synology_drive_server"
  | "restart_synology_drive_sharesync";

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

interface ToolDefinition {
  description: string;
  write: boolean;
  buildPreview: (target: NasTarget, input: { lookbackHours?: number; filter?: string }) => string;
}

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }
  return new OpenAI({ apiKey });
}

function randomId() {
  return randomUUID();
}

function getActionSigningKey() {
  return process.env.COPILOT_ACTION_SIGNING_KEY ?? process.env.OPENAI_API_KEY ?? "";
}

function signAction(target: NasTarget, commandPreview: string, expiresAt: string) {
  const signingKey = getActionSigningKey();
  if (!signingKey) {
    throw new Error("COPILOT_ACTION_SIGNING_KEY or OPENAI_API_KEY is not configured.");
  }

  return createHmac("sha256", signingKey)
    .update(`${target}\n${commandPreview}\n${expiresAt}`)
    .digest("hex");
}

function buildApprovalToken(target: NasTarget, commandPreview: string) {
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const signature = signAction(target, commandPreview, expiresAt);
  return Buffer.from(JSON.stringify({ target, commandPreview, expiresAt, signature })).toString("base64url");
}

function verifyApprovalToken(target: NasTarget, commandPreview: string, token: string) {
  let parsed: {
    target: NasTarget;
    commandPreview: string;
    expiresAt: string;
    signature: string;
  };

  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new Error("Approval token is invalid.");
  }

  if (parsed.target !== target || parsed.commandPreview !== commandPreview) {
    throw new Error("Approval token does not match the requested action.");
  }

  if (Date.parse(parsed.expiresAt) < Date.now()) {
    throw new Error("Approval token has expired.");
  }

  const expectedSignature = signAction(parsed.target, parsed.commandPreview, parsed.expiresAt);
  if (expectedSignature !== parsed.signature) {
    throw new Error("Approval token signature is invalid.");
  }
}

function sanitizeJson(text: string) {
  return text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "").trim();
}

function quote(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

const TOOL_DEFINITIONS: Record<CopilotToolName, ToolDefinition> = {
  check_disk_space: {
    description: "Read-only. Check volume1 disk utilization and free space.",
    write: false,
    buildPreview: () => "df -h /volume1",
  },
  check_agent_container: {
    description: "Read-only. Confirm whether the Synology Monitor agent container is running.",
    write: false,
    buildPreview: () =>
      "/usr/local/bin/docker ps --format '{{.Image}}|{{.Status}}|{{.Names}}' | grep synology-monitor-agent || true",
  },
  tail_drive_server_log: {
    description: "Read-only. Inspect recent Synology Drive server log lines.",
    write: false,
    buildPreview: (_target, input) => `tail -n ${Math.max(40, Math.min(300, (input.lookbackHours ?? 2) * 40))} /var/log/synologydrive.log`,
  },
  search_drive_server_log: {
    description: "Read-only. Search Synology Drive server logs for a specific term such as a share, user, or error fragment.",
    write: false,
    buildPreview: (_target, input) => {
      const filter = input.filter?.trim() || "error";
      const lines = Math.max(40, Math.min(300, (input.lookbackHours ?? 2) * 40));
      return `grep -i ${quote(filter)} /var/log/synologydrive.log | tail -n ${lines}`;
    },
  },
  tail_sharesync_log: {
    description: "Read-only. Inspect recent ShareSync log lines under @synologydrive/log/syncfolder.log.",
    write: false,
    buildPreview: (_target, input) => {
      const lines = Math.max(40, Math.min(240, (input.lookbackHours ?? 2) * 30));
      return `find /volume1 -path '*/@synologydrive/log/syncfolder.log' -print -exec tail -n ${lines} {} \\;`;
    },
  },
  restart_monitor_agent: {
    description: "Write. Restart the Synology Monitor agent container on the NAS.",
    write: true,
    buildPreview: () => "cd /volume1/docker/synology-monitor-agent && docker compose restart",
  },
  restart_synology_drive_server: {
    description: "Write. Restart the Synology Drive package.",
    write: true,
    buildPreview: () => "/usr/syno/bin/synopkg restart SynologyDrive",
  },
  restart_synology_drive_sharesync: {
    description: "Write. Restart the Synology Drive ShareSync package.",
    write: true,
    buildPreview: () => "/usr/syno/bin/synopkg restart SynologyDriveShareSync",
  },
};

function toolCatalogText() {
  return Object.entries(TOOL_DEFINITIONS)
    .map(([name, tool]) => `- ${name}: ${tool.description}`)
    .join("\n");
}

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
      title: `${diagnostic.target} SSH diagnostics`,
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
  const [nasUnits, alerts, driveLogs, diagnostics, securityEvents] = await Promise.all([
    supabase.from("smon_nas_units").select("id, name, hostname, model, status, last_seen").order("name"),
    supabase
      .from("smon_alerts")
      .select("severity, status, source, title, message, created_at")
      .or(`status.eq.active,created_at.gte.${lookbackCutoff}`)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("smon_logs")
      .select("source, severity, message, metadata, ingested_at")
      .in("source", ["drive", "drive_server", "drive_sharesync"])
      .gte("ingested_at", lookbackCutoff)
      .order("ingested_at", { ascending: false })
      .limit(60),
    collectNasDiagnostics(lookbackHours),
    supabase
      .from("smon_security_events")
      .select("severity, type, title, description, file_path, user, detected_at")
      .gte("detected_at", lookbackCutoff)
      .order("detected_at", { ascending: false })
      .limit(20),
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

  const client = getOpenAIClient();
  const model = process.env.OPENAI_CHAT_MODEL ?? "gpt-5.4";

  const context = {
    authenticated_user: user.email,
    copilot_role: role,
    lookback_hours: lookbackHours,
    nas_units: nasUnits.data ?? [],
    active_alerts: alerts.data ?? [],
    recent_drive_logs: driveLogs.data ?? [],
    recent_security_events: securityEvents.data ?? [],
    ssh_diagnostics: diagnostics,
    evidence_catalog: evidenceCatalog,
    allowed_tools: toolCatalogText(),
  };

  const input = [
    {
      role: "system" as const,
      content: [
        {
          type: "input_text" as const,
          text:
            "You are the Synology Monitor Copilot. Focus on filesystem, Synology Drive, ShareSync, user-attributed operations, and recent NAS state. " +
            "Use only the allowed tools when proposing actions. Never invent shell commands outside the tool catalog. " +
            `The human's current role is ${role}. If the role is viewer, do not propose write actions. ` +
            "Keep answers concrete and cite the most relevant evidence IDs from the provided catalog.",
        },
      ],
    },
    {
      role: "system" as const,
      content: [
        {
          type: "input_text" as const,
          text: `Current system context:\n${JSON.stringify(context, null, 2)}`,
        },
      ],
    },
    ...messages.map((message) => ({
      role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: [{ type: "input_text" as const, text: message.content }],
    })),
  ];

  const response = await client.responses.create({
    model,
    reasoning: { effort: reasoningEffort },
    input,
    text: {
      format: {
        type: "json_schema",
        name: "nas_copilot_response",
        schema: buildSchema(),
        strict: true,
      },
    },
  });

  const outputText = sanitizeJson(response.output_text ?? "");
  const parsed = JSON.parse(outputText) as {
    answer: string;
    evidence_ids: string[];
    proposed_actions: ToolProposal[];
  };

  const evidence = evidenceCatalog.filter((item) => parsed.evidence_ids.includes(item.id));
  const proposedActions =
    role === "viewer"
      ? []
      : parsed.proposed_actions.map((proposal) => materializeAction(proposal, lookbackHours));

  return {
    answer: parsed.answer,
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
  const result = await executeApprovedCommand(target, commandPreview);
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
