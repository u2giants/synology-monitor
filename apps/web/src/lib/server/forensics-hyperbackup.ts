/**
 * Hyper Backup forensics — builds a normalized cleanup timeline from
 * HyperBackup metadata files and logs read via the NAS API.
 *
 * Primary data sources (read via NAS API tier-1 shell commands):
 *   /volume1/@appdata/HyperBackup/config/task_state.conf
 *   /volume1/@appdata/HyperBackup/last_result/backup.last
 *   /volume1/@appdata/HyperBackup/log/synolog/synobackup.log
 *
 * Secondary: backup_tasks rows already in Supabase (agent-collected telemetry).
 *
 * Design constraint: no 2>/dev/null in commands (keeps them tier 1).
 */

import type { SupabaseClient } from "@/lib/server/issue-store";
import type { DerivedFactInput } from "@/lib/server/fact-store";
import { resolveNasApiConfig, nasApiExec } from "@/lib/server/nas-api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type BackupTimelineEventKind =
  | "backup_started"
  | "backup_finished_success"
  | "version_rotation_started"
  | "backup_skipped_destination_busy"
  | "cleanup_keepalive_died"
  | "cleanup_failed"
  | "cleanup_completed"
  | "state_change"
  | "unknown";

export interface BackupTimelineEvent {
  timestamp: string | null;
  kind: BackupTimelineEventKind;
  message: string;
  source: string;
  task_id: string | null;
}

