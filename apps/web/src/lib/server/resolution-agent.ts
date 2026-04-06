/**
 * Resolution Agent — the brain of the issue resolution state machine.
 * Each call to tick() processes one step and returns the new state.
 *
 * The agent can iterate: diagnose → analyze → re-diagnose → propose fix →
 * apply ONE fix → verify → re-diagnose if issues remain → propose next fix → ...
 */

import { callMinimaxJSON } from "./minimax";
import { getRemediationModel, getSecondOpinionModel } from "./ai-settings";
import { readFile } from "fs/promises";
import { join } from "path";
import { runNasScript, getNasConfigs } from "./nas";
import {
  TOOL_DEFINITIONS,
  toolCatalogText,
  buildApprovalToken,
  verifyApprovalToken,
  type NasTarget,
  type CopilotToolName,
} from "./tools";
import {
  loadResolution,
  updateResolution,
  createSteps,
  updateStepStatus,
  appendLog,
  safeAppendMessage,
  type SupabaseClient,
  type ResolutionFull,
  type ResolutionStep,
  type StepInput,
} from "./resolution-store";
import { getCustomMetricContext } from "./metric-collector";
import OpenAI from "openai";

// --- Tick lock: prevent concurrent ticks on the same resolution ---
const activeTicks = new Set<string>();

// --- AI call health tracking (in-memory, resets on server restart) ---
const aiCallStats = {
  total: 0,
  success: 0,
  parseError: 0,
  timeout: 0,
  modelError: 0,
  lastErrors: [] as { model: string; error: string; ts: number }[],
};
function trackAICall(ok: boolean, model: string, error?: string) {
  aiCallStats.total++;
  if (ok) { aiCallStats.success++; return; }
  const errLower = (error ?? "").toLowerCase();
  if (errLower.includes("timeout") || errLower.includes("timed out")) aiCallStats.timeout++;
  else if (errLower.includes("parse") || errLower.includes("json")) aiCallStats.parseError++;
  else aiCallStats.modelError++;
  aiCallStats.lastErrors.push({ model, error: (error ?? "unknown").slice(0, 200), ts: Date.now() });
  if (aiCallStats.lastErrors.length > 20) aiCallStats.lastErrors.shift();
}
function getAIHealthSummary(): string {
  if (aiCallStats.total === 0) return "No AI calls tracked yet (server may have just restarted).";
  const pct = Math.round(100 * aiCallStats.success / aiCallStats.total);
  let summary = `AI calls: ${aiCallStats.total} total, ${pct}% success, ${aiCallStats.parseError} parse errors, ${aiCallStats.timeout} timeouts, ${aiCallStats.modelError} model errors.`;
  if (aiCallStats.lastErrors.length > 0) {
    const recent = aiCallStats.lastErrors.slice(-5).map(e =>
      `  - ${new Date(e.ts).toISOString()} ${e.model}: ${e.error}`
    ).join("\n");
    summary += `\nRecent errors:\n${recent}`;
  }
  return summary;
}

// --- OpenRouter client ---

function getOpenAIClient() {
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured.");
  return new OpenAI({ apiKey, baseURL: "https://openrouter.ai/api/v1" });
}

// --- System context ---

async function fetchSystemContext(supabase: SupabaseClient, lookbackHours: number) {
  const lookbackCutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();
  const resourceCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  const [
    alerts, driveLogs, securityEvents, processSnaps, diskIO, netConns,
    storageSnaps, syncTasks, systemMetrics, containers, serviceHealth,
  ] = await Promise.all([
    supabase
      .from("smon_alerts")
      .select("severity, status, source, title, message, created_at")
      .or(`status.eq.active,created_at.gte.${lookbackCutoff}`)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("smon_logs")
      .select("source, severity, message, metadata, ingested_at")
      .in("source", [
        "drive", "drive_server", "drive_sharesync",
        "webapi", "storage", "share", "kernel",
        "service", "share_config", "share_health",
        "package_health", "dsm_system_log", "kernel_health",
      ])
      .gte("ingested_at", lookbackCutoff)
      .order("ingested_at", { ascending: false })
      .limit(120),
    supabase
      .from("smon_security_events")
      .select("severity, type, title, description, file_path, user, detected_at")
      .gte("detected_at", lookbackCutoff)
      .order("detected_at", { ascending: false })
      .limit(20),
    supabase
      .from("smon_process_snapshots")
      .select("nas_id, captured_at, name, username, cpu_pct, mem_pct, write_bps, parent_service")
      .gte("captured_at", resourceCutoff)
      .order("write_bps", { ascending: false })
      .limit(30),
    supabase
      .from("smon_disk_io_stats")
      .select("nas_id, captured_at, device, read_bps, write_bps, await_ms, util_pct")
      .gte("captured_at", resourceCutoff)
      .order("captured_at", { ascending: false })
      .limit(20),
    supabase
      .from("smon_net_connections")
      .select("nas_id, remote_ip, local_port, conn_count, username")
      .gte("captured_at", resourceCutoff)
      .order("conn_count", { ascending: false })
      .limit(20),
    // --- Data that was being collected but NOT fed to the AI until now ---
    supabase
      .from("smon_storage_snapshots")
      .select("nas_id, volume_id, volume_path, total_bytes, used_bytes, status, raid_type, disks, recorded_at")
      .gte("recorded_at", resourceCutoff)
      .order("recorded_at", { ascending: false })
      .limit(10),
    supabase
      .from("smon_sync_task_snapshots")
      .select("nas_id, captured_at, task_id, task_name, status, backlog_count, backlog_bytes, current_file, retry_count, last_error, speed_bps, indexing_queue")
      .gte("captured_at", resourceCutoff)
      .order("captured_at", { ascending: false })
      .limit(20),
    supabase
      .from("smon_metrics")
      .select("nas_id, type, value, unit, metadata, recorded_at")
      .gte("recorded_at", resourceCutoff)
      .order("recorded_at", { ascending: false })
      .limit(40),
    supabase
      .from("smon_container_status")
      .select("nas_id, container_name, image, status, cpu_percent, memory_bytes, uptime_seconds, recorded_at")
      .gte("recorded_at", resourceCutoff)
      .order("recorded_at", { ascending: false })
      .limit(20),
    supabase
      .from("smon_service_health")
      .select("nas_id, service_name, status, captured_at")
      .gte("captured_at", resourceCutoff)
      .order("captured_at", { ascending: false })
      .limit(30),
  ]);

  return {
    active_alerts: alerts.data ?? [],
    recent_drive_logs: driveLogs.data ?? [],
    recent_security_events: securityEvents.data ?? [],
    top_processes: processSnaps.data ?? [],
    disk_io_stats: diskIO.data ?? [],
    net_connections: netConns.data ?? [],
    storage_health: storageSnaps.data ?? [],
    sync_task_status: syncTasks.data ?? [],
    system_metrics: systemMetrics.data ?? [],
    container_status: containers.data ?? [],
    service_health: serviceHealth.data ?? [],
  };
}

// --- AI calls ---

interface PlanResponse {
  plan_summary: string;
  steps: Array<{
    title: string;
    target: NasTarget;
    tool_name: CopilotToolName;
    reason: string;
    lookback_hours?: number;
    filter?: string;
  }>;
}

interface AnalysisResponse {
  needs_more_diagnostics: boolean;
  additional_steps: Array<{
    title: string;
    target: NasTarget;
    tool_name: CopilotToolName;
    reason: string;
    lookback_hours?: number;
    filter?: string;
  }>;
  diagnosis_summary: string;
  root_cause: string;
  confidence: "high" | "medium" | "low";
  /**
   * Data the AI needs but cannot collect with current tools.
   * Entries with a collection_command will be auto-scheduled for recurring SSH collection.
   * Entries without one require manual operator action.
   */
  missing_data_suggestions?: Array<{
    metric_name: string;
    description: string;
    target: NasTarget;
    /** Exact read-only shell command to collect this metric via SSH. Omit if manual action required. */
    collection_command?: string;
    interval_minutes?: number;
    why_needed: string;
    /** If no command available: what should the operator do manually? (e.g., enable a DSM feature) */
    manual_action?: string;
  }>;
}

interface FixProposalResponse {
  fix_summary: string;
  risk_assessment: string;
  fix_steps: Array<{
    title: string;
    target: NasTarget;
    tool_name: CopilotToolName;
    reason: string;
    risk: "low" | "medium" | "high";
    filter?: string;
  }>;
  verification_steps: Array<{
    title: string;
    target: NasTarget;
    tool_name: CopilotToolName;
    reason: string;
    lookback_hours?: number;
    filter?: string;
  }>;
}

interface VerificationResponse {
  fixed: boolean;
  verification_summary: string;
  remaining_concerns: string;
}

interface ReflectionResponse {
  evidence_quality: "good" | "thin" | "contaminated";
  quality_issues: string[];
  progress_assessment: "making_progress" | "stalled" | "looping";
  recommendation: "proceed" | "gather_more" | "escalate_to_user";
  notes: string;
}

async function callModel<T>(prompt: string, modelOverride?: string): Promise<T> {
  const client = getOpenAIClient();
  const model = modelOverride ?? await getRemediationModel();

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      max_tokens: 8000,
    });

    const text = response.choices?.[0]?.message?.content ?? "";
    const cleaned = text.replace(/^```json\s*/i, "").replace(/\s*```$/, "").trim();
    const result = JSON.parse(cleaned) as T;
    trackAICall(true, model);
    return result;
  } catch (err) {
    trackAICall(false, model, err instanceof Error ? err.message : "unknown");
    throw err;
  }
}

/** Call the primary remediation model */
async function callRemediation<T>(prompt: string): Promise<T> {
  return callModel<T>(prompt);
}

