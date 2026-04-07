import OpenAI from "openai";
import { collectNasDiagnostics, executeApprovedCommand } from "@/lib/server/nas";
import {
  appendIssueEvidence,
  appendIssueMessage,
  createIssueAction,
  loadIssue,
  type IssueAction,
  type IssueConfidence,
  type IssueFull,
  type IssueSeverity,
  type SupabaseClient,
  updateIssue,
  updateIssueAction,
} from "@/lib/server/issue-store";
import {
  TOOL_DEFINITIONS,
  buildApprovalToken,
  type CopilotToolName,
  type NasTarget,
} from "@/lib/server/tools";
import { getDiagnosisModel, getRemediationModel } from "./ai-settings";

type ToolActionPlan = {
  tool_name: CopilotToolName;
  target: NasTarget;
  summary: string;
  reason: string;
  expected_outcome: string;
  rollback_plan?: string;
  risk?: "low" | "medium" | "high";
  filter?: string;
  lookback_hours?: number;
};

type AgentDecision = {
  response: string;
  summary: string;
  current_hypothesis: string;
  hypothesis_confidence: IssueConfidence;
  severity: IssueSeverity;
  affected_nas: string[];
  conversation_summary: string;
  next_step: string;
  status: "running" | "waiting_on_user" | "waiting_for_approval" | "resolved" | "stuck";
  constraints_to_add: string[];
  blocked_tools: CopilotToolName[];
  evidence_notes: Array<{ title: string; detail: string }>;
  diagnostic_action: ToolActionPlan | null;
  remediation_action: ToolActionPlan | null;
};

const MAX_AGENT_CYCLES = 2;

const ALLOWED_DIAGNOSTIC_TOOLS: CopilotToolName[] = [
  "check_drive_package_health",
  "check_drive_database",
  "check_share_database",
  "search_webapi_log",
  "search_all_logs",
  "find_problematic_files",
  "check_kernel_io_errors",
  "check_filesystem_health",
  "check_io_stalls",
  "check_sharesync_status",
  "tail_sharesync_log",
  "tail_drive_server_log",
  "search_drive_server_log",
  "get_resource_snapshot",
];

const ALLOWED_REMEDIATION_TOOLS: CopilotToolName[] = [
  "restart_synology_drive_sharesync",
  "restart_synology_drive_server",
  "rename_file_to_old",
  "remove_invalid_chars",
  "trigger_sharesync_resync",
];

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

async function gatherTelemetryContext(supabase: SupabaseClient, issue: IssueFull["issue"]) {
  const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const nasFilter = issue.affected_nas.length > 0 ? issue.affected_nas : null;

  const [alertsResult, logsResult, processResult, diskResult] = await Promise.all([
    supabase
      .from("smon_alerts")
      .select("id, source, severity, title, message, created_at")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(12),
    supabase
      .from("smon_logs")
      .select("id, nas_id, source, severity, message, metadata, ingested_at")
      .gte("ingested_at", since)
      .in("severity", ["critical", "error", "warning"])
      .order("ingested_at", { ascending: false })
      .limit(80),
    supabase
      .from("smon_process_snapshots")
      .select("nas_id, captured_at, name, username, cpu_pct, mem_pct, write_bps, parent_service")
      .gte("captured_at", since)
      .order("captured_at", { ascending: false })
      .limit(20),
    supabase
      .from("smon_disk_io_stats")
      .select("nas_id, captured_at, device, read_bps, write_bps, await_ms, util_pct")
      .gte("captured_at", since)
      .order("captured_at", { ascending: false })
      .limit(20),
  ]);

  const alerts = alertsResult.data ?? [];
  const logs = (logsResult.data ?? []).filter((row) => {
    if (!nasFilter?.length) return true;
    const nasValue = typeof row.nas_id === "string" ? row.nas_id : "";
    return nasFilter.some((nas) => nasValue.includes(nas) || String((row.metadata as Record<string, unknown> | null)?.nas_name ?? "").includes(nas));
  });

  return {
    alerts,
    logs,
    top_processes: processResult.data ?? [],
    disk_io: diskResult.data ?? [],
  };
}

function summarizeActionHistory(actions: IssueAction[]) {
  return actions.slice(-10).map((action) => ({
    kind: action.kind,
    status: action.status,
    tool_name: action.tool_name,
    target: action.target,
    summary: action.summary,
    reason: action.reason,
    result_text: action.result_text?.slice(0, 1000) ?? "",
  }));
}

