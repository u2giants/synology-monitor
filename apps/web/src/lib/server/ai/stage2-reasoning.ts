/**
 * Stage 2 — Reasoning Core (PLAN.md §3, §5, §7, §9).
 *
 * One agentic turn of the "SSH-genius" brain, with guardrails. It:
 *   - rebuilds its context from the DB every turn (§7 resumable invariant):
 *     persisted transcript + the bounded evidence slice from the lossless store;
 *   - assembles the prompt stable→dynamic via the context compiler (§9.1.2) so
 *     the system/tools/schema/taxonomy prefix caches and only the evidence slice
 *     + per-turn instruction are dynamic;
 *   - calls the operator-selected reasoning model with READ-ONLY tier-1 tools +
 *     fetch_evidence executed inline (§3/§6); tier-2/3 actions are NOT callable —
 *     the model proposes them and they go through the approval gate (§7);
 *   - runs a re-chew guard (§1e/§3): if the evidence is unchanged and the model
 *     keeps wanting to "continue", it stops re-chewing and switches to asking the
 *     operator what's missing;
 *   - ends in exactly one terminal, mapped onto the §7 state machine.
 *
 * Verification after an executed action is just the next turn of this same loop
 * (§3) — there is no separate verifier stage.
 *
 * Dormant until the worker cutover (step 8): this is the new loop body that will
 * replace runIssueAgent's internals; nothing calls it yet.
 */

import { createHash } from "node:crypto";
import { getReasoningConfig } from "@/lib/server/ai-settings";
import {
  updateIssue,
  type Issue,
  type SupabaseClient,
} from "@/lib/server/issue-store";
import { TOOL_DEFINITIONS, type CopilotToolName, type NasTarget } from "@/lib/server/tools";
import { nasApiExec, nasApiPreview, resolveNasApiConfig } from "@/lib/server/nas-api-client";
import { parseJsonObject } from "@/lib/server/model-json";
import { callModel } from "./call-model";
import { block, type PromptBlock } from "./context-compiler";
import { fetchEvidence, FETCH_EVIDENCE_TOOL, type FetchEvidenceParams } from "./fetch-evidence";
import { loadEvidenceSlice } from "./stage1-structurer";
import type { ToolExecutor, ToolSchema } from "./providers";
import {
  applyTurnOutcome,
  isNasUnreachable,
  withNasReachability,
  TURN_CAP,
  type ActionIntent,
  type ApplyTurnResult,
  type IssuePatch,
  type TurnOutcome,
} from "./stage2-turn";

const MAX_OUTPUT_TOKENS = 8_192;

// ─── Stable prompt blocks (cacheable prefix) ─────────────────────────────────

const SYSTEM_PROMPT = `You are the reasoning core of an autonomous Synology NAS incident investigator,
operating two production NAS units (edgesynology1, edgesynology2). You have the
instincts of an expert with a live SSH session: form a hypothesis, gather the
exact evidence that would confirm or kill it, and iterate — but you work through a
curated, approval-gated tool layer, not raw shell.

Operating rules:
- Use READ-ONLY tools freely to investigate (they auto-execute). Aggregate
  evidence first (fetch_evidence group_by) to see the shape, then page into
  specifics — never assume a sparse/empty result means healthy.
- Prefer normalized, deduped evidence over raw volume. The evidence slice already
  separates anomalous events from baseline noise; the rest is retrievable via
  fetch_evidence.
- You may NOT execute service/file changes yourself. When a fix is warranted,
  PROPOSE it as a remediation in your final answer; the operator approves it and
  the system executes + verifies on the next turn.
- If the NAS is unreachable, say so and diagnose from stored evidence
  (fetch_evidence still works — it reads the database, not the NAS).
- If you've already seen this evidence and nothing changed, do not re-chew: fetch
  more evidence, run a different diagnostic, widen scope, or ask the operator.`;