/** Call the second opinion model with robust JSON extraction (some models ignore response_format) */
async function callSecondOpinion<T>(prompt: string): Promise<T> {
  const model = await getSecondOpinionModel();
  const client = getOpenAIClient();

  // Add hard JSON enforcement to the prompt — some models ignore response_format
  const jsonPrompt = `${prompt}

IMPORTANT: Your ENTIRE response must be valid JSON. Start your response with { and end with }. Do NOT include any explanation, preamble, or markdown fences outside the JSON object.`;

  let text = "";
  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "You respond only with valid JSON objects. Never include explanation or prose outside the JSON." },
        { role: "user", content: jsonPrompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: 8000,
    });

    text = response.choices?.[0]?.message?.content ?? "";
  } catch (err) {
    trackAICall(false, model, err instanceof Error ? err.message : "unknown");
    throw err;
  }

  // Try direct parse
  const cleaned = text.replace(/^```json\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const result = JSON.parse(cleaned) as T;
    trackAICall(true, model);
    return result;
  } catch {
    // Try to extract the first {...} block from prose
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const result = JSON.parse(match[0]) as T;
        trackAICall(true, model);
        return result;
      } catch { /* fall through */ }
    }
    trackAICall(false, model, `JSON parse: "${text.slice(0, 120)}"`);
    throw new Error(`Second opinion model returned non-JSON: "${text.slice(0, 120)}"`);
  }
}

// --- Step materialization with null-safety ---

function materializeStepInput(
  raw: { title?: string; target?: string; tool_name?: string; reason?: string; risk?: string; lookback_hours?: number; filter?: string },
  category: "diagnostic" | "fix" | "verification",
  autoApproveReads: boolean,
  lookbackHours: number
): StepInput | null {
  // Validate required fields — AI sometimes returns incomplete objects
  const toolName = raw.tool_name as CopilotToolName;
  const target = raw.target as NasTarget;
  if (!raw.title || !target || !toolName) return null;

  const toolDef = TOOL_DEFINITIONS[toolName];
  if (!toolDef) return null;

  const preview = toolDef.buildPreview(target, {
    lookbackHours: raw.lookback_hours ?? lookbackHours,
    filter: raw.filter,
  });

  const isWrite = toolDef.write;
  const needsApproval = isWrite || !autoApproveReads;

  return {
    category,
    title: raw.title,
    target,
    toolName,
    commandPreview: preview,
    reason: raw.reason ?? "",
    risk: (raw.risk as "low" | "medium" | "high") ?? (isWrite ? "medium" : "low"),
    approvalToken: needsApproval ? buildApprovalToken(target, preview) : null,
    requiresApproval: needsApproval,
    status: needsApproval ? "planned" : "approved",
  };
}

// --- Execute a single step via SSH ---

async function executeStep(step: ResolutionStep): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }> {
  if (step.approval_token) {
    verifyApprovalToken(step.target as NasTarget, step.command_preview, step.approval_token);
  }

  const config = getNasConfigs().find((c) => c.name === step.target);
  if (!config) {
    return { ok: false, stdout: "", stderr: `Unknown NAS target: ${step.target}`, exitCode: null };
  }

  try {
    const result = await runNasScript(config, step.command_preview, 90_000);
    return { ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  } catch (err) {
    return { ok: false, stdout: "", stderr: err instanceof Error ? err.message : "SSH error", exitCode: null };
  }
}

/** appendLog that never throws — informational entries must never block phase transitions. */
async function safeAppendLog(
  supabase: SupabaseClient, userId: string, resolutionId: string,
  entryType: string, content: string, technicalDetail?: string | null
) {
  try {
    await appendLog(supabase, userId, resolutionId, entryType, content, technicalDetail);
  } catch (err) {
    console.error(`[safeAppendLog] Failed to write entry_type="${entryType}": ${err instanceof Error ? err.message : err}`);
  }
}

// --- Stall detection ---

const ACTIVE_PHASES_SET = new Set([
  "planning", "diagnosing", "analyzing", "proposing_fix", "applying_fix", "verifying",
]);
const STEP_RUNNING_TIMEOUT_MS = 120_000;
const PHASE_STALL_TIMEOUT_MS = 12 * 60 * 1000; // 12 minutes

/**
 * Detects and recovers from two classes of stall:
 * 1. A step stuck in "running" for >120s (SSH command never returned)
 * 2. An active phase with no DB updates for >12 min (agent silently hung)
 * Returns true if a stall was handled (caller should skip normal phase processing).
 */
async function detectStalls(
  supabase: SupabaseClient,
  userId: string,
  state: ResolutionFull
): Promise<boolean> {
  const { resolution, steps } = state;
  const now = Date.now();

  // 1. Hung running step
  for (const step of steps) {
    if (step.status === "running" && step.started_at) {
      const runningMs = now - new Date(step.started_at).getTime();
      if (runningMs > STEP_RUNNING_TIMEOUT_MS) {
        const secs = Math.round(runningMs / 1000);
        await updateStepStatus(supabase, userId, step.id, "failed",
          `Timed out after ${secs}s — step was still marked running when the next tick checked.`);
        await appendLog(supabase, userId, resolution.id, "error",
          `Step "${step.title}" on ${step.target} timed out after ${secs}s and was marked failed. The agent will continue with whatever data was collected.`);
        return true;
      }
    }
  }

  // 2. Phase-level stall
  if (ACTIVE_PHASES_SET.has(resolution.phase)) {
    const stalledMs = now - new Date(resolution.updated_at).getTime();
    if (stalledMs > PHASE_STALL_TIMEOUT_MS) {
      const mins = Math.round(stalledMs / 60_000);
      await updateResolution(supabase, userId, resolution.id, {
        phase: "stuck",
        stuck_reason: `Agent stalled in phase "${resolution.phase}" for ${mins} minutes with no progress. This usually means an AI model timed out or a network error occurred silently. Try sending a message to restart, or cancel and create a new resolution.`,
      });
      await appendLog(supabase, userId, resolution.id, "stuck",
        `No progress for ${mins} minutes in phase "${resolution.phase}". The agent was stuck and has been paused. Send a message or cancel to proceed.`);
      return true;
    }
  }

  return false;
}

// --- DB state consistency checks (no AI needed, catches impossible states) ---

/**
 * Checks for impossible DB states that a phase handler cannot recover from on its own.
 *
 * IMPORTANT: Only flag states where the normal handler CANNOT advance the phase.
 * Phases like "diagnosing" with all steps completed are VALID transitional states —
 * handleDiagnosing moves them to "analyzing" on the very same tick. Flagging those
 * creates false positives that incorrectly block normal operation.
 *
 * "awaiting_fix_approval" is the only truly unrecoverable state without user action,
 * because its switch-case is a no-op — nothing advances it if there's nothing to approve.
 */
function checkStateConsistency(state: ResolutionFull): string[] {
  const issues: string[] = [];
  const { resolution, steps } = state;

  // awaiting_fix_approval with all-rejected steps is handled by the tick handler
  // (it transitions back to proposing_fix). Do NOT flag it as inconsistent here —
  // the handler runs in the same tick and fixes it before it can cause problems.

  // Step marked running with no started_at — always a data integrity bug
  for (const step of steps) {
    if (step.status === "running" && !step.started_at) {
      issues.push(`INCONSISTENT: Step "${step.title}" is "running" but started_at is null.`);
    }
  }

  return issues;
}

// --- Reflection / quality gate ---

function reflectionPrompt(res: ResolutionFull, currentConfidence: string): string {
  const logEntries = res.log
    .slice(-30)
    .map(e => `[${e.entry_type}] ${e.content.slice(0, 300)}`)
    .join("\n");

  const stepSummary = res.steps
    .filter(s => s.status === "completed" || s.status === "failed")
    .map(s => `- ${s.tool_name} on ${s.target} [${s.status}]: ${(s.result_text ?? "no output").slice(0, 400)}`)
    .join("\n");

  return `You are a quality reviewer for an AI diagnostic agent working on a production Synology NAS.
Your job is to assess whether the agent's evidence is solid enough to proceed to a fix proposal.

ISSUE: ${res.resolution.title}
CURRENT CONFIDENCE: ${currentConfidence}
DIAGNOSIS SUMMARY: ${res.resolution.diagnosis_summary ?? "not yet written"}
ROOT CAUSE: ${res.resolution.root_cause ?? "not yet identified"}
ATTEMPT: ${res.resolution.attempt_count + 1} of ${res.resolution.max_attempts}

AGENT ACTIVITY (last 30 entries):
${logEntries}

DIAGNOSTIC STEP RESULTS:
${stepSummary || "No steps completed yet."}

EVALUATE THE FOLLOWING:
1. Evidence quality: Are step results substantive? Look for SSH banners with no real output, empty results, timeouts, or steps that just returned the default shell prompt. These are NOT real data.
2. Progress: Is the agent converging on a specific root cause with real evidence, or repeating similar checks without new information?
3. Recommendation: Should it proceed to propose a fix, gather more evidence first, or escalate to the user because the evidence is too weak or contradictory?

Respond ONLY with valid JSON:
{
  "evidence_quality": "good",
  "quality_issues": ["list any specific issues — e.g. 'check_sharesync_status returned only SSH banner', 'no disk health data collected'"],
  "progress_assessment": "making_progress",
  "recommendation": "proceed",
  "notes": "One or two sentences explaining your verdict"
}

evidence_quality: "good" = solid real output; "thin" = some gaps but enough to proceed; "contaminated" = significant outputs were noise/empty/SSH banners
recommendation: "proceed" = evidence supports the diagnosis; "gather_more" = needs specific additional checks; "escalate_to_user" = evidence too weak or contradictory to propose a safe fix`;
}

/**
 * Ask the second-opinion model to review evidence quality before proposing a fix.
 * Returns a safe default ("proceed") on any error so it never blocks the agent.
 */
async function reflectOnProgress(res: ResolutionFull, currentConfidence: string): Promise<ReflectionResponse> {
  try {
    return await callSecondOpinion<ReflectionResponse>(reflectionPrompt(res, currentConfidence));
  } catch {
    return {
      evidence_quality: "good",
      quality_issues: [],
      progress_assessment: "making_progress",
      recommendation: "proceed",
      notes: "Reflection check skipped (model error) — proceeding.",
    };
  }
}

// --- Code-aware incident review ---

interface SoftwareBugReviewResponse {
  likely_software_bug: boolean;
  confidence: "high" | "medium" | "low";
  behavior_observed: string;
  expected_behavior: string;
  suspected_component: string;
  suggested_fix_for_developer: string;
  alert_title: string;
}

/**
 * Code-aware incident review. Reads source code, checks cross-resolution patterns,
 * and evaluates AI call health to determine if a stuck resolution is a software bug.
 *
 * OUTPUT ONLY — never modifies code or state. Creates a log entry and a
 * dashboard alert so a developer can investigate. Runs fire-and-forget.
 */
async function reviewOwnBehavior(
  supabase: SupabaseClient,
  userId: string,
  state: ResolutionFull
): Promise<void> {
  try {
    const cwd = process.cwd();
    const srcBase = join(cwd, "src/lib/server");

    // --- 1. Source code: phase handlers, store, minimax, failed tools ---
    let agentSource = "";
    try {
      const raw = await readFile(join(srcBase, "resolution-agent.ts"), "utf-8");
      const handlerStart = raw.indexOf("// --- Phase handlers ---");
      const handlerEnd = raw.indexOf("// --- Main tick function ---");
      if (handlerStart !== -1 && handlerEnd !== -1) {
        agentSource = raw.slice(handlerStart, handlerEnd).slice(0, 15000);
      } else {
        agentSource = raw.slice(0, 15000);
      }
    } catch { /* source unavailable */ }

    let storeSource = "";
    try {
      const raw = await readFile(join(srcBase, "resolution-store.ts"), "utf-8");
      storeSource = raw.slice(0, 8000);
    } catch { /* source unavailable */ }

    let minimaxSource = "";
    try {
      const raw = await readFile(join(srcBase, "minimax.ts"), "utf-8");
      minimaxSource = raw.slice(0, 5000);
    } catch { /* source unavailable */ }

    let toolSource = "";
    const failedToolNames = [...new Set(
      state.steps
        .filter(s => s.status === "failed" || (s.status === "completed" && !s.result_text?.trim()))
        .map(s => s.tool_name)
    )];
    if (failedToolNames.length > 0) {
      try {
        const raw = await readFile(join(srcBase, "tools.ts"), "utf-8");
        const excerpts: string[] = [];
        for (const toolName of failedToolNames.slice(0, 3)) {
          const idx = raw.indexOf(`${toolName}:`);
          if (idx !== -1) excerpts.push(raw.slice(Math.max(0, idx - 20), idx + 1200));
        }
        toolSource = excerpts.join("\n\n---\n\n");
      } catch { /* tools source unavailable */ }
    }

    // Read relevant API route if the phase suggests an API-level issue
    let apiRouteSource = "";
    const phaseRouteMap: Record<string, string> = {
      awaiting_fix_approval: "approve/route.ts",
      planning: "message/route.ts",
    };
    const routeFile = phaseRouteMap[state.resolution.phase];
    if (routeFile) {
      try {
        apiRouteSource = await readFile(join(cwd, `src/app/api/resolution/${routeFile}`), "utf-8");
      } catch { /* route unavailable */ }
    }

    // --- 2. Cross-resolution pattern detection ---
    let patternSection = "";
    try {
      const { data: recentStuck } = await supabase
        .from("smon_issue_resolutions")
        .select("id, title, phase, stuck_reason, updated_at")
        .eq("user_id", userId)
        .eq("phase", "stuck")
        .gte("updated_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
        .order("updated_at", { ascending: false })
        .limit(10);

      if (recentStuck && recentStuck.length > 1) {
        // Group by stuck_reason prefix (first 80 chars) to detect repetition
        const reasonCounts = new Map<string, number>();
        for (const r of recentStuck) {
          const key = (r.stuck_reason ?? "").slice(0, 80);
          reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
        }
        const repeats = [...reasonCounts.entries()].filter(([, c]) => c >= 2);

        patternSection = `\nCROSS-RESOLUTION PATTERNS (last 7 days, ${recentStuck.length} stuck resolutions):\n`;
        patternSection += recentStuck.map(r =>
          `- "${r.title}" stuck at: ${(r.stuck_reason ?? "unknown").slice(0, 120)} (${r.updated_at})`
        ).join("\n");
        if (repeats.length > 0) {
          patternSection += `\n\n⚠️ REPEATED STUCK REASONS (strong signal for software bug):\n`;
          patternSection += repeats.map(([reason, count]) => `- "${reason}..." appeared ${count} times`).join("\n");
        }
      }
    } catch { /* pattern detection failed — continue without */ }

    // --- 3. AI call health stats ---
    const aiHealth = getAIHealthSummary();

    // --- 4. DB consistency issues already detected ---
    const consistencyIssues = checkStateConsistency(state);
    const consistencySection = consistencyIssues.length > 0
      ? `\nDB STATE INCONSISTENCIES DETECTED:\n${consistencyIssues.map(i => `- ${i}`).join("\n")}`
      : "";

    // --- Build prompt ---
    const logSummary = state.log
      .slice(-40)
      .map(e => `[${e.entry_type}] ${e.content.slice(0, 400)}`)
      .join("\n");

    const stepSummary = state.steps
      .map(s => `${s.category} | ${s.tool_name} on ${s.target} | ${s.status}${s.result_text ? ` | output: ${s.result_text.slice(0, 200)}` : ""}`)
      .join("\n");

    const prompt = `You are a software quality reviewer. A production AI agent just got stuck while trying to resolve a NAS issue.
Your job is to determine whether this looks like a SOFTWARE BUG in the agent itself vs. a genuine NAS problem that the agent correctly couldn't solve.

DO NOT suggest any code changes. DO NOT modify anything. ONLY describe what you observe and what a developer should investigate.

RESOLUTION SUMMARY:
Title: ${state.resolution.title}
Phase when stuck: ${state.resolution.phase}
Stuck reason: ${state.resolution.stuck_reason}
Attempt count: ${state.resolution.attempt_count}
Diagnosis summary: ${state.resolution.diagnosis_summary ?? "none"}

AGENT ACTIVITY LOG (last 40 entries):
${logSummary}

ALL STEPS (category | tool | status | output excerpt):
${stepSummary}
${consistencySection}
${patternSection}

AI CALL HEALTH:
${aiHealth}
${agentSource ? `\nPHASE HANDLER SOURCE CODE (resolution-agent.ts):\n\`\`\`typescript\n${agentSource}\n\`\`\`` : ""}
${storeSource ? `\nDB STORE SOURCE CODE (resolution-store.ts):\n\`\`\`typescript\n${storeSource}\n\`\`\`` : ""}
${minimaxSource ? `\nAI CALL LAYER (minimax.ts):\n\`\`\`typescript\n${minimaxSource}\n\`\`\`` : ""}
${toolSource ? `\nFAILED TOOL DEFINITIONS (tools.ts):\n\`\`\`typescript\n${toolSource}\n\`\`\`` : ""}
${apiRouteSource ? `\nRELEVANT API ROUTE:\n\`\`\`typescript\n${apiRouteSource}\n\`\`\`` : ""}

QUESTIONS TO ANSWER:
1. Does the sequence of phase transitions, step statuses, and log entries make sense for a correctly functioning agent? Or does something look wrong?
2. Are there any steps that returned empty output, SSH banners, or clearly wrong data that the agent treated as valid?
3. Does any phase transition happen at a point it shouldn't (e.g., entering awaiting_fix_approval with no actual fix steps waiting)?
4. If source code is available: does the code logic match the observed behavior, or is there a guard condition, loop, or timeout that would cause the observed problem?
5. Do the DB queries in resolution-store.ts have correct filters? Could a missing .eq() or wrong status filter cause the observed state?
6. Is the AI call layer (minimax.ts) handling errors and truncation correctly? Could a parse failure be silently swallowed?
7. If multiple resolutions are stuck with similar reasons, that is almost certainly a software bug — a one-off could be a NAS problem, a pattern cannot.

Respond ONLY with valid JSON — no explanations outside the JSON:
{
  "likely_software_bug": false,
  "confidence": "medium",
  "behavior_observed": "What the log shows happening",
  "expected_behavior": "What should have happened if the software was working correctly",
  "suspected_component": "e.g. handleProposingFix guard condition, check_drive_database shell command, minimax JSON parsing, approveSteps DB filter",
  "suggested_fix_for_developer": "Plain English description of what a developer should investigate and change — NO code, just what and where",
  "alert_title": "Short title for a developer dashboard alert (max 80 chars)"
}

If this looks like a genuine NAS problem (not a software bug), set likely_software_bug to false and confidence to high.`;

    const review = await callSecondOpinion<SoftwareBugReviewResponse>(prompt);

    if (!review.likely_software_bug) return;

    // Log the finding in the resolution activity
    await safeAppendLog(supabase, userId, state.resolution.id, "software_issue",
      `**Possible software bug detected** (${review.confidence} confidence)\n\n` +
      `**Observed:** ${review.behavior_observed}\n\n` +
      `**Expected:** ${review.expected_behavior}\n\n` +
      `**Suspected component:** ${review.suspected_component}\n\n` +
      `**For developers:** ${review.suggested_fix_for_developer}`
    );

    // Create a dashboard alert so it's visible outside this resolution
    if (review.confidence === "high" || review.confidence === "medium") {
      await supabase.from("smon_alerts").insert({
        severity: review.confidence === "high" ? "critical" : "warning",
        source: "resolution_agent",
        title: `[Agent Bug] ${review.alert_title}`,
        message: `Resolution "${state.resolution.title}" (${state.resolution.id}) went stuck and a code review suspects a software bug.\n\n` +
          `Observed: ${review.behavior_observed}\n` +
          `Component: ${review.suspected_component}\n` +
          `Developer action: ${review.suggested_fix_for_developer}`,
        status: "active",
      });
    }
  } catch {
    // Never let the review crash the agent — it's informational only
  }
}

// --- Safety preamble (injected into every prompt) ---

const SAFETY_PREAMBLE = `
CRITICAL CONTEXT: You are operating on a LIVE PRODUCTION FILE SERVER that serves an entire company.
Your #1 priority is DO NO HARM. Speed does not matter. Thoroughness does.

YOU ARE THE DRIVER, NOT A PASSENGER.
You own this problem end-to-end. You have the tools, the data, and the authority to solve it.
Do NOT say "I don't have access to X" or "I need the operator to check Y" unless you have
genuinely exhausted every available tool and data source first. If a log or data point would
help your diagnosis, GO GET IT — you have diagnostic tools, you can search ANY log file on
the NAS, you can permanently expand what data gets collected, and you can check databases.

When data is missing:
- First: use search_all_logs to find where the data actually lives
- Second: use the specific tool to read it (search_webapi_log, check_drive_database, etc.)
- Third: if no tool covers it, add a collection_command in missing_data_suggestions — this
  permanently expands the monitoring agent's collection, not just for this diagnosis but forever
- ONLY as a last resort: ask the operator for manual action

When you need to do something that interrupts service access (restarts, etc.):
- ASK the operator if now is a good time. Late nights and weekends are generally safe.
- Explain exactly what will happen: "Drive sync will pause for ~30 seconds during restart"
- If it's 2am on a Saturday, say so and recommend doing it now while impact is minimal.

Core safety rules:
- NEVER touch, rename, move, or delete user files unless the operator explicitly requests it.
- Prefer service restarts over data operations. Prefer read-only investigation over write actions.
- ONE fix at a time. Apply one fix, verify it worked, then decide about the next.
- Take 5 steps, 10 steps, 50 steps — it does not matter as long as nothing goes wrong.
`.trim();

// --- Prompts ---

function getUserContext(res: ResolutionFull): string {
  const userInputs = res.log
    .filter(e => e.entry_type === "user_input")
    .map(e => e.content)
    .join("\n");
  return userInputs ? `\nADDITIONAL CONTEXT FROM USER:\n${userInputs}` : "";
}

function getHistoryContext(res: ResolutionFull): string {
  // Always include diagnostics already run — never gate on attempt_count.
  // This prevents the planner from re-proposing tools that were already executed
  // when replanning after stuck or after a rejected fix.
  const ranDiag = res.steps.filter(s => s.category === "diagnostic" && (s.status === "completed" || s.status === "failed"));
  const diagNote = ranDiag.length > 0
    ? `\nDIAGNOSTICS ALREADY RUN — DO NOT RE-PROPOSE THESE:\n${ranDiag.map(s => `- ${s.tool_name} on ${s.target}: ${s.status}`).join("\n")}`
    : "";

  const diagSummary = res.resolution.diagnosis_summary
    ? `\nCurrent diagnosis: ${res.resolution.diagnosis_summary.slice(0, 600)}`
    : "";

  const fixHistory = res.steps.filter(s => s.category === "fix");
  const fixNote = fixHistory.length > 0
    ? `\nFIXES ALREADY TRIED:\n${fixHistory.map(s => `- ${s.title} on ${s.target}: ${s.status}${s.result_text ? ` — ${s.result_text.slice(0, 150)}` : ""}`).join("\n")}`
    : "";

  const verNote = res.resolution.verification_result
    ? `\nVerification result: ${res.resolution.verification_result}`
    : "";

  const parts = [diagSummary, diagNote, fixNote, verNote].filter(Boolean);
  return parts.length > 0 ? `\nCONTEXT FROM THIS INVESTIGATION SO FAR:${parts.join("")}\n` : "";
}

function planningPrompt(res: ResolutionFull, context: Record<string, unknown>): string {
  return `${SAFETY_PREAMBLE}

You are planning diagnostics for a Synology NAS issue. Your job is ONLY to gather information.
Do NOT propose any fix actions — only read-only diagnostics.

ISSUE: ${res.resolution.title}
DESCRIPTION: ${res.resolution.description}
SEVERITY: ${res.resolution.severity}
AFFECTED NAS: ${res.resolution.affected_nas.join(", ") || "unknown — check BOTH NAS units"}
${getHistoryContext(res)}${getUserContext(res)}

SYSTEM CONTEXT (recent alerts, logs, resource data):
${JSON.stringify(context, null, 1).slice(0, 30000)}

AVAILABLE DIAGNOSTIC TOOLS (all are read-only):
${Object.entries(TOOL_DEFINITIONS).filter(([,t]) => !t.write).map(([name, t]) => `- ${name}: ${t.description}`).join("\n")}

KNOWN SYNOLOGY ERROR PATTERNS (search for these when relevant):
- "Failed to SYNOShareGet" / "share_db_get.c" → share database corruption → use check_share_database and search_webapi_log
- "WebAPI SYNO.SynologyDrive.* is not valid" → Drive package registration broken → use check_drive_package_health
- "error when reading st :stoi" / "service-ctrl.cpp" → service control binary crash → use search_all_logs with filter "stoi"
- Processes in 'D' state (uninterruptible sleep) → I/O stalls, disk problems → use check_kernel_io_errors and check_filesystem_health
- "sqlite3.*corrupt" / "database disk image is malformed" → Drive DB corruption → use check_drive_database
- ShareSync log empty or returns only SSH banner → service may be unable to start → use check_drive_package_health

IMPORTANT: If a diagnostic tool returns only an SSH banner/MOTD with no actual command output, that is a
symptom (the command failed to execute), NOT a normal result. Report it and try an alternative approach.

INSTRUCTIONS:
1. If the issue could affect BOTH NAS units, check BOTH. Don't assume only one is affected.
2. If multiple error types are reported, they may share a root cause. Plan diagnostics that can distinguish.
3. Be thorough. If unsure, add more diagnostic steps. We will have time for multiple rounds.
4. Propose 3-8 diagnostic steps. It's OK to propose more if the issue is complex.
5. For Drive/ShareSync issues, ALWAYS include: check_share_database, check_drive_package_health,
   search_webapi_log, and check_kernel_io_errors. These are the logs where the root cause lives.
6. If the issue description mentions specific error messages, use search_all_logs to find EXACTLY
   where those messages appear, how often, and when they started.

Respond ONLY with valid JSON:
{
  "plan_summary": "Plain English: what we are going to check and why (written for a non-technical business owner)",
  "steps": [
    {
      "title": "Human-readable step name",
      "target": "edgesynology1",
      "tool_name": "check_disk_space",
      "reason": "Why this specific check is needed for this issue",
      "lookback_hours": 2,
      "filter": null
    }
  ]
}`;
}

async function analysisPrompt(res: ResolutionFull, supabase: SupabaseClient): Promise<string> {
  const stepResults = res.steps
    .filter(s => s.category === "diagnostic" && (s.status === "completed" || s.status === "failed"))
    .map(s => `### ${s.title} (${s.target}) [${s.status}]\n${s.result_text?.slice(0, 2000) ?? "no output"}`)
    .join("\n\n");

  const customMetrics = await getCustomMetricContext(supabase, res.resolution.id);

  return `${SAFETY_PREAMBLE}

You are analyzing diagnostic results for a Synology NAS issue.
Your job is to determine the root cause with HIGH CONFIDENCE before any fix is attempted.

ISSUE: ${res.resolution.title}
DESCRIPTION: ${res.resolution.description}
${getUserContext(res)}

DIAGNOSTIC RESULTS:
${stepResults}
${customMetrics}

AVAILABLE DIAGNOSTIC TOOLS (if you need more information):
${Object.entries(TOOL_DEFINITIONS).filter(([,t]) => !t.write).map(([name, t]) => `- ${name}: ${t.description}`).join("\n")}

KNOWN SYNOLOGY ERROR PATTERNS (use to interpret results):
- "Failed to SYNOShareGet" / "share_db_get.c" → share database corruption or inaccessible
- "WebAPI SYNO.SynologyDrive.* is not valid" → Drive package not properly registered with DSM WebAPI layer
- "error when reading st :stoi" / "service-ctrl.cpp" → service control binary crash parsing a non-numeric value
- Processes stuck in 'D' state → uninterruptible I/O wait, likely disk/RAID/filesystem issue
- If a command returned only an SSH banner with no output → command failed to run, tool path may be wrong, or service can't start

INSTRUCTIONS:
1. Look at ALL the evidence together. Multiple symptoms may have the SAME root cause.
2. If your confidence is "medium" or "low", request MORE diagnostics with the new tools available to you:
   check_share_database, check_drive_package_health, check_kernel_io_errors, search_webapi_log,
   check_drive_database, search_all_logs, check_filesystem_health.
3. If some diagnostics failed (SSH error, timeout, empty output), that itself is useful information — explain what it means.
4. Clearly separate what you KNOW from what you SUSPECT.
5. Write the diagnosis_summary for a non-technical business owner. Write the root_cause for a sysadmin.
6. MISSING DATA & PERMANENT COLLECTION EXPANSION:
   The monitoring agent runs inside a Docker container on each NAS with access to /proc, /host/log,
   /host/volume1, all file shares, and host networking. If data exists on the NAS that would help
   diagnosis but isn't available in SYSTEM CONTEXT or DIAGNOSTIC RESULTS above, you can PERMANENTLY
   expand what the agent collects by adding entries to missing_data_suggestions.

   This is NOT a one-time thing — once you request a metric, the agent collects it on schedule forever,
   across all future diagnoses. Think about what data would be CONSISTENTLY useful for diagnosing
   NAS issues, not just this specific problem.

   For each entry:
   - If it can be collected via a read-only shell command (executed inside the container):
     provide collection_command and interval_minutes. The agent picks it up within 60 seconds.
   - If it requires a manual operator action (e.g., enabling a DSM feature, installing a package):
     describe exactly what to do in manual_action and leave collection_command empty.
   Commands MUST be read-only (no rm, mv, dd, mkfs, chmod -R, or any write operation).

Respond ONLY with valid JSON:
{
  "needs_more_diagnostics": false,
  "additional_steps": [],
  "diagnosis_summary": "Plain English: what is happening, why, and what is affected — for a business owner",
  "root_cause": "Technical root cause with evidence references",
  "confidence": "high",
  "missing_data_suggestions": [
    {
      "metric_name": "sharesync_queue_depth",
      "description": "Number of files pending sync",
      "target": "edgesynology2",
      "collection_command": "synopkg exec DriveAPI status 2>&1 | grep -i queue",
      "interval_minutes": 5,
      "why_needed": "Would reveal whether sync backlog is growing over time",
      "manual_action": null
    }
  ]
}

missing_data_suggestions can be an empty array [] if no gaps exist.
If confidence is not "high", set needs_more_diagnostics to true and list what else to check.`;
}