function summarizeMessages(state: IssueFull) {
  return state.messages.slice(-12).map((message) => ({
    role: message.role,
    content: message.content,
    created_at: message.created_at,
  }));
}

function summarizeEvidence(state: IssueFull) {
  return state.evidence.slice(-20).map((evidence) => ({
    source_kind: evidence.source_kind,
    title: evidence.title,
    detail: evidence.detail,
  }));
}

function toolPromptLines(toolNames: CopilotToolName[]) {
  return toolNames
    .map((toolName) => `- ${toolName}: ${TOOL_DEFINITIONS[toolName].description}`)
    .join("\n");
}

async function callDecisionModel(
  state: IssueFull,
  telemetry: Awaited<ReturnType<typeof gatherTelemetryContext>>
): Promise<AgentDecision> {
  const client = getOpenAIClient();
  const model = state.actions.some((action) => action.kind === "diagnostic" && action.status === "completed")
    ? await getRemediationModel()
    : await getDiagnosisModel();

  const prompt = `You are the driver for a single Synology NAS issue.

Your job is to own this issue end to end. Maintain one coherent hypothesis, update it when new evidence arrives, and either:
1. run the one best next read-only diagnostic,
2. propose one exact remediation action for approval, or
3. ask the user one focused question when automation is blocked.

Hard rules:
- Treat the user's latest message as a direct reply to your last message.
- Never repeat a rejected or blocked action unless you explicitly explain what new evidence changed.
- Never propose a file modification unless you know the exact file path.
- Never ask for approval unless you are returning one exact remediation_action object.
- If evidence is thin, say so and gather the one most discriminating next diagnostic.
- Be concise, direct, and operator-focused. No phase narration.

Issue record:
${JSON.stringify({
  title: state.issue.title,
  summary: state.issue.summary,
  status: state.issue.status,
  severity: state.issue.severity,
  affected_nas: state.issue.affected_nas,
  current_hypothesis: state.issue.current_hypothesis,
  hypothesis_confidence: state.issue.hypothesis_confidence,
  next_step: state.issue.next_step,
  conversation_summary: state.issue.conversation_summary,
  operator_constraints: state.issue.operator_constraints,
  blocked_tools: state.issue.blocked_tools,
}, null, 2)}

Recent conversation:
${JSON.stringify(summarizeMessages(state), null, 2)}

Recent evidence:
${JSON.stringify(summarizeEvidence(state), null, 2)}

Recent actions:
${JSON.stringify(summarizeActionHistory(state.actions), null, 2)}

Live telemetry:
${JSON.stringify(telemetry, null, 2)}

Allowed diagnostic tools:
${toolPromptLines(ALLOWED_DIAGNOSTIC_TOOLS)}

Allowed remediation tools:
${toolPromptLines(ALLOWED_REMEDIATION_TOOLS)}

Return JSON only:
{
  "response": "What you say to the operator now. Must include current belief, what changed, and the one next thing you want to do.",
  "summary": "Short issue summary for list views.",
  "current_hypothesis": "Current best explanation.",
  "hypothesis_confidence": "high|medium|low",
  "severity": "critical|warning|info",
  "affected_nas": ["edgesynology1"],
  "conversation_summary": "Durable summary of the thread so far.",
  "next_step": "One sentence saying the next meaningful step.",
  "status": "running|waiting_on_user|waiting_for_approval|resolved|stuck",
  "constraints_to_add": ["durable operator constraints learned from this turn"],
  "blocked_tools": ["tool names that should not be proposed again unless evidence changes"],
  "evidence_notes": [{"title":"", "detail":""}],
  "diagnostic_action": {
    "tool_name": "check_drive_database",
    "target": "edgesynology1",
    "summary": "Run one precise read-only diagnostic",
    "reason": "Why this is the most discriminating next step",
    "expected_outcome": "What result should clarify",
    "filter": "",
    "lookback_hours": 2
  } or null,
  "remediation_action": {
    "tool_name": "remove_invalid_chars",
    "target": "edgesynology1",
    "summary": "One exact change to make",
    "reason": "Why this is now justified",
    "expected_outcome": "What should improve",
    "rollback_plan": "How to revert if needed",
    "risk": "low|medium|high",
    "filter": "/exact/path/to/file",
    "lookback_hours": 2
  } or null
}

Only one of diagnostic_action or remediation_action may be non-null.`;

  const response = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    max_tokens: 2500,
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  return JSON.parse(raw) as AgentDecision;
}

