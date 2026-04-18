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
  compressLogsToFacts,
  consolidateIssueMemory,
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
  buildNasApiApprovalToken,
  collectNasDiagnostics,
  nasApiExec,
  resolveNasApiConfig,
} from "@/lib/server/nas-api-client";
import {
  classifyIssueSubjects,
  loadMemoriesForIssue,
  saveMemories,
} from "@/lib/server/agent-memory-store";
import { loadDriveForensics, buildDriveForensicFacts } from "@/lib/server/forensics-drive";
import { loadBackupCleanupTimeline, buildBackupTimelineFacts } from "@/lib/server/forensics-hyperbackup";

const MAX_AGENT_CYCLES = 8;

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
    .from("nas_units")
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

  // 1. Deterministic rule-based facts (thresholds, status checks)
  const derivedFacts = deriveFactsFromTelemetry(state.issue, telemetry);
  for (const fact of derivedFacts) {
    const factId = await upsertFact(supabase, fact);
    await attachFactToIssue(supabase, userId, state.issue.id, factId);
  }

  // 2. Model-driven log compression (cheap extractor model).
  //    Turns raw log rows into pattern summaries and anomaly facts so the
  //    expensive hypothesis/planner models never see the raw noise.
  const nasContext = state.issue.affected_nas[0] ?? "unknown";
  let compressedFactCount = 0;
  let compressorModel = "none";
  try {
    const { model, facts: logFacts } = await compressLogsToFacts({
      logs: Array.isArray(telemetry.logs) ? telemetry.logs as Array<Record<string, unknown>> : [],
      audit_logs: Array.isArray(telemetry.audit_logs) ? telemetry.audit_logs as Array<Record<string, unknown>> : [],
      nas_context: nasContext,
    });
    compressorModel = model;

    for (const lf of logFacts) {
      const factId = await upsertFact(supabase, {
        nasId: nasContext,
        factType: lf.is_anomaly ? "log_anomaly" : "log_pattern",
        // Key by source so pattern facts upsert in place each tick;
        // anomaly keys include title hash to preserve distinct events.
        factKey: lf.is_anomaly
          ? `log-anomaly:${nasContext}:${lf.source}:${lf.title.slice(0, 60).replace(/\s+/g, "-").toLowerCase()}`
          : `log-pattern:${nasContext}:${lf.source}`,
        severity: lf.severity,
        title: lf.title,
        detail: lf.detail,
        value: { source: lf.source, is_anomaly: lf.is_anomaly },
      });
      await attachFactToIssue(supabase, userId, state.issue.id, factId);
      compressedFactCount++;
    }
  } catch (err) {
    // Non-fatal — deterministic facts still available
    console.error("[syncIssueFacts] log compressor failed:", err);
  }

  // 3. Forensic Drive attribution and delete/rename classification.
  //    Only runs when there is evidence of Drive churn in recent logs.
  let forensicDriveFactCount = 0;
  try {
    const driveChurnInLogs = (
      Array.isArray(telemetry.logs) ? telemetry.logs as Array<Record<string, unknown>> : []
    ).some((row) => row.source === "drive_churn_signal" || row.source === "drive_client_attribution");

    if (driveChurnInLogs || state.issue.affected_nas.length > 0) {
      const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      const { attribution, eventSummary } = await loadDriveForensics(
        supabase,
        state.issue.affected_nas,
        since48h,
      );

      const nasId = nasContext;
      const attrForNas = attribution.find((a) => a.nas_id.includes(nasId) || nasId.includes(a.nas_id));
      const summaryForNas = eventSummary.find((s) => s.nas_id.includes(nasId) || nasId.includes(s.nas_id));

      const driveFacts = buildDriveForensicFacts(nasId, attrForNas, summaryForNas);
      for (const fact of driveFacts) {
        const factId = await upsertFact(supabase, fact);
        await attachFactToIssue(supabase, userId, state.issue.id, factId);
        forensicDriveFactCount++;
      }
    }
  } catch (err) {
    console.error("[syncIssueFacts] drive forensics failed:", err);
  }

  // 4. Forensic Hyper Backup cleanup timeline.
  //    Only runs when backup tasks are in scope and there is evidence of issues.
  let forensicBackupFactCount = 0;
  try {
    const backupTasksInTelemetry = Array.isArray(telemetry.backup_tasks)
      ? telemetry.backup_tasks as Array<Record<string, unknown>>
      : [];
    const hasBackupActivity =
      backupTasksInTelemetry.length > 0 ||
      state.issue.title.toLowerCase().includes("backup") ||
      state.issue.title.toLowerCase().includes("hyper");

    if (hasBackupActivity && state.issue.affected_nas.length > 0) {
      for (const nasName of state.issue.affected_nas) {
        try {
          const timeline = await loadBackupCleanupTimeline(nasName);
          if (timeline) {
            const backupFacts = buildBackupTimelineFacts(nasContext, timeline);
            for (const fact of backupFacts) {
              const factId = await upsertFact(supabase, fact);
              await attachFactToIssue(supabase, userId, state.issue.id, factId);
              forensicBackupFactCount++;
            }
          }
        } catch (err) {
          console.error(`[syncIssueFacts] backup timeline failed for ${nasName}:`, err);
        }
      }
    }
  } catch (err) {
    console.error("[syncIssueFacts] backup forensics failed:", err);
  }

  const facts = await listIssueFacts(supabase, userId, state.issue.id);
  await recordIssueStageRun(supabase, userId, state.issue.id, {
    stageKey: "fact_refresh",
    status: "completed",
    modelTier: "deterministic",
    inputSummary: {
      derived_fact_count: derivedFacts.length,
      compressed_log_fact_count: compressedFactCount,
      forensic_drive_fact_count: forensicDriveFactCount,
      forensic_backup_fact_count: forensicBackupFactCount,
    },
    output: { attached_fact_count: facts.length, compressor_model: compressorModel },
    startedAt,
  });
  return facts;
}

