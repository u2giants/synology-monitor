import {
  appendIssueEvidence,
  appendIssueMessage,
  type IssueFull,
  type SupabaseClient,
} from "@/lib/server/issue-store";
import { collectNasDiagnostics } from "@/lib/server/nas-api-client";
import { classifyIssueSubjects, loadMemoriesForIssue } from "@/lib/server/agent-memory-store";


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

export async function gatherTelemetryContext(supabase: SupabaseClient, userId: string, issue: IssueFull["issue"]) {
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
    // separate from the high-volume nas_logs stream.
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
