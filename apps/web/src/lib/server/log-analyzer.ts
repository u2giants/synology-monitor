/**
 * Log Analyzer - Automatic AI-powered root cause analysis
 * Uses Minimax M2.7 for bulk log analysis and diagnosis
 */

import { callMinimaxJSON } from "./minimax";
import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";

// Types for the analysis result
export interface AffectedFile {
  path: string;
  detail: string;
}

export interface AnalyzedProblem {
  id: string;
  slug: string;
  title: string;
  explanation: string;
  severity: "critical" | "warning" | "info";
  affected_nas: string[];
  affected_shares: string[];
  affected_users: string[];
  affected_files: AffectedFile[];
  raw_event_count: number;
  raw_event_ids: string[];
  technical_diagnosis: string;
  first_seen: string;
  last_seen: string;
}

export interface AnalysisResult {
  problems: AnalyzedProblem[];
  summary: string;
}

interface MinimaxAnalysisResponse {
  problems: {
    id: string;
    title: string;
    explanation: string;
    severity: "critical" | "warning" | "info";
    affected_nas: string[];
    affected_shares: string[];
    affected_users: string[];
    affected_files: AffectedFile[];
    raw_event_count: number;
    raw_event_ids: string[];
    technical_diagnosis: string;
    first_seen: string;
    last_seen: string;
  }[];
  summary: string;
}

const SYSTEM_PROMPT = `You are a Synology NAS diagnostic AI. You receive raw alerts, error logs, and sync events from two Synology DS1621xs+ NAS devices (edgesynology1 and edgesynology2) that sync data between each other using Synology Drive ShareSync.

Your job is to:
1. Identify the ROOT CAUSE of each distinct problem. Multiple alerts/log entries may stem from the same root cause — group them together.
2. For each distinct root cause, produce:
   - A plain-English title (no technical jargon, understandable by a non-technical business owner)
   - A plain-English explanation of what is happening and why
   - Which NAS(es) are affected
   - Which files/shares/users are affected (be specific — include paths, usernames, share names)
   - The severity: critical (data loss risk), warning (degraded but no data loss), info (cosmetic/minor)
   - A detailed technical diagnosis that a repair AI can use to fix the problem
3. If a sync conflict or failure involves files, explain what state each NAS has (which version is newer, which is older, are there size differences)
4. Count how many raw log entries map to each root cause

All timestamps in your response must be in America/New_York timezone (EST/EDT) format like: 2026-04-01T15:00:00-04:00

Respond ONLY with valid JSON matching this exact structure:
{
  "problems": [
    {
      "id": "unique-short-slug",
      "title": "Plain English title",
      "explanation": "What's happening, in plain English, with full detail",
      "severity": "critical|warning|info",
      "affected_nas": ["edgesynology1"],
      "affected_shares": ["/files"],
      "affected_users": ["ahazan"],
      "affected_files": [{"path": "/files/project.psd", "detail": "conflict between NAS1 (modified 2026-04-01 3:15 PM, 45MB) and NAS2 (modified 2026-04-01 2:50 PM, 44MB)"}],
      "raw_event_count": 28,
      "raw_event_ids": ["id1", "id2"],
      "technical_diagnosis": "Detailed technical explanation for the repair AI, including exact log evidence, sequence of events, and what needs to happen to fix this",
      "first_seen": "2026-04-01T15:00:00-04:00",
      "last_seen": "2026-04-01T16:30:00-04:00"
    }
  ],
  "summary": "One-paragraph overall health summary in plain English"
}`;

/**
 * Fetch recent data from Supabase for analysis
 */