export interface BackupCleanupTimeline {
  nas_name: string;
  task_id: string | null;
  current_state: string | null;
  last_state: string | null;
  last_backup_success_time: string | null;
  last_backup_success_version: number | null;
  result: string | null;
  events: BackupTimelineEvent[];
  /** Whether the backup itself finished OK while cleanup did not. */
  backup_succeeded_but_cleanup_failed: boolean;
  /** True when state_conf says cleanup is stuck or failed. */
  cleanup_unhealthy: boolean;
  raw_state_conf: string;
  raw_backup_last: string;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Reads HyperBackup state from the NAS and returns a normalized timeline.
 * Falls back gracefully when API calls fail or files do not exist.
 */
export async function loadBackupCleanupTimeline(
  nasName: string,
): Promise<BackupCleanupTimeline | null> {
  const config = resolveNasApiConfig(nasName);
  if (!config) return null;

  // Build a tier-1 command that reads the key HyperBackup metadata files.
  // Deliberately avoids 2>/dev/null so it stays tier 1.
  const cmd = [
    "echo '=== TASK_STATE ==='",
    "test -f /volume1/@appdata/HyperBackup/config/task_state.conf && sed -n '1,200p' /volume1/@appdata/HyperBackup/config/task_state.conf || echo 'NOT_FOUND'",
    "echo '=== BACKUP_LAST ==='",
    "test -f /volume1/@appdata/HyperBackup/last_result/backup.last && sed -n '1,200p' /volume1/@appdata/HyperBackup/last_result/backup.last || echo 'NOT_FOUND'",
    "echo '=== SYNOBACKUP_LOG ==='",
    "test -f /volume1/@appdata/HyperBackup/log/synolog/synobackup.log && tail -n 120 /volume1/@appdata/HyperBackup/log/synolog/synobackup.log || echo 'NOT_FOUND'",
    "echo '=== HYPERBACKUP_LOG ==='",
    "test -f /volume1/@appdata/HyperBackup/log/hyperbackup.log && tail -n 80 /volume1/@appdata/HyperBackup/log/hyperbackup.log || echo 'NOT_FOUND'",
  ].join("\n");

  try {
    const result = await nasApiExec(config, cmd, 1);
    return parseBackupOutput(nasName, result.stdout + result.stderr);
  } catch {
    return null;
  }
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

function parseBackupOutput(nasName: string, raw: string): BackupCleanupTimeline {
  const sections = splitSections(raw);
  const stateConf = sections["TASK_STATE"] ?? "";
  const backupLast = sections["BACKUP_LAST"] ?? "";
  const synobackupLog = sections["SYNOBACKUP_LOG"] ?? "";
  const hyperbackupLog = sections["HYPERBACKUP_LOG"] ?? "";

  // Parse task_state.conf.
  const stateConfData = parseIniFile(stateConf);
  // task_state.conf may have multiple [task_N] sections; use the first real one.
  const taskSection = Object.entries(stateConfData).find(([k]) => k.startsWith("task_"));
  const taskId = taskSection ? taskSection[0].replace("task_", "") : null;
  const currentState = taskSection ? (taskSection[1]["state"] ?? null) : null;
  const lastState = taskSection ? (taskSection[1]["last_state"] ?? null) : null;

  // Parse backup.last.
  const backupLastData = parseIniFile(backupLast);
  const taskLastSection = taskId ? (backupLastData[`task_${taskId}`] ?? {}) : {};
  const result = taskLastSection["result"] ?? null;
  const startTimeRaw = taskLastSection["start_time"] ? Number(taskLastSection["start_time"]) : null;
  const endTimeRaw = taskLastSection["end_time"] ? Number(taskLastSection["end_time"]) : null;
  const lastSuccessRaw = taskLastSection["last_backup_success_time"]
    ? Number(taskLastSection["last_backup_success_time"])
    : null;
  const lastSuccessVersion = taskLastSection["last_backup_success_version"]
    ? Number(taskLastSection["last_backup_success_version"])
    : null;

  const lastBackupSuccessTime = lastSuccessRaw ? epochToISO(lastSuccessRaw) : null;

  // Build timeline from log lines.
  const events: BackupTimelineEvent[] = [];
  const allLogLines = [
    ...synobackupLog.split("\n").map((l) => ({ line: l, source: "synobackup.log" })),
    ...hyperbackupLog.split("\n").map((l) => ({ line: l, source: "hyperbackup.log" })),
  ];

  for (const { line, source } of allLogLines) {
    const ev = classifyLogLine(line, taskId ? `task_${taskId}` : null, source);
    if (ev) events.push(ev);
  }

  // Add synthetic events from metadata if log events are sparse.
  if (startTimeRaw && startTimeRaw > 0) {
    events.push({
      timestamp: epochToISO(startTimeRaw),
      kind: "backup_started",
      message: `Backup task ${taskId ?? "?"} started`,
      source: "backup.last",
      task_id: taskId,
    });
  }
  if (endTimeRaw && endTimeRaw > 0 && endTimeRaw !== startTimeRaw) {
    events.push({
      timestamp: epochToISO(endTimeRaw),
      kind: result?.toLowerCase().includes("success") || result === "backingup"
        ? "backup_finished_success"
        : "state_change",
      message: `Backup task ${taskId ?? "?"} ended (result=${result ?? "unknown"})`,
      source: "backup.last",
      task_id: taskId,
    });
  }

  // Add current state from task_state.conf.
  if (currentState || lastState) {
    events.push({
      timestamp: null,
      kind: mapStateToKind(lastState ?? currentState ?? ""),
      message: `Current state: ${currentState ?? "unknown"}, last state: ${lastState ?? "unknown"}`,
      source: "task_state.conf",
      task_id: taskId,
    });
  }

  // Sort chronologically (nulls last).
  events.sort((a, b) => {
    if (!a.timestamp && !b.timestamp) return 0;
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return a.timestamp.localeCompare(b.timestamp);
  });

  const cleanupUnhealthy =
    (lastState ?? "").toLowerCase().includes("error") ||
    (lastState ?? "").toLowerCase().includes("fail") ||
    (currentState ?? "").toLowerCase().includes("error") ||
    (currentState ?? "").toLowerCase().includes("fail") ||
    (result ?? "").toLowerCase().includes("fail") ||
    events.some((e) => e.kind === "cleanup_failed" || e.kind === "cleanup_keepalive_died");

  const backupSucceededButCleanupFailed =
    lastBackupSuccessTime !== null && cleanupUnhealthy;

  return {
    nas_name: nasName,
    task_id: taskId,
    current_state: currentState,
    last_state: lastState,
    last_backup_success_time: lastBackupSuccessTime,
    last_backup_success_version: lastSuccessVersion,
    result,
    events,
    backup_succeeded_but_cleanup_failed: backupSucceededButCleanupFailed,
    cleanup_unhealthy: cleanupUnhealthy,
    raw_state_conf: stateConf.slice(0, 500),
    raw_backup_last: backupLast.slice(0, 500),
  };
}

/** Classifies a single log line into a timeline event. */
function classifyLogLine(
  line: string,
  taskSection: string | null,
  source: string,
): BackupTimelineEvent | null {
  if (!line.trim()) return null;
  const lower = line.toLowerCase();

  // Extract timestamp from the line (common Synology format: YYYY/MM/DD HH:MM:SS).
  const tsMatch = line.match(/(\d{4})[/-](\d{2})[/-](\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  const timestamp = tsMatch
    ? `${tsMatch[1]}-${tsMatch[2]}-${tsMatch[3]}T${tsMatch[4]}:${tsMatch[5]}:${tsMatch[6]}Z`
    : null;

  let kind: BackupTimelineEventKind = "unknown";
  let matched = false;

  if (lower.includes("backup") && (lower.includes("start") || lower.includes("begin"))) {
    kind = "backup_started"; matched = true;
  } else if (
    (lower.includes("backup") || lower.includes("task")) &&
    (lower.includes("finish") || lower.includes("complete") || lower.includes("success"))
  ) {
    kind = "backup_finished_success"; matched = true;
  } else if (
    lower.includes("version") &&
    (lower.includes("delet") || lower.includes("rotat") || lower.includes("cleanup") || lower.includes("clean up"))
  ) {
    kind = "version_rotation_started"; matched = true;
  } else if (
    lower.includes("destination") &&
    (lower.includes("busy") || lower.includes("skip"))
  ) {
    kind = "backup_skipped_destination_busy"; matched = true;
  } else if (lower.includes("keepalive") && (lower.includes("die") || lower.includes("dead") || lower.includes("timeout"))) {
    kind = "cleanup_keepalive_died"; matched = true;
  } else if (
    (lower.includes("cleanup") || lower.includes("clean up") || lower.includes("version_delete")) &&
    (lower.includes("fail") || lower.includes("error"))
  ) {
    kind = "cleanup_failed"; matched = true;
  } else if (
    (lower.includes("cleanup") || lower.includes("version_delete")) &&
    lower.includes("complet")
  ) {
    kind = "cleanup_completed"; matched = true;
  }

  if (!matched) return null;

  return {
    timestamp,
    kind,
    message: line.trim().slice(0, 300),
    source,
    task_id: taskSection ? taskSection.replace("task_", "") : null,
  };
}

function mapStateToKind(state: string): BackupTimelineEventKind {
  const lower = state.toLowerCase();
  if (lower.includes("error") || lower.includes("fail")) return "cleanup_failed";
  if (lower.includes("version_delete") || lower.includes("cleanup")) return "version_rotation_started";
  if (lower.includes("success") || lower.includes("complete")) return "backup_finished_success";
  return "state_change";
}

// ─── Fact builder ─────────────────────────────────────────────────────────────

/**
 * Converts a BackupCleanupTimeline into DerivedFactInput entries.
 */
export function buildBackupTimelineFacts(
  nasId: string,
  timeline: BackupCleanupTimeline,
): DerivedFactInput[] {
  if (!timeline.events.length && !timeline.cleanup_unhealthy) return [];

  const facts: DerivedFactInput[] = [];

  // ── Fact 1: Backup success vs cleanup failure distinction ─────────────────
  if (timeline.backup_succeeded_but_cleanup_failed) {
    facts.push({
      nasId,
      factType: "forensic_backup_timeline",
      factKey: `forensic-backup-timeline:${nasId}:${timeline.task_id ?? "global"}`,
      severity: "warning",
      title: "Latest backup succeeded, but post-backup version cleanup failed",
      detail: [
        `Task ${timeline.task_id ?? "?"}: backup itself completed successfully (last success: ${timeline.last_backup_success_time ?? "unknown"}).`,
        `After backup, version rotation / cleanup entered a failed state.`,
        timeline.last_state ? `Last state recorded: ${timeline.last_state}` : "",
        timeline.current_state ? `Current state: ${timeline.current_state}` : "",
        "This means the task is unhealthy even though the last backup timestamp looks recent.",
      ].filter(Boolean).join("\n"),
      value: {
        task_id: timeline.task_id,
        last_backup_success_time: timeline.last_backup_success_time,
        last_backup_success_version: timeline.last_backup_success_version,
        current_state: timeline.current_state,
        last_state: timeline.last_state,
        result: timeline.result,
        cleanup_unhealthy: timeline.cleanup_unhealthy,
        event_count: timeline.events.length,
        events: timeline.events.slice(0, 8),
      },
      observedAt: new Date().toISOString(),
    });
  } else if (timeline.cleanup_unhealthy) {
    // Cleanup unhealthy but backup success timestamp not confirmed.
    facts.push({
      nasId,
      factType: "forensic_backup_timeline",
      factKey: `forensic-backup-timeline:${nasId}:${timeline.task_id ?? "global"}`,
      severity: "warning",
      title: `Hyper Backup cleanup is in an unhealthy state (${timeline.last_state ?? timeline.current_state ?? "unknown"})`,
      detail: [
        `Task ${timeline.task_id ?? "?"} state: current=${timeline.current_state ?? "?"}, last=${timeline.last_state ?? "?"}.`,
        `This indicates the post-backup cleanup process did not complete normally.`,
        `High cpu_iowait may persist until cleanup finishes or is cleared.`,
      ].filter(Boolean).join("\n"),
      value: {
        task_id: timeline.task_id,
        current_state: timeline.current_state,
        last_state: timeline.last_state,
        result: timeline.result,
        event_count: timeline.events.length,
        events: timeline.events.slice(0, 8),
      },
      observedAt: new Date().toISOString(),
    });
  }

  return facts;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Splits a command output by === SECTION === markers. */
function splitSections(raw: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let current = "";
  let buf: string[] = [];

  for (const line of raw.split("\n")) {
    const m = line.match(/^===\s*([A-Z0-9_]+)\s*===\s*$/);
    if (m) {
      if (current) sections[current] = buf.join("\n").trim();
      current = m[1];
      buf = [];
    } else {
      buf.push(line);
    }
  }
  if (current) sections[current] = buf.join("\n").trim();
  return sections;
}

/**
 * Parses a simple INI-style file into sections.
 * Returns Record<sectionName, Record<key, value>>.
 */
function parseIniFile(content: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  let currentSection = "global";
  result[currentSection] = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;

    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      result[currentSection] = {};
      continue;
    }

    const kvMatch = trimmed.match(/^([^=]+)=(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      // Strip surrounding quotes from values.
      const val = kvMatch[2].trim().replace(/^["']|["']$/g, "");
      result[currentSection][key] = val;
    }
  }
  return result;
}

/** Converts a Unix epoch (seconds) to an ISO 8601 string. */
function epochToISO(epoch: number): string {
  return new Date(epoch * 1000).toISOString();
}