async function gatherTelemetryContext(supabase: SupabaseClient, userId: string, issue: IssueFull["issue"]) {
  const since6h = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const since30m = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const nasFilter = issue.affected_nas.length > 0 ? issue.affected_nas : null;

  // Kick off memory loading in parallel with telemetry queries.
  // Classified by subject so only relevant topics are loaded.
  const memoriesPromise = loadMemoriesForIssue(
    supabase,
    userId,
    classifyIssueSubjects(issue),
    issue.affected_nas.length > 0 ? issue.affected_nas : undefined,
  );

  const [
    alertsResult,
    logsResult,
    storageLogsResult,
    processResult,
    diskResult,
    scheduledTasksResult,
    backupTasksResult,
    snapshotReplicasResult,
    containerIOResult,
    syncTasksResult,
    ioMetricsResult,
    storageSnapshotsResult,
    dsmErrorsResult,
  ] = await Promise.all([
    supabase
      .from("alerts")
      .select("id, source, severity, title, message, created_at")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(12),

    // Noisy polling sources (share_config, package_health, drive_server,
    // dsm_system_log, backup) — warning+ only, 6h.  At info level these emit
    // hundreds of routine enumeration rows per hour that add no diagnostic
    // signal and fill the context window.
    supabase
      .from("nas_logs")
      .select("id, nas_id, source, severity, message, metadata, ingested_at")
      .gte("ingested_at", since6h)
      .in("severity", ["critical", "error", "warning"])
      .not("source", "in", '("system","storage","scheduled_task","share_quota","share_health")')
      .order("ingested_at", { ascending: false })
      .limit(60),

    // High-signal sources — all severities (including info), 48h window.
    // - system: SSH logins, DSM API authentications, invoked errors.
    //   These are info-level but are the triggering events for anomalous
    //   host-level processes (e.g. a curl-to-DSM auth 34s before rogue greps
    //   start is invisible if info is filtered).
    // - storage: RAID state changes, replication — relevant even when healthy.
    // - scheduled_task: task completions are info-level but form the trigger
    //   trail for scripts that spawn child processes.
    // - share_quota / share_health: low volume, all severities useful.
    supabase
      .from("nas_logs")
      .select("id, nas_id, source, severity, message, metadata, ingested_at")
      .gte("ingested_at", since48h)
      .in("source", ["system", "storage", "scheduled_task", "share_quota", "share_health"])
      .order("ingested_at", { ascending: false })
      .limit(80),

    supabase
      .from("process_snapshots")
      // cmdline and pid are essential: without them the agent sees "grep" but
      // not what it's scanning for, making foreign/stuck processes invisible.
      // read_bps surfaces I/O-heavy processes that don't show up in CPU ranking.
      .select("nas_id, captured_at, pid, name, cmdline, username, cpu_pct, mem_pct, read_bps, write_bps, parent_service")
      .gte("captured_at", since6h)
      .order("captured_at", { ascending: false })
      .limit(20),

    supabase
      .from("disk_io_stats")
      .select("nas_id, captured_at, device, read_bps, write_bps, await_ms, util_pct")
      .gte("captured_at", since6h)
      .order("captured_at", { ascending: false })
      .limit(20),

    supabase
      .from("scheduled_tasks")
      .select("nas_id, task_id, task_name, task_type, owner, enabled, status, last_run_time, next_run_time, last_result, captured_at")
      .gte("captured_at", since48h)
      .or("last_result.neq.0,status.eq.error")
      .order("captured_at", { ascending: false })
      .limit(20),

    supabase
      .from("backup_tasks")
      .select("nas_id, task_id, task_name, enabled, status, last_result, last_run_time, next_run_time, dest_type, dest_name, total_bytes, transferred_bytes, speed_bps, captured_at")
      .gte("captured_at", since6h)
      .order("captured_at", { ascending: false })
      .limit(30),

    supabase
      .from("snapshot_replicas")
      .select("nas_id, task_id, task_name, status, src_share, dst_share, dst_host, last_result, last_run_time, next_run_time, captured_at")
      .gte("captured_at", since6h)
      .order("captured_at", { ascending: false })
      .limit(20),

    supabase
      .from("container_io")
      .select("nas_id, captured_at, container_name, read_bps, write_bps, read_ops, write_ops")
      .gte("captured_at", since30m)
      .order("write_bps", { ascending: false })
      .limit(15),

    supabase
      .from("sync_task_snapshots")
      .select("nas_id, captured_at, task_id, task_name, status, backlog_count, backlog_bytes, current_file, retry_count, last_error, speed_bps")
      .gte("captured_at", since6h)
      .order("captured_at", { ascending: false })
      .limit(15),

    supabase
      .from("metrics")
      .select("nas_id, type, value, unit, metadata, recorded_at")
      .gte("recorded_at", since30m)
      .in("type", [
        "cpu_iowait_pct",
        "hyperbackup_last_new_files",
        "hyperbackup_last_removed_files",
        "hyperbackup_last_renamed_files",
        "hyperbackup_last_copy_miss_files",
        "drive_log_rename_hits",
        "drive_log_delete_hits",
        "drive_log_move_hits",
        "drive_log_conflict_hits",
        "drive_log_connect_hits",
        "drive_log_disconnect_hits",
        "drive_log_mac_hits",
        "nfs_read_bps", "nfs_write_bps", "nfs_calls_ps",
        "vm_pgpgout_ps", "vm_swap_out_ps", "vm_swap_in_ps",
      ])
      .order("recorded_at", { ascending: false })
      .limit(40),

    // Structured DSM volume/RAID state — the authoritative source for storage
    // health.  Includes status (normal/degraded/crashed), raid_type, and disk
    // member details.  48h window so recovery context is preserved.
    supabase
      .from("storage_snapshots")
      .select("nas_id, volume_id, volume_path, total_bytes, used_bytes, status, raid_type, disks, recorded_at")
      .gte("recorded_at", since48h)
      .order("recorded_at", { ascending: false })
      .limit(20),

    // DSM Log Center errors — warning/error events from the NAS OS itself,
    // separate from the high-volume smon_logs stream.
    supabase
      .from("dsm_errors")
      .select("nas_id, level, message, who, log_name, logged_at, created_at")
      .gte("logged_at", since48h)
      .order("logged_at", { ascending: false })
      .limit(30),
  ]);

  const telemetry_errors: string[] = [];

  const alerts = collectResult("alerts", alertsResult, telemetry_errors);
  const logs = collectResult("logs", logsResult, telemetry_errors).filter((row) => {
    if (!nasFilter?.length) return true;
    const nasValue = typeof row.nas_id === "string" ? row.nas_id : "";
    return nasFilter.some((nas) => nasValue.includes(nas) || String((row.metadata as Record<string, unknown> | null)?.nas_name ?? "").includes(nas));
  });

  // High-signal logs (system, storage, scheduled_task, share_quota/health)
  // with 48h window and all severities — apply same NAS filter as general logs.
  const audit_logs = collectResult("audit_logs", storageLogsResult, telemetry_errors).filter((row) => {
    if (!nasFilter?.length) return true;
    const nasValue = typeof row.nas_id === "string" ? row.nas_id : "";
    return nasFilter.some((nas) => nasValue.includes(nas) || String((row.metadata as Record<string, unknown> | null)?.nas_name ?? "").includes(nas));
  });

  // Sibling issues: other open/active investigations for this user.
  // Passed to the planner so it can recognise cross-issue dependencies
  // (e.g. "ShareSync failures caused by disk I/O pressure on the same NAS").
  const siblingResult = await supabase
    .from("issues")
    .select("id, title, summary, status, affected_nas, current_hypothesis")
    .eq("user_id", userId)
    .neq("id", issue.id)
    .not("status", "in", '("resolved","cancelled")')
    .order("updated_at", { ascending: false })
    .limit(10);

  const sibling_issues = (siblingResult.data ?? []).map((s) => ({
    id: s.id as string,
    title: s.title as string,
    summary: s.summary as string,
    status: s.status as string,
    affected_nas: Array.isArray(s.affected_nas) ? s.affected_nas as string[] : [],
    current_hypothesis: s.current_hypothesis as string | null,
  }));

  // Resolve memories (started in parallel above; nearly always resolved by now)
  const agentMemory = await memoriesPromise;

  return {
    alerts,
    logs,
    audit_logs,
    telemetry_errors,
    top_processes: collectResult("top_processes", processResult, telemetry_errors),
    disk_io: collectResult("disk_io", diskResult, telemetry_errors),
    scheduled_tasks_with_issues: collectResult("scheduled_tasks_with_issues", scheduledTasksResult, telemetry_errors),
    backup_tasks: dedupeLatestByField(collectResult("backup_tasks", backupTasksResult, telemetry_errors), "task_id"),
    snapshot_replicas: dedupeLatestByField(collectResult("snapshot_replicas", snapshotReplicasResult, telemetry_errors), "task_id"),
    container_io_top: collectResult("container_io_top", containerIOResult, telemetry_errors),
    sharesync_tasks: dedupeLatestByField(collectResult("sharesync_tasks", syncTasksResult, telemetry_errors), "task_id"),
    io_pressure_metrics: collectResult("io_pressure_metrics", ioMetricsResult, telemetry_errors),
    storage_snapshots: dedupeLatestByField(collectResult("storage_snapshots", storageSnapshotsResult, telemetry_errors), "volume_id"),
    dsm_errors: collectResult("dsm_errors", dsmErrorsResult, telemetry_errors),
    // Persistent knowledge from past resolved issues — loaded per-subject so
    // only relevant topics are included (e.g. HyperBackup memories for backup issues).
    agent_memory: agentMemory.map((m) => ({
      subject: m.subject,
      memory_type: m.memory_type,
      title: m.title,
      content: m.content,
      tags: m.tags,
      nas_id: m.nas_id,
    })),
    // Other open investigations for this user. The planner uses this to detect
    // cross-issue dependencies (e.g. "my root cause is another active issue").
    sibling_issues,
  };
}

