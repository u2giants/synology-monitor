/**
 * Resolution Agent — the brain of the issue resolution state machine.
 * Each call to tick() processes one step and returns the new state.
 *
 * The agent can iterate: diagnose → analyze → re-diagnose → propose fix →
 * apply ONE fix → verify → re-diagnose if issues remain → propose next fix → ...
 */

import { callMinimaxJSON } from "./minimax";
import { getRemediationModel, getSecondOpinionModel } from "./ai-settings";
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
  type SupabaseClient,
  type ResolutionFull,
  type ResolutionStep,
  type StepInput,
} from "./resolution-store";
import OpenAI from "openai";

// --- Tick lock: prevent concurrent ticks on the same resolution ---
const activeTicks = new Set<string>();

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

  const [alerts, driveLogs, securityEvents, processSnaps, diskIO, netConns] = await Promise.all([
    supabase
      .from("smon_alerts")
      .select("severity, status, source, title, message, created_at")
      .or(`status.eq.active,created_at.gte.${lookbackCutoff}`)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("smon_logs")
      .select("source, severity, message, metadata, ingested_at")
      .in("source", ["drive", "drive_server", "drive_sharesync"])
      .gte("ingested_at", lookbackCutoff)
      .order("ingested_at", { ascending: false })
      .limit(60),
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
  ]);

  return {
    active_alerts: alerts.data ?? [],
    recent_drive_logs: driveLogs.data ?? [],
    recent_security_events: securityEvents.data ?? [],
    top_processes: processSnaps.data ?? [],
    disk_io_stats: diskIO.data ?? [],
    net_connections: netConns.data ?? [],
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

async function callModel<T>(prompt: string, modelOverride?: string): Promise<T> {
  const client = getOpenAIClient();
  const model = modelOverride ?? await getRemediationModel();

  const response = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    max_tokens: 8000,
  });

  const text = response.choices?.[0]?.message?.content ?? "";
  const cleaned = text.replace(/^```json\s*/i, "").replace(/\s*```$/, "").trim();
  return JSON.parse(cleaned) as T;
}

/** Call the primary remediation model */
async function callRemediation<T>(prompt: string): Promise<T> {
  return callModel<T>(prompt);
}

/** Call the second opinion model */
async function callSecondOpinion<T>(prompt: string): Promise<T> {
  const model = await getSecondOpinionModel();
  return callModel<T>(prompt, model);
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

// --- Safety preamble (injected into every prompt) ---

const SAFETY_PREAMBLE = `
CRITICAL CONTEXT: You are operating on a LIVE PRODUCTION FILE SERVER that serves an entire company.
Your #1 priority is DO NO HARM. Speed does not matter. Thoroughness does.

Core principles:
- It is always better to run more diagnostics than to guess at a fix.
- It is always better to propose a safe, reversible action than a fast, irreversible one.
- NEVER touch, rename, move, or delete user files unless the operator explicitly requests it.
- Prefer service restarts over data operations. Prefer read-only investigation over write actions.
- ONE change at a time. Apply one fix, verify it worked, then decide about the next.
- If you are not confident, say so and ask for more diagnostics or user input.
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
  if (res.resolution.attempt_count === 0) return "";
  const fixHistory = res.steps
    .filter(s => s.category === "fix")
    .map(s => `- ${s.title}: ${s.status}${s.result_text ? ` (${s.result_text.slice(0, 200)})` : ""}`)
    .join("\n");
  const verNote = res.resolution.verification_result
    ? `\nVerification result: ${res.resolution.verification_result}`
    : "";
  return `\nPREVIOUS ATTEMPT ${res.resolution.attempt_count} RESULT:\n${fixHistory}${verNote}`;
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

INSTRUCTIONS:
1. If the issue could affect BOTH NAS units, check BOTH. Don't assume only one is affected.
2. If multiple error types are reported, they may share a root cause. Plan diagnostics that can distinguish.
3. Be thorough. If unsure, add more diagnostic steps. We will have time for multiple rounds.
4. Propose 3-8 diagnostic steps. It's OK to propose more if the issue is complex.

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

function analysisPrompt(res: ResolutionFull): string {
  const stepResults = res.steps
    .filter(s => s.category === "diagnostic" && (s.status === "completed" || s.status === "failed"))
    .map(s => `### ${s.title} (${s.target}) [${s.status}]\n${s.result_text?.slice(0, 2000) ?? "no output"}`)
    .join("\n\n");

  return `${SAFETY_PREAMBLE}

You are analyzing diagnostic results for a Synology NAS issue.
Your job is to determine the root cause with HIGH CONFIDENCE before any fix is attempted.

ISSUE: ${res.resolution.title}
DESCRIPTION: ${res.resolution.description}
${getUserContext(res)}

DIAGNOSTIC RESULTS:
${stepResults}

AVAILABLE DIAGNOSTIC TOOLS (if you need more information):
${Object.entries(TOOL_DEFINITIONS).filter(([,t]) => !t.write).map(([name, t]) => `- ${name}: ${t.description}`).join("\n")}

INSTRUCTIONS:
1. Look at ALL the evidence together. Multiple symptoms may have the SAME root cause.
2. If your confidence is "medium" or "low", you MUST request more diagnostics. Do not guess.
3. If some diagnostics failed (SSH error, timeout), that itself is useful information — explain what it means.
4. Clearly separate what you KNOW from what you SUSPECT.
5. Write the diagnosis_summary for a non-technical business owner. Write the root_cause for a sysadmin.

Respond ONLY with valid JSON:
{
  "needs_more_diagnostics": false,
  "additional_steps": [],
  "diagnosis_summary": "Plain English: what is happening, why, and what is affected — for a business owner",
  "root_cause": "Technical root cause with evidence references",
  "confidence": "high"
}

If confidence is not "high", set needs_more_diagnostics to true and list what else to check.`;
}