function fixProposalPrompt(res: ResolutionFull): string {
  const writeTools = Object.entries(TOOL_DEFINITIONS)
    .filter(([, t]) => t.write)
    .map(([name, t]) => `- ${name}: ${t.description}`)
    .join("\n");

  const rejectedSteps = res.steps.filter(s => s.category === "fix" && s.status === "rejected");
  const rejectedSection = rejectedSteps.length > 0
    ? `\nPREVIOUSLY REJECTED FIXES — DO NOT PROPOSE THESE AGAIN:\n${rejectedSteps.map(s => `- ${s.tool_name} on ${s.target}: ${s.title} (REJECTED BY USER)`).join("\n")}\n`
    : "";

  const userInputs = res.log.filter(e => e.entry_type === "user_input").map(e => e.content);
  const userConstraints = userInputs.length > 0
    ? `\nUSER CONSTRAINTS — THESE ARE HARD RULES, NOT SUGGESTIONS:\n${userInputs.map(u => `- "${u}"`).join("\n")}\nIf the user said something does not work (e.g. "restarts don't help"), do NOT propose any action in that category, even if it is a different tool or service.\n`
    : "";

  return `${SAFETY_PREAMBLE}

You are proposing a fix for a Synology NAS issue. This is a PRODUCTION file server.

ISSUE: ${res.resolution.title}
DESCRIPTION (includes all accumulated user context and rejection history): ${res.resolution.description}
ROOT CAUSE: ${res.resolution.root_cause}
DIAGNOSIS: ${res.resolution.diagnosis_summary}
${userConstraints}
${rejectedSection}
AVAILABLE FIX TOOLS:
${writeTools}

AVAILABLE DIAGNOSTIC TOOLS (for verification after fix):
${Object.entries(TOOL_DEFINITIONS).filter(([,t]) => !t.write).map(([name, t]) => `- ${name}: ${t.description}`).join("\n")}

RULES — READ CAREFULLY:
1. Propose exactly ONE fix action. Not two, not three. ONE.
   After it runs, we verify, and then decide on the next action if needed.
2. NEVER propose a fix from the "PREVIOUSLY REJECTED FIXES" list above. The user has already
   tried or rejected those. Propose the NEXT most appropriate action given that those failed.
3. Choose the SAFEST option that hasn't already been tried.
   Prefer less-invasive options over more-invasive ones, but if restarts have already been
   rejected, move to the next appropriate step (e.g., clearing state files, reinstalling).
4. Explain the risk clearly. What service will be briefly interrupted? Will users notice?
5. Propose 1-2 verification steps to run AFTER the fix to confirm it worked.
6. Every step MUST have a "title" field.
7. If no safe automated fix is possible, set fix_steps to [] and explain in fix_summary
   what manual steps the user should take in DSM.

Respond ONLY with valid JSON:
{
  "fix_summary": "Plain English: exactly what we will do, what the user should expect during the fix (e.g., 'Drive sync will pause for ~30 seconds'), and why this is the safest approach",
  "risk_assessment": "What could go wrong and how we would recover if it does",
  "fix_steps": [
    { "title": "Restart Synology Drive ShareSync on edgesynology2", "target": "edgesynology2", "tool_name": "restart_synology_drive_sharesync", "reason": "Why this specific action addresses the root cause", "risk": "medium", "filter": null }
  ],
  "verification_steps": [
    { "title": "Verify ShareSync is running cleanly", "target": "edgesynology2", "tool_name": "check_sharesync_status", "reason": "Confirm the restart resolved the error", "lookback_hours": 1, "filter": null }
  ]
}`;
}

