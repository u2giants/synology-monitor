import { createIssue, loadIssue, updateIssue, type IssueSeverity, type SupabaseClient } from "./issue-store";
import { seedIssueFromOrigin } from "./issue-agent";

type DetectedIssue = {
  fingerprint: string;
  title: string;
  summary: string;
  severity: IssueSeverity;
  affected_nas: string[];
  evidence: Array<{ title: string; detail: string }>;
};

type AlertRow = {
  id: string;
  nas_id: string | null;
  source: string;
  severity: string;
  title: string;
  message: string;
  details: Record<string, unknown> | null;
  created_at: string;
};

type LogRow = {
  id: string;
  nas_id: string | null;
  source: string;
  severity: string;
  message: string;
  metadata: Record<string, unknown> | null;
  ingested_at: string;
};

type MetricRow = {
  nas_id: string | null;
  type: string;
  value: number;
  recorded_at: string;
};

type CorrelatedSignalState = {
  driveChurn: boolean;
  hyperbackupChurn: boolean;
  backupCleanupFailure: boolean;
  snapshotCleanup: boolean;
  evidence: Array<{ title: string; detail: string }>;
};

type SignalGroup = {
  fingerprint: string;
  family: string;
  title: string;
  summary: string;
  severity: IssueSeverity;
  affected_nas: string[];
  evidence: Array<{ title: string; detail: string }>;
  count: number;
  scope: string;
};

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeKey(value: string) {
  return value
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

function folderOf(path: string) {
  if (!path) return "";
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx > 0 ? normalized.slice(0, idx) : normalized;
}

function mapSeverity(severity: string): IssueSeverity {
  if (severity === "critical" || severity === "error") return "critical";
  if (severity === "warning") return "warning";
  return "info";
}

function severityRank(severity: IssueSeverity) {
  if (severity === "critical") return 3;
  if (severity === "warning") return 2;
  return 1;
}

function isActionableInfoLog(message: string) {
  const lower = message.toLowerCase();
  return (
    lower.includes("synologydrive.admin.sharesync") ||
    lower.includes("synologydrive.sharesync") ||
    lower.includes("apiinternalutil.cpp:200 webapi") ||
    lower.includes("_sharesync_list")
  );
}

async function fetchNasNameMap(supabase: SupabaseClient): Promise<Map<string, string>> {
  const { data } = await supabase.from("nas_units").select("id, name, hostname");
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    const name = (row.name || row.hostname || row.id) as string;
    map.set(row.id as string, name);
  }
  return map;
}

async function fetchDetectionContext(supabase: SupabaseClient, lookbackMinutes: number) {
  const since = new Date(Date.now() - lookbackMinutes * 60 * 1000).toISOString();
  const sinceMetrics = new Date(Date.now() - Math.min(lookbackMinutes, 120) * 60 * 1000).toISOString();

  const [alertsResult, errorLogsResult, driveInfoResult, metricsResult] = await Promise.all([
    supabase
      .from("alerts")
      .select("id, nas_id, source, severity, title, message, details, created_at")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(250),
    supabase
      .from("nas_logs")
      .select("id, nas_id, source, severity, message, metadata, ingested_at")
      .gte("ingested_at", since)
      .in("severity", ["critical", "error", "warning"])
      .order("ingested_at", { ascending: false })
      .limit(1200),
    supabase
      .from("nas_logs")
      .select("id, nas_id, source, severity, message, metadata, ingested_at")
      .gte("ingested_at", since)
      .eq("source", "drive_server")
      .order("ingested_at", { ascending: false })
      .limit(4000),

    supabase
      .from("metrics")
      .select("nas_id, type, value, recorded_at")
      .eq("type", "cpu_iowait_pct")
      .gte("recorded_at", sinceMetrics)
      .gte("value", 15)
      .order("recorded_at", { ascending: false })
      .limit(200),
  ]);

  const combinedLogs = [
    ...((errorLogsResult.data ?? []) as LogRow[]),
    ...((driveInfoResult.data ?? []) as LogRow[]).filter((log) => isActionableInfoLog(log.message)),
  ];

  const dedupedLogs = Array.from(new Map(combinedLogs.map((log) => [log.id, log])).values());

  return {
    alerts: (alertsResult.data ?? []) as AlertRow[],
    logs: dedupedLogs,
    metrics: (metricsResult.data ?? []) as MetricRow[],
  };
}

