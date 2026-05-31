import type { SupabaseClient, IssueSeverity } from "@/lib/server/issue-store";

type NasUnitRow = {
  id: string;
  name: string | null;
  hostname: string | null;
};

type AlertRow = {
  id: string;
  nas_id: string | null;
  severity: IssueSeverity;
  source: string;
  title: string;
  message: string;
  created_at: string;
};

// Detected issues surface here as "problems" in the copilot/resolution UI.
// Formerly read from analyzed_problems; now reads from issues with
// origin_type='detected' so the source of truth matches /api/analysis.
type DetectedIssueRow = {
  id: string;
  title: string;
  summary: string | null;
  severity: IssueSeverity;
  affected_nas: string[];
  current_hypothesis: string | null;
  status: string;
  updated_at: string;
};

function severityRank(severity: IssueSeverity) {
  if (severity === "critical") return 3;
  if (severity === "warning") return 2;
  return 1;
}

function pickSeverity(values: IssueSeverity[]): IssueSeverity {
  return values.reduce<IssueSeverity>((highest, value) => {
    return severityRank(value) > severityRank(highest) ? value : highest;
  }, "info");
}

function formatUtc(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toISOString().replace(".000Z", "Z");
}

const ACTIVE_ISSUE_STATUSES = ["open", "running", "waiting_on_user", "waiting_for_approval", "waiting_on_issue"];

export async function buildBackendFindingsSnapshot(supabase: SupabaseClient) {
  const [nasUnitsResult, detectedIssuesResult, alertsResult] = await Promise.all([
    supabase.from("nas_units").select("id, name, hostname"),
    supabase
      .from("issues")
      .select("id, title, summary, severity, affected_nas, current_hypothesis, status, updated_at")
      .eq("origin_type", "detected")
      .in("status", ACTIVE_ISSUE_STATUSES)
      .order("updated_at", { ascending: false })
      .limit(12),
    supabase
      .from("alerts")
      .select("id, nas_id, severity, source, title, message, created_at")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  if (nasUnitsResult.error) throw new Error(`Failed to load NAS units: ${nasUnitsResult.error.message}`);
  if (detectedIssuesResult.error) throw new Error(`Failed to load detected issues: ${detectedIssuesResult.error.message}`);
  if (alertsResult.error) throw new Error(`Failed to load active alerts: ${alertsResult.error.message}`);

  const nasNameById = new Map<string, string>();
  for (const row of (nasUnitsResult.data ?? []) as NasUnitRow[]) {
    nasNameById.set(row.id, row.name || row.hostname || row.id);
  }

  const problems = (detectedIssuesResult.data ?? []) as DetectedIssueRow[];
  const alerts = (alertsResult.data ?? []) as AlertRow[];

  const affectedNas = Array.from(new Set([
    ...problems.flatMap((p) => p.affected_nas ?? []),
    ...alerts.map((a) => a.nas_id ? (nasNameById.get(a.nas_id) ?? a.nas_id) : null),
  ].filter((v): v is string => Boolean(v))));

  const severities = [
    ...problems.map((p) => p.severity),
    ...alerts.map((a) => a.severity),
  ];
  const severity = severities.length > 0 ? pickSeverity(severities) : "info";

  const latestUpdatedAt = problems[0]?.updated_at ?? null;
  const title = problems.length > 0 || alerts.length > 0
    ? "Current backend findings across both NASes"
    : "No active backend findings across both NASes";

  const lines: string[] = [];
  lines.push(title);
  lines.push(`Last detection run: ${latestUpdatedAt ? formatUtc(latestUpdatedAt) : "unavailable"}`);
  lines.push(`Open detected issues: ${problems.length}`);
  lines.push(`Active alerts: ${alerts.length}`);
  lines.push(`Affected NAS: ${affectedNas.length > 0 ? affectedNas.join(", ") : "none"}`);

  if (problems.length > 0) {
    lines.push("");
    lines.push("Detected issues:");
    for (const p of problems) {
      const nasLabel = p.affected_nas?.length ? ` [${p.affected_nas.join(", ")}]` : "";
      lines.push(`- (${p.severity}) ${p.title}${nasLabel}`);
      if (p.summary) lines.push(`  ${p.summary}`);
      if (p.current_hypothesis) lines.push(`  Hypothesis: ${p.current_hypothesis}`);
    }
  }

  if (alerts.length > 0) {
    lines.push("");
    lines.push("Active alerts:");
    for (const alert of alerts) {
      const nasLabel = alert.nas_id ? (nasNameById.get(alert.nas_id) ?? alert.nas_id) : "unknown NAS";
      lines.push(`- (${alert.severity}) ${alert.title} [${nasLabel}]`);
      lines.push(`  Source: ${alert.source}`);
      lines.push(`  ${alert.message}`);
      lines.push(`  Observed: ${formatUtc(alert.created_at)}`);
    }
  }

  if (problems.length === 0 && alerts.length === 0) {
    lines.push("");
    lines.push("The monitor backend does not currently report any open detected issues or active alerts.");
  }

  const summary = problems.length > 0 || alerts.length > 0
    ? `${problems.length} open detected issue${problems.length === 1 ? "" : "s"} and ${alerts.length} active alert${alerts.length === 1 ? "" : "s"} are currently present in the monitor backend.`
    : "The monitor backend currently reports no open detected issues and no active alerts.";

  return {
    title,
    summary,
    severity,
    affectedNas,
    seed: lines.join("\n"),
    metadata: {
      source: "backend_findings_snapshot",
      latest_analysis_run_at: latestUpdatedAt,
      open_problem_count: problems.length,
      active_alert_count: alerts.length,
    },
  };
}

export async function buildBackendFindingsPromptContext(supabase: SupabaseClient) {
  const snapshot = await buildBackendFindingsSnapshot(supabase);
  return [
    "## Current Monitor Backend Findings",
    snapshot.seed,
    "",
    `Overall summary: ${snapshot.summary}`,
  ].join("\n");
}