const NAS_TAXONOMY = `NAS issue families (from the detector): sharesync-metadata-corruption,
sharesync-api-invalid, drive-not-ready, sync-failure, sync-conflict,
thumbnail-extract-failure, backup-failure, rename-activity; sustained I/O
pressure (>=20% avg iowait, critical >=40%); correlated drive/hyperbackup churn +
snapshot cleanup + I/O.

Known DSM blind spots — never read empty as healthy:
- container_status CPU/mem always read 0 (use container_io instead);
- scheduled_tasks can return DSM error 103 on edgesynology1;
- some snapshot-replication APIs are unsupported;
- log-derived fields are regex-parsed (categorizations imperfect; raw text faithful).`;

const OUTPUT_SCHEMA = `When you have investigated enough for this turn, return ONLY a JSON object:
{
  "hypothesis": "current best explanation",
  "confidence": "high|medium|low",
  "severity": "critical|warning|info",
  "conversation_summary": "durable one-paragraph thread summary",
  "agent_message": "what to tell the operator this turn",
  "decision": "continue|propose_remediation|ask_user|blocked_on_issue|resolved|stuck",
  "remediation": {            // required iff decision=propose_remediation
    "command": "exact shell command",
    "tier": 2,                 // 2=service op, 3=file op
    "target": "edgesynology1",
    "summary": "what this changes",
    "reason": "why it's warranted now",
    "expected_outcome": "what success looks like",
    "rollback_plan": "how to undo",
    "risk": "low|medium|high"
  },
  "user_question": "one focused question",        // iff decision=ask_user
  "depends_on_issue_id": "uuid"                    // iff decision=blocked_on_issue
}
- decision=continue means you want another investigation turn.
- Do not narrate tool calls in agent_message; summarize findings.`;

// ─── Turn output ─────────────────────────────────────────────────────────────

interface TurnOutput {
  hypothesis?: string;
  confidence?: "high" | "medium" | "low";
  severity?: "critical" | "warning" | "info";
  conversation_summary?: string;
  agent_message?: string;
  decision?: "continue" | "propose_remediation" | "ask_user" | "blocked_on_issue" | "resolved" | "stuck";
  remediation?: {
    command?: string;
    tier?: number;
    target?: string;
    summary?: string;
    reason?: string;
    expected_outcome?: string;
    rollback_plan?: string;
    risk?: "low" | "medium" | "high";
  };
  user_question?: string;
  depends_on_issue_id?: string;
}

export interface Stage2TurnResult extends ApplyTurnResult {
  reChewed: boolean;
  toolCallCount: number;
}

// ─── Whole-system snapshot (semi-stable) ─────────────────────────────────────

export interface WholeSystemSnapshot {
  text: string;
  nasReachable: boolean;
}

export async function buildWholeSystemSnapshot(
  supabase: SupabaseClient,
  userId: string,
  issue: Issue,
): Promise<WholeSystemSnapshot> {
  const since6h = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const [{ data: activeAlerts }, { data: openIssues }] = await Promise.all([
    supabase.from("alerts").select("severity").eq("status", "active").gte("created_at", since6h),
    supabase
      .from("issues")
      .select("id, title, status, severity")
      .eq("user_id", userId)
      .in("status", ["open", "running", "waiting_on_user", "waiting_for_approval", "waiting_on_issue"]),
  ]);

  const alertBySeverity = countBy((activeAlerts ?? []) as Array<{ severity?: string }>, (a) => a.severity ?? "info");
  const siblings = ((openIssues ?? []) as Array<{ id: string; title: string; status: string; severity: string }>)
    .filter((i) => i.id !== issue.id)
    .slice(0, 12);

  const text = [
    "## Whole-system snapshot",
    `Active alerts (6h): ${Object.entries(alertBySeverity).map(([s, n]) => `${s}=${n}`).join(", ") || "none"}`,
    `Open/active issues: ${(openIssues ?? []).length}`,
    siblings.length
      ? `Sibling issues you may correlate with:\n${siblings.map((i) => `- [${i.status}/${i.severity}] ${i.title} (${i.id})`).join("\n")}`
      : "No sibling issues.",
  ].join("\n");

  return { text, nasReachable: true };
}

// ─── Tool catalog for Stage 2 ────────────────────────────────────────────────