function verificationPrompt(res: ResolutionFull): string {
  const verResults = res.steps
    .filter(s => s.category === "verification" && (s.status === "completed" || s.status === "failed"))
    .map(s => `### ${s.title} (${s.target}) [${s.status}]\n${s.result_text?.slice(0, 2000) ?? "no output"}`)
    .join("\n\n");

  const fixResults = res.steps
    .filter(s => s.category === "fix" && (s.status === "completed" || s.status === "failed"))
    .map(s => `### ${s.title} (${s.target}) [${s.status}]\n${s.result_text?.slice(0, 500) ?? "no output"}`)
    .join("\n\n");

  return `${SAFETY_PREAMBLE}

You are verifying whether a fix worked on a production Synology NAS.

ISSUE: ${res.resolution.title}
ORIGINAL DIAGNOSIS: ${res.resolution.diagnosis_summary}
FIX APPLIED: ${res.resolution.fix_summary}

FIX EXECUTION RESULTS:
${fixResults}

VERIFICATION RESULTS:
${verResults}

INSTRUCTIONS:
1. Be conservative. If there is ANY sign of remaining problems, set fixed to false.
2. It is better to do another round of diagnostics than to declare victory prematurely.
3. If the fix worked for the immediate symptom but you see other related issues, mention them in remaining_concerns.
4. "Fixed" means the root cause is addressed AND the system is healthy. Not just that the command succeeded.

Respond ONLY with valid JSON:
{
  "fixed": true,
  "verification_summary": "Plain English: what the verification shows — is the system actually healthy now?",
  "remaining_concerns": "Any issues still present, or empty string if fully confirmed fixed"
}`;
}

