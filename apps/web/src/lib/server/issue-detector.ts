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

async function fetchDetectionContext(supabase: SupabaseClient, lookbackMinutes: number) {
  const since = new Date(Date.now() - lookbackMinutes * 60 * 1000).toISOString();

  const [alertsResult, errorLogsResult, driveInfoResult] = await Promise.all([
    supabase
      .from("smon_alerts")
      .select("id, nas_id, source, severity, title, message, details, created_at")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(250),
    supabase
      .from("smon_logs")
      .select("id, nas_id, source, severity, message, metadata, ingested_at")
      .gte("ingested_at", since)
      .in("severity", ["critical", "error", "warning"])
      .order("ingested_at", { ascending: false })
      .limit(1200),
    supabase
      .from("smon_logs")
      .select("id, nas_id, source, severity, message, metadata, ingested_at")
      .gte("ingested_at", since)
      .eq("source", "drive_server")
      .order("ingested_at", { ascending: false })
      .limit(4000),
  ]);

  const combinedLogs = [
    ...((errorLogsResult.data ?? []) as LogRow[]),
    ...((driveInfoResult.data ?? []) as LogRow[]).filter((log) => isActionableInfoLog(log.message)),
  ];

  const dedupedLogs = Array.from(new Map(combinedLogs.map((log) => [log.id, log])).values());

  return {
    alerts: (alertsResult.data ?? []) as AlertRow[],
    logs: dedupedLogs,
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
  const context = await fetchDetectionContext(supabase, lookbackMinutes);
  const issues = mergeGroupsIntoIssues([
    ...buildAlertGroups(context.alerts),
    ...buildLogGroups(context.logs),
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