function actionFingerprint(action: {
  tool_name: string;
  target: string | null;
  filter?: string;
}) {
  return `${action.tool_name}:${action.target ?? "unknown"}:${action.filter ?? ""}`;
}

function buildCommandPreview(plan: ToolActionPlan) {
  const tool = TOOL_DEFINITIONS[plan.tool_name];
  if (!tool) {
    throw new Error(`Unknown tool ${plan.tool_name}`);
  }
  return tool.buildPreview(plan.target, {
    filter: plan.filter,
    lookbackHours: plan.lookback_hours,
  });
}

function ensureAllowed(plan: ToolActionPlan, kind: "diagnostic" | "remediation") {
  const allowed = kind === "diagnostic" ? ALLOWED_DIAGNOSTIC_TOOLS : ALLOWED_REMEDIATION_TOOLS;
  if (!allowed.includes(plan.tool_name)) {
    throw new Error(`Tool ${plan.tool_name} is not allowed for ${kind}`);
  }
}

function mergeStringLists(...lists: string[][]) {
  return Array.from(new Set(lists.flat().map((item) => item.trim()).filter(Boolean)));
}

function hasAlreadyTried(state: IssueFull, plan: ToolActionPlan) {
  const fp = actionFingerprint(plan);
  return state.actions.some((action) => actionFingerprint({
    tool_name: action.tool_name,
    target: action.target,
    filter: action.command_preview,
  }) === fp || (
    action.tool_name === plan.tool_name &&
    action.target === plan.target &&
    (action.status === "rejected" || action.status === "completed" || action.status === "failed")
  ));
}

async function executeDiagnosticAction(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
  plan: ToolActionPlan
) {
  const commandPreview = buildCommandPreview(plan);
  const actionId = await createIssueAction(supabase, userId, issueId, {
    kind: "diagnostic",
    target: plan.target,
    toolName: plan.tool_name,
    commandPreview,
    summary: plan.summary,
    reason: plan.reason,
    expectedOutcome: plan.expected_outcome,
    rollbackPlan: "",
    risk: "low",
    requiresApproval: false,
  });

  await updateIssueAction(supabase, userId, actionId, { status: "running" });

  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let status: IssueAction["status"] = "completed";

  try {
    const result = await executeApprovedCommand(plan.target, commandPreview);
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = result.exitCode;
    status = result.exitCode === 0 ? "completed" : "failed";
  } catch (error) {
    stderr = error instanceof Error ? error.message : "Unknown diagnostic execution error";
    status = "failed";
  }

  const resultText = [stdout, stderr].filter(Boolean).join("\n\n").slice(0, 12000);
  await updateIssueAction(supabase, userId, actionId, {
    status,
    result_text: resultText,
    exit_code: exitCode,
    completed_at: new Date().toISOString(),
  });

  await appendIssueEvidence(supabase, userId, issueId, {
    source_kind: "diagnostic",
    title: `${plan.summary} (${plan.tool_name})`,
    detail: resultText || "No output returned.",
    metadata: {
      tool_name: plan.tool_name,
      target: plan.target,
      exit_code: exitCode,
      status,
    },
  });
}

async function executeApprovedActions(supabase: SupabaseClient, userId: string, state: IssueFull) {
  const approved = state.actions.find((action) => action.status === "approved");
  if (!approved) return false;

  await updateIssue(supabase, userId, state.issue.id, { status: "running" });
  await updateIssueAction(supabase, userId, approved.id, { status: "running" });

  let resultText = "";
  let exitCode: number | null = null;
  let status: IssueAction["status"] = "completed";

  try {
    const result = await executeApprovedCommand(approved.target as NasTarget, approved.command_preview);
    resultText = [result.stdout, result.stderr].filter(Boolean).join("\n\n").slice(0, 12000);
    exitCode = result.exitCode;
    status = result.exitCode === 0 ? "completed" : "failed";
  } catch (error) {
    resultText = error instanceof Error ? error.message : "Unknown remediation execution error";
    status = "failed";
  }

  await updateIssueAction(supabase, userId, approved.id, {
    status,
    result_text: resultText,
    exit_code: exitCode,
    completed_at: new Date().toISOString(),
  });

  await appendIssueEvidence(supabase, userId, state.issue.id, {
    source_kind: "diagnostic",
    title: `Action result: ${approved.summary}`,
    detail: resultText || "No output returned.",
    metadata: {
      tool_name: approved.tool_name,
      target: approved.target,
      exit_code: exitCode,
      status,
    },
  });

  return true;
}