// --- Phase handlers ---

async function handlePlanning(
  supabase: SupabaseClient,
  userId: string,
  state: ResolutionFull
): Promise<void> {
  // Guard: if diagnostic steps already exist for this attempt, skip (race condition protection)
  const existingDiag = state.steps.filter(s => s.category === "diagnostic");
  if (existingDiag.length > 0 && state.resolution.attempt_count === 0) return;

  const context = await fetchSystemContext(supabase, state.resolution.lookback_hours);

  // Try the fast diagnosis model first
  let plan: PlanResponse | null = null;
  const { data: fastPlan, error: fastError } = await callMinimaxJSON<PlanResponse>(
    "You are a Synology NAS diagnostic planner. Respond ONLY with valid JSON.",
    planningPrompt(state, context)
  );
  trackAICall(!!fastPlan, "diagnosis-model", fastError ?? undefined);

  if (fastPlan && fastPlan.steps?.length >= 2) {
    plan = fastPlan;
  } else {
    // Escalate to the stronger remediation model for a better plan
    await appendLog(supabase, userId, state.resolution.id, "plan",
      `Diagnosis model returned ${fastPlan?.steps?.length ?? 0} steps. Escalating to stronger model for a more thorough plan.`);
    try {
      plan = await callRemediation<PlanResponse>(planningPrompt(state, context));
    } catch {
      plan = fastPlan; // Fall back to whatever the fast model returned
    }
  }

  if (!plan || !plan.steps?.length) {
    await appendLog(supabase, userId, state.resolution.id, "error",
      "Failed to generate a diagnostic plan. Neither AI model could determine what to check.",
      fastError ?? "No steps returned");
    await updateResolution(supabase, userId, state.resolution.id, {
      phase: "stuck",
      stuck_reason: "Could not generate a diagnostic plan. Try adding more context about the issue.",
    });
    return;
  }

  const maxBatch = state.steps.reduce((max, s) => Math.max(max, s.batch), -1);
  const batch = maxBatch + 1;

  // Deduplicate against already-run tools (important in round 2+ to avoid repeating diagnostics)
  const alreadyRun = new Set(state.steps.filter(s => s.category === "diagnostic").map(s => `${s.tool_name}:${s.target}`));
  const dedupedPlanSteps = plan.steps.filter(s => !alreadyRun.has(`${s.tool_name}:${s.target}`));

  const stepInputs = dedupedPlanSteps
    .map(raw => materializeStepInput(raw, "diagnostic", state.resolution.auto_approve_reads, state.resolution.lookback_hours))
    .filter((s): s is StepInput => s !== null);

  if (stepInputs.length === 0) {
    await appendLog(supabase, userId, state.resolution.id, "error", "AI returned diagnostic steps but none had valid tool names.");
    await updateResolution(supabase, userId, state.resolution.id, { phase: "stuck", stuck_reason: "Could not create valid diagnostic steps." });
    return;
  }

  await createSteps(supabase, userId, state.resolution.id, batch, stepInputs);
  await appendLog(supabase, userId, state.resolution.id, "plan", plan.plan_summary);
  await updateResolution(supabase, userId, state.resolution.id, { phase: "diagnosing" });
  const roundLabel = state.resolution.attempt_count > 0 ? ` (round ${state.resolution.attempt_count + 1})` : "";
  await safeAppendMessage(supabase, userId, state.resolution.id, "agent",
    `Starting investigation${roundLabel}. ${plan.plan_summary}`);
}

