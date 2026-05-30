/**
 * Stage 2 turn state machine (PLAN.md §7).
 *
 * Collapsing the old four reasoning stages into one agentic loop must not break
 * the existing job/approval/dependency layer. This module is the resumable
 * SKELETON of a Stage-2 "turn": the terminal outcomes and how each maps onto
 * issue_jobs + issue statuses + the approval gate. The actual model reasoning
 * (deciding which terminal) is built on top of this in step 5; keeping the
 * skeleton separate and dormant means step 4 doesn't disturb the live loop.
 *
 * Invariant (§7): a turn is resumable from DB state only — never from in-memory
 * loop state or a warm cache. The process dies at every approval/user gate and
 * may resume in a different worker; the persisted transcript (issue_messages /
 * issue_actions / issue_evidence_items) is the single source of truth.
 *
 * Approval (§7): we persist the action INTENT (tool + tier + args + command
 * preview) and NEVER the HMAC token. The token expires in 15 min but
 * propose→approve can be hours, so a persisted token would be expired on resume.
 * The token is minted fresh immediately before the nas-api call at execution
 * time (mintApprovalTokenForIntent) — the 15-min window then bounds only
 * exec→exec (seconds), never the operator's think time.
 */

import {
  appendIssueMessage,
  createIssueAction,
  recordIssueTransition,
  updateIssue,
  type Issue,
  type IssueActionKind,
  type IssueStatus,
  type SupabaseClient,
} from "@/lib/server/issue-store";
import { buildApprovalToken, type NasTarget } from "@/lib/server/tools";
import { enqueueIssueJob } from "@/lib/server/workflow-store";

/** Bounded number of Stage-2 turns per issue (the old MAX_AGENT_CYCLES, renamed). */
export const TURN_CAP = 8;

export type ActionTier = 1 | 2 | 3;

/** The persisted action INTENT — never includes the HMAC approval token (§7). */
export interface ActionIntent {
  kind: IssueActionKind; // diagnostic | remediation
  tier: ActionTier;
  target: NasTarget | null;
  toolName: string;
  commandPreview: string;
  args?: Record<string, unknown>;
  summary: string;
  reason: string;
  expectedOutcome: string;
  rollbackPlan?: string;
  risk: "low" | "medium" | "high";
}

/**
 * Exactly one terminal per turn (§7). Hypothesis/confidence updates ride along on
 * every outcome via `issuePatch`.
 */
export type TurnOutcome =
  | {
      // Read-only diagnostic(s) ran; results already persisted to evidence. Continue.
      kind: "diagnostic";
      agentMessage: string;
      issuePatch?: IssuePatch;
    }
  | {
      // Needs a tier-2/3 action — persist the intent, wait for the operator.
      kind: "needs_approval";
      agentMessage: string;
      intent: ActionIntent;
      issuePatch?: IssuePatch;
    }
  | {
      kind: "needs_user";
      agentMessage: string;
      question: string;
      issuePatch?: IssuePatch;
    }
  | {
      kind: "blocked_on_issue";
      agentMessage: string;
      dependsOnIssueId: string;
      issuePatch?: IssuePatch;
    }
  | {
      kind: "done";
      agentMessage: string;
      verdict: "resolved" | "stuck";
      issuePatch?: IssuePatch;
    };

export interface IssuePatch {
  current_hypothesis?: string;
  hypothesis_confidence?: "high" | "medium" | "low";
  next_step?: string;
  conversation_summary?: string;
  severity?: "critical" | "warning" | "info";
}

export interface ApplyTurnResult {
  status: IssueStatus;
  /** issue_actions row id when an approval intent was persisted. */
  actionId?: string;
  /** True when the worker should enqueue/continue another turn. */
  continues: boolean;
}

/**
 * Map a turn outcome onto the DB: persist the transcript entry, set the issue
 * status, record the transition, and enqueue the next job — exactly the §7 table.
 * Reuses the existing store/queue functions so the job/approval/dependency layer
 * is untouched.
 */
