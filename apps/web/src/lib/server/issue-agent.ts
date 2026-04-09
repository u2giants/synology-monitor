import { collectNasDiagnostics, executeApprovedCommand } from "@/lib/server/nas";
import {
  appendIssueEvidence,
  appendIssueMessage,
  createIssueAction,
  loadIssue,
  type IssueAction,
  type IssueFull,
  type IssueSeverity,
  type SupabaseClient,
  updateIssue,
  updateIssueAction,
} from "@/lib/server/issue-store";
import { listCapabilityState, upsertCapabilityState } from "@/lib/server/capability-store";
import { attachFactToIssue, deriveFactsFromTelemetry, listIssueFacts, upsertFact } from "@/lib/server/fact-store";
import { recordIssueStageRun } from "@/lib/server/issue-stage-store";
import {
  explainIssueState,
  planIssueRemediation,
  planIssueNextStep,
  rankIssueHypothesis,
  verifyIssueAction,
  type ToolActionPlan,
  type HypothesisRankResult,
  type NextStepPlanResult,
} from "@/lib/server/issue-stage-models";
import {
  TOOL_DEFINITIONS,
  buildApprovalToken,
  type CopilotToolName,
  type NasTarget,
} from "@/lib/server/tools";

const MAX_AGENT_CYCLES = 3;

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
  "check_scheduled_tasks",
  "check_backup_status",
  "check_container_io",
];

const ALLOWED_REMEDIATION_TOOLS: CopilotToolName[] = [
  "restart_synology_drive_sharesync",
  "restart_synology_drive_server",
  "rename_file_to_old",
  "remove_invalid_chars",
  "trigger_sharesync_resync",
];