async function handleDiagnosing(
  supabase: SupabaseClient,
  userId: string,
  state: ResolutionFull
): Promise<void> {
  const currentBatch = Math.max(...state.steps.filter(s => s.category === "diagnostic").map(s => s.batch), 0);
  const batchSteps = state.steps.filter(s => s.category === "diagnostic" && s.batch === currentBatch);

  const pending = batchSteps.filter(s => s.status === "planned");
  if (pending.length > 0) return; // Waiting for user approval

  const nextApproved = batchSteps.find(s => s.status === "approved");
  if (nextApproved) {
    await updateStepStatus(supabase, userId, nextApproved.id, "running");
    const result = await executeStep(nextApproved);

    const status = result.ok ? "completed" : "failed";
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n\n").slice(0, 10000);
    await updateStepStatus(supabase, userId, nextApproved.id, status, output, result.exitCode);

    await appendLog(supabase, userId, state.resolution.id, "step_result",
      `${nextApproved.title} on ${nextApproved.target}: ${status}`,
      output.slice(0, 2000));
    return;
  }

  // All steps done
  await updateResolution(supabase, userId, state.resolution.id, { phase: "analyzing" });
}

/** Create metric collection schedules for any missing data the AI identified. */
async function processMissingDataSuggestions(
  supabase: SupabaseClient,
  userId: string,
  resolutionId: string,
  suggestions: AnalysisResponse["missing_data_suggestions"]
): Promise<void> {
  if (!suggestions?.length) return;

  for (const s of suggestions) {
    if (s.collection_command && s.target) {
      // Check if we already scheduled this command or this metric name on this NAS
      const { count } = await supabase
        .from("smon_custom_metric_schedules")
        .select("id", { count: "exact", head: true })
        .eq("nas_id", s.target)
        .or(`collection_command.eq.${s.collection_command},name.eq.${s.metric_name}`);

      if (!count || count === 0) {
        await supabase.from("smon_custom_metric_schedules").insert({
          created_by: userId,
          resolution_id: resolutionId,
          name: s.metric_name,
          description: s.description,
          nas_id: s.target,
          collection_command: s.collection_command,
          interval_minutes: Math.max(1, Math.min(60, s.interval_minutes ?? 5)),
          is_active: true,
        });
        await appendLog(supabase, userId, resolutionId, "analysis",
          `Started collecting metric: **${s.metric_name}** on ${s.target} every ${s.interval_minutes ?? 5} min.\n${s.why_needed}`);
      }
    } else if (s.manual_action) {
      // Notify operator that manual action is needed
      await appendLog(supabase, userId, resolutionId, "analysis",
        `**Manual action needed to improve diagnosis:**\n${s.manual_action}\n\n_Why: ${s.why_needed}_`);
    }
  }
}

async function handleAnalyzing(
  supabase: SupabaseClient,
  userId: string,
  state: ResolutionFull
): Promise<void> {
  const fresh = await loadResolution(supabase, userId, state.resolution.id);
  if (!fresh) return;

  const builtAnalysisPrompt = await analysisPrompt(fresh, supabase);
  const primaryAnalysis = await callRemediation<AnalysisResponse>(builtAnalysisPrompt);

  let analysis = primaryAnalysis;

  // If primary model isn't confident, get a second opinion from a different model
  if (analysis.confidence !== "high") {
    await appendLog(supabase, userId, fresh.resolution.id, "analysis",
      `Primary model confidence: ${analysis.confidence}. Requesting second opinion from a different AI model.`);

    try {
      const secondPrompt = `${builtAnalysisPrompt}

IMPORTANT: A different AI model already analyzed this and concluded:
- Diagnosis: ${analysis.diagnosis_summary}
- Root cause: ${analysis.root_cause}
- Confidence: ${analysis.confidence}
${analysis.needs_more_diagnostics ? `- It recommended more diagnostics: ${JSON.stringify(analysis.additional_steps)}` : ""}

You are a second opinion. Do you agree with this diagnosis? If you have a different theory or see something the first model missed, say so. If you agree, you can raise the confidence level.`;

      const secondOpinion = await callSecondOpinion<AnalysisResponse>(secondPrompt);

      // Use whichever analysis has higher confidence, or merge insights
      if (secondOpinion.confidence === "high" || (secondOpinion.confidence === "medium" && analysis.confidence === "low")) {
        const mergedSummary = secondOpinion.diagnosis_summary !== analysis.diagnosis_summary
          ? `${secondOpinion.diagnosis_summary}\n\n(First opinion: ${analysis.diagnosis_summary})`
          : secondOpinion.diagnosis_summary;

        analysis = {
          ...secondOpinion,
          diagnosis_summary: mergedSummary,
          additional_steps: [
            ...(analysis.additional_steps ?? []),
            ...(secondOpinion.additional_steps ?? []),
          ],
        };

        await appendLog(supabase, userId, fresh.resolution.id, "analysis",
          `Second opinion raised confidence to ${secondOpinion.confidence}. ${secondOpinion.root_cause !== analysis.root_cause ? `Different root cause suggested: ${secondOpinion.root_cause}` : "Agrees with primary diagnosis."}`);
      } else {
        await appendLog(supabase, userId, fresh.resolution.id, "analysis",
          `Second opinion also at ${secondOpinion.confidence} confidence. ${secondOpinion.diagnosis_summary}`);

        // Merge any additional diagnostic suggestions from both
        analysis.additional_steps = [
          ...(analysis.additional_steps ?? []),
          ...(secondOpinion.additional_steps ?? []),
        ];
        if (secondOpinion.needs_more_diagnostics) analysis.needs_more_diagnostics = true;
      }
    } catch (err) {
      await appendLog(supabase, userId, fresh.resolution.id, "error",
        `Second opinion model failed: ${err instanceof Error ? err.message : "unknown error"}. Proceeding with primary analysis.`);
    }
  }

  // Count distinct diagnostic batches
  const MAX_DIAGNOSTIC_ROUNDS = 3;
  const diagnosticBatches = new Set(fresh.steps.filter(s => s.category === "diagnostic").map(s => s.batch));
  const diagnosticRoundCount = diagnosticBatches.size;

  // Loop detection: if we're on round 2+ and the root cause hasn't changed, we're semantically looping
  if (diagnosticRoundCount >= 2 && fresh.resolution.root_cause &&
      analysis.root_cause && analysis.root_cause === fresh.resolution.root_cause) {
    await appendLog(supabase, userId, fresh.resolution.id, "analysis",
      `Semantic loop detected: round ${diagnosticRoundCount} analysis reached the same root cause as the previous round. ${analysis.needs_more_diagnostics ? "Agent still wants more diagnostics but the diagnosis hasn't changed — forcing a decision." : ""}`);
    // Force a conclusion — additional rounds won't change the picture
    analysis.needs_more_diagnostics = false;
    analysis.confidence = "high";
  }

  // Reflection quality gate: before committing to a fix, ask a second AI to review evidence quality
  const reflection = await reflectOnProgress(fresh, analysis.confidence);
  if (reflection.recommendation === "escalate_to_user") {
    await safeAppendLog(supabase, userId, fresh.resolution.id, "reflection",
      `Quality review blocked fix proposal: ${reflection.evidence_quality} evidence.\n\n${reflection.notes}`,
      reflection.quality_issues.join("; ") || null);
    await updateResolution(supabase, userId, fresh.resolution.id, {
      phase: "stuck",
      diagnosis_summary: analysis.diagnosis_summary,
      root_cause: analysis.root_cause,
      stuck_reason: `Quality review: ${reflection.notes} Issues: ${reflection.quality_issues.join("; ")}. Add more context or manually inspect the NAS.`,
    });
    return;
  } else if (reflection.recommendation === "gather_more" && diagnosticRoundCount >= MAX_DIAGNOSTIC_ROUNDS) {
    // Nothing left to gather — treat as proceed so medium-confidence cases still get a fix attempt
    await safeAppendLog(supabase, userId, fresh.resolution.id, "reflection",
      `Quality review suggested more diagnostics but max rounds (${MAX_DIAGNOSTIC_ROUNDS}) reached — proceeding with current evidence.`,
      reflection.quality_issues.join("; ") || null);
  } else if (reflection.recommendation === "gather_more") {
    await safeAppendLog(supabase, userId, fresh.resolution.id, "reflection",
      `Quality review: ${reflection.evidence_quality} evidence — requesting additional diagnostics before fix.\n\n${reflection.notes}`,
      reflection.quality_issues.join("; ") || null);
    // Ask the primary model what to collect next, given the quality issues
    try {
      const revisedPrompt = `${builtAnalysisPrompt}

QUALITY REVIEW FEEDBACK (from a second AI reviewer):
${reflection.quality_issues.map(q => `• ${q}`).join("\n")}

The reviewer recommends gathering more evidence before proposing a fix. Please reconsider: set needs_more_diagnostics to true and list specific additional diagnostic steps that would address these gaps.`;
      const revisedAnalysis = await callRemediation<AnalysisResponse>(revisedPrompt);
      // Merge additional steps from both analyses
      analysis.needs_more_diagnostics = true;
      analysis.confidence = revisedAnalysis.confidence ?? "medium";
      analysis.additional_steps = [
        ...(revisedAnalysis.additional_steps ?? []),
        ...(analysis.additional_steps ?? []),
      ];
    } catch {
      // If revised call fails, force needsMore anyway so the existing path handles it
      analysis.needs_more_diagnostics = true;
      analysis.confidence = "medium";
    }
  } else {
    // "proceed" — log a brief note if any quality issues were found
    if (reflection.quality_issues.length > 0) {
      await safeAppendLog(supabase, userId, fresh.resolution.id, "reflection",
        `Quality review passed (${reflection.evidence_quality}): ${reflection.notes}`);
    }
  }

  // If AI wants more diagnostics OR confidence is not high enough, try to loop back.
  // At max rounds, medium confidence is acceptable — better a cautious fix attempt than going stuck.
  const confidenceBlocksProgress = analysis.confidence === "low" ||
    (analysis.confidence === "medium" && diagnosticRoundCount < MAX_DIAGNOSTIC_ROUNDS);
  const needsMore = analysis.needs_more_diagnostics || confidenceBlocksProgress;

  if (needsMore) {
    // Deduplicate proposed additional steps by tool_name+target, and filter already-run ones
    const alreadyRun = new Set(fresh.steps.map(s => `${s.tool_name}:${s.target}`));
    const seen = new Set<string>();
    const dedupedSteps = (analysis.additional_steps ?? []).filter(s => {
      const key = `${s.tool_name}:${s.target}`;
      if (seen.has(key) || alreadyRun.has(key)) return false;
      seen.add(key);
      return true;
    });

    const hasNewSteps = dedupedSteps.length > 0;
    const underRoundLimit = diagnosticRoundCount < MAX_DIAGNOSTIC_ROUNDS;

    if (hasNewSteps && underRoundLimit) {
      const maxBatch = fresh.steps.reduce((max, s) => Math.max(max, s.batch), -1);
      const batch = maxBatch + 1;

      const stepInputs = dedupedSteps
        .map(raw => materializeStepInput(raw, "diagnostic", fresh.resolution.auto_approve_reads, fresh.resolution.lookback_hours))
        .filter((s): s is StepInput => s !== null);

      if (stepInputs.length > 0) {
        await createSteps(supabase, userId, fresh.resolution.id, batch, stepInputs);
        await appendLog(supabase, userId, fresh.resolution.id, "analysis",
          `Need more information (confidence: ${analysis.confidence}, round ${diagnosticRoundCount + 1} of ${MAX_DIAGNOSTIC_ROUNDS}). ${analysis.diagnosis_summary}`);
        await updateResolution(supabase, userId, fresh.resolution.id, { phase: "diagnosing" });
        return;
      }
    }

    // Auto-schedule any missing data the AI identified
    await processMissingDataSuggestions(supabase, userId, fresh.resolution.id, analysis.missing_data_suggestions);

    // Cannot gather more evidence. If confidence is medium, proceed to a cautious fix
    // rather than going stuck — doing nothing is worse than a conservative attempt.
    if (analysis.confidence !== "low") {
      await safeAppendLog(supabase, userId, fresh.resolution.id, "analysis",
        `No new diagnostic steps available after ${diagnosticRoundCount} round(s). Proceeding to fix at ${analysis.confidence} confidence with conservative approach.`);
      // Fall through to the fix proposal path below
    } else {
      // Low confidence — genuinely stuck, need user input
      const roundMsg = diagnosticRoundCount >= MAX_DIAGNOSTIC_ROUNDS
        ? `After ${diagnosticRoundCount} diagnostic rounds the agent could not reach sufficient confidence.`
        : `No new diagnostic steps available.`;

      const validNextSteps = (analysis.additional_steps ?? []).filter(s => s.title && s.target);
      const potentialNextSteps = validNextSteps.length
        ? `\n\nPotential next steps suggested by AI (not yet run):\n${validNextSteps.map(s => `• ${s.title} (${s.target}): ${s.reason || "no reason given"}`).join("\n")}`
        : "";

      const fullSummary = `${analysis.diagnosis_summary}\n\nRoot cause hypothesis: ${analysis.root_cause}\n\nConfidence: ${analysis.confidence}${potentialNextSteps}`;

      const stuckActionItems: string[] = [];
      if (analysis.root_cause) {
        stuckActionItems.push(`Check DSM > Log Center for errors related to: ${analysis.root_cause}`);
      }
      if ((analysis.additional_steps ?? []).length > 0) {
        const firstStep = (analysis.additional_steps as Array<{title?: string; target?: string}>)[0];
        if (firstStep?.title) stuckActionItems.push(`Consider running manually: ${firstStep.title}${firstStep.target ? ` on ${firstStep.target}` : ""}`);
      }
      if ((analysis.missing_data_suggestions ?? []).length > 0) {
        const suggestions = (analysis.missing_data_suggestions ?? [])
          .slice(0, 2)
          .map((s: unknown) => (typeof s === "string" ? s : (s as { why_needed?: string; description?: string })?.why_needed ?? (s as { description?: string })?.description ?? ""))
          .filter(Boolean);
        if (suggestions.length > 0) stuckActionItems.push(`Useful info to provide: ${suggestions.join("; ")}`);
      }
      if (stuckActionItems.length === 0) {
        stuckActionItems.push("Provide any recent changes, error messages, or DSM notification text you've seen");
      }

      const stuckReason = `${roundMsg} Confidence: ${analysis.confidence}. Manual steps to try:\n${stuckActionItems.map((a, i) => `${i + 1}. ${a}`).join("\n")}\n\nType a response below to give the agent more context or ask it to try a different approach.`;

      await updateResolution(supabase, userId, fresh.resolution.id, {
        phase: "stuck",
        diagnosis_summary: fullSummary,
        root_cause: analysis.root_cause,
        stuck_reason: stuckReason,
      });
      await appendLog(supabase, userId, fresh.resolution.id, "stuck",
        `${roundMsg} Here is what we know:\n\n${fullSummary}`);
      await safeAppendMessage(supabase, userId, fresh.resolution.id, "agent",
        `I've run ${diagnosticRoundCount} round(s) of diagnostics but don't have enough confidence to propose an automated fix. ${stuckActionItems[0] ?? "Please provide any additional context that might help."}  What can you tell me?`);
      return;
    }
  }

  // Schedule any useful metric collection the AI identified even when confident
  await processMissingDataSuggestions(supabase, userId, fresh.resolution.id, analysis.missing_data_suggestions);

  // Proceed to fix proposal (high confidence, or medium at max rounds)
  const confidenceNote = analysis.confidence !== "high"
    ? ` [Note: proceeding at ${analysis.confidence} confidence after exhausting diagnostic rounds — fix proposal should be conservative and reversible]`
    : "";
  await updateResolution(supabase, userId, fresh.resolution.id, {
    phase: "proposing_fix",
    diagnosis_summary: analysis.diagnosis_summary + confidenceNote,
    root_cause: analysis.root_cause,
  });
  await appendLog(supabase, userId, fresh.resolution.id, "diagnosis",
    `${analysis.diagnosis_summary}\n\nConfidence: ${analysis.confidence}${confidenceNote}`,
    analysis.root_cause);
  const diagShort = analysis.diagnosis_summary.split("\n")[0].slice(0, 300);
  await safeAppendMessage(supabase, userId, fresh.resolution.id, "agent",
    `Here's what I found: ${diagShort}${analysis.root_cause ? ` Root cause: ${analysis.root_cause}.` : ""} I'm going to propose a fix now.`);
}

