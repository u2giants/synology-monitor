import type { SupabaseClient, IssueFull, IssueStateTransition } from "@/lib/server/issue-store";
import { listIssueFacts, type FactRecord } from "@/lib/server/fact-store";
import { listCapabilityState, type CapabilityRecord } from "@/lib/server/capability-store";
import type { IssueJob } from "@/lib/server/workflow-store";
import { listIssueStageRuns, type IssueStageRun } from "@/lib/server/issue-stage-store";

export interface IssueViewState extends IssueFull {
  facts: FactRecord[];
  capabilities: CapabilityRecord[];
  jobs: IssueJob[];
  transitions: IssueStateTransition[];
  stage_runs: IssueStageRun[];
}

async function resolveIssueNasIds(
  supabase: SupabaseClient,
  nasNames: string[],
) {
  if (nasNames.length === 0) return [] as string[];
  const filters = nasNames.flatMap((nas) => [`name.eq.${nas}`, `hostname.eq.${nas}`]).join(",");
  const { data, error } = await supabase
    .from("nas_units")
    .select("id")
    .or(filters);

  if (error) {
    throw new Error(`Failed to resolve issue NAS IDs: ${error.message}`);
  }

  return (data ?? []).map((row) => row.id as string);
}

export async function loadIssueViewState(
  supabase: SupabaseClient,
  userId: string,
  state: IssueFull,
): Promise<IssueViewState> {
  const nasIds = await resolveIssueNasIds(supabase, state.issue.affected_nas);

  const [facts, capabilities, jobsResult, transitionsResult, stageRuns] = await Promise.all([
    listIssueFacts(supabase, userId, state.issue.id),
    listCapabilityState(supabase, nasIds),
    supabase
      .from("issue_jobs")
      .select("*")
      .eq("issue_id", state.issue.id)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("issue_state_transitions")
      .select("*")
      .eq("issue_id", state.issue.id)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20),
    listIssueStageRuns(supabase, userId, state.issue.id),
  ]);

  if (jobsResult.error) {
    throw new Error(`Failed to load issue jobs: ${jobsResult.error.message}`);
  }

  if (transitionsResult.error) {
    throw new Error(`Failed to load issue transitions: ${transitionsResult.error.message}`);
  }

  return {
    ...state,
    facts,
    capabilities,
    jobs: (jobsResult.data ?? []) as IssueJob[],
    transitions: (transitionsResult.data ?? []) as IssueStateTransition[],
    stage_runs: stageRuns,
  };
}