function pickScope(input: {
  title?: string;
  message?: string;
  details?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}) {
  const details = input.details ?? {};
  const metadata = input.metadata ?? {};
  const path =
    stringValue(details.path) ||
    stringValue(details.folder_path) ||
    stringValue(metadata.path) ||
    stringValue(metadata.file_path) ||
    stringValue(metadata.folder_path);
  const share =
    stringValue(details.share_name) ||
    stringValue(metadata.share_name) ||
    stringValue(details.task_name) ||
    stringValue(metadata.task_name);
  const folder = folderOf(path);

  if (folder) return folder;
  if (path) return path;
  if (share) return share;

  const combined = `${input.title ?? ""} ${input.message ?? ""}`.toLowerCase();
  if (combined.includes("backup")) return "backup";
  if (combined.includes("rename")) return "rename";
  if (combined.includes("sharesync")) return "sharesync";
  if (combined.includes("drive")) return "drive";
  return "general";
}

function alertFamily(alert: AlertRow) {
  const title = normalizeKey(alert.title);
  if (title.includes("mass file rename")) return "mass-file-rename";
  if (title.includes("backup") && (title.includes("failed") || title.includes("failure"))) return "backup-failure";
  if (title.includes("sync") && title.includes("error")) return "sync-error";
  if (title.includes("sharesync")) return "sharesync";
  return title;
}

function logFamily(log: LogRow) {
  const lower = normalizeKey(log.message);
  const action = normalizeKey(stringValue(log.metadata?.action));

  if (lower.includes("failed to synoshareget") || lower.includes("error when reading st") || lower.includes(":stoi")) {
    return "sharesync-metadata-corruption";
  }
  if (lower.includes("webapi syno.synologydrive.admin.sharesync is not valid") || lower.includes("webapi syno.synologydrive.sharesync is not valid")) {
    return "sharesync-api-invalid";
  }
  if (lower.includes("cloud station is not ready")) return "drive-not-ready";
  if (lower.includes("thumb_info.cpp") || lower.includes("exiv2 exception")) return "thumbnail-extract-failure";
  if (lower.includes("backup") && lower.includes("fail")) return "backup-failure";
  if (action === "sync_failure" || lower.includes("sync") && lower.includes("fail")) return "sync-failure";
  if (action === "sync_conflict" || lower.includes("conflict")) return "sync-conflict";
  if (action === "rename" || lower.includes("rename")) return "rename-activity";
  return "";
}

function mergesAcrossNas(family: string) {
  return [
    "sharesync-metadata-corruption",
    "sharesync-api-invalid",
    "drive-not-ready",
    "sync-failure",
  ].includes(family);
}

function groupTitle(family: string, scope: string) {
  switch (family) {
    case "mass-file-rename":
      return `Mass rename activity in ${scope}`;
    case "sharesync-metadata-corruption":
      return `ShareSync metadata lookup failures in ${scope}`;
    case "sharesync-api-invalid":
      return `ShareSync API failures in ${scope}`;
    case "sync-failure":
      return `Recurring sync failures in ${scope}`;
    case "sync-conflict":
      return `Sync conflicts in ${scope}`;
    case "drive-not-ready":
      return `Synology Drive reports not-ready state in ${scope}`;
    case "thumbnail-extract-failure":
      return `Drive thumbnail extraction failures in ${scope}`;
    case "backup-failure":
      return `Repeated backup failures for ${scope}`;
    default:
      return scope && scope !== "general" ? `Recurring issue in ${scope}` : "Recurring telemetry issue";
  }
}