async function handleProposingFix(
  supabase: SupabaseClient,
  userId: string,
  state: ResolutionFull
): Promise<void> {
  // Guard: if there are already PENDING (not yet run) fix steps, skip creating new ones.
  // Do NOT skip if all existing fix steps are completed/failed — that means a prior round
  // already ran and we need to create fresh fix steps for this new round.
  const existingFix = state.steps.filter(s => s.category === "fix");
  const hasPendingFix = existingFix.some(s => s.status === "planned" || s.status === "approved");
  if (hasPendingFix) {
    await updateResolution(supabase, userId, state.resolution.id, { phase: "awaiting_fix_approval" });
    return;
  }

  const fresh = await loadResolution(supabase, userId, state.resolution.id);
  if (!fresh) return;

  const proposal = await callRemediation<FixProposalResponse>(fixProposalPrompt(fresh));
  const maxBatch = fresh.steps.reduce((max, s) => Math.max(max, s.batch), -1);
  const fixBatch = maxBatch + 1;

  // Fix steps — always require approval
  const fixInputs = (proposal.fix_steps ?? [])
    .map(raw => materializeStepInput({ ...raw, lookback_hours: undefined }, "fix", false, fresh.resolution.lookback_hours))
    .filter((s): s is StepInput => s !== null);

  // Verification steps — auto-approve reads
  const verifyInputs = (proposal.verification_steps ?? [])
    .map(raw => materializeStepInput(raw, "verification", true, fresh.resolution.lookback_hours))
    .filter((s): s is StepInput => s !== null);

  if (fixInputs.length > 0) {
    await createSteps(supabase, userId, fresh.resolution.id, fixBatch, fixInputs);
  }
  if (verifyInputs.length > 0) {
    await createSteps(supabase, userId, fresh.resolution.id, fixBatch + 1, verifyInputs);
  }

  await updateResolution(supabase, userId, fresh.resolution.id, {
    phase: "awaiting_fix_approval",
    fix_summary: proposal.fix_summary,
  });
  await appendLog(supabase, userId, fresh.resolution.id, "fix_proposal",
    `${proposal.fix_summary}\n\nRisk: ${proposal.risk_assessment}`);
  await safeAppendMessage(supabase, userId, fresh.resolution.id, "agent",
    `Here's what I'd like to do: ${proposal.fix_summary} Please approve or reject the action below.`);
}

async function handleApplyingFix(
  supabase: SupabaseClient,
  userId: string,
  state: ResolutionFull
): Promise<void> {
  const fixSteps = state.steps.filter(s => s.category === "fix");

  const nextApproved = fixSteps.find(s => s.status === "approved");
  if (nextApproved) {
    await updateStepStatus(supabase, userId, nextApproved.id, "running");
    const result = await executeStep(nextApproved);

    const status = result.ok ? "completed" : "failed";
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n\n").slice(0, 10000);
    await updateStepStatus(supabase, userId, nextApproved.id, status, output, result.exitCode);

    await appendLog(supabase, userId, state.resolution.id, "step_result",
      `Fix step: ${nextApproved.title} on ${nextApproved.target}: ${status}`,
      output.slice(0, 2000));
    return;
  }

  // Check if any planned fix steps remain (user approved some but not all)
  const pendingFix = fixSteps.filter(s => s.status === "planned");
  if (pendingFix.length > 0) {
    // Go back to awaiting approval for the remaining steps
    await updateResolution(supabase, userId, state.resolution.id, { phase: "awaiting_fix_approval" });
    return;
  }

  // All fix steps done — move to verifying
  await updateResolution(supabase, userId, state.resolution.id, { phase: "verifying" });
}