export async function applyTurnOutcome(
  supabase: SupabaseClient,
  userId: string,
  issue: Issue,
  outcome: TurnOutcome,
): Promise<ApplyTurnResult> {
  const fromStatus = issue.status;

  // Always persist the agent's message + any hypothesis/summary updates first.
  await appendIssueMessage(supabase, userId, issue.id, "agent", outcome.agentMessage);
  if (outcome.issuePatch) {
    await updateIssue(supabase, userId, issue.id, outcome.issuePatch);
  }

  switch (outcome.kind) {
    case "diagnostic": {
      await transition(supabase, userId, issue.id, fromStatus, "running", "diagnostic_complete");
      // Continue the loop with another turn (bounded by TURN_CAP at the caller).
      await enqueueIssueJob(supabase, userId, issue.id, "run_issue", { trigger: "turn_continue" });
      return { status: "running", continues: true };
    }

    case "needs_approval": {
      // Persist the INTENT only — approval_token stays null; minted at exec time.
      const actionId = await createIssueAction(supabase, userId, issue.id, {
        kind: outcome.intent.kind,
        target: outcome.intent.target,
        toolName: outcome.intent.toolName,
        commandPreview: outcome.intent.commandPreview,
        summary: outcome.intent.summary,
        reason: outcome.intent.reason,
        expectedOutcome: outcome.intent.expectedOutcome,
        rollbackPlan: outcome.intent.rollbackPlan ?? "",
        risk: outcome.intent.risk,
        requiresApproval: true,
        approvalToken: null, // NEVER persist the token (§7)
      });
      await transition(
        supabase,
        userId,
        issue.id,
        fromStatus,
        "waiting_for_approval",
        "needs_approval",
        { tier: outcome.intent.tier, action_id: actionId },
      );
      return { status: "waiting_for_approval", actionId, continues: false };
    }

    case "needs_user": {
      await transition(supabase, userId, issue.id, fromStatus, "waiting_on_user", "needs_user");
      return { status: "waiting_on_user", continues: false };
    }

    case "blocked_on_issue": {
      await updateIssue(supabase, userId, issue.id, {
        status: "waiting_on_issue",
        depends_on_issue_id: outcome.dependsOnIssueId,
      });
      await recordIssueTransition(
        supabase,
        userId,
        issue.id,
        fromStatus,
        "waiting_on_issue",
        "blocked_on_issue",
        { depends_on_issue_id: outcome.dependsOnIssueId },
      );
      return { status: "waiting_on_issue", continues: false };
    }

    case "done": {
      await transition(supabase, userId, issue.id, fromStatus, outcome.verdict, "turn_terminal");
      // Stage 3 (explainer/memory) + releaseDependentIssues run after resolve in
      // the worker; nothing extra to enqueue here.
      return { status: outcome.verdict, continues: false };
    }
  }
}

/**
 * Mint a fresh approval token at EXECUTION time, immediately before the nas-api
 * call (§7). Never persisted. Throws if the intent has no NAS target (a tier-2/3
 * action must target a NAS).
 */
export function mintApprovalTokenForIntent(intent: ActionIntent): string {
  if (!intent.target) {
    throw new Error("mintApprovalTokenForIntent: tier-2/3 action intent has no NAS target.");
  }
  return buildApprovalToken(intent.target, intent.commandPreview);
}

// ─── NAS reachability degrade (§7) ───────────────────────────────────────────

export interface NasUnreachableResult {
  ok: false;
  reason: "nas_unreachable";
  target: string | null;
  detail: string;
}

export function isNasUnreachable(v: unknown): v is NasUnreachableResult {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { reason?: unknown }).reason === "nas_unreachable"
  );
}

/**
 * Wrap a live NAS tool call so a Tailscale/NAS outage degrades instead of hangs
 * (§7): retry once, then return a structured nas_unreachable result (not a raw
 * exception). fetch_evidence reads Supabase and is unaffected, so the agent can
 * still diagnose from stored telemetry and tell the operator the NAS is offline.
 */
export async function withNasReachability<T>(
  target: string | null,
  call: () => Promise<T>,
): Promise<T | NasUnreachableResult> {
  try {
    return await call();
  } catch (firstErr) {
    if (!isConnectionError(firstErr)) throw firstErr;
    try {
      return await call(); // single retry
    } catch (secondErr) {
      if (!isConnectionError(secondErr)) throw secondErr;
      return {
        ok: false,
        reason: "nas_unreachable",
        target,
        detail: secondErr instanceof Error ? secondErr.message : String(secondErr),
      };
    }
  }
}

function isConnectionError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code ?? "";
  const msg = err instanceof Error ? err.message : String(err);
  return (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EHOSTUNREACH" ||
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|fetch failed|network/i.test(msg)
  );
}

async function transition(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
  fromStatus: IssueStatus,
  toStatus: IssueStatus,
  reason: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await updateIssue(supabase, userId, issueId, { status: toStatus });
  await recordIssueTransition(supabase, userId, issueId, fromStatus, toStatus, reason, metadata);
}