async function fetchAnalysisData(lookbackMinutes: number) {
  const supabase = await createSupabaseServerClient();
  const since = new Date(Date.now() - lookbackMinutes * 60 * 1000).toISOString();

  const [
    alertsResult,
    logsResult,
    securityResult,
    driveLogsResult,
  ] = await Promise.all([
    // Active alerts
    supabase
      .from("smon_alerts")
      .select("*")
      .eq("status", "active")
      .gte("created_at", since),

    // Recent error/warning logs (scale limit with lookback window)
    supabase
      .from("smon_logs")
      .select("*")
      .in("severity", ["error", "warning", "critical"])
      .gte("ingested_at", since)
      .order("ingested_at", { ascending: false })
      .limit(Math.min(1000, lookbackMinutes * 2)),

    // Recent security events
    supabase
      .from("smon_security_events")
      .select("*")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(Math.min(500, lookbackMinutes)),

    // Drive/sync logs
    supabase
      .from("smon_logs")
      .select("*")
      .in("source", ["drive", "drive_server", "drive_sharesync", "smb"])
      .gte("ingested_at", since)
      .order("ingested_at", { ascending: false })
      .limit(Math.min(1000, lookbackMinutes * 2)),
  ]);

  return {
    alerts: alertsResult.data || [],
    logs: logsResult.data || [],
    securityEvents: securityResult.data || [],
    driveLogs: driveLogsResult.data || [],
  };
}

/**
 * Format data for the AI prompt
 */
function formatDataForPrompt(
  alerts: unknown[],
  logs: unknown[],
  securityEvents: unknown[],
  driveLogs: unknown[]
): string {
  const sections: string[] = [];

  if (alerts.length > 0) {
    sections.push(`## ACTIVE ALERTS (${alerts.length})\n${JSON.stringify(alerts, null, 2)}`);
  }

  if (logs.length > 0) {
    sections.push(`## ERROR/WARNING LOGS (${logs.length})\n${JSON.stringify(logs, null, 2)}`);
  }

  if (securityEvents.length > 0) {
    sections.push(`## SECURITY EVENTS (${securityEvents.length})\n${JSON.stringify(securityEvents, null, 2)}`);
  }

  if (driveLogs.length > 0) {
    sections.push(`## DRIVE/SYNC LOGS (${driveLogs.length})\n${JSON.stringify(driveLogs, null, 2)}`);
  }

  return sections.join("\n\n");
}

/**
 * Store analysis results in database
 */
async function storeAnalysisResult(
  result: AnalysisResult,
  lookbackMinutes: number,
  tokensUsed: number
): Promise<string | null> {
  const supabase = await createSupabaseServerClient();

  // Create analysis run
  const { data: runData, error: runError } = await supabase
    .from("smon_analysis_runs")
    .insert({
      summary: result.summary,
      problem_count: result.problems.length,
      model: "MiniMax-M2.7",
      tokens_used: tokensUsed,
      lookback_minutes: lookbackMinutes,
    })
    .select("id")
    .single();

  if (runError || !runData) {
    console.error("[log-analyzer] Failed to create analysis run:", runError);
    return null;
  }

  const runId = runData.id;

  // Insert problems
  if (result.problems.length > 0) {
    const problemsToInsert = result.problems.map((problem) => ({
      analysis_run_id: runId,
      slug: problem.id,
      title: problem.title,
      explanation: problem.explanation,
      severity: problem.severity,
      affected_nas: problem.affected_nas,
      affected_shares: problem.affected_shares,
      affected_users: problem.affected_users,
      affected_files: problem.affected_files,
      raw_event_count: problem.raw_event_count,
      raw_event_ids: problem.raw_event_ids,
      technical_diagnosis: problem.technical_diagnosis,
      first_seen: problem.first_seen,
      last_seen: problem.last_seen,
    }));

    const { error: problemsError } = await supabase
      .from("smon_analyzed_problems")
      .insert(problemsToInsert);

    if (problemsError) {
      console.error("[log-analyzer] Failed to insert problems:", problemsError);
    }
  }

  // Auto-resolve old problems that don't appear in new analysis
  await autoResolveOldProblems(supabase, result.problems, runId);

  return runId;
}

/**
 * Auto-resolve problems from previous runs that don't appear in current analysis
 */