async function handleVerifying(
  supabase: SupabaseClient,
  userId: string,
  state: ResolutionFull
): Promise<void> {
  const verifySteps = state.steps.filter(s => s.category === "verification");

  const nextApproved = verifySteps.find(s => s.status === "approved");
  if (nextApproved) {
    await updateStepStatus(supabase, userId, nextApproved.id, "running");
    const result = await executeStep(nextApproved);

    const status = result.ok ? "completed" : "failed";
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n\n").slice(0, 10000);
    await updateStepStatus(supabase, userId, nextApproved.id, status, output, result.exitCode);
    return;
  }

  if (verifySteps.some(s => s.status === "planned")) return;

  // All verification done — analyze results
  const fresh = await loadResolution(supabase, userId, state.resolution.id);
  if (!fresh) return;

  const verdict = await callRemediation<VerificationResponse>(verificationPrompt(fresh));

  if (verdict.fixed && !verdict.remaining_concerns) {
    await updateResolution(supabase, userId, fresh.resolution.id, {
      phase: "resolved",
      verification_result: verdict.verification_summary,
      resolved_at: new Date().toISOString(),
    });
    await appendLog(supabase, userId, fresh.resolution.id, "verification",
      `Issue resolved. ${verdict.verification_summary}`);
    await safeAppendMessage(supabase, userId, fresh.resolution.id, "agent",
      `Issue resolved. ${verdict.verification_summary}`);

    if (fresh.resolution.origin_type === "problem" && fresh.resolution.origin_id) {
      await supabase
        .from("smon_analyzed_problems")
        .update({ status: "resolved", resolution: `Resolved by agent. ${verdict.verification_summary}` })
        .eq("id", fresh.resolution.origin_id);
    }
  } else {
    // Not fully fixed — go back to diagnosing for another round
    const newAttempt = fresh.resolution.attempt_count + 1;
    if (newAttempt >= fresh.resolution.max_attempts) {
      await updateResolution(supabase, userId, fresh.resolution.id, {
        phase: "stuck",
        attempt_count: newAttempt,
        verification_result: verdict.verification_summary,
        stuck_reason: `Fix did not fully work after ${newAttempt} attempt(s). ${verdict.remaining_concerns}`,
      });
      await appendLog(supabase, userId, fresh.resolution.id, "stuck",
        `Fix did not fully work. ${verdict.verification_summary}. ${verdict.remaining_concerns}`);
      await safeAppendMessage(supabase, userId, fresh.resolution.id, "agent",
        `I'm stuck after ${newAttempt} attempt(s) — the fix didn't resolve the issue. ${verdict.remaining_concerns} Please give me more context or try a different approach.`);
    } else {
      // Reflect before re-entering the diagnosis loop — are we making real progress?
      const reflection = await reflectOnProgress(fresh, "medium");
      if (reflection.progress_assessment === "looping" || reflection.recommendation === "escalate_to_user") {
        await safeAppendLog(supabase, userId, fresh.resolution.id, "reflection",
          `Quality review after failed fix: ${reflection.progress_assessment} — ${reflection.notes}`,
          reflection.quality_issues.join("; ") || null);
        await updateResolution(supabase, userId, fresh.resolution.id, {
          phase: "stuck",
          attempt_count: newAttempt,
          verification_result: verdict.verification_summary,
          stuck_reason: `Fix did not work and quality review detected: ${reflection.notes} Add more context or a different approach to help the agent.`,
        });
        await appendLog(supabase, userId, fresh.resolution.id, "stuck",
          `Fix did not resolve the issue and the quality reviewer flagged: ${reflection.notes}`);
        await safeAppendMessage(supabase, userId, fresh.resolution.id, "agent",
          `I'm stuck — the fix didn't work and the quality reviewer flagged: ${reflection.notes} I need your help to try a different approach.`);
      } else {
        if (reflection.quality_issues.length > 0) {
          await safeAppendLog(supabase, userId, fresh.resolution.id, "reflection",
            `Quality review before retry: ${reflection.notes}`);
        }
        // Go back to planning for another round of diagnose → fix → verify
        await updateResolution(supabase, userId, fresh.resolution.id, {
          phase: "planning",
          attempt_count: newAttempt,
          verification_result: verdict.verification_summary,
        });
        await appendLog(supabase, userId, fresh.resolution.id, "verification",
          `Partially fixed. Starting another round (attempt ${newAttempt + 1}). ${verdict.remaining_concerns}`);
        await safeAppendMessage(supabase, userId, fresh.resolution.id, "agent",
          `That fix helped but didn't fully resolve it. ${verdict.remaining_concerns} Starting another diagnostic round now.`);
      }
    }
  }
}

// --- Handle rejected fix: transition back to proposing_fix with rejection context ---

async function handleRejectedFix(
  supabase: SupabaseClient,
  userId: string,
  state: ResolutionFull,
) {
  const fixSteps = state.steps.filter(s => s.category === "fix");
  const pendingFix = fixSteps.filter(s => s.status === "planned" || s.status === "approved");

  // If there are still pending fix steps, nothing to do yet — waiting for user decision
  if (pendingFix.length > 0) return;

  // All fix steps are rejected — go back to proposing_fix so the AI can try a different approach

  // Skip any orphaned verification steps from this rejected fix proposal so they
  // don't execute as part of the next fix attempt
  const orphanedVerifySteps = state.steps.filter(
    s => s.category === "verification" && (s.status === "planned" || s.status === "approved")
  );
  for (const vs of orphanedVerifySteps) {
    await updateStepStatus(supabase, userId, vs.id, "skipped", "Skipped: associated fix was rejected");
  }

  const rejectedTitles = fixSteps.filter(s => s.status === "rejected").map(s => s.title);

  const recentUserInput = state.log
    .filter(e => e.entry_type === "user_input")
    .slice(-3)
    .map(e => e.content)
    .join("\n");

  const rejectionContext = [
    rejectedTitles.length > 0 ? `Previously rejected fix(es): ${rejectedTitles.join("; ")}` : null,
    recentUserInput ? `User feedback: ${recentUserInput}` : null,
  ].filter(Boolean).join("\n");

  await safeAppendLog(supabase, userId, state.resolution.id, "fix_proposal",
    `Fix was rejected. Returning to fix proposal phase to try a different approach.\n\n${rejectionContext}`);
  const rejectedNames = rejectedTitles.length > 0 ? rejectedTitles.join(", ") : "that approach";
  await safeAppendMessage(supabase, userId, state.resolution.id, "agent",
    `Got it — "${rejectedNames}" is off the table. Looking for a different approach now.`);

  const { data: res } = await supabase
    .from("smon_issue_resolutions")
    .select("description")
    .eq("id", state.resolution.id)
    .eq("user_id", userId)
    .single();

  if (res && rejectionContext) {
    await supabase
      .from("smon_issue_resolutions")
      .update({
        description: `${res.description}\n\nFix rejection context: ${rejectionContext}`,
        updated_at: new Date().toISOString(),
      })
      .eq("id", state.resolution.id)
      .eq("user_id", userId);
  }

  await updateResolution(supabase, userId, state.resolution.id, { phase: "proposing_fix" });
}

// --- Main tick function ---

export async function tick(
  supabase: SupabaseClient,
  userId: string,
  resolutionId: string
): Promise<ResolutionFull | null> {
  // Prevent concurrent ticks on the same resolution
  if (activeTicks.has(resolutionId)) {
    return loadResolution(supabase, userId, resolutionId);
  }

  activeTicks.add(resolutionId);
  let phaseBefore = "stuck"; // default to "stuck" so we don't fire review on error paths

  try {
    const state = await loadResolution(supabase, userId, resolutionId);
    if (!state) return null;

    // Stall detection: recover from hung running steps and phase-level freezes
    const stalled = await detectStalls(supabase, userId, state);
    if (stalled) return loadResolution(supabase, userId, resolutionId);

    // DB state consistency: catch impossible states that are always software bugs
    const inconsistencies = checkStateConsistency(state);
    if (inconsistencies.length > 0) {
      for (const issue of inconsistencies) {
        await safeAppendLog(supabase, userId, resolutionId, "software_issue", issue);
      }
      // Force to stuck — the state machine is in an invalid state
      await updateResolution(supabase, userId, resolutionId, {
        phase: "stuck",
        stuck_reason: `Internal state inconsistency detected: ${inconsistencies[0]}. This is likely a software bug — an alert will be created.`,
      });
      // Return so the stuck → reviewOwnBehavior flow fires
      const updated = await loadResolution(supabase, userId, resolutionId);
      if (updated) {
        reviewOwnBehavior(supabase, userId, updated).catch(() => {});
      }
      return updated;
    }

    phaseBefore = state.resolution.phase;
    const { phase } = state.resolution;

    switch (phase) {
      case "planning":
        await handlePlanning(supabase, userId, state);
        break;
      case "diagnosing":
        await handleDiagnosing(supabase, userId, state);
        break;
      case "analyzing":
        await handleAnalyzing(supabase, userId, state);
        break;
      case "proposing_fix":
        await handleProposingFix(supabase, userId, state);
        break;
      case "applying_fix":
        await handleApplyingFix(supabase, userId, state);
        break;
      case "verifying":
        await handleVerifying(supabase, userId, state);
        break;
      case "awaiting_fix_approval":
        await handleRejectedFix(supabase, userId, state);
        break;
      case "resolved":
      case "stuck":
      case "cancelled":
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await appendLog(supabase, userId, resolutionId, "error", `Agent error: ${message}`);
  } finally {
    activeTicks.delete(resolutionId);
  }

  const finalState = await loadResolution(supabase, userId, resolutionId);

  // If this tick caused a transition to "stuck", run the code-aware bug review (fire-and-forget)
  if (finalState && finalState.resolution.phase === "stuck" && phaseBefore !== "stuck") {
    reviewOwnBehavior(supabase, userId, finalState).catch(() => {});
  }

  return finalState;
}
