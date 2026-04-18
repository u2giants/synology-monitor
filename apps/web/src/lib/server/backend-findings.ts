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

type ProblemRow = {
  id: string;
  title: string;
  explanation: string;
  severity: IssueSeverity;
  affected_nas: string[];
  technical_diagnosis: string;
  status: "open" | "investigating" | "resolved";
  created_at: string;
};

type AnalysisRunRow = {
  id: string;
  created_at: string;
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

export async function buildBackendFindingsSnapshot(supabase: SupabaseClient) {
  const [nasUnitsResult, latestRunResult, alertsResult] = await Promise.all([
    supabase.from("nas_units").select("id, name, hostname"),
    supabase
      .from("analysis_runs")
      .select("id, created_at")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("alerts")
      .select("id, nas_id, severity, source, title, message, created_at")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  if (nasUnitsResult.error) {
    throw new Error(`Failed to load NAS units: ${nasUnitsResult.error.message}`);
  }
  if (latestRunResult.error) {
    throw new Error(`Failed to load latest analysis run: ${latestRunResult.error.message}`);
  }
  if (alertsResult.error) {
    throw new Error(`Failed to load active alerts: ${alertsResult.error.message}`);
  }

  const nasNameById = new Map<string, string>();
  for (const row of (nasUnitsResult.data ?? []) as NasUnitRow[]) {
    nasNameById.set(row.id, row.name || row.hostname || row.id);
  }

  let problems: ProblemRow[] = [];
  if (latestRunResult.data?.id) {
    const problemsResult = await supabase
      .from("analyzed_problems")
      .select("id, title, explanation, severity, affected_nas, technical_diagnosis, status, created_at")
      .eq("analysis_run_id", latestRunResult.data.id)
      .neq("status", "resolved")
      .order("created_at", { ascending: true })
      .limit(12);

    if (problemsResult.error) {
      throw new Error(`Failed to load analyzed problems: ${problemsResult.error.message}`);
    }
    problems = (problemsResult.data ?? []) as ProblemRow[];
  }

  const alerts = (alertsResult.data ?? []) as AlertRow[];
  const affectedNas = Array.from(new Set([
    ...problems.flatMap((problem) => problem.affected_nas ?? []),
    ...alerts.map((alert) => alert.nas_id ? (nasNameById.get(alert.nas_id) ?? alert.nas_id) : null),
  ].filter((value): value is string => Boolean(value))));

  const severities = [
    ...problems.map((problem) => problem.severity),
    ...alerts.map((alert) => alert.severity),
  ];
  const severity = severities.length > 0 ? pickSeverity(severities) : "info";

  const latestRun = latestRunResult.data as AnalysisRunRow | null;
  const title = problems.length > 0 || alerts.length > 0
    ? "Current backend findings across both NASes"
    : "No active backend findings across both NASes";

  const lines: string[] = [];
  lines.push(title);
  if (latestRun?.created_at) {
    lines.push(`Latest analysis run: ${formatUtc(latestRun.created_at)}`);
  } else {
    lines.push("Latest analysis run: unavailable");
  }
  lines.push(`Open analyzed problems: ${problems.length}`);
  lines.push(`Active alerts: ${alerts.length}`);
  lines.push(`Affected NAS: ${affectedNas.length > 0 ? affectedNas.join(", ") : "none"}`);

  if (problems.length > 0) {
    lines.push("");
    lines.push("Analyzed problems:");
    for (const problem of problems) {
      const nasLabel = problem.affected_nas?.length ? ` [${problem.affected_nas.join(", ")}]` : "";
      lines.push(`- (${problem.severity}) ${problem.title}${nasLabel}`);
      lines.push(`  ${problem.explanation}`);
      lines.push(`  Technical diagnosis: ${problem.technical_diagnosis}`);
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
    lines.push("The monitor backend does not currently report any open analyzed problems or active alerts.");
  }

  const summary = problems.length > 0 || alerts.length > 0
    ? `${problems.length} open analyzed problem${problems.length === 1 ? "" : "s"} and ${alerts.length} active alert${alerts.length === 1 ? "" : "s"} are currently present in the monitor backend.`
    : "The monitor backend currently reports no open analyzed problems and no active alerts.";

  return {
    title,
    summary,
    severity,
    affectedNas,
    seed: lines.join("\n"),
    metadata: {
      source: "backend_findings_snapshot",
      latest_analysis_run_at: latestRun?.created_at ?? null,
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