function groupSummary(family: string, scope: string, count: number) {
  switch (family) {
    case "mass-file-rename":
      return `${count} rename alerts point to the same folder or share. This should be treated as one investigation thread until the underlying cause is explained.`;
    case "sharesync-metadata-corruption":
      return `${count} Drive error events show ShareSync failing to read or parse shared-folder metadata for ${scope}. This is a backend ShareSync fault, not just a front-end warning.`;
    case "sharesync-api-invalid":
      return `${count} Drive admin and ShareSync API calls are returning invalid-state responses for ${scope}. This points to a broken ShareSync control plane, not isolated user file errors.`;
    case "sync-failure":
      return `${count} sync failure events are being grouped into one issue because they share the same Drive or ShareSync fault pattern.`;
    case "sync-conflict":
      return `${count} sync conflict events are clustered together for ${scope}.`;
    case "drive-not-ready":
      return `${count} Drive API calls reported that Cloud Station or Drive was not ready. This likely belongs to the same Drive control-plane fault.`;
    case "thumbnail-extract-failure":
      return `${count} Drive thumbnail extraction errors were observed. These are application errors but usually lower priority than ShareSync metadata failures.`;
    case "backup-failure":
      return `${count} backup failures were grouped into one backup issue thread.`;
    default:
      return `${count} related telemetry events were grouped into one issue for ${scope}.`;
  }
}

function mergeAffectedNas(existing: string[], value: string | null) {
  if (!value || existing.includes(value)) return existing;
  return [...existing, value];
}

function upsertGroup(
  groups: Map<string, SignalGroup>,
  key: string,
  input: {
    family: string;
    title: string;
    summary: string;
    severity: IssueSeverity;
    nasId: string | null;
    scope: string;
    evidence: { title: string; detail: string };
  }
) {
  const existing = groups.get(key);
  if (existing) {
    existing.count += 1;
    existing.evidence.push(input.evidence);
    existing.affected_nas = mergeAffectedNas(existing.affected_nas, input.nasId);
    if (severityRank(input.severity) > severityRank(existing.severity)) {
      existing.severity = input.severity;
    }
    existing.summary = groupSummary(existing.family, existing.scope, existing.count);
    return;
  }

  groups.set(key, {
    fingerprint: key,
    family: input.family,
    title: input.title,
    summary: input.summary,
    severity: input.severity,
    affected_nas: input.nasId ? [input.nasId] : [],
    evidence: [input.evidence],
    count: 1,
    scope: input.scope,
  });
}

function buildAlertGroups(alerts: AlertRow[]) {
  const groups = new Map<string, SignalGroup>();

  for (const alert of alerts) {
    const family = alertFamily(alert);
    if (!["mass-file-rename", "backup-failure", "sync-error", "sharesync"].includes(family)) continue;

    const scope = pickScope({ title: alert.title, message: alert.message, details: alert.details });
    const key = `detected:${family}:${normalizeKey(scope)}`;
    upsertGroup(groups, key, {
      family,
      title: groupTitle(family, scope),
      summary: groupSummary(family, scope, 1),
      severity: mapSeverity(alert.severity),
      nasId: alert.nas_id,
      scope,
      evidence: {
        title: alert.title,
        detail: `${alert.message} (${alert.created_at})`,
      },
    });
  }

  return Array.from(groups.values());
}

function buildLogGroups(logs: LogRow[]) {
  const groups = new Map<string, SignalGroup>();

  for (const log of logs) {
    const family = logFamily(log);
    if (!family) continue;

    const scope = pickScope({ message: log.message, metadata: log.metadata });
    const component = stringValue(log.metadata?.component);
    const scopeKey = normalizeKey(component || scope);
    const key = mergesAcrossNas(family)
      ? `detected:${family}:${scopeKey}`
      : `detected:${family}:${scopeKey}:${log.nas_id ?? "global"}`;
    const severity = family === "sharesync-api-invalid"
      ? "warning"
      : family === "drive-not-ready"
        ? "critical"
        : mapSeverity(log.severity);
    upsertGroup(groups, key, {
      family,
      title: groupTitle(family, component || scope),
      summary: groupSummary(family, component || scope, 1),
      severity,
      nasId: log.nas_id,
      scope: component || scope,
      evidence: {
        title: `${log.source} ${log.severity}`,
        detail: `${log.message} (${log.ingested_at})`,
      },
    });
  }

  return Array.from(groups.values())
    .filter((group) => {
      if (group.family === "sharesync-metadata-corruption") return true;
      if (group.family === "sharesync-api-invalid") return group.count >= 5;
      if (group.family === "drive-not-ready") return group.count >= 2;
      if (group.family === "sync-failure") return group.count >= 2;
      if (group.family === "sync-conflict") return group.count >= 2;
      if (group.family === "thumbnail-extract-failure") return group.count >= 20;
      if (group.family === "backup-failure") return true;
      return group.count >= 2;
    });
}

