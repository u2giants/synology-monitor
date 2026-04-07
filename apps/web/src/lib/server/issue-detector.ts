import OpenAI from "openai";
import { createIssue, loadIssue, updateIssue, type IssueSeverity, type SupabaseClient } from "./issue-store";
import { seedIssueFromOrigin } from "./issue-agent";
import { getDiagnosisModel } from "./ai-settings";

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

type GroupedSignal = {
  fingerprint: string;
  kind: "alert_cluster" | "log_cluster" | "security_cluster";
  title: string;
  severity: IssueSeverity;
  affected_nas: string[];
  scope: string;
  count: number;
  summary: string;
  evidence: Array<{ title: string; detail: string }>;
};

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

async function fetchDetectionContext(supabase: SupabaseClient, lookbackMinutes: number) {
  const since = new Date(Date.now() - lookbackMinutes * 60 * 1000).toISOString();

  const [alertsResult, logsResult, securityResult] = await Promise.all([
    supabase
      .from("smon_alerts")
      .select("id, nas_id, source, severity, title, message, details, created_at")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("smon_logs")
      .select("id, nas_id, source, severity, message, metadata, ingested_at")
      .gte("ingested_at", since)
      .in("severity", ["critical", "error", "warning"])
      .order("ingested_at", { ascending: false })
      .limit(250),
    supabase
      .from("smon_security_events")
      .select("id, nas_id, severity, type, title, description, file_path, user, detected_at")
      .gte("detected_at", since)
      .order("detected_at", { ascending: false })
      .limit(60),
  ]);

  return {
    alerts: (alertsResult.data ?? []) as AlertRow[],
    logs: (logsResult.data ?? []) as LogRow[],
    security_events: securityResult.data ?? [],
  };
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

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function mapSeverity(severity: string): IssueSeverity {
  if (severity === "critical" || severity === "error") return "critical";
  if (severity === "warning") return "warning";
  return "info";
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
  const message = normalizeKey(log.message);
  const action = normalizeKey(stringValue(log.metadata?.action));
  if (message.includes("stoi") || message.includes("synoshareget")) return "sharesync-metadata-corruption";
  if (message.includes("backup") && message.includes("fail")) return "backup-failure";
  if (action === "rename" || message.includes("rename")) return "rename-activity";
  if (action === "sync_failure" || message.includes("sync") && message.includes("fail")) return "sync-failure";
  if (action === "sync_conflict" || message.includes("conflict")) return "sync-conflict";
  return `${log.source}:${action || message.slice(0, 80)}`;
}

function buildAlertClusters(alerts: AlertRow[]): GroupedSignal[] {
  const clusters = new Map<string, GroupedSignal>();

  for (const alert of alerts) {
    const family = alertFamily(alert);
    const scope = pickScope({ title: alert.title, message: alert.message, details: alert.details });
    const key = `alert:${family}:${normalizeKey(scope)}:${alert.nas_id ?? "global"}`;

    const existing = clusters.get(key);
    const evidence = {
      title: alert.title,
      detail: `${alert.message} (${alert.created_at})`,
    };

    if (existing) {
      existing.count += 1;
      existing.evidence.push(evidence);
      existing.severity = severityRank(existing.severity) >= severityRank(mapSeverity(alert.severity))
        ? existing.severity
        : mapSeverity(alert.severity);
      continue;
    }

    clusters.set(key, {
      fingerprint: key,
      kind: "alert_cluster",
      title: humanizeAlertClusterTitle(family, scope),
      severity: mapSeverity(alert.severity),
      affected_nas: alert.nas_id ? [alert.nas_id] : [],
      scope,
      count: 1,
      summary: humanizeAlertClusterSummary(family, scope, 1),
      evidence: [evidence],
    });
  }

  return Array.from(clusters.values()).map((cluster) => ({
    ...cluster,
    summary: humanizeAlertClusterSummary(cluster.fingerprint.split(":")[1] ?? "issue", cluster.scope, cluster.count),
  }));
}

function buildLogClusters(logs: LogRow[]): GroupedSignal[] {
  const clusters = new Map<string, GroupedSignal>();

  for (const log of logs) {
    const family = logFamily(log);
    const scope = pickScope({ message: log.message, metadata: log.metadata });
    const key = `log:${family}:${normalizeKey(scope)}:${log.nas_id ?? "global"}`;

    const existing = clusters.get(key);
    const evidence = {
      title: `${log.source} ${log.severity}`,
      detail: `${log.message} (${log.ingested_at})`,
    };

    if (existing) {
      existing.count += 1;
      existing.evidence.push(evidence);
      existing.severity = severityRank(existing.severity) >= severityRank(mapSeverity(log.severity))
        ? existing.severity
        : mapSeverity(log.severity);
      continue;
    }

    clusters.set(key, {
      fingerprint: key,
      kind: "log_cluster",
      title: humanizeLogClusterTitle(family, scope),
      severity: mapSeverity(log.severity),
      affected_nas: log.nas_id ? [log.nas_id] : [],
      scope,
      count: 1,
      summary: humanizeLogClusterSummary(family, scope, 1),
      evidence: [evidence],
    });
  }

  return Array.from(clusters.values())
    .filter((cluster) => cluster.count >= 2 || cluster.severity === "critical")
    .map((cluster) => ({
      ...cluster,
      summary: humanizeLogClusterSummary(cluster.fingerprint.split(":")[1] ?? "issue", cluster.scope, cluster.count),
    }));
}

function humanizeAlertClusterTitle(family: string, scope: string) {
  if (family === "mass-file-rename") return `Mass rename activity in ${scope}`;
  if (family === "backup-failure") return `Repeated backup failures for ${scope}`;
  if (family === "sync-error") return `Sync errors affecting ${scope}`;
  if (family === "sharesync") return `ShareSync alerts affecting ${scope}`;
  return scope && scope !== "general" ? `${scope}: recurring alert cluster` : "Recurring active alerts";
}

function humanizeAlertClusterSummary(family: string, scope: string, count: number) {
  if (family === "mass-file-rename") return `${count} active mass-rename alerts point to the same folder or share. Treat this as one investigation thread until the underlying cause is confirmed.`;
  if (family === "backup-failure") return `${count} active alerts indicate the same backup job is failing repeatedly. This should be investigated as one backup problem, not ${count} separate incidents.`;
  if (family === "sync-error") return `${count} active sync-error alerts appear to share the same root cause for ${scope}.`;
  return `${count} related active alerts were grouped into one issue thread for ${scope}.`;
}

function humanizeLogClusterTitle(family: string, scope: string) {
  if (family === "sharesync-metadata-corruption") return `ShareSync metadata errors on ${scope}`;
  if (family === "backup-failure") return `Backup failures on ${scope}`;
  if (family === "rename-activity") return `Heavy rename activity in ${scope}`;
  if (family === "sync-failure") return `Sync failures affecting ${scope}`;
  if (family === "sync-conflict") return `Sync conflicts affecting ${scope}`;
  return scope && scope !== "general" ? `Recurring ${scope} errors` : "Recurring log error cluster";
}

function humanizeLogClusterSummary(family: string, scope: string, count: number) {
  if (family === "sharesync-metadata-corruption") return `${count} log events point to ShareSync failing to parse or retrieve share metadata for ${scope}.`;
  if (family === "backup-failure") return `${count} log events show the same backup workflow failing repeatedly.`;
  if (family === "rename-activity") return `${count} rename-related log events were grouped together for ${scope}.`;
  if (family === "sync-failure") return `${count} sync-failure log events were grouped into one issue thread for ${scope}.`;
  return `${count} related log events were grouped together for ${scope}.`;
}

function severityRank(severity: IssueSeverity) {
  if (severity === "critical") return 3;
  if (severity === "warning") return 2;
  return 1;
}

function repairTruncatedJSON(text: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let lastSafePos = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      inString = !inString;
      if (!inString) lastSafePos = i + 1;
      continue;
    }
    if (inString) continue;

    if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") {
      if (stack.length > 0) {
        stack.pop();
        lastSafePos = i + 1;
      }
    }
  }

  if (stack.length === 0) return text;
  return text.slice(0, lastSafePos) + stack.reverse().join("");
}