/** Read-only tier-1 tools (write:false) + fetch_evidence, as model tool schemas. */
export function buildStage2Tools(): ToolSchema[] {
  const nasTools: ToolSchema[] = (Object.entries(TOOL_DEFINITIONS) as Array<[CopilotToolName, (typeof TOOL_DEFINITIONS)[CopilotToolName]]>)
    .filter(([, def]) => !def.write)
    .map(([name, def]) => ({
      name,
      description: def.description,
      input_schema: {
        type: "object",
        properties: {
          target: { type: "string", enum: ["edgesynology1", "edgesynology2"], description: "NAS to run on." },
          lookbackHours: { type: "number", description: "Lookback window in hours (where applicable)." },
          filter: { type: "string", description: "Search term (where applicable)." },
        },
      },
    }));
  return [
    {
      name: FETCH_EVIDENCE_TOOL.name,
      description: FETCH_EVIDENCE_TOOL.description,
      input_schema: FETCH_EVIDENCE_TOOL.parameters as Record<string, unknown>,
    },
    ...nasTools,
  ];
}

function makeToolExecutor(
  supabase: SupabaseClient,
  issue: Issue,
  record: { count: number; lastResults: string[]; nasReachable: boolean },
): ToolExecutor {
  const defaultTarget = (issue.affected_nas[0] as NasTarget | undefined) ?? "edgesynology1";

  return async (call) => {
    record.count += 1;

    if (call.name === FETCH_EVIDENCE_TOOL.name) {
      try {
        const params = { ...(call.input as Partial<FetchEvidenceParams>), issue_id: issue.id } as FetchEvidenceParams;
        const result = await fetchEvidence(supabase, params);
        const content = JSON.stringify(result).slice(0, 12_000);
        record.lastResults.push(content);
        return { content };
      } catch (err) {
        return { content: `fetch_evidence error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    }

    const def = TOOL_DEFINITIONS[call.name as CopilotToolName];
    if (!def || def.write) {
      return { content: `Tool "${call.name}" is not an available read-only tool.`, isError: true };
    }

    try {
      const target = ((call.input.target as string) || defaultTarget) as NasTarget;
      const config = resolveNasApiConfig(target);
      if (!config) return { content: `No NAS API config for ${target}.`, isError: true };

      const command = def.buildPreview(target, {
        lookbackHours: typeof call.input.lookbackHours === "number" ? call.input.lookbackHours : undefined,
        filter: typeof call.input.filter === "string" ? call.input.filter : undefined,
      });

      // Classify FIRST. Read-only investigation runs TIER 1 ONLY; anything higher
      // (or blocked) must go through the operator approval gate as a proposed
      // remediation — Stage 2 never auto-executes a tier-2/3 action (§3/§7).
      const preview = await withNasReachability(target, () => nasApiPreview(config, command));
      if (isNasUnreachable(preview)) {
        record.nasReachable = false;
        return { content: `NAS ${target} is unreachable (${preview.detail}). Diagnose from stored evidence via fetch_evidence.`, isError: true };
      }
      if (preview.blocked || preview.tier !== 1) {
        return {
          content:
            `"${call.name}" resolved to a tier-${preview.tier} command${preview.blocked ? " (blocked by the NAS validator)" : ""}, ` +
            `which is not auto-executable. Read-only investigation is tier-1 only. If a change — or a ` +
            `privileged read of a user-data path — is warranted, propose it as a remediation ` +
            `(decision=propose_remediation) so the operator can approve it. Command: ${command}`,
          isError: true,
        };
      }

      const exec = await withNasReachability(target, () => nasApiExec(config, command, 1, undefined, 30_000));
      if (isNasUnreachable(exec)) {
        record.nasReachable = false;
        return { content: `NAS ${target} is unreachable (${exec.detail}). Diagnose from stored evidence via fetch_evidence.`, isError: true };
      }

      const body = `$ ${command}\n${exec.stdout}${exec.stderr ? `\n[stderr] ${exec.stderr}` : ""}`.slice(0, 12_000);
      record.lastResults.push(body);

      // Persist the tool result into the lossless store so later turns can page it.
      await supabase.from("issue_evidence_items").insert({
        issue_id: issue.id,
        nas_id: target,
        source: `tool:${call.name}`,
        severity: exec.exit_code === 0 ? "info" : "error",
        ts: new Date().toISOString(),
        first_ts: new Date().toISOString(),
        last_ts: new Date().toISOString(),
        body,
        dedup_count: 1,
        in_scope: true,
        anomalous: exec.exit_code !== 0,
        metadata: { tool: call.name, target, exit_code: exec.exit_code },
      });

      return { content: body };
    } catch (err) {
      // Never throw out of the executor — a tool failure must return to the model
      // as a result it can react to, not crash the whole turn.
      return { content: `Tool "${call.name}" failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  };
}

// ─── The turn ────────────────────────────────────────────────────────────────

export async function runStage2Turn(
  supabase: SupabaseClient,
  userId: string,
  issue: Issue,
): Promise<Stage2TurnResult> {
  const meta = (issue.metadata ?? {}) as Record<string, unknown>;
  const turnCount = Number(meta.turn_count ?? 0);

  // Turn cap → terminate as stuck rather than loop forever.
  if (turnCount >= TURN_CAP) {
    const outcome: TurnOutcome = {
      kind: "done",
      verdict: "stuck",
      agentMessage:
        "Reached the investigation turn limit without a confident resolution. Stopping and flagging for operator review.",
    };
    const applied = await applyTurnOutcome(supabase, userId, issue, outcome);
    return { ...applied, reChewed: false, toolCallCount: 0 };
  }

  const [{ model, effort }, slice, snapshot, transcript] = await Promise.all([
    getReasoningConfig(),
    loadEvidenceSlice(supabase, issue.id),
    buildWholeSystemSnapshot(supabase, userId, issue),
    loadTranscript(supabase, userId, issue.id),
  ]);

  // Re-chew guard: hash the evidence signature; if identical to last turn, push
  // the model off re-chewing and toward "what's missing".
  const fingerprint = createHash("sha256").update(slice.text).digest("hex");
  const prevFingerprint = typeof meta.rechew_fingerprint === "string" ? meta.rechew_fingerprint : "";
  const repeatCount = fingerprint === prevFingerprint ? Number(meta.rechew_repeat ?? 0) + 1 : 0;
  const reChewing = repeatCount > 0;

  const instruction = reChewing
    ? `RE-CHEW GUARD: the evidence is unchanged since the last turn (repeat #${repeatCount}). ` +
      `Do NOT repeat the same analysis. Either fetch_evidence you haven't seen, run a DIFFERENT ` +
      `read-only diagnostic, widen scope to a sibling issue, propose a remediation, or ask the ` +
      `operator a specific question. If genuinely nothing more can be learned without operator ` +
      `input, decision=ask_user.`
    : `Investigate this issue. Use read-only tools as needed, then return the JSON turn output.`;

  const blocks: PromptBlock[] = [
    block.stable("system", SYSTEM_PROMPT),
    block.stable("output_schema", OUTPUT_SCHEMA),
    block.stable("taxonomy", NAS_TAXONOMY),
    block.semiStable("snapshot", snapshot.text),
    block.semiStable("issue", renderIssueSummary(issue)),
    block.dynamic("evidence", slice.text),
    block.dynamic("instruction", instruction),
  ];

  const record = { count: 0, lastResults: [] as string[], nasReachable: snapshot.nasReachable };
  const tools = buildStage2Tools();
  const executeTool = makeToolExecutor(supabase, issue, record);

  const result = await callModel({
    model,
    effort,
    blocks,
    messages: transcript,
    tools,
    executeTool,
    maxToolIterations: 8,
    maxTokens: MAX_OUTPUT_TOKENS,
    stage: "reasoning",
    issueId: issue.id,
  });

  let parsed: TurnOutput;
  try {
    parsed = parseJsonObject<TurnOutput>(result.text);
  } catch {
    parsed = { decision: "continue", agent_message: result.text.slice(0, 2_000) };
  }

  // Persist re-chew state for the next turn.
  await updateIssue(supabase, userId, issue.id, {
    metadata: { ...meta, turn_count: turnCount + 1, rechew_fingerprint: fingerprint, rechew_repeat: repeatCount },
  });

  const outcome = toTurnOutcome(parsed, { reChewing, repeatCount, defaultTarget: issue.affected_nas[0] });
  const applied = await applyTurnOutcome(supabase, userId, issue, outcome);
  return { ...applied, reChewed: reChewing, toolCallCount: record.count };
}

// ─── mapping + helpers ───────────────────────────────────────────────────────

export function toTurnOutcome(
  parsed: TurnOutput,
  ctx: { reChewing: boolean; repeatCount: number; defaultTarget?: string },
): TurnOutcome {
  const issuePatch: IssuePatch = {};
  if (parsed.hypothesis) issuePatch.current_hypothesis = parsed.hypothesis;
  if (parsed.confidence) issuePatch.hypothesis_confidence = parsed.confidence;
  if (parsed.severity) issuePatch.severity = parsed.severity;
  if (parsed.conversation_summary) issuePatch.conversation_summary = parsed.conversation_summary;

  const agentMessage = parsed.agent_message?.trim() || "(no message)";
  let decision = parsed.decision ?? "continue";

  // Re-chew backstop: if the model keeps wanting to "continue" on unchanged
  // evidence, force an operator question after 2 repeats so it can't loop.
  if (decision === "continue" && ctx.reChewing && ctx.repeatCount >= 2) {
    decision = "ask_user";
  }

  switch (decision) {
    case "propose_remediation": {
      const r = parsed.remediation ?? {};
      const tier = r.tier === 3 ? 3 : 2;
      const intent: ActionIntent = {
        kind: "remediation",
        tier,
        target: (r.target as NasTarget | undefined) ?? (ctx.defaultTarget as NasTarget | undefined) ?? null,
        toolName: "stage2_remediation",
        commandPreview: r.command ?? "",
        summary: r.summary ?? "",
        reason: r.reason ?? "",
        expectedOutcome: r.expected_outcome ?? "",
        rollbackPlan: r.rollback_plan,
        risk: r.risk ?? "medium",
      };
      if (!intent.commandPreview) {
        return { kind: "needs_user", agentMessage, question: "I intended to propose a fix but produced no command. What should I check next?", issuePatch };
      }
      return { kind: "needs_approval", agentMessage, intent, issuePatch };
    }
    case "ask_user":
      return { kind: "needs_user", agentMessage, question: parsed.user_question?.trim() || agentMessage, issuePatch };
    case "blocked_on_issue":
      return parsed.depends_on_issue_id
        ? { kind: "blocked_on_issue", agentMessage, dependsOnIssueId: parsed.depends_on_issue_id, issuePatch }
        : { kind: "needs_user", agentMessage, question: "I'm blocked on another issue but didn't identify which. Please advise.", issuePatch };
    case "resolved":
      return { kind: "done", agentMessage, verdict: "resolved", issuePatch };
    case "stuck":
      return { kind: "done", agentMessage, verdict: "stuck", issuePatch };
    case "continue":
    default:
      return { kind: "diagnostic", agentMessage, issuePatch };
  }
}

async function loadTranscript(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const { data } = await supabase
    .from("issue_messages")
    .select("role, content")
    .eq("issue_id", issueId)
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(60);

  return ((data ?? []) as Array<{ role: string; content: string }>).map((m) => ({
    role: m.role === "agent" ? "assistant" : "user",
    content: m.role === "system" ? `[system] ${m.content}` : m.content,
  }));
}

function renderIssueSummary(issue: Issue): string {
  return [
    "## This issue",
    `Title: ${issue.title}`,
    `Severity: ${issue.severity} · Status: ${issue.status}`,
    `Affected NAS: ${issue.affected_nas.join(", ") || "unknown"}`,
    issue.current_hypothesis ? `Current hypothesis (${issue.hypothesis_confidence ?? "?"}): ${issue.current_hypothesis}` : "",
    issue.summary ? `Summary: ${issue.summary}` : "",
    issue.operator_constraints.length ? `Operator constraints: ${issue.operator_constraints.join("; ")}` : "",
  ].filter(Boolean).join("\n");
}

function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}