function fixProposalPrompt(res: ResolutionFull): string {
  const writeTools = Object.entries(TOOL_DEFINITIONS)
    .filter(([, t]) => t.write)
    .map(([name, t]) => `- ${name}: ${t.description}`)
    .join("\n");

  return `${SAFETY_PREAMBLE}

You are proposing a fix for a Synology NAS issue. This is a PRODUCTION file server.

ISSUE: ${res.resolution.title}
ROOT CAUSE: ${res.resolution.root_cause}
DIAGNOSIS: ${res.resolution.diagnosis_summary}
${getUserContext(res)}

AVAILABLE FIX TOOLS:
${writeTools}

AVAILABLE DIAGNOSTIC TOOLS (for verification after fix):
${Object.entries(TOOL_DEFINITIONS).filter(([,t]) => !t.write).map(([name, t]) => `- ${name}: ${t.description}`).join("\n")}

RULES — READ CAREFULLY:
1. Propose exactly ONE fix action. Not two, not three. ONE.
   After it runs, we verify, and then decide on the next action if needed.
2. Choose the SAFEST option. Prefer service restarts over file operations.
   NEVER propose file renames/moves/deletes unless the user specifically asked for it.
3. Explain the risk clearly. What service will be briefly interrupted? Will users notice?
4. Propose 1-2 verification steps to run AFTER the fix to confirm it worked.
5. Every step MUST have a "title" field.
6. If the safest fix is "do nothing and monitor", say so.

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

  const stepInputs = plan.steps
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

async function handleAnalyzing(
  supabase: SupabaseClient,
  userId: string,
  state: ResolutionFull
): Promise<void> {
  const fresh = await loadResolution(supabase, userId, state.resolution.id);
  if (!fresh) return;

  const primaryAnalysis = await callRemediation<AnalysisResponse>(analysisPrompt(fresh));

  let analysis = primaryAnalysis;

  // If primary model isn't confident, get a second opinion from a different model
  if (analysis.confidence !== "high") {
    await appendLog(supabase, userId, fresh.resolution.id, "analysis",
      `Primary model confidence: ${analysis.confidence}. Requesting second opinion from a different AI model.`);

    try {
      const secondPrompt = `${analysisPrompt(fresh)}

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

  // If AI wants more diagnostics OR confidence is not high, loop back
  const needsMore = analysis.needs_more_diagnostics || analysis.confidence !== "high";

  if (needsMore && analysis.additional_steps?.length) {
    const maxBatch = fresh.steps.reduce((max, s) => Math.max(max, s.batch), -1);
    const batch = maxBatch + 1;

    // Deduplicate additional steps by tool_name+target
    const seen = new Set<string>();
    const dedupedSteps = (analysis.additional_steps ?? []).filter(s => {
      const key = `${s.tool_name}:${s.target}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const stepInputs = dedupedSteps
      .map(raw => materializeStepInput(raw, "diagnostic", fresh.resolution.auto_approve_reads, fresh.resolution.lookback_hours))
      .filter((s): s is StepInput => s !== null);

    if (stepInputs.length > 0) {
      await createSteps(supabase, userId, fresh.resolution.id, batch, stepInputs);
    }
    await appendLog(supabase, userId, fresh.resolution.id, "analysis",
      `Need more information (confidence: ${analysis.confidence}). ${analysis.diagnosis_summary}`);
    await updateResolution(supabase, userId, fresh.resolution.id, { phase: "diagnosing" });
    return;
  }

  // Even without additional steps, if confidence is low, report it and pause for user input
  if (analysis.confidence === "low") {
    await updateResolution(supabase, userId, fresh.resolution.id, {
      phase: "stuck",
      diagnosis_summary: analysis.diagnosis_summary,
      stuck_reason: `Both AI models have low confidence in the diagnosis. The agent needs more information to proceed safely. Root cause hypothesis: ${analysis.root_cause}`,
    });
    await appendLog(supabase, userId, fresh.resolution.id, "analysis",
      `Low confidence diagnosis even after second opinion. Pausing for user input.\n\n${analysis.diagnosis_summary}`);
    return;
  }

  // High or medium confidence — proceed to fix proposal
  await updateResolution(supabase, userId, fresh.resolution.id, {
    phase: "proposing_fix",
    diagnosis_summary: analysis.diagnosis_summary,
    root_cause: analysis.root_cause,
  });
  await appendLog(supabase, userId, fresh.resolution.id, "diagnosis",
    `${analysis.diagnosis_summary}\n\nConfidence: ${analysis.confidence}`,
    analysis.root_cause);
}

async function handleProposingFix(
  supabase: SupabaseClient,
  userId: string,
  state: ResolutionFull
): Promise<void> {
  // Guard: if fix steps already exist, skip (race condition protection)
  const existingFix = state.steps.filter(s => s.category === "fix");
  if (existingFix.length > 0) {
    // Steps already created — just transition
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
    } else {
      // Go back to planning for another round of diagnose → fix → verify
      await updateResolution(supabase, userId, fresh.resolution.id, {
        phase: "planning",
        attempt_count: newAttempt,
        verification_result: verdict.verification_summary,
      });
      await appendLog(supabase, userId, fresh.resolution.id, "verification",
        `Partially fixed. Starting another round (attempt ${newAttempt + 1}). ${verdict.remaining_concerns}`);
    }
  }
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

  try {
    const state = await loadResolution(supabase, userId, resolutionId);
    if (!state) return null;

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

  return loadResolution(supabase, userId, resolutionId);
}
