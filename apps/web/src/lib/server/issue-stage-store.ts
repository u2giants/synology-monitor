import type { SupabaseClient } from "@/lib/server/issue-store";

export type IssueStageKey =
  | "capability_refresh"
  | "fact_refresh"
  | "hypothesis_rank"
  | "next_step_plan"
  | "operator_explanation"
  | "verification";

export type IssueStageStatus = "running" | "completed" | "failed" | "skipped";

export interface IssueStageRun {
  id: string;
  issue_id: string;
  user_id: string;
  stage_key: IssueStageKey;
  status: IssueStageStatus;
  model_name: string | null;
  model_tier: string | null;
  input_summary: Record<string, unknown>;
  output: Record<string, unknown>;
  error_text: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function recordIssueStageRun(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
  input: {
    stageKey: IssueStageKey;
    status: IssueStageStatus;
    modelName?: string | null;
    modelTier?: string | null;
    inputSummary?: Record<string, unknown>;
    output?: Record<string, unknown>;
    errorText?: string | null;
    startedAt?: string;
    completedAt?: string | null;
  },
) {
  const { error } = await supabase.from("smon_issue_stage_runs").insert({
    issue_id: issueId,
    user_id: userId,
    stage_key: input.stageKey,
    status: input.status,
    model_name: input.modelName ?? null,
    model_tier: input.modelTier ?? null,
    input_summary: input.inputSummary ?? {},
    output: input.output ?? {},
    error_text: input.errorText ?? null,
    started_at: input.startedAt ?? new Date().toISOString(),
    completed_at: input.completedAt ?? (input.status === "running" ? null : new Date().toISOString()),
  });

  if (error) {
    throw new Error(`Failed to record issue stage run: ${error.message}`);
  }
}

export async function listIssueStageRuns(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
) {
  const { data, error } = await supabase
    .from("smon_issue_stage_runs")
    .select("*")
    .eq("issue_id", issueId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) {
    throw new Error(`Failed to load issue stage runs: ${error.message}`);
  }

  return (data ?? []) as IssueStageRun[];
}