async function autoResolveOldProblems(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  currentProblems: AnalyzedProblem[],
  currentRunId: string
) {
  // Get all open problems from previous runs
  const previousOpenProblems = await supabase
    .from("smon_analyzed_problems")
    .select("id, slug, raw_event_ids")
    .eq("status", "open")
    .neq("analysis_run_id", currentRunId);

  if (previousOpenProblems.error || !previousOpenProblems.data) return;

  const currentEventIds = new Set(
    currentProblems.flatMap((p) => p.raw_event_ids)
  );

  for (const oldProblem of previousOpenProblems.data) {
    // Check if any of the old problem's events are still present
    const hasOverlappingEvents = oldProblem.raw_event_ids?.some(
      (id: string) => currentEventIds.has(id)
    );

    // If no overlapping events, auto-resolve
    if (!hasOverlappingEvents) {
      await supabase
        .from("smon_analyzed_problems")
        .update({
          status: "resolved",
          resolution: "Automatically resolved - no related events in latest analysis",
        })
        .eq("id", oldProblem.id);
    }
  }
}

/**
 * Main analysis function - runs Minimax on recent data and stores results
 */
export async function analyzeRecentLogs(
  lookbackMinutes: number = 60
): Promise<{
  runId: string | null;
  result: AnalysisResult | null;
  error?: string;
}> {
  try {
    // Fetch data
    const data = await fetchAnalysisData(lookbackMinutes);

    const totalItems =
      data.alerts.length +
      data.logs.length +
      data.securityEvents.length +
      data.driveLogs.length;

    if (totalItems === 0) {
      return {
        runId: null,
        result: { problems: [], summary: "No events found in the specified time range." },
      };
    }

    // Build prompt
    const userPrompt = `Analyze the following data from the Synology NAS monitoring system:

${formatDataForPrompt(data.alerts, data.logs, data.securityEvents, data.driveLogs)}

Total: ${totalItems} events to analyze. Identify distinct root causes and group related events.`;

    // Call Minimax
    const { data: minimaxData, error: minimaxError } = await callMinimaxJSON<MinimaxAnalysisResponse>(
      SYSTEM_PROMPT,
      userPrompt
    );

    if (minimaxError || !minimaxData) {
      console.error("[log-analyzer] Minimax call failed:", minimaxError);
      return {
        runId: null,
        result: null,
        error: minimaxError || "Minimax returned no data",
      };
    }

    // Format result
    const result: AnalysisResult = {
      problems: minimaxData.problems.map((p) => ({
        id: p.id,
        slug: p.id,
        title: p.title,
        explanation: p.explanation,
        severity: p.severity,
        affected_nas: p.affected_nas || [],
        affected_shares: p.affected_shares || [],
        affected_users: p.affected_users || [],
        affected_files: p.affected_files || [],
        raw_event_count: p.raw_event_count || 0,
        raw_event_ids: p.raw_event_ids || [],
        technical_diagnosis: p.technical_diagnosis || "",
        first_seen: p.first_seen || new Date().toISOString(),
        last_seen: p.last_seen || new Date().toISOString(),
      })),
      summary: minimaxData.summary || "Analysis complete.",
    };

    // Store in database
    const runId = await storeAnalysisResult(result, lookbackMinutes, 0);

    return { runId, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[log-analyzer] Analysis failed:", message);
    return { runId: null, result: null, error: message };
  }
}

/**
 * Get the most recent analysis run with its problems
 */
export async function getLatestAnalysis() {
  const supabase = await createSupabaseServerClient();

  const { data: latestRun, error: runError } = await supabase
    .from("smon_analysis_runs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (runError || !latestRun) {
    return { run: null, problems: [] };
  }

  const { data: problems, error: problemsError } = await supabase
    .from("smon_analyzed_problems")
    .select("*")
    .eq("analysis_run_id", latestRun.id)
    .order("created_at", { ascending: true });

  return {
    run: latestRun,
    problems: problemsError ? [] : problems,
  };
}

/**
 * Get a specific analysis run by ID
 */
export async function getAnalysisById(runId: string) {
  const supabase = await createSupabaseServerClient();

  const { data: run, error: runError } = await supabase
    .from("smon_analysis_runs")
    .select("*")
    .eq("id", runId)
    .single();

  if (runError || !run) {
    return { run: null, problems: [] };
  }

  const { data: problems, error: problemsError } = await supabase
    .from("smon_analyzed_problems")
    .select("*")
    .eq("analysis_run_id", runId)
    .order("created_at", { ascending: true });

  return {
    run,
    problems: problemsError ? [] : problems,
  };
}
