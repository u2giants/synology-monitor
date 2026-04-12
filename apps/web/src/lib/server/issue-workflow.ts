import { runIssueAgent } from "@/lib/server/issue-agent";
import type { SupabaseClient } from "@/lib/server/issue-store";
import { listIssuesDependingOn, loadIssue } from "@/lib/server/issue-store";
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

/**
 * When issue B resolves, re-open and re-queue every issue A that was
 * waiting on B. Posts a system message to A so the thread shows the trigger.
 */
async function releaseDependentIssues(
  supabase: SupabaseClient,
  userId: string,
  resolvedIssueId: string,
) {
  const dependents = await listIssuesDependingOn(supabase, userId, resolvedIssueId);
  if (dependents.length === 0) return;

  for (const dep of dependents) {
    await supabase
      .from("issues")
      .update({ status: "open", depends_on_issue_id: null, updated_at: new Date().toISOString() })
      .eq("id", dep.id)
      .eq("user_id", userId);

    await supabase.from("issue_messages").insert({
      issue_id: dep.id,
      user_id: userId,
      role: "system",
      content: "The issue this investigation was blocked on has been resolved. Resuming automatically.",
      metadata: { trigger: "dependency_released", resolved_issue_id: resolvedIssueId },
    });

    await enqueueIssueJob(supabase, userId, dep.id, "run_issue", {
      trigger: "dependency_released",
      resolved_issue_id: resolvedIssueId,
    });
  }
}

/**
 * If other issues have been waiting on this one for >30 minutes with no
 * progress, post a one-time nudge note so the operator and the agent are aware.
 * Does not re-post if a nudge was already sent in the last 30 minutes.
 */
async function maybeNudgeBlockingIssue(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
) {
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const { data: waiting } = await supabase
    .from("issues")
    .select("id, title")
    .eq("user_id", userId)
    .eq("depends_on_issue_id", issueId)
    .eq("status", "waiting_on_issue")
    .lt("updated_at", thirtyMinAgo);

  if (!waiting?.length) return;

  // Avoid spamming — skip if we sent a nudge recently
  const { data: recentNudge } = await supabase
    .from("issue_messages")
    .select("id")
    .eq("issue_id", issueId)
    .eq("role", "system")
    .gte("created_at", thirtyMinAgo)
    .contains("metadata", { trigger: "dependency_nudge" })
    .limit(1);

  if (recentNudge?.length) return;

  const titles = waiting.map((d) => `"${d.title as string}"`).join(", ");
  const count = waiting.length;
  await supabase.from("issue_messages").insert({
    issue_id: issueId,
    user_id: userId,
    role: "system",
    content: `Note: ${count} other investigation${count === 1 ? "" : "s"} ${count === 1 ? "is" : "are"} blocked waiting for this to resolve: ${titles}.`,
    metadata: { trigger: "dependency_nudge", waiting_count: count },
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

  // If other issues are waiting on this one and it's been idle >30 min, nudge.
  await maybeNudgeBlockingIssue(supabase, userId, job.issue_id);

  await runIssueAgent(supabase, userId, issue.issue.id);

  // If this issue just resolved, release any issues that were blocked on it.
  const afterState = await loadIssue(supabase, userId, job.issue_id);
  if (afterState?.issue.status === "resolved") {
    await releaseDependentIssues(supabase, userId, job.issue_id);
  }
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