// Keep only the most recent row per unique field value (e.g. per task_id).
function dedupeLatestByField<T extends Record<string, unknown>>(items: T[], field: keyof T): T[] {
  const seen = new Set<unknown>();
  return items.filter((item) => {
    const key = item[field];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectResult<T>(
  label: string,
  result: { data: T[] | null; error: { message: string } | null },
  telemetryErrors: string[],
) {
  if (result.error) {
    telemetryErrors.push(`${label}: ${result.error.message}`);
    return [] as T[];
  }
  return result.data ?? [];
}

async function resolveNasUnitIds(
  supabase: SupabaseClient,
  nasNames: string[],
) {
  if (nasNames.length === 0) return [] as Array<{ id: string; name: string; hostname: string | null }>;
  const { data, error } = await supabase
    .from("smon_nas_units")
    .select("id, name, hostname")
    .or(nasNames.map((nas) => `name.eq.${nas},hostname.eq.${nas}`).join(","));

  if (error) {
    throw new Error(`Failed to resolve NAS units: ${error.message}`);
  }

  return (data ?? []) as Array<{ id: string; name: string; hostname: string | null }>;
}

async function syncTelemetryCapabilities(
  supabase: SupabaseClient,
  userId: string,
  issue: IssueFull["issue"],
  telemetry: Record<string, unknown>,
) {
  const startedAt = new Date().toISOString();
  const nasUnits = await resolveNasUnitIds(supabase, issue.affected_nas);
  if (nasUnits.length === 0) {
    await recordIssueStageRun(supabase, userId, issue.id, {
      stageKey: "capability_refresh",
      status: "skipped",
      modelTier: "deterministic",
      inputSummary: { affected_nas: issue.affected_nas },
      output: { reason: "no_resolved_nas_units" },
      startedAt,
    });
    return [];
  }

  const telemetryErrors = Array.isArray(telemetry.telemetry_errors) ? telemetry.telemetry_errors as string[] : [];
  const capabilities = [
    { key: "can_list_scheduled_tasks", label: "scheduled_tasks_with_issues" },
    { key: "can_list_hyperbackup_tasks", label: "backup_tasks" },
    { key: "can_list_snapshot_replication", label: "snapshot_replicas" },
    { key: "can_read_container_io", label: "container_io_top" },
    { key: "can_read_issue_telemetry", label: "logs" },
  ] as const;

  for (const nas of nasUnits) {
    for (const capability of capabilities) {
      const matchingError = telemetryErrors.find((entry) => entry.startsWith(`${capability.label}:`));
      await upsertCapabilityState(supabase, {
        nasId: nas.id,
        capabilityKey: capability.key,
        state: matchingError ? "degraded" : "supported",
        sourceKind: "issue_worker",
        evidence: matchingError ? "Telemetry query failed during issue run." : "Telemetry query succeeded during issue run.",
        rawError: matchingError ?? null,
        metadata: {
          issue_id: issue.id,
          issue_title: issue.title,
        },
      });
    }
  }

  const state = await listCapabilityState(supabase, nasUnits.map((nas) => nas.id));
  await recordIssueStageRun(supabase, userId, issue.id, {
    stageKey: "capability_refresh",
    status: "completed",
    modelTier: "deterministic",
    inputSummary: { affected_nas: issue.affected_nas, telemetry_error_count: telemetryErrors.length },
    output: { capability_count: state.length },
    startedAt,
  });
  return state;
}

async function syncIssueFacts(
  supabase: SupabaseClient,
  userId: string,
  state: IssueFull,
  telemetry: Record<string, unknown>,
) {
  const startedAt = new Date().toISOString();
  const derivedFacts = deriveFactsFromTelemetry(state.issue, telemetry);

  for (const fact of derivedFacts) {
    const factId = await upsertFact(supabase, fact);
    await attachFactToIssue(supabase, userId, state.issue.id, factId);
  }

  const facts = await listIssueFacts(supabase, userId, state.issue.id);
  await recordIssueStageRun(supabase, userId, state.issue.id, {
    stageKey: "fact_refresh",
    status: "completed",
    modelTier: "deterministic",
    inputSummary: { derived_fact_count: derivedFacts.length },
    output: { attached_fact_count: facts.length },
    startedAt,
  });
  return facts;
}

async function gatherTelemetryContext(supabase: SupabaseClient, issue: IssueFull["issue"]) {
  const since6h = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const since30m = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const nasFilter = issue.affected_nas.length > 0 ? issue.affected_nas : null;

  const [
    alertsResult,
    logsResult,
    processResult,
    diskResult,
    scheduledTasksResult,
    backupTasksResult,
    snapshotReplicasResult,
    containerIOResult,
    syncTasksResult,
    ioMetricsResult,
  ] = await Promise.all([
    supabase
      .from("smon_alerts")
      .select("id, source, severity, title, message, created_at")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(12),

    supabase
      .from("smon_logs")
      .select("id, nas_id, source, severity, message, metadata, ingested_at")
      .gte("ingested_at", since6h)
      .in("severity", ["critical", "error", "warning"])
      .order("ingested_at", { ascending: false })
      .limit(80),

    supabase
      .from("smon_process_snapshots")
      .select("nas_id, captured_at, name, username, cpu_pct, mem_pct, write_bps, parent_service")
      .gte("captured_at", since6h)
      .order("captured_at", { ascending: false })
      .limit(20),

    supabase
      .from("smon_disk_io_stats")
      .select("nas_id, captured_at, device, read_bps, write_bps, await_ms, util_pct")
      .gte("captured_at", since6h)
      .order("captured_at", { ascending: false })
      .limit(20),

    supabase
      .from("smon_scheduled_tasks")
      .select("nas_id, task_id, task_name, task_type, owner, enabled, status, last_run_time, next_run_time, last_result, captured_at")
      .gte("captured_at", since48h)
      .or("last_result.neq.0,status.eq.error")
      .order("captured_at", { ascending: false })
      .limit(20),

    supabase
      .from("smon_backup_tasks")
      .select("nas_id, task_id, task_name, enabled, status, last_result, last_run_time, next_run_time, dest_type, dest_name, total_bytes, transferred_bytes, speed_bps, captured_at")
      .gte("captured_at", since6h)
      .order("captured_at", { ascending: false })
      .limit(30),

    supabase
      .from("smon_snapshot_replicas")
      .select("nas_id, task_id, task_name, status, src_share, dst_share, dst_host, last_result, last_run_time, next_run_time, captured_at")
      .gte("captured_at", since6h)
      .order("captured_at", { ascending: false })
      .limit(20),

    supabase
      .from("smon_container_io")
      .select("nas_id, captured_at, container_name, read_bps, write_bps, read_ops, write_ops")
      .gte("captured_at", since30m)
      .order("write_bps", { ascending: false })
      .limit(15),

    supabase
      .from("smon_sync_task_snapshots")
      .select("nas_id, captured_at, task_id, task_name, status, backlog_count, backlog_bytes, current_file, retry_count, last_error, speed_bps")
      .gte("captured_at", since6h)
      .order("captured_at", { ascending: false })
      .limit(15),

    supabase
      .from("smon_metrics")
      .select("nas_id, type, value, unit, metadata, recorded_at")
      .gte("recorded_at", since30m)
      .in("type", [
        "cpu_iowait_pct",
        "nfs_read_bps", "nfs_write_bps", "nfs_calls_ps",
        "vm_pgpgout_ps", "vm_swap_out_ps", "vm_swap_in_ps",
      ])
      .order("recorded_at", { ascending: false })
      .limit(40),
  ]);

  const telemetry_errors: string[] = [];

  const alerts = collectResult("alerts", alertsResult, telemetry_errors);
  const logs = collectResult("logs", logsResult, telemetry_errors).filter((row) => {
    if (!nasFilter?.length) return true;
    const nasValue = typeof row.nas_id === "string" ? row.nas_id : "";
    return nasFilter.some((nas) => nasValue.includes(nas) || String((row.metadata as Record<string, unknown> | null)?.nas_name ?? "").includes(nas));
  });

  return {
    alerts,
    logs,
    telemetry_errors,
    top_processes: collectResult("top_processes", processResult, telemetry_errors),
    disk_io: collectResult("disk_io", diskResult, telemetry_errors),
    scheduled_tasks_with_issues: collectResult("scheduled_tasks_with_issues", scheduledTasksResult, telemetry_errors),
    backup_tasks: dedupeLatestByField(collectResult("backup_tasks", backupTasksResult, telemetry_errors), "task_id"),
    snapshot_replicas: dedupeLatestByField(collectResult("snapshot_replicas", snapshotReplicasResult, telemetry_errors), "task_id"),
    container_io_top: collectResult("container_io_top", containerIOResult, telemetry_errors),
    sharesync_tasks: dedupeLatestByField(collectResult("sharesync_tasks", syncTasksResult, telemetry_errors), "task_id"),
    io_pressure_metrics: collectResult("io_pressure_metrics", ioMetricsResult, telemetry_errors),
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

function mergeStringLists(...lists: string[][]) {
  return Array.from(new Set(lists.flat().map((item) => item.trim()).filter(Boolean)));
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

function hasAlreadyTried(state: IssueFull, plan: ToolActionPlan) {
  const fp = actionFingerprint(plan);
  return state.actions.some((action) =>
    actionFingerprint({
      tool_name: action.tool_name,
      target: action.target,
      filter: action.command_preview,
    }) === fp || (
      action.tool_name === plan.tool_name &&
      action.target === plan.target &&
      (action.status === "rejected" || action.status === "completed" || action.status === "failed")
    ),
  );
}

async function appendEvidenceNotes(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
  notes: Array<{ title: string; detail: string }>,
) {
  for (const note of notes) {
    if (!note.title || !note.detail) continue;
    await appendIssueEvidence(supabase, userId, issueId, {
      source_kind: "analysis",
      title: note.title,
      detail: note.detail,
      metadata: {},
    });
  }
}

function toolDescriptions(toolNames: CopilotToolName[]) {
  return toolNames.map((toolName) => ({
    tool_name: toolName,
    description: TOOL_DEFINITIONS[toolName].description,
  }));
}

function buildAgentResponse(
  response: string,
  plan: NextStepPlanResult,
) {
  const parts: string[] = [];
  const trimmedResponse = response.trim();
  const userQuestion = plan.user_question?.trim() ?? "";

  if (trimmedResponse) {
    parts.push(trimmedResponse);
  }

  if (userQuestion) {
    const alreadyIncluded = trimmedResponse.toLowerCase().includes(userQuestion.toLowerCase());
    if (!alreadyIncluded) {
      parts.push(`I need one answer from you before I can continue: ${userQuestion}`);
    }
  }

  if (plan.status === "waiting_for_approval" && plan.remediation_action) {
    const approvalPrompt = `Approve or reject this action: ${plan.remediation_action.summary}`;
    const alreadyIncluded = trimmedResponse.toLowerCase().includes("approve")
      || trimmedResponse.toLowerCase().includes(plan.remediation_action.summary.toLowerCase());
    if (!alreadyIncluded) {
      parts.push(approvalPrompt);
    }
  }

  if (parts.length === 0 && plan.next_step.trim()) {
    parts.push(plan.next_step.trim());
  }

  return parts.join("\n\n").trim();
}

async function runHypothesisStage(
  supabase: SupabaseClient,
  userId: string,
  state: IssueFull,
  telemetry: Record<string, unknown>,
) {
  const startedAt = new Date().toISOString();
  try {
    const { model, parsed } = await rankIssueHypothesis({
      issue: state.issue,
      recent_messages: summarizeMessages(state),
      recent_evidence: summarizeEvidence(state),
      recent_actions: summarizeActionHistory(state.actions),
      telemetry,
    });
    await recordIssueStageRun(supabase, userId, state.issue.id, {
      stageKey: "hypothesis_rank",
      status: "completed",
      modelName: model,
      modelTier: "reasoner",
      inputSummary: {
        message_count: state.messages.length,
        evidence_count: state.evidence.length,
        action_count: state.actions.length,
        fact_count: Array.isArray(telemetry.normalized_facts) ? telemetry.normalized_facts.length : 0,
      },
      output: parsed as unknown as Record<string, unknown>,
      startedAt,
    });
    return parsed;
  } catch (error) {
    await recordIssueStageRun(supabase, userId, state.issue.id, {
      stageKey: "hypothesis_rank",
      status: "failed",
      modelTier: "reasoner",
      inputSummary: { message_count: state.messages.length },
      errorText: error instanceof Error ? error.message : "Unknown hypothesis stage error",
      startedAt,
    });
    throw error;
  }
}

async function runPlanningStage(
  supabase: SupabaseClient,
  userId: string,
  state: IssueFull,
  telemetry: Record<string, unknown>,
  hypothesis: HypothesisRankResult,
) {
  const startedAt = new Date().toISOString();
  try {
    const recentActions = summarizeActionHistory(state.actions);
    const completedDiagnosticCount = state.actions.filter(
      (a) => a.kind === "diagnostic" && (a.status === "completed" || a.status === "failed"),
    ).length;
    const { model, parsed } = await planIssueNextStep({
      issue: state.issue,
      hypothesis,
      telemetry,
      recent_actions: recentActions.map((a) => ({
        tool_name: a.tool_name ?? "",
        status: a.status,
        summary: a.summary ?? "",
        result_text: a.result_text,
      })),
      completed_diagnostic_count: completedDiagnosticCount,
      allowed_diagnostic_tools: toolDescriptions(ALLOWED_DIAGNOSTIC_TOOLS),
      allowed_remediation_tools: toolDescriptions(ALLOWED_REMEDIATION_TOOLS),
    });
    await recordIssueStageRun(supabase, userId, state.issue.id, {
      stageKey: "next_step_plan",
      status: "completed",
      modelName: model,
      modelTier: "reasoner",
      inputSummary: {
        hypothesis_confidence: hypothesis.hypothesis_confidence,
        blocked_tool_count: state.issue.blocked_tools.length,
        completed_diagnostic_count: completedDiagnosticCount,
        recent_action_count: recentActions.length,
      },
      output: parsed as unknown as Record<string, unknown>,
      startedAt,
    });
    return parsed;
  } catch (error) {
    await recordIssueStageRun(supabase, userId, state.issue.id, {
      stageKey: "next_step_plan",
      status: "failed",
      modelTier: "reasoner",
      inputSummary: { issue_status: state.issue.status },
      errorText: error instanceof Error ? error.message : "Unknown next-step planning error",
      startedAt,
    });
    throw error;
  }
}

async function runRemediationStage(
  supabase: SupabaseClient,
  userId: string,
  state: IssueFull,
  telemetry: Record<string, unknown>,
  hypothesis: HypothesisRankResult,
  plan: NextStepPlanResult,
) {
  const startedAt = new Date().toISOString();
  try {
    const { model, parsed } = await planIssueRemediation({
      issue: state.issue,
      hypothesis,
      plan,
      telemetry,
      allowed_remediation_tools: toolDescriptions(ALLOWED_REMEDIATION_TOOLS),
    });
    await recordIssueStageRun(supabase, userId, state.issue.id, {
      stageKey: "next_step_plan",
      status: "completed",
      modelName: model,
      modelTier: "remediation_planner",
      inputSummary: {
        initial_status: plan.status,
        had_remediation_candidate: Boolean(plan.remediation_action),
      },
      output: parsed as unknown as Record<string, unknown>,
      startedAt,
    });
    return parsed;
  } catch (error) {
    await recordIssueStageRun(supabase, userId, state.issue.id, {
      stageKey: "next_step_plan",
      status: "failed",
      modelTier: "remediation_planner",
      inputSummary: { issue_status: state.issue.status },
      errorText: error instanceof Error ? error.message : "Unknown remediation planning error",
      startedAt,
    });
    throw error;
  }
}

async function runExplanationStage(
  supabase: SupabaseClient,
  userId: string,
  state: IssueFull,
  hypothesis: HypothesisRankResult,
  plan: NextStepPlanResult,
) {
  const startedAt = new Date().toISOString();
  try {
    const { model, parsed } = await explainIssueState({
      issue: state.issue,
      hypothesis,
      plan,
    });
    await recordIssueStageRun(supabase, userId, state.issue.id, {
      stageKey: "operator_explanation",
      status: "completed",
      modelName: model,
      modelTier: "explainer",
      inputSummary: {
        status: plan.status,
        next_step: plan.next_step,
      },
      output: parsed as unknown as Record<string, unknown>,
      startedAt,
    });
    return parsed;
  } catch (error) {
    await recordIssueStageRun(supabase, userId, state.issue.id, {
      stageKey: "operator_explanation",
      status: "failed",
      modelTier: "explainer",
      inputSummary: { issue_status: state.issue.status },
      errorText: error instanceof Error ? error.message : "Unknown operator explanation error",
      startedAt,
    });
    throw error;
  }
}

async function runVerificationStage(
  supabase: SupabaseClient,
  userId: string,
  state: IssueFull,
  action: IssueAction,
  telemetry: Record<string, unknown>,
) {
  const startedAt = new Date().toISOString();
  try {
    const { model, parsed } = await verifyIssueAction({
      issue: state.issue,
      action,
      telemetry,
    });
    await recordIssueStageRun(supabase, userId, state.issue.id, {
      stageKey: "verification",
      status: "completed",
      modelName: model,
      modelTier: "verifier",
      inputSummary: {
        tool_name: action.tool_name,
        action_status: action.status,
      },
      output: parsed as unknown as Record<string, unknown>,
      startedAt,
    });
    return parsed;
  } catch (error) {
    await recordIssueStageRun(supabase, userId, state.issue.id, {
      stageKey: "verification",
      status: "failed",
      modelTier: "verifier",
      inputSummary: { tool_name: action.tool_name },
      errorText: error instanceof Error ? error.message : "Unknown verification error",
      startedAt,
    });
    throw error;
  }
}

async function executeDiagnosticAction(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
  plan: ToolActionPlan,
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

async function executeApprovedActions(
  supabase: SupabaseClient,
  userId: string,
  state: IssueFull,
) {
  const approved = state.actions.find((action) => action.status === "approved");
  if (!approved) return null;

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

  return {
    ...approved,
    status,
    result_text: resultText,
    exit_code: exitCode,
    completed_at: new Date().toISOString(),
  } as IssueAction;
}

async function refreshIssueContext(
  supabase: SupabaseClient,
  userId: string,
  state: IssueFull,
) {
  const telemetry = await gatherTelemetryContext(supabase, state.issue);
  const [facts, capability_state] = await Promise.all([
    syncIssueFacts(supabase, userId, state, telemetry),
    syncTelemetryCapabilities(supabase, userId, state.issue, telemetry),
  ]);

  return {
    ...telemetry,
    normalized_facts: facts.map((fact) => ({
      fact_type: fact.fact_type,
      severity: fact.severity,
      title: fact.title,
      detail: fact.detail,
      value: fact.value,
    })),
    capability_state: capability_state.map((record) => ({
      nas_id: record.nas_id,
      capability_key: record.capability_key,
      state: record.state,
      evidence: record.evidence,
      raw_error: record.raw_error,
    })),
  };
}

async function applyHypothesisAndPlan(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
  state: IssueFull,
  hypothesis: HypothesisRankResult,
  plan: NextStepPlanResult,
  summary: string,
) {
  const mergedConstraints = mergeStringLists(
    state.issue.operator_constraints,
    plan.constraints_to_add ?? [],
  );
  const mergedBlockedTools = mergeStringLists(
    state.issue.blocked_tools,
    plan.blocked_tools ?? [],
  );

  await appendEvidenceNotes(supabase, userId, issueId, plan.evidence_notes ?? []);

  await updateIssue(supabase, userId, issueId, {
    summary,
    severity: hypothesis.severity,
    status: plan.status,
    affected_nas: hypothesis.affected_nas,
    current_hypothesis: hypothesis.current_hypothesis,
    hypothesis_confidence: hypothesis.hypothesis_confidence,
    next_step: plan.next_step,
    conversation_summary: hypothesis.conversation_summary,
    operator_constraints: mergedConstraints,
    blocked_tools: mergedBlockedTools,
  });

  return { mergedConstraints, mergedBlockedTools };
}

function deriveTerminalPlanStatus(
  state: IssueFull,
  plan: NextStepPlanResult,
  hasPendingApproval: boolean,
) {
  if (hasPendingApproval) return "waiting_for_approval" as const;
  if (plan.status !== "waiting_on_user") return plan.status;
  if (plan.user_question?.trim()) return "waiting_on_user" as const;
  return "stuck" as const;
}

export async function runIssueAgent(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
) {
  let cycles = 0;

  while (cycles < MAX_AGENT_CYCLES) {
    cycles += 1;
    let state = await loadIssue(supabase, userId, issueId);
    if (!state) return null;

    const executedAction = await executeApprovedActions(supabase, userId, state);
    if (executedAction) {
      state = await loadIssue(supabase, userId, issueId);
      if (!state) return null;
      const telemetry = await refreshIssueContext(supabase, userId, state);
      const verification = await runVerificationStage(supabase, userId, state, executedAction, telemetry);
      await appendEvidenceNotes(supabase, userId, issueId, verification.evidence_notes ?? []);
      await updateIssue(supabase, userId, issueId, {
        summary: verification.summary,
        status: verification.status,
        current_hypothesis: verification.current_hypothesis,
        hypothesis_confidence: verification.hypothesis_confidence,
        next_step: verification.next_step,
        conversation_summary: verification.conversation_summary,
        resolved_at: verification.status === "resolved" ? new Date().toISOString() : null,
      });
      await appendIssueMessage(supabase, userId, issueId, "agent", verification.response);
      return loadIssue(supabase, userId, issueId);
    }

    const openProposal = state.actions.find((action) => action.status === "proposed" && action.requires_approval);
    if (openProposal) {
      await updateIssue(supabase, userId, issueId, { status: "waiting_for_approval" });
      return loadIssue(supabase, userId, issueId);
    }

    const telemetry = await refreshIssueContext(supabase, userId, state);
    const hypothesis = await runHypothesisStage(supabase, userId, state, telemetry);
    let plan = await runPlanningStage(supabase, userId, state, telemetry, hypothesis);
    if (plan.remediation_action) {
      plan = await runRemediationStage(supabase, userId, state, telemetry, hypothesis, plan);
    }
    const explanation = await runExplanationStage(supabase, userId, state, hypothesis, plan);
    const agentResponse = buildAgentResponse(explanation.response, plan);

    const { mergedBlockedTools } = await applyHypothesisAndPlan(
      supabase,
      userId,
      issueId,
      state,
      hypothesis,
      plan,
      explanation.summary,
    );

    if (plan.diagnostic_action) {
      ensureAllowed(plan.diagnostic_action, "diagnostic");
      if (!mergedBlockedTools.includes(plan.diagnostic_action.tool_name) && !hasAlreadyTried(state, plan.diagnostic_action)) {
        await appendIssueMessage(supabase, userId, issueId, "agent", agentResponse);
        await executeDiagnosticAction(supabase, userId, issueId, plan.diagnostic_action);
        continue;
      }
    }

    if (plan.remediation_action) {
      ensureAllowed(plan.remediation_action, "remediation");
      if (!mergedBlockedTools.includes(plan.remediation_action.tool_name) && !hasAlreadyTried(state, plan.remediation_action)) {
        if (!plan.remediation_action.target) {
          await updateIssue(supabase, userId, issueId, { status: "waiting_on_user" });
          await appendIssueMessage(
            supabase,
            userId,
            issueId,
            "agent",
            "I do not have a safe remediation target yet. I need one exact NAS or file target before I can ask you to approve a change.",
          );
          return loadIssue(supabase, userId, issueId);
        }
        const commandPreview = buildCommandPreview(plan.remediation_action);
        await createIssueAction(supabase, userId, issueId, {
          kind: "remediation",
          target: plan.remediation_action.target,
          toolName: plan.remediation_action.tool_name,
          commandPreview,
          summary: plan.remediation_action.summary,
          reason: plan.remediation_action.reason,
          expectedOutcome: plan.remediation_action.expected_outcome,
          rollbackPlan: plan.remediation_action.rollback_plan ?? "",
          risk: plan.remediation_action.risk ?? "medium",
          requiresApproval: true,
          approvalToken: buildApprovalToken(plan.remediation_action.target, commandPreview),
        });
        await updateIssue(supabase, userId, issueId, { status: "waiting_for_approval" });
      } else {
        await updateIssue(supabase, userId, issueId, {
          status: deriveTerminalPlanStatus(state, plan, false),
        });
      }
    }

    const remediationPlan = plan.remediation_action;
    const hasPendingApproval = remediationPlan
      ? !mergedBlockedTools.includes(remediationPlan.tool_name)
        && !hasAlreadyTried(state, remediationPlan)
        && Boolean(remediationPlan.target)
      : false;
    const finalStatus = deriveTerminalPlanStatus(state, plan, hasPendingApproval);

    await updateIssue(supabase, userId, issueId, { status: finalStatus });
    await appendIssueMessage(supabase, userId, issueId, "agent", agentResponse);

    if (finalStatus === "resolved") {
      await updateIssue(supabase, userId, issueId, {
        status: "resolved",
        resolved_at: new Date().toISOString(),
      });
    }

    return loadIssue(supabase, userId, issueId);
  }

  return loadIssue(supabase, userId, issueId);
}

export async function seedIssueFromOrigin(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
  seedText: string,
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