function summarizeActionHistory(actions: IssueAction[]) {
  return actions.slice(-10).map((action) => ({
    kind: action.kind,
    status: action.status,
    command: action.command_preview,
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

function hasAlreadyTried(state: IssueFull, plan: ToolActionPlan) {
  const cmd = plan.command?.trim();
  if (!cmd) return false;
  return state.actions.some((action) => {
    const sameCommand = action.command_preview?.trim() === cmd;
    const sameTarget = action.target === plan.target;
    if (sameCommand && sameTarget) return true;
    // Also block if the same command was tried on any target and failed/completed
    if (sameCommand && (action.status === "rejected" || action.status === "completed" || action.status === "failed")) return true;
    return false;
  });
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

  const gaps = (plan.tool_gaps ?? []).filter(Boolean);
  if (gaps.length > 0) {
    parts.push(
      `**Capability gaps identified** (actions needed but not currently possible):\n${gaps.map((g) => `- ${g}`).join("\n")}`,
    );
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
        command: a.command ?? "",
        status: a.status,
        summary: a.summary ?? "",
        result_text: a.result_text,
      })),
      completed_diagnostic_count: completedDiagnosticCount,
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
  const actionId = await createIssueAction(supabase, userId, issueId, {
    kind: "diagnostic",
    target: plan.target,
    toolName: `shell:tier${plan.tier}`,
    commandPreview: plan.command,
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
    const nasConfig = plan.target ? resolveNasApiConfig(plan.target) : null;
    if (!nasConfig) {
      throw new Error(`No NAS API config found for target: ${plan.target ?? "(none)"}`);
    }
    const result = await nasApiExec(nasConfig, plan.command, plan.tier as 1 | 2 | 3);
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = result.exit_code;
    status = result.exit_code === 0 ? "completed" : "failed";
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
    title: plan.summary,
    detail: resultText || "No output returned.",
    metadata: {
      command: plan.command,
      tier: plan.tier,
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
    const nasConfig = approved.target ? resolveNasApiConfig(approved.target) : null;
    if (!nasConfig) {
      throw new Error(`No NAS API config found for target: ${approved.target ?? "(none)"}`);
    }
    // Recover tier from tool_name (stored as "shell:tier2", "shell:tier3")
    const tierMatch = approved.tool_name?.match(/shell:tier(\d)/);
    const tier = tierMatch ? (Number(tierMatch[1]) as 1 | 2 | 3) : 2;
    const result = await nasApiExec(
      nasConfig,
      approved.command_preview,
      tier,
      approved.approval_token ?? undefined,
      90_000,
    );
    resultText = [result.stdout, result.stderr].filter(Boolean).join("\n\n").slice(0, 12000);
    exitCode = result.exit_code;
    status = result.exit_code === 0 ? "completed" : "failed";
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
  const telemetry = await gatherTelemetryContext(supabase, userId, state.issue);
  const [facts, capability_state] = await Promise.all([
    syncIssueFacts(supabase, userId, state, telemetry),
    syncTelemetryCapabilities(supabase, userId, state.issue, telemetry),
  ]);

  // Strip raw log arrays — their signal is now captured in normalized_facts
  // as compressed pattern/anomaly facts by the extractor model. Passing raw
  // rows to the hypothesis and planner models wastes context and adds noise.
  const { logs: _logs, audit_logs: _auditLogs, ...telemetryWithoutLogs } = telemetry;
  void _logs; void _auditLogs;

  return {
    ...telemetryWithoutLogs,
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
      if (verification.status === "resolved") {
        const finalState = await loadIssue(supabase, userId, issueId);
        if (finalState) void runMemoryConsolidation(supabase, userId, finalState).catch(console.error);
      }
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

    // Cross-issue dependency: planner identified that this issue is blocked
    // by another active investigation. Park this issue and let the workflow
    // re-queue it when the blocker resolves.
    if (plan.depends_on_issue_id) {
      const { data: blocker } = await supabase
        .from("issues")
        .select("id, title, status")
        .eq("id", plan.depends_on_issue_id)
        .maybeSingle();

      if (blocker && blocker.status !== "resolved" && blocker.status !== "cancelled") {
        await updateIssue(supabase, userId, issueId, {
          status: "waiting_on_issue",
          depends_on_issue_id: plan.depends_on_issue_id as string,
          next_step: `Waiting for "${blocker.title as string}" to resolve first.`,
        });
        await appendIssueMessage(
          supabase,
          userId,
          issueId,
          "agent",
          `I've identified that this issue is directly caused by another active investigation: "${blocker.title as string}".\n\nI'll automatically resume once that issue is resolved. In the meantime, resolving the root cause there will likely clear this one too.`,
        );
        return loadIssue(supabase, userId, issueId);
      }
      // Blocker is already resolved/cancelled — ignore the dependency and continue
    }

    if (plan.diagnostic_action) {
      if (!hasAlreadyTried(state, plan.diagnostic_action)) {
        await appendIssueMessage(supabase, userId, issueId, "agent", agentResponse);
        await executeDiagnosticAction(supabase, userId, issueId, plan.diagnostic_action);
        continue;
      }
    }

    if (plan.remediation_action) {
      if (!hasAlreadyTried(state, plan.remediation_action)) {
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
        const remTier = plan.remediation_action.tier as 2 | 3;
        const nasConfig = resolveNasApiConfig(plan.remediation_action.target);
        const approvalToken = nasConfig
          ? buildNasApiApprovalToken(nasConfig, plan.remediation_action.command, remTier)
          : undefined;
        await createIssueAction(supabase, userId, issueId, {
          kind: "remediation",
          target: plan.remediation_action.target,
          toolName: `shell:tier${remTier}`,
          commandPreview: plan.remediation_action.command,
          summary: plan.remediation_action.summary,
          reason: plan.remediation_action.reason,
          expectedOutcome: plan.remediation_action.expected_outcome,
          rollbackPlan: plan.remediation_action.rollback_plan ?? "",
          risk: plan.remediation_action.risk ?? "medium",
          requiresApproval: true,
          approvalToken,
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
      ? !hasAlreadyTried(state, remediationPlan)
        && Boolean(remediationPlan.target)
      : false;
    let finalStatus = deriveTerminalPlanStatus(state, plan, hasPendingApproval);

    // Guard: if the planner returned status="running" but produced no action,
    // the investigation would silently stall with no follow-up job queued.
    // Treat this as "stuck" so the operator sees it and can click Continue.
    // (waiting_on_issue is handled earlier and never reaches this point.)
    if (finalStatus === "running" && !plan.diagnostic_action && !plan.remediation_action) {
      finalStatus = "stuck";
    }

    await updateIssue(supabase, userId, issueId, { status: finalStatus });
    await appendIssueMessage(supabase, userId, issueId, "agent", agentResponse);

    if (finalStatus === "resolved") {
      await updateIssue(supabase, userId, issueId, {
        status: "resolved",
        resolved_at: new Date().toISOString(),
      });
      const resolvedState = await loadIssue(supabase, userId, issueId);
      if (resolvedState) void runMemoryConsolidation(supabase, userId, resolvedState).catch(console.error);
    }

    return loadIssue(supabase, userId, issueId);
  }

  return loadIssue(supabase, userId, issueId);
}

/** Fire-and-forget: extract and persist durable memories after an issue resolves. */
async function runMemoryConsolidation(
  supabase: SupabaseClient,
  userId: string,
  state: IssueFull,
): Promise<void> {
  try {
    const completedActions = state.actions
      .filter((a) => a.status === "completed" || a.status === "failed")
      .map((a) => ({
        command: a.command_preview ?? "",
        summary: a.summary ?? "",
        result_excerpt: (a.result_text ?? "").slice(0, 400),
        status: a.status,
      }));

    const evidenceHighlights = state.evidence.slice(-10).map((e) => ({
      title: e.title,
      detail: e.detail.slice(0, 300),
    }));

    const { memories } = await consolidateIssueMemory({
      issue_id: state.issue.id,
      title: state.issue.title,
      summary: state.issue.summary ?? "",
      final_hypothesis: state.issue.current_hypothesis ?? "",
      conversation_summary: state.issue.conversation_summary ?? "",
      affected_nas: state.issue.affected_nas,
      evidence_highlights: evidenceHighlights,
      completed_actions: completedActions,
    });

    if (memories.length > 0) {
      await saveMemories(
        supabase,
        userId,
        memories.map((m) => ({ ...m, source_issue_id: state.issue.id })),
      );
    }
  } catch (err) {
    console.error("[runMemoryConsolidation] Failed:", err);
  }
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
