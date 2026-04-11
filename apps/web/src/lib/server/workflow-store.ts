import type { SupabaseClient } from "@/lib/server/issue-store";

export type IssueJobType = "run_issue" | "user_message" | "approval_decision" | "detect_issue";
export type IssueJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface IssueJob {
  id: string;
  issue_id: string;
  user_id: string;
  job_type: IssueJobType;
  status: IssueJobStatus;
  priority: number;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  run_at: string;
  locked_at: string | null;
  locked_by: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export async function enqueueIssueJob(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
  jobType: IssueJobType,
  payload: Record<string, unknown> = {},
  options: { priority?: number; runAt?: string; dedupe?: boolean } = {},
) {
  if (options.dedupe !== false) {
    const { data: existing, error: existingError } = await supabase
      .from("issue_jobs")
      .select("id")
      .eq("issue_id", issueId)
      .eq("user_id", userId)
      .eq("job_type", jobType)
      .in("status", ["queued", "running"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingError) {
      throw new Error(`Failed to check existing issue job: ${existingError.message}`);
    }

    if (existing?.id) {
      return existing.id;
    }
  }

  const { data, error } = await supabase
    .from("issue_jobs")
    .insert({
      issue_id: issueId,
      user_id: userId,
      job_type: jobType,
      payload,
      priority: options.priority ?? 100,
      run_at: options.runAt ?? new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Failed to enqueue issue job: ${error?.message ?? "unknown error"}`);
  }

  return data.id as string;
}

export async function claimNextIssueJob(
  supabase: SupabaseClient,
  userId: string,
  workerId: string,
) {
  const now = new Date().toISOString();
  const { data: candidates, error } = await supabase
    .from("issue_jobs")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "queued")
    .lte("run_at", now)
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(10);

  if (error) {
    throw new Error(`Failed to list issue jobs: ${error.message}`);
  }

  for (const candidate of (candidates ?? []) as IssueJob[]) {
    const { data: updated, error: updateError } = await supabase
      .from("issue_jobs")
      .update({
        status: "running",
        attempts: candidate.attempts + 1,
        locked_at: now,
        locked_by: workerId,
        updated_at: now,
      })
      .eq("id", candidate.id)
      .eq("user_id", userId)
      .eq("status", "queued")
      .select("*")
      .maybeSingle();

    if (updateError) {
      throw new Error(`Failed to claim issue job: ${updateError.message}`);
    }

    if (updated) {
      return updated as IssueJob;
    }
  }

  return null;
}

export async function claimNextIssueJobGlobal(
  supabase: SupabaseClient,
  workerId: string,
) {
  const now = new Date().toISOString();
  const { data: candidates, error } = await supabase
    .from("issue_jobs")
    .select("*")
    .eq("status", "queued")
    .lte("run_at", now)
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(10);

  if (error) {
    throw new Error(`Failed to list global issue jobs: ${error.message}`);
  }

  for (const candidate of (candidates ?? []) as IssueJob[]) {
    const { data: updated, error: updateError } = await supabase
      .from("issue_jobs")
      .update({
        status: "running",
        attempts: candidate.attempts + 1,
        locked_at: now,
        locked_by: workerId,
        updated_at: now,
      })
      .eq("id", candidate.id)
      .eq("status", "queued")
      .select("*")
      .maybeSingle();

    if (updateError) {
      throw new Error(`Failed to claim global issue job: ${updateError.message}`);
    }

    if (updated) {
      return updated as IssueJob;
    }
  }

  return null;
}

export async function completeIssueJob(
  supabase: SupabaseClient,
  userId: string,
  jobId: string,
) {
  const { error } = await supabase
    .from("issue_jobs")
    .update({
      status: "completed",
      locked_at: null,
      locked_by: null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("user_id", userId);

  if (error) {
    throw new Error(`Failed to complete issue job: ${error.message}`);
  }
}

export async function failIssueJob(
  supabase: SupabaseClient,
  userId: string,
  job: Pick<IssueJob, "id" | "attempts" | "max_attempts">,
  errorText: string,
) {
  const exhausted = job.attempts >= job.max_attempts;
  const nextStatus: IssueJobStatus = exhausted ? "failed" : "queued";
  const nextRunAt = exhausted
    ? null
    : new Date(Date.now() + Math.min(job.attempts, 5) * 30_000).toISOString();

  const { error } = await supabase
    .from("issue_jobs")
    .update({
      status: nextStatus,
      last_error: errorText,
      locked_at: null,
      locked_by: null,
      run_at: nextRunAt ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: exhausted ? new Date().toISOString() : null,
    })
    .eq("id", job.id)
    .eq("user_id", userId);

  if (error) {
    throw new Error(`Failed to fail issue job: ${error.message}`);
  }
}

export async function cancelQueuedIssueJobs(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
) {
  const { error } = await supabase
    .from("issue_jobs")
    .update({
      status: "cancelled",
      updated_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    })
    .eq("issue_id", issueId)
    .eq("user_id", userId)
    .eq("status", "queued");

  if (error) {
    throw new Error(`Failed to cancel queued issue jobs: ${error.message}`);
  }
}
