import { runIssueAgent } from "@/lib/server/issue-agent";
import type { SupabaseClient } from "@/lib/server/issue-store";
import { loadIssue } from "@/lib/server/issue-store";
import {
  claimNextIssueJobGlobal,
  claimNextIssueJob,
  completeIssueJob,
  enqueueIssueJob,
  failIssueJob,
  type IssueJob,
  type IssueJobType,
} from "@/lib/server/workflow-store";

function buildWorkerId() {
  return `web-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}

export function shouldInlineDrain() {
  return process.env.ISSUE_WORKER_MODE !== "background";
}

export async function queueIssueRun(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
  jobType: IssueJobType = "run_issue",
  payload: Record<string, unknown> = {},
) {
  return enqueueIssueJob(supabase, userId, issueId, jobType, payload, {
    priority: jobType === "approval_decision" ? 200 : 100,
  });
}

async function processIssueJob(
  supabase: SupabaseClient,
  userId: string,
  job: IssueJob,
) {
  const issue = await loadIssue(supabase, userId, job.issue_id);
  if (!issue) {
    throw new Error(`Issue ${job.issue_id} not found for job ${job.id}`);
  }

  await runIssueAgent(supabase, userId, issue.issue.id);
}

export async function drainIssueQueue(
  supabase: SupabaseClient,
  userId: string,
  options: { limit?: number } = {},
) {
  const workerId = buildWorkerId();
  const limit = options.limit ?? 3;
  let processed = 0;

  while (processed < limit) {
    const job = await claimNextIssueJob(supabase, userId, workerId);
    if (!job) break;

    try {
      await processIssueJob(supabase, userId, job);
      await completeIssueJob(supabase, userId, job.id);
    } catch (error) {
      await failIssueJob(
        supabase,
        userId,
        job,
        error instanceof Error ? error.message : "Unknown issue worker failure",
      );
      throw error;
    }

    processed += 1;
  }

  return processed;
}

export async function drainIssueQueueGlobal(
  supabase: SupabaseClient,
  options: { limit?: number } = {},
) {
  const workerId = buildWorkerId();
  const limit = options.limit ?? 10;
  let processed = 0;

  while (processed < limit) {
    const job = await claimNextIssueJobGlobal(supabase, workerId);
    if (!job) break;

    try {
      await processIssueJob(supabase, job.user_id, job);
      await completeIssueJob(supabase, job.user_id, job.id);
    } catch (error) {
      await failIssueJob(
        supabase,
        job.user_id,
        job,
        error instanceof Error ? error.message : "Unknown global issue worker failure",
      );
      throw error;
    }

    processed += 1;
  }

  return processed;
}
