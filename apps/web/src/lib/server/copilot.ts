import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import OpenAI from "openai";
import { collectNasDiagnostics, executeApprovedCommand } from "@/lib/server/nas";
import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";
import { callMinimax, callMinimaxJSON } from "./minimax";
import { getRemediationModel } from "./ai-settings";
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
  | "get_resource_snapshot"
  | "restart_monitor_agent"
  | "restart_synology_drive_server"
  | "restart_synology_drive_sharesync"
  | "check_sharesync_status"
  | "rename_file_to_old"
  | "remove_invalid_chars"
  | "trigger_sharesync_resync";

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
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY or OPENAI_API_KEY is not configured.");
  }
  return new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
  });
}

function randomId() {
  return randomUUID();
}

function getActionSigningKey(): string {
  const signingKey = process.env.COPILOT_ACTION_SIGNING_KEY ?? process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  if (!signingKey) {
    throw new Error("COPILOT_ACTION_SIGNING_KEY or OPENROUTER_API_KEY must be set.");
  }
  return signingKey;
}

function signAction(target: NasTarget, commandPreview: string, expiresAt: string) {
  const signingKey = getActionSigningKey();

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
  const expectedBuf = Buffer.from(expectedSignature, "hex");
  const actualBuf = Buffer.from(parsed.signature, "hex");
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
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
      return `for f in /volume1/*/@synologydrive/log/syncfolder.log; do [ -f "$f" ] || continue; echo "$f"; tail -n ${lines} "$f"; done`;
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
  check_sharesync_status: {
    description: "Read-only. Check current ShareSync task status and any stuck sync operations. Useful for diagnosing stuck syncs.",
    write: false,
    buildPreview: (_target, input) => {
      const lines = Math.max(60, Math.min(200, (input.lookbackHours ?? 2) * 40));
      return `for f in /volume1/*/@synologydrive/log/syncfolder.log; do [ -f "$f" ] || continue; echo "=== $f ==="; tail -n ${lines} "$f"; done | grep -A2 -B2 -i "syncing\\|stuck\\|error\\|conflict" || echo "No issues found in recent logs"`;
    },
  },
  get_resource_snapshot: {
    description: "Read-only. Live on-NAS snapshot: top processes by CPU/mem/IO, per-disk I/O stats, active SMB/NFS/Drive connections, ShareSync backlog, memory pressure, and recent kernel errors. Use this when you need real-time attribution of I/O spikes or unknown load.",
    write: false,
    buildPreview: (_target, _input) => {
      return [
        "echo '=== TOP CPU/MEM ==='",
        "ps aux --sort=-%cpu | head -20",
        "echo '=== TOP DISK WRITE ==='",
        "ps aux --sort=-%cpu | awk '{print $11, $1, $3, $4}' | head -15",
        "echo '=== DISK IO (diskstats) ==='",
        "awk '{if (($4+$8)>0) print $3, \"reads:\", $4, \"writes:\", $8, \"inprog:\", $12}' /proc/diskstats | grep -E 'sd|md'",
        "echo '=== DISK IO UTIL (iostat) ==='",
        "iostat -dxy 1 2 2>/dev/null | tail -30 || echo 'iostat unavailable'",
        "echo '=== OPEN FILES ON VOLUME ==='",
        "lsof -n +D /volume1 2>/dev/null | awk 'NR>1{print $1,$3,$9}' | sort | uniq -c | sort -rn | head -25 || true",
        "echo '=== SMB SESSIONS ==='",
        "smbstatus -S 2>/dev/null | head -30 || ss -tnp 'sport = :445' 2>/dev/null | head -20 || echo 'SMB status unavailable'",
        "echo '=== NETWORK TOP PEERS ==='",
        "ss -tn state established 2>/dev/null | awk 'NR>1{split($5,a,\":\"); print a[1]}' | sort | uniq -c | sort -rn | head -20",
        "echo '=== SHARESYNC TASKS ==='",
        "for f in /volume1/*/@synologydrive/log/syncfolder.log /volume1/@SynologyDriveShareSync/*/log/syncfolder.log; do [ -f \"$f\" ] || continue; echo \"=== $f ===\"; tail -40 \"$f\"; done 2>/dev/null || true",
        "echo '=== INDEXING QUEUE ==='",
        "synoindex -S 2>/dev/null | head -10 || ls -la /volume1/@synoindex/ 2>/dev/null | head -10 || true",
        "echo '=== RUNNING SCHEDULED TASKS ==='",
        "/usr/syno/bin/synopkg list --name 2>/dev/null | head -20 || true",
        "echo '=== MEMORY PRESSURE ==='",
        "free -h",
        "grep -E 'MemAvail|Dirty|Writeback|SwapTotal|SwapFree' /proc/meminfo",
        "echo '=== IO WAIT ==='",
        "top -b -n2 -d0.3 2>/dev/null | grep 'Cpu(s)' | tail -1 || vmstat 1 2 | tail -1",
        "echo '=== KERNEL ERRORS (last 50) ==='",
        "dmesg -T 2>/dev/null | grep -iE 'error|warn|fail|oom|i\\/o' | tail -50 || dmesg | tail -50",
        "echo '=== PACKAGE RESTART HISTORY ==='",
        "grep -i 'restart\\|start\\|stop\\|crash' /var/log/synolog/synopkg.log 2>/dev/null | tail -30 || tail -30 /var/log/synolog/synopkg.log 2>/dev/null || true",
      ].join("\n");
    },
  },
  rename_file_to_old: {
    description: "Write. Rename a problematic file by appending .old to its name. Use this for files causing sync conflicts. Requires file_path parameter.",
    write: true,
    buildPreview: (_target, input) => {
      const filePath = input.filter || "/volume1/SharedDrive/problematic_file.txt";
      return `mv "${filePath}" "${filePath}.old" && echo "Renamed successfully"`;
    },
  },
  remove_invalid_chars: {
    description: "Write. Remove invalid characters (like /\\:*?\"<>|) from a filename. Use this when ShareSync fails due to special characters in file names. Requires file_path parameter.",
    write: true,
    buildPreview: (_target, input) => {
      const filePath = input.filter || "/volume1/SharedDrive/file_with_invalid_chars.txt";
      // Get the directory and filename, then sanitize the filename
      return `dir=$(dirname "${filePath}"); file=$(basename "${filePath}"); newfile=$(echo "$file" | sed 's/[/\\:*?"<>|]/_/g'); [ "$file" != "$newfile" ] && mv "${filePath}" "$dir/$newfile" && echo "Renamed: $file -> $newfile" || echo "No invalid characters found"`;
    },
  },
  trigger_sharesync_resync: {
    description: "Write. Trigger a manual re-sync for a specific ShareSync task by restarting ShareSync for the affected folder. Use after resolving sync issues. Requires folder path in filter parameter.",
    write: true,
    buildPreview: (_target, input) => {
      const folder = input.filter || "/volume1/SharedFolder";
      return `/usr/syno/bin/synopkg restart SynologyDriveShareSync && sleep 10 && echo "ShareSync restarted for folder: ${folder}"`;
    },
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
    `User question: ${userQuestion}\n\nAvailable data:\n${JSON.stringify(context, null, 2)}`
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
    // --- new resource attribution tables ---
    supabase
      .from("smon_process_snapshots")
      .select("nas_id, captured_at, snapshot_grp, pid, name, username, state, cpu_pct, mem_rss_kb, mem_pct, read_bps, write_bps, parent_service")
      .gte("captured_at", resourceCutoff)
      .order("captured_at", { ascending: false })
      .order("write_bps", { ascending: false })
      .limit(60),
    supabase
      .from("smon_disk_io_stats")
      .select("nas_id, captured_at, device, volume_path, reads_ps, writes_ps, read_bps, write_bps, await_ms, util_pct, queue_depth")
      .gte("captured_at", resourceCutoff)
      .order("captured_at", { ascending: false })
      .limit(40),
    supabase
      .from("smon_sync_task_snapshots")
      .select("nas_id, captured_at, task_id, task_name, task_type, status, backlog_count, current_file, current_folder, retry_count, last_error, speed_bps, indexing_queue")
      .gte("captured_at", resourceCutoff)
      .order("captured_at", { ascending: false })
      .limit(30),
    supabase
      .from("smon_net_connections")
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
  const client = getOpenAIClient();
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
            "You are the Synology Monitor Copilot. Focus on filesystem, Synology Drive, ShareSync, user-attributed operations, and recent NAS state. " +
            "Use only the allowed tools when proposing actions. Never invent shell commands outside the tool catalog. " +
            `The human's current role is ${role}. If the role is viewer, do not propose write actions. ` +
            "Keep answers concrete and cite the most relevant evidence IDs from the provided catalog.",
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

  const response = await client.responses.create({
    model,
    reasoning: { effort: reasoningEffort },
    input: input as never,
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

/**
 * Load an analyzed problem by ID and build a copilot prompt from it.
 */
export async function buildProblemPrompt(problemId: string): Promise<string | null> {
  const supabase = await createSupabaseServerClient();

  const { data: problem } = await supabase
    .from("smon_analyzed_problems")
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