export async function runIssueAgent(
  supabase: SupabaseClient,
  userId: string,
  issueId: string
) {
  let cycles = 0;

  while (cycles < MAX_AGENT_CYCLES) {
    cycles += 1;
    let state = await loadIssue(supabase, userId, issueId);
    if (!state) return null;

    const ranApprovedAction = await executeApprovedActions(supabase, userId, state);
    if (ranApprovedAction) {
      continue;
    }

    const openProposal = state.actions.find((action) => action.status === "proposed" && action.requires_approval);
    if (openProposal) {
      await updateIssue(supabase, userId, issueId, { status: "waiting_for_approval" });
      return loadIssue(supabase, userId, issueId);
    }

    const telemetry = await gatherTelemetryContext(supabase, state.issue);
    const decision = await callDecisionModel(state, telemetry);

    const mergedConstraints = mergeStringLists(
      state.issue.operator_constraints,
      decision.constraints_to_add ?? [],
    );
    const mergedBlockedTools = mergeStringLists(
      state.issue.blocked_tools,
      decision.blocked_tools ?? [],
    );

    for (const note of decision.evidence_notes ?? []) {
      if (note.title && note.detail) {
        await appendIssueEvidence(supabase, userId, issueId, {
          source_kind: "analysis",
          title: note.title,
          detail: note.detail,
          metadata: {},
        });
      }
    }

    await updateIssue(supabase, userId, issueId, {
      summary: decision.summary,
      severity: decision.severity,
      status: decision.status,
      affected_nas: decision.affected_nas,
      current_hypothesis: decision.current_hypothesis,
      hypothesis_confidence: decision.hypothesis_confidence,
      next_step: decision.next_step,
      conversation_summary: decision.conversation_summary,
      operator_constraints: mergedConstraints,
      blocked_tools: mergedBlockedTools,
    });

    if (decision.diagnostic_action) {
      ensureAllowed(decision.diagnostic_action, "diagnostic");
      if (!mergedBlockedTools.includes(decision.diagnostic_action.tool_name) && !hasAlreadyTried(state, decision.diagnostic_action)) {
        await appendIssueMessage(supabase, userId, issueId, "agent", decision.response);
        await executeDiagnosticAction(supabase, userId, issueId, decision.diagnostic_action);
        continue;
      }
    }

    if (decision.remediation_action) {
      ensureAllowed(decision.remediation_action, "remediation");
      if (!mergedBlockedTools.includes(decision.remediation_action.tool_name) && !hasAlreadyTried(state, decision.remediation_action)) {
        if (!decision.remediation_action.target) {
          await updateIssue(supabase, userId, issueId, { status: "waiting_on_user" });
          await appendIssueMessage(
            supabase,
            userId,
            issueId,
            "agent",
            "I do not have a safe remediation target yet. I need one exact NAS target before I can ask you to approve a change."
          );
          break;
        }
        const commandPreview = buildCommandPreview(decision.remediation_action);
        await createIssueAction(supabase, userId, issueId, {
          kind: "remediation",
          target: decision.remediation_action.target,
          toolName: decision.remediation_action.tool_name,
          commandPreview,
          summary: decision.remediation_action.summary,
          reason: decision.remediation_action.reason,
          expectedOutcome: decision.remediation_action.expected_outcome,
          rollbackPlan: decision.remediation_action.rollback_plan ?? "",
          risk: decision.remediation_action.risk ?? "medium",
          requiresApproval: true,
          approvalToken: buildApprovalToken(decision.remediation_action.target, commandPreview),
        });
        await updateIssue(supabase, userId, issueId, { status: "waiting_for_approval" });
      } else {
        await updateIssue(supabase, userId, issueId, { status: "waiting_on_user" });
      }
    }

    await appendIssueMessage(supabase, userId, issueId, "agent", decision.response);

    if (decision.status === "resolved") {
      await updateIssue(supabase, userId, issueId, {
        status: "resolved",
        resolved_at: new Date().toISOString(),
      });
    }

    break;
  }

  return loadIssue(supabase, userId, issueId);
}

export async function seedIssueFromOrigin(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
  seedText: string
) {
  await appendIssueMessage(supabase, userId, issueId, "system", seedText);
  await appendIssueEvidence(supabase, userId, issueId, {
    source_kind: "analysis",
    title: "Issue seed",
    detail: seedText,
    metadata: {},
  });
}

export async function collectGlobalDiagnosticsSnapshot() {
  return collectNasDiagnostics(2);
}
