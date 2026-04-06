/**
 * Resolution store — CRUD for smon_issue_resolutions, smon_resolution_steps, smon_resolution_log
 */

import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";
import type { NasTarget, CopilotToolName } from "./tools";

export type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

export type ResolutionPhase =
  | "planning" | "diagnosing" | "analyzing" | "proposing_fix"
  | "awaiting_fix_approval" | "applying_fix" | "verifying"
  | "resolved" | "stuck" | "cancelled";

export type StepStatus = "planned" | "approved" | "running" | "completed" | "failed" | "skipped" | "rejected";
export type StepCategory = "diagnostic" | "fix" | "verification";

export interface Resolution {
  id: string;
  user_id: string;
  origin_type: "problem" | "alert" | "manual";
  origin_id: string | null;
  title: string;
  description: string;
  severity: "critical" | "warning" | "info";
  affected_nas: string[];
  phase: ResolutionPhase;
  diagnosis_summary: string | null;
  root_cause: string | null;
  fix_summary: string | null;
  verification_result: string | null;
  stuck_reason: string | null;
  attempt_count: number;
  max_attempts: number;
  auto_approve_reads: boolean;
  lookback_hours: number;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface ResolutionStep {
  id: string;
  resolution_id: string;
  step_order: number;
  batch: number;
  category: StepCategory;
  title: string;
  target: string;
  tool_name: string;
  command_preview: string;
  reason: string;
  risk: "low" | "medium" | "high";
  approval_token: string | null;
  requires_approval: boolean;
  status: StepStatus;
  result_text: string | null;
  exit_code: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface ResolutionLogEntry {
  id: string;
  resolution_id: string;
  entry_type: string;
  content: string;
  technical_detail: string | null;
  created_at: string;
}

export interface ResolutionFull {
  resolution: Resolution;
  steps: ResolutionStep[];
  log: ResolutionLogEntry[];
}

// --- Create ---

export async function createResolution(
  supabase: SupabaseClient,
  userId: string,
  input: {
    originType: "problem" | "alert" | "manual";
    originId?: string | null;
    title: string;
    description: string;
    severity?: "critical" | "warning" | "info";
    affectedNas?: string[];
    autoApproveReads?: boolean;
    lookbackHours?: number;
  }
): Promise<string> {
  const { data, error } = await supabase
    .from("smon_issue_resolutions")
    .insert({
      user_id: userId,
      origin_type: input.originType,
      origin_id: input.originId ?? null,
      title: input.title,
      description: input.description,
      severity: input.severity ?? "warning",
      affected_nas: input.affectedNas ?? [],
      auto_approve_reads: input.autoApproveReads ?? true,
      lookback_hours: input.lookbackHours ?? 2,
    })
    .select("id")
    .single();

  if (error) throw new Error(`Failed to create resolution: ${error.message}`);
  return data.id;
}

// --- Read ---

export async function loadResolution(
  supabase: SupabaseClient,
  userId: string,
  resolutionId: string
): Promise<ResolutionFull | null> {
  const [resResult, stepsResult, logResult] = await Promise.all([
    supabase
      .from("smon_issue_resolutions")
      .select("*")
      .eq("id", resolutionId)
      .eq("user_id", userId)
      .single(),
    supabase
      .from("smon_resolution_steps")
      .select("*")
      .eq("resolution_id", resolutionId)
      .eq("user_id", userId)
      .order("step_order", { ascending: true }),
    supabase
      .from("smon_resolution_log")
      .select("*")
      .eq("resolution_id", resolutionId)
      .eq("user_id", userId)
      .order("created_at", { ascending: true }),
  ]);

  if (resResult.error || !resResult.data) return null;

  return {
    resolution: resResult.data as Resolution,
    steps: (stepsResult.data ?? []) as ResolutionStep[],
    log: (logResult.data ?? []) as ResolutionLogEntry[],
  };
}

export async function listResolutions(
  supabase: SupabaseClient,
  userId: string
): Promise<Resolution[]> {
  const { data, error } = await supabase
    .from("smon_issue_resolutions")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(30);

  if (error) throw new Error(`Failed to list resolutions: ${error.message}`);
  return (data ?? []) as Resolution[];
}

// --- Update resolution ---

export async function updateResolution(
  supabase: SupabaseClient,
  userId: string,
  resolutionId: string,
  updates: Partial<{
    phase: ResolutionPhase;
    diagnosis_summary: string;
    root_cause: string;
    fix_summary: string;
    verification_result: string;
    stuck_reason: string;
    attempt_count: number;
    auto_approve_reads: boolean;
    resolved_at: string;
  }>
) {
  const { error } = await supabase
    .from("smon_issue_resolutions")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", resolutionId)
    .eq("user_id", userId);

  if (error) throw new Error(`Failed to update resolution: ${error.message}`);
}

export async function deleteResolution(
  supabase: SupabaseClient,
  userId: string,
  resolutionId: string
) {
  // Delete child rows first (steps and log), then the resolution
  await supabase.from("smon_resolution_steps").delete().eq("resolution_id", resolutionId);
  await supabase.from("smon_resolution_log").delete().eq("resolution_id", resolutionId);
  const { error } = await supabase
    .from("smon_issue_resolutions")
    .delete()
    .eq("id", resolutionId)
    .eq("user_id", userId);
  if (error) throw new Error(`Failed to delete resolution: ${error.message}`);
}

// --- Steps ---

export interface StepInput {
  category: StepCategory;
  title: string;
  target: NasTarget;
  toolName: CopilotToolName;
  commandPreview: string;
  reason: string;
  risk: "low" | "medium" | "high";
  approvalToken: string | null;
  requiresApproval: boolean;
  status?: StepStatus;
}

export async function createSteps(
  supabase: SupabaseClient,
  userId: string,
  resolutionId: string,
  batch: number,
  steps: StepInput[]
): Promise<ResolutionStep[]> {
  // Get current max step_order
  const { data: maxRow } = await supabase
    .from("smon_resolution_steps")
    .select("step_order")
    .eq("resolution_id", resolutionId)
    .order("step_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  const baseOrder = (maxRow?.step_order ?? -1) + 1;

  const rows = steps.map((step, i) => ({
    resolution_id: resolutionId,
    user_id: userId,
    step_order: baseOrder + i,
    batch,
    category: step.category,
    title: step.title,
    target: step.target,
    tool_name: step.toolName,
    command_preview: step.commandPreview,
    reason: step.reason,
    risk: step.risk,
    approval_token: step.approvalToken,
    requires_approval: step.requiresApproval,
    status: step.status ?? "planned",
  }));

  const { data, error } = await supabase
    .from("smon_resolution_steps")
    .insert(rows)
    .select("*");

  if (error) throw new Error(`Failed to create steps: ${error.message}`);
  return (data ?? []) as ResolutionStep[];
}

export async function updateStepStatus(
  supabase: SupabaseClient,
  userId: string,
  stepId: string,
  status: StepStatus,
  resultText?: string | null,
  exitCode?: number | null
) {
  const updates: Record<string, unknown> = { status };
  if (status === "running") updates.started_at = new Date().toISOString();
  if (status === "completed" || status === "failed") {
    updates.completed_at = new Date().toISOString();
    if (resultText !== undefined) updates.result_text = resultText;
    if (exitCode !== undefined) updates.exit_code = exitCode;
  }
  if (status === "approved" || status === "rejected" || status === "skipped") {
    if (resultText !== undefined) updates.result_text = resultText;
  }

  const { error } = await supabase
    .from("smon_resolution_steps")
    .update(updates)
    .eq("id", stepId)
    .eq("user_id", userId);

  if (error) throw new Error(`Failed to update step: ${error.message}`);
}

export async function approveSteps(
  supabase: SupabaseClient,
  userId: string,
  stepIds: string[]
) {
  const { error } = await supabase
    .from("smon_resolution_steps")
    .update({ status: "approved" })
    .in("id", stepIds)
    .eq("user_id", userId)
    .eq("status", "planned");

  if (error) throw new Error(`Failed to approve steps: ${error.message}`);
}

export async function rejectSteps(
  supabase: SupabaseClient,
  userId: string,
  stepIds: string[]
) {
  const { error } = await supabase
    .from("smon_resolution_steps")
    .update({ status: "rejected" })
    .in("id", stepIds)
    .eq("user_id", userId)
    .eq("status", "planned");

  if (error) throw new Error(`Failed to reject steps: ${error.message}`);
}

// --- Log ---

export async function appendLog(
  supabase: SupabaseClient,
  userId: string,
  resolutionId: string,
  entryType: string,
  content: string,
  technicalDetail?: string | null
) {
  const { error } = await supabase
    .from("smon_resolution_log")
    .insert({
      resolution_id: resolutionId,
      user_id: userId,
      entry_type: entryType,
      content,
      technical_detail: technicalDetail ?? null,
    });

  if (error) throw new Error(`Failed to append log: ${error.message}`);
}