function buildMetricsGroups(metrics: MetricRow[], nasNameMap: Map<string, string>) {
  const groups = new Map<string, SignalGroup>();

  // Group iowait readings by nas_id
  const byNas = new Map<string, { values: number[]; nasName: string }>();
  for (const m of metrics) {
    if (!m.nas_id) continue;
    const nasName = nasNameMap.get(m.nas_id) ?? m.nas_id;
    const existing = byNas.get(m.nas_id);
    if (existing) {
      existing.values.push(m.value);
    } else {
      byNas.set(m.nas_id, { values: [m.value], nasName });
    }
  }

  for (const [nasId, { values, nasName }] of byNas) {
    if (values.length < 3) continue; // need at least 3 readings
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const max = Math.max(...values);
    if (avg < 20) continue; // sustained average below threshold — skip

    const severity: IssueSeverity = avg >= 40 ? "critical" : "warning";
    const key = `detected:io-pressure:${nasId}`;
    upsertGroup(groups, key, {
      family: "io-pressure",
      title: `Sustained disk I/O pressure on ${nasName}`,
      summary: `${values.length} readings show cpu_iowait averaging ${avg.toFixed(1)}% (peak ${max.toFixed(1)}%) on ${nasName}. High I/O wait blocks processes, degrades ShareSync performance, and can destabilize DSM WebAPI registration.`,
      severity,
      nasId: nasName,
      scope: nasName,
      evidence: {
        title: "High cpu_iowait_pct samples",
        detail: `avg=${avg.toFixed(1)}%, peak=${max.toFixed(1)}%, samples=${values.length}`,
      },
    });
  }

  return Array.from(groups.values());
}

function buildCorrelatedIncidentGroups(logs: LogRow[], metrics: MetricRow[], nasNameMap: Map<string, string>) {
  const byNas = new Map<string, CorrelatedSignalState>();

  const ensureNas = (nasId: string) => {
    const existing = byNas.get(nasId);
    if (existing) return existing;
    const created: CorrelatedSignalState = {
      driveChurn: false,
      hyperbackupChurn: false,
      backupCleanupFailure: false,
      snapshotCleanup: false,
      evidence: [],
    };
    byNas.set(nasId, created);
    return created;
  };

  for (const log of logs) {
    if (!log.nas_id) continue;
    const state = ensureNas(log.nas_id);
    const source = String(log.source ?? "");
    const message = String(log.message ?? "").toLowerCase();

    if (source === "drive_churn_signal") {
      state.driveChurn = true;
      state.evidence.push({
        title: "Drive churn signal",
        detail: `${log.message} (${log.ingested_at})`,
      });
    }
    if (source === "hyperbackup_churn") {
      state.hyperbackupChurn = true;
      state.evidence.push({
        title: "Hyper Backup churn signal",
        detail: `${log.message} (${log.ingested_at})`,
      });
    }
    if (
      source === "hyperbackup_fallback"
      && (message.includes("version_delete") || message.includes("version_delet") || message.includes("version rotation"))
    ) {
      state.backupCleanupFailure = true;
      state.evidence.push({
        title: "Backup cleanup stalled",
        detail: `${log.message} (${log.ingested_at})`,
      });
    }
    if (
      message.includes("drop snapshot")
      || message.includes("sharepresnapshotnotify")
      || message.includes("sharepostsnapshotnotify")
      || message.includes("action = 'delete'")
    ) {
      state.snapshotCleanup = true;
      state.evidence.push({
        title: "Snapshot cleanup activity",
        detail: `${log.message} (${log.ingested_at})`,
      });
    }
  }

  const ioWaitByNas = new Map<string, { avg: number; peak: number; samples: number }>();
  for (const metric of metrics) {
    if (!metric.nas_id || metric.type !== "cpu_iowait_pct") continue;
    const existing = ioWaitByNas.get(metric.nas_id);
    if (existing) {
      existing.samples += 1;
      existing.avg += metric.value;
      if (metric.value > existing.peak) existing.peak = metric.value;
    } else {
      ioWaitByNas.set(metric.nas_id, { avg: metric.value, peak: metric.value, samples: 1 });
    }
  }

  const groups: SignalGroup[] = [];
  for (const [nasId, state] of byNas) {
    const io = ioWaitByNas.get(nasId);
    if (!io || io.samples === 0) continue;
    const avgIoWait = io.avg / io.samples;
    if (avgIoWait < 20) continue;
    if (!state.backupCleanupFailure) continue;
    if (!(state.driveChurn || state.hyperbackupChurn || state.snapshotCleanup)) continue;

    const nasName = nasNameMap.get(nasId) ?? nasId;
    const signals = [
      state.driveChurn ? "Drive churn" : null,
      state.hyperbackupChurn ? "Hyper Backup churn" : null,
      state.snapshotCleanup ? "snapshot cleanup" : null,
    ].filter(Boolean).join(", ");

    groups.push({
      fingerprint: `detected:drive-backup-cleanup:${nasId}`,
      family: "drive-backup-cleanup",
      title: `Drive churn is jamming backup cleanup on ${nasName}`,
      summary: `${nasName} shows Hyper Backup cleanup failure with ${signals} and sustained cpu_iowait averaging ${avgIoWait.toFixed(1)}% (peak ${io.peak.toFixed(1)}%). This pattern usually means a large Synology Drive reorganization or conflict cleanup created enough delete/rename churn to stall post-backup version rotation.`,
      severity: io.peak >= 40 ? "critical" : "warning",
      affected_nas: [nasName],
      evidence: [
        ...state.evidence.slice(0, 6),
        {
          title: "Sustained disk I/O pressure",
          detail: `avg cpu_iowait_pct=${avgIoWait.toFixed(1)} peak=${io.peak.toFixed(1)} samples=${io.samples}`,
        },
      ],
      count: state.evidence.length,
      scope: nasName,
    });
  }

  return groups;
}