function parseJsonSafely<T>(raw: string): T | null {
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const braceMatch = cleaned.match(/\{[\s\S]*/);
    if (!braceMatch) return null;
    try {
      return JSON.parse(braceMatch[0]) as T;
    } catch {
      try {
        return JSON.parse(repairTruncatedJSON(braceMatch[0])) as T;
      } catch {
        return null;
      }
    }
  }
}

async function detectIssuesFromClusters(clusters: GroupedSignal[]) {
  const client = getOpenAIClient();
  const model = await getDiagnosisModel();
  const limitedClusters = clusters
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.count - a.count)
    .slice(0, 40)
    .map((cluster) => ({
      fingerprint: cluster.fingerprint,
      title: cluster.title,
      severity: cluster.severity,
      affected_nas: cluster.affected_nas,
      scope: cluster.scope,
      count: cluster.count,
      summary: cluster.summary,
      evidence: cluster.evidence.slice(0, 5),
    }));

  const response = await client.chat.completions.create({
    model,
    messages: [{
      role: "user",
      content: `You are creating operator-facing issue threads from pre-grouped Synology telemetry.

The input is already clustered. Your job is to merge clusters only when they clearly describe the same root cause.
Prefer fewer, better issue threads.
If five alerts are the same problem in the same folder or backup task, produce one issue thread.

Clustered telemetry:
${JSON.stringify(limitedClusters, null, 2)}

Return JSON only:
{
  "issues": [
    {
      "fingerprint": "stable-short-id",
      "title": "Operator-facing issue title",
      "summary": "2-4 sentence summary with plain-English cause and business impact",
      "severity": "critical|warning|info",
      "affected_nas": ["edgesynology1"],
      "evidence": [
        {"title":"Why this issue exists", "detail":"specific evidence"}
      ]
    }
  ]
}`
    }],
    response_format: { type: "json_object" },
    max_tokens: 2200,
  });

  const raw = response.choices[0]?.message?.content ?? '{"issues":[]}';
  const parsed = parseJsonSafely<{ issues?: DetectedIssue[] }>(raw);
  return parsed?.issues ?? null;
}

function fallbackIssuesFromClusters(clusters: GroupedSignal[]): DetectedIssue[] {
  return clusters
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.count - a.count)
    .slice(0, 25)
    .map((cluster) => ({
      fingerprint: cluster.fingerprint,
      title: cluster.title,
      summary: cluster.summary,
      severity: cluster.severity,
      affected_nas: cluster.affected_nas,
      evidence: cluster.evidence.slice(0, 4),
    }));
}

export async function runIssueDetection(
  supabase: SupabaseClient,
  userId: string,
  lookbackMinutes: number
) {
  const context = await fetchDetectionContext(supabase, lookbackMinutes);
  const alertClusters = buildAlertClusters(context.alerts);
  const logClusters = buildLogClusters(context.logs);
  const allClusters = [...alertClusters, ...logClusters];

  const modelIssues = await detectIssuesFromClusters(allClusters);
  const issues = modelIssues && modelIssues.length > 0 ? modelIssues : fallbackIssuesFromClusters(allClusters);

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
      for (const evidence of detected.evidence ?? []) {
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
