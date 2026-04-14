import type { SupabaseClient, IssueFull } from "@/lib/server/issue-store";

export type FactSeverity = "info" | "warning" | "critical";
export type FactStatus = "active" | "resolved" | "expired";

export interface FactRecord {
  id: string;
  nas_id: string | null;
  fact_type: string;
  fact_key: string;
  severity: FactSeverity;
  status: FactStatus;
  title: string;
  detail: string;
  value: Record<string, unknown>;
  metadata: Record<string, unknown>;
  observed_at: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DerivedFactInput {
  nasId?: string | null;
  factType: string;
  factKey: string;
  severity: FactSeverity;
  title: string;
  detail: string;
  value?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  observedAt?: string;
  expiresAt?: string | null;
}

export async function upsertFact(
  supabase: SupabaseClient,
  input: DerivedFactInput,
) {
  const now = new Date().toISOString();

  const { data: existing, error: existingError } = await supabase
    .from("facts")
    .select("id")
    .eq("fact_key", input.factKey)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();

  if (existingError) {
    throw new Error(`Failed to look up fact: ${existingError.message}`);
  }

  if (existing?.id) {
    const { error } = await supabase
      .from("facts")
      .update({
        nas_id: input.nasId ?? null,
        fact_type: input.factType,
        severity: input.severity,
        title: input.title,
        detail: input.detail,
        value: input.value ?? {},
        metadata: input.metadata ?? {},
        observed_at: input.observedAt ?? now,
        expires_at: input.expiresAt ?? null,
        updated_at: now,
      })
      .eq("id", existing.id);

    if (error) {
      throw new Error(`Failed to update fact: ${error.message}`);
    }

    return existing.id as string;
  }

  const { data, error } = await supabase
    .from("facts")
    .insert({
      nas_id: input.nasId ?? null,
      fact_type: input.factType,
      fact_key: input.factKey,
      severity: input.severity,
      title: input.title,
      detail: input.detail,
      value: input.value ?? {},
      metadata: input.metadata ?? {},
      observed_at: input.observedAt ?? now,
      expires_at: input.expiresAt ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Failed to create fact: ${error?.message ?? "unknown error"}`);
  }

  return data.id as string;
}

export async function attachFactToIssue(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
  factId: string,
) {
  const { error } = await supabase
    .from("issue_facts")
    .upsert({
      issue_id: issueId,
      fact_id: factId,
      user_id: userId,
    }, {
      onConflict: "issue_id,fact_id",
    });

  if (error) {
    throw new Error(`Failed to attach fact to issue: ${error.message}`);
  }
}

export async function listIssueFacts(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
) {
  const { data, error } = await supabase
    .from("issue_facts")
    .select("fact_id, facts(*)")
    .eq("issue_id", issueId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to list issue facts: ${error.message}`);
  }

  return ((data ?? [])
    .flatMap((row) => Array.isArray(row.facts) ? row.facts : [row.facts])
    .filter(Boolean)) as unknown as FactRecord[];
}

export function deriveFactsFromTelemetry(
  issue: IssueFull["issue"],
  telemetry: Record<string, unknown>,
) {
  const derived: DerivedFactInput[] = [];
  const issueNas = issue.affected_nas[0] ?? null;
  const logs = Array.isArray(telemetry.logs) ? telemetry.logs as Array<Record<string, unknown>> : [];
  const auditLogs = Array.isArray(telemetry.audit_logs) ? telemetry.audit_logs as Array<Record<string, unknown>> : [];

  const telemetryErrors = Array.isArray(telemetry.telemetry_errors) ? telemetry.telemetry_errors as string[] : [];
  for (const error of telemetryErrors) {
    derived.push({
      nasId: issueNas,
      factType: "telemetry_gap",
      factKey: `telemetry-gap:${issueNas ?? "global"}:${error}`,
      severity: "warning",
      title: "Telemetry visibility is degraded",
      detail: error,
      value: { error },
    });
  }

  const scheduledTasks = Array.isArray(telemetry.scheduled_tasks_with_issues) ? telemetry.scheduled_tasks_with_issues as Array<Record<string, unknown>> : [];
  for (const task of scheduledTasks.slice(0, 10)) {
    derived.push({
      nasId: typeof task.nas_id === "string" ? task.nas_id : issueNas,
      factType: "scheduled_task_failure",
      factKey: `scheduled-task:${task.nas_id ?? issueNas}:${task.task_id}:${task.last_result ?? task.status ?? "unknown"}`,
      severity: "warning",
      title: `Scheduled task failing: ${String(task.task_name ?? task.task_id ?? "unknown task")}`,
      detail: `Task status=${String(task.status ?? "unknown")} last_result=${String(task.last_result ?? "unknown")}`,
      value: task,
    });
  }

  const backupTasks = Array.isArray(telemetry.backup_tasks) ? telemetry.backup_tasks as Array<Record<string, unknown>> : [];
  for (const task of backupTasks.slice(0, 10)) {
    const lastResult = String(task.last_result ?? "").toLowerCase();
    const status = String(task.status ?? "").toLowerCase();
    if (!(lastResult.includes("fail") || lastResult.includes("error") || status.includes("fail") || status.includes("error") || status.includes("warn"))) {
      continue;
    }
    derived.push({
      nasId: typeof task.nas_id === "string" ? task.nas_id : issueNas,
      factType: "backup_failure",
      factKey: `backup-task:${task.nas_id ?? issueNas}:${task.task_id}:${task.last_result ?? task.status ?? "unknown"}`,
      severity: "warning",
      title: `Backup task unhealthy: ${String(task.task_name ?? task.task_id ?? "unknown backup")}`,
      detail: `Backup status=${String(task.status ?? "unknown")} last_result=${String(task.last_result ?? "unknown")}`,
      value: task,
    });
  }

  const sharesyncTasks = Array.isArray(telemetry.sharesync_tasks) ? telemetry.sharesync_tasks as Array<Record<string, unknown>> : [];
  for (const task of sharesyncTasks.slice(0, 10)) {
    const backlogCount = Number(task.backlog_count ?? 0);
    const retryCount = Number(task.retry_count ?? 0);
    const status = String(task.status ?? "").toLowerCase();
    if (!(status.includes("error") || backlogCount > 100 || retryCount > 5 || String(task.last_error ?? "").length > 0)) {
      continue;
    }
    derived.push({
      nasId: typeof task.nas_id === "string" ? task.nas_id : issueNas,
      factType: "sharesync_backlog",
      factKey: `sharesync-task:${task.nas_id ?? issueNas}:${task.task_id}:${status}:${backlogCount}:${retryCount}`,
      severity: status.includes("error") ? "critical" : "warning",
      title: `ShareSync task unhealthy: ${String(task.task_name ?? task.task_id ?? "unknown task")}`,
      detail: `status=${status || "unknown"} backlog=${backlogCount} retries=${retryCount} last_error=${String(task.last_error ?? "")}`.trim(),
      value: task,
    });
  }

  const containerIO = Array.isArray(telemetry.container_io_top) ? telemetry.container_io_top as Array<Record<string, unknown>> : [];
  for (const container of containerIO.slice(0, 5)) {
    const writeBps = Number(container.write_bps ?? 0);
    if (writeBps < 10 * 1024 * 1024) continue;
    derived.push({
      nasId: typeof container.nas_id === "string" ? container.nas_id : issueNas,
      factType: "container_hot_write",
      factKey: `container-hot-write:${container.nas_id ?? issueNas}:${container.container_name}:${Math.round(writeBps / 1024 / 1024)}`,
      severity: "warning",
      title: `Container is a heavy writer: ${String(container.container_name ?? "unknown container")}`,
      detail: `write_bps=${writeBps}`,
      value: container,
    });
  }

  const ioPressureMetrics = Array.isArray(telemetry.io_pressure_metrics) ? telemetry.io_pressure_metrics as Array<Record<string, unknown>> : [];
  let maxIoWait = 0;
  for (const metric of ioPressureMetrics) {
    if (String(metric.type) !== "cpu_iowait_pct") continue;
    const value = Number(metric.value ?? 0);
    if (value > maxIoWait) maxIoWait = value;
    if (value <= 20) continue;
    derived.push({
      nasId: typeof metric.nas_id === "string" ? metric.nas_id : issueNas,
      factType: "io_wait_high",
      factKey: `io-wait-high:${metric.nas_id ?? issueNas}:${value}`,
      severity: value >= 40 ? "critical" : "warning",
      title: "CPU is blocked on disk I/O",
      detail: `cpu_iowait_pct=${value}`,
      value: metric,
    });
  }

  const driveChurnLog = logs.find((row) => String(row.source ?? "") === "drive_churn_signal");
  const hyperbackupChurnLog = logs.find((row) => String(row.source ?? "") === "hyperbackup_churn");
  const backupCleanupTask = backupTasks.find((task) => {
    const lastResult = String(task.last_result ?? "").toLowerCase();
    return lastResult.includes("version_delete")
      || lastResult.includes("version_delet")
      || lastResult.includes("version_rotation")
      || lastResult.includes("version deleting");
  });

  const snapshotCleanupLog = [...logs, ...auditLogs].find((row) => {
    const message = String(row.message ?? "").toLowerCase();
    return message.includes("drop snapshot")
      || message.includes("action = 'delete'")
      || message.includes("sharepresnapshotnotify")
      || message.includes("sharepostsnapshotnotify");
  });

  if (backupCleanupTask && maxIoWait >= 20 && (driveChurnLog || hyperbackupChurnLog || snapshotCleanupLog)) {
    const taskNas = typeof backupCleanupTask.nas_id === "string" ? backupCleanupTask.nas_id : issueNas;
    const taskName = String(backupCleanupTask.task_name ?? backupCleanupTask.task_id ?? "unknown backup");
    const lastResult = String(backupCleanupTask.last_result ?? "unknown");
    const signals = [
      driveChurnLog ? "Drive churn spike" : null,
      hyperbackupChurnLog ? "Hyper Backup churn spike" : null,
      snapshotCleanupLog ? "snapshot cleanup activity" : null,
      `peak cpu_iowait_pct=${maxIoWait}`,
    ].filter(Boolean);

    derived.push({
      nasId: taskNas,
      factType: "correlated_storage_incident",
      factKey: `correlated-storage-incident:${taskNas ?? "global"}:${String(backupCleanupTask.task_id ?? taskName)}:${lastResult.toLowerCase()}`,
      severity: maxIoWait >= 40 ? "critical" : "warning",
      title: "Drive reorganization is destabilizing Hyper Backup cleanup",
      detail: `${taskName} is in ${lastResult} while storage pressure is elevated and churn signals are present. This pattern usually means Synology Drive reorganization or conflict cleanup created enough rename/delete churn to jam post-backup version rotation.`,
      value: {
        task: backupCleanupTask,
        peak_cpu_iowait_pct: maxIoWait,
        drive_churn_log: driveChurnLog ?? null,
        hyperbackup_churn_log: hyperbackupChurnLog ?? null,
        snapshot_cleanup_log: snapshotCleanupLog ?? null,
      },
      metadata: {
        related_signals: signals,
      },
    });
  }

  return derived;
}
