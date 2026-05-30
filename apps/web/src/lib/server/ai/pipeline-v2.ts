/**
 * Issue-agent pipeline v2 — the cutover orchestrator (PLAN.md §10 step 5/8).
 *
 * Wires the dormant 3-stage runners into one worker entry point that replaces
 * runIssueAgent's internals. A job = one step of the resumable loop (§7):
 *   1. execute an approved tier-2/3 action if one is pending (mint the HMAC token
 *      FRESH at exec time — never the persisted one, which would be expired);
 *   2. seed the lossless evidence store with Stage 1 on the first turn;
 *   3. run one Stage 2 reasoning turn (which ends in a §7 terminal and enqueues
 *      the next turn itself, bounded by TURN_CAP);
 *   4. on resolve, write the Stage 3 operator wrap-up + durable memories.
 *
 * Gated per-issue / per-env so it can be validated on one issue before becoming
 * the default (see issue-workflow.ts). Default OFF — deploying this changes
 * nothing until opted in.
 */

import {
  appendIssueMessage,
  loadIssue,
  updateIssue,
  updateIssueAction,
  type IssueFull,
  type SupabaseClient,
} from "@/lib/server/issue-store";
import {
  buildNasApiApprovalToken,
  nasApiExec,
  resolveNasApiConfig,
} from "@/lib/server/nas-api-client";
import { gatherTelemetryContext } from "@/lib/server/issue-agent";
import { runStage1Structurer, telemetryToRawItems } from "./stage1-structurer";
import { runStage2Turn, type Stage2TurnResult } from "./stage2-reasoning";
import { runStage3Explainer } from "./stage3-explainer";

const RUNNABLE = new Set(["open", "running", "waiting_on_issue"]);

export async function runIssueAgentV2(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
): Promise<Stage2TurnResult | null> {
  const full = await loadIssue(supabase, userId, issueId);
  if (!full) return null;

  // 1. Execute a pending approved action (may flip waiting_for_approval→running).
  await executeApprovedAction(supabase, userId, full);

  // Reload — status / actions may have changed.
  const afterExec = await loadIssue(supabase, userId, issueId);
  if (!afterExec) return null;
  const issue = afterExec.issue;
  if (!RUNNABLE.has(issue.status)) return null; // awaiting user/approval, or terminal

  // 2. Seed the lossless evidence store once, on the first turn.
  const { count } = await supabase
    .from("issue_evidence_items")
    .select("id", { count: "exact", head: true })
    .eq("issue_id", issueId);
  if (!count) {
    const telemetry = await gatherTelemetryContext(supabase, userId, issue);
    const raw = telemetryToRawItems(telemetry as unknown as Record<string, unknown>);
    await runStage1Structurer({ supabase, issueId, affectedNas: issue.affected_nas, raw });
  }

  // 3. One Stage 2 reasoning turn.
  const turn = await runStage2Turn(supabase, userId, issue);

  // 4. Stage 3 on resolve.
  if (turn.status === "resolved") {
    const resolved = await loadIssue(supabase, userId, issueId);
    if (resolved) {
      try {
        await runStage3Explainer(supabase, userId, resolved.issue);
      } catch {
        // Explainer/memory is best-effort; never fail the resolution on it.
      }
    }
  }

  return turn;
}

/**
 * Execute the approved tier-2/3 action, minting a fresh HMAC token at exec time
 * (§7). Verification is the next Stage-2 turn, not done here. Returns true if an
 * action was executed.
 */
async function executeApprovedAction(
  supabase: SupabaseClient,
  userId: string,
  full: IssueFull,
): Promise<boolean> {
  const approved = full.actions.find((a) => a.status === "approved");
  if (!approved) return false;

  await updateIssue(supabase, userId, full.issue.id, { status: "running" });
  await updateIssueAction(supabase, userId, approved.id, { status: "running" });

  let resultText = "";
  let exitCode: number | null = null;
  let status: "completed" | "failed" = "completed";

  try {
    const config = approved.target ? resolveNasApiConfig(approved.target) : null;
    if (!config) throw new Error(`No NAS API config for target: ${approved.target ?? "(none)"}`);
    const tierMatch = approved.tool_name?.match(/tier(\d)/);
    const tier = tierMatch ? (Number(tierMatch[1]) as 2 | 3) : 2;
    // Mint the approval token NOW — never reuse a persisted (expired) one (§7).
    const token = buildNasApiApprovalToken(config, approved.command_preview, tier);
    const result = await nasApiExec(config, approved.command_preview, tier, token, 90_000);
    resultText = [result.stdout, result.stderr].filter(Boolean).join("\n\n").slice(0, 12_000);
    exitCode = result.exit_code;
    status = result.exit_code === 0 ? "completed" : "failed";
  } catch (err) {
    resultText = err instanceof Error ? err.message : "Unknown remediation execution error";
    status = "failed";
  }

  await updateIssueAction(supabase, userId, approved.id, {
    status,
    result_text: resultText,
    exit_code: exitCode,
    completed_at: new Date().toISOString(),
  });

  // Persist the execution result into the lossless store so the verification
  // turn (next Stage 2 turn) can see it.
  const now = new Date().toISOString();
  await supabase.from("issue_evidence_items").insert({
    issue_id: full.issue.id,
    nas_id: approved.target,
    source: `action:${approved.id}`,
    severity: exitCode === 0 ? "info" : "error",
    ts: now,
    first_ts: now,
    last_ts: now,
    body: `Executed: ${approved.command_preview}\nexit=${exitCode}\n${resultText}`.slice(0, 12_000),
    dedup_count: 1,
    in_scope: true,
    anomalous: status === "failed",
    metadata: { action_id: approved.id, exit_code: exitCode, executed_status: status },
  });

  await appendIssueMessage(
    supabase,
    userId,
    full.issue.id,
    "system",
    `Approved action executed (exit ${exitCode ?? "?"}, ${status}). Verifying on the next turn.`,
    { trigger: "approved_action_executed", action_id: approved.id },
  );

  return true;
}