function mergeGroupsIntoIssues(groups: SignalGroup[]): DetectedIssue[] {
  return groups
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.count - a.count)
    .slice(0, 25)
    .map((group) => ({
      fingerprint: group.fingerprint,
      title: group.title,
      summary: group.summary,
      severity: group.severity,
      affected_nas: group.affected_nas,
      evidence: group.evidence.slice(0, 8),
    }));
}

export async function runIssueDetection(
  supabase: SupabaseClient,
  userId: string,
  lookbackMinutes: number
) {
  const [context, nasNameMap] = await Promise.all([
    fetchDetectionContext(supabase, lookbackMinutes),
    fetchNasNameMap(supabase),
  ]);
  const issues = mergeGroupsIntoIssues([
    ...buildAlertGroups(context.alerts),
    ...buildLogGroups(context.logs),
    ...buildMetricsGroups(context.metrics, nasNameMap),
    ...buildCorrelatedIncidentGroups(context.logs, context.metrics, nasNameMap),
  ]);

  const createdIds: string[] = [];

  for (const detected of issues) {
    const issueId = await createIssue(supabase, userId, {
      originType: "detected",
      title: detected.title,
      summary: detected.summary,
      severity: detected.severity,
      affectedNas: detected.affected_nas,
      fingerprint: detected.fingerprint,
      metadata: {
        detection_lookback_minutes: lookbackMinutes,
      },
    });

    const existing = await loadIssue(supabase, userId, issueId);
    if (existing && existing.messages.length === 0) {
      await seedIssueFromOrigin(supabase, userId, issueId, `Detection summary: ${detected.summary}`);
      for (const evidence of detected.evidence) {
        await seedIssueFromOrigin(supabase, userId, issueId, `${evidence.title}: ${evidence.detail}`);
      }
    } else {
      await updateIssue(supabase, userId, issueId, {
        title: detected.title,
        summary: detected.summary,
        severity: detected.severity,
        affected_nas: detected.affected_nas,
      });
    }

    createdIds.push(issueId);
  }

  return createdIds;
}
