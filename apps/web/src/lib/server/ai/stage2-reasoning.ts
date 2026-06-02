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
 * This is the live loop body (the legacy runIssueAgent was removed); the worker
 * runs it for every issue via pipeline-v2's runIssueAgentV2.
 */

import { createHash } from "node:crypto";
import { getReasoningConfig } from "@/lib/server/ai-settings";
import {
  updateIssue,
  type Issue,
  type SupabaseClient,
} from "@/lib/server/issue-store";
import { type NasTarget } from "@/lib/server/tools";
import { ALL_TOOL_DEFS, findToolByName, toInputSchema } from "@synology-monitor/shared/nas-tools";
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
exact evidence that would confirm or kill it, and iterate — through a
curated, approval-gated tool layer.

Tool inventory (all auto-execute, tier-1 read-only):
- fetch_evidence: page or aggregate the lossless evidence store (DB). Aggregate
  first (group_by) to see the shape, then page into specifics. Works when NAS is offline.
- run_command: free-form read-only shell command on a NAS (cat, tail, head, grep,
  cat /proc/mdstat, cat /sys/block/md*/inflight, tail -n 200 /path/to/log.log, etc.).
  Use this when a predefined tool does not cover the file or command you need.
  Write commands are hard-blocked by the NAS validator.
- Predefined diagnostic tools: 100+ curated NAS read-only commands covering SMART,
  BTRFS, ShareSync, Docker, process/network/storage diagnostics. Prefer these over
  run_command when they cover the query.

Operating rules:
- Aggregate evidence first (fetch_evidence group_by) before paging into raw rows.
  Never assume a sparse/empty result means healthy.
- For raw log files and /proc//sys virtual files use run_command directly:
  "tail -n 100 /var/log/kern.log", "cat /proc/mdstat", "cat /sys/block/md5/inflight".
- You may NOT auto-execute service/file changes. When a fix is warranted, PROPOSE
  it as a remediation; the operator approves it; the system executes + verifies on
  the next turn.
- If the NAS is unreachable, say so and diagnose from stored evidence
  (fetch_evidence still works — it reads the database, not the NAS).
- If you've already seen this evidence and nothing changed, do not re-chew: fetch
  more evidence, run a different diagnostic, widen scope, or ask the operator.
- decision=continue is only valid after you actually called at least one tool in
  this turn. If you need more data, call the tool now; do not describe a future
  tool call in agent_message.`;

const NAS_TAXONOMY = `NAS issue families (from the detector): sharesync-metadata-corruption,
sharesync-api-invalid, drive-not-ready, sync-failure, sync-conflict,
thumbnail-extract-failure, backup-failure, rename-activity; sustained I/O
pressure (>=20% avg iowait, critical >=40%); correlated drive/hyperbackup churn +
snapshot cleanup + I/O.

## I/O wait diagnosis — interpretation rules

**First check /proc/mdstat.** An active RAID resync/check/rebuild writes 50-200 MB/s
sustained → 40-60% iowait is NORMAL and expected. check_io_stalls shows this.

**disk_io_stats fields:**
- util_pct ≥ 80%: device is saturated — this device IS the bottleneck.
- util_pct near 100%: every unit of iowait originates here. Nothing else needed.
- await_ms: HDD normal < 20 ms, loaded 20-100 ms, severe > 100 ms. SSD < 5 ms.
- queue_depth > 2-4 on HDDs: severe backpressure — requests queue faster than the disk drains.
- reads_ps / writes_ps: high writes + high await = write-intensive random I/O (worst for HDDs).

**Process state field:**
- state='D' (uninterruptible sleep): this process IS waiting for I/O right now.
  D-state processes are the direct cause of cpu_iowait_pct — they are not a symptom,
  they ARE the metric. Use check_process_io_detail to see wchan (kernel sleep function)
  and /proc/PID/stack (kernel call chain) to identify exactly what each D-state process
  is blocked on, without needing strace or special capabilities.

**Per-CPU iowait from check_cpu_iowait:**
- If iowait is concentrated on CPU-0 while others are low: all block I/O IRQs are
  routed to CPU-0. Check /proc/irq/*/affinity and /sys/block/*/queue/affinirq_hint.
  Rebalancing IRQ affinity across cores can cut total iowait in half.
- If all CPUs show similar iowait: the device is genuinely saturated.

**PSI /proc/pressure/io from check_psi_pressure:**
- 'some.avg10' > 10%: at least one task has been stalling on I/O over the last 10s.
- 'full.avg10' > 5%: ALL runnable tasks were stalled — complete I/O saturation.
  This is the single most definitive indicator of a real bottleneck vs. noisy iowait.

**Dirty page thresholds (vm.dirty_ratio, vm.dirty_background_ratio) from check_memory_detail:**
- Default dirty_ratio=20: kernel lets dirty pages grow to 20% of RAM, then stall-flushes
  everything at once → bursty iowait spike pattern. visible as sudden large iowait spikes
  that then drop to near zero, repeating on a cycle.
- Low dirty_ratio (5) + low dirty_background_ratio (3): continuous background flush,
  no burst spikes. Use set_vm_dirty_ratios to tune live; propose persist via sysctl.conf.

**NFS as iowait source:**
- If /proc/mounts shows nfs entries: a slow remote NFS server causes iowait
  indistinguishable from local disk saturation. check_nfs_client reads client RPC stats.
  High retrans count = NFS timeout/retry storm. Use ss to check NFS connection state.

**I/O scheduler (check_io_scheduler):**
- mq-deadline for HDDs/RAID: reduces seek storms, prioritizes latency.
- bfq on a RAID array: over-fairness causes seek amplification → high await.
- 'none' for SSDs: no reordering needed; cfq/bfq add latency for no gain.

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
- decision=continue is invalid unless you called at least one tool this turn.
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

async function probeNasReachable(nasName: string): Promise<boolean> {
  const config = resolveNasApiConfig(nasName);
  if (!config) return false;
  try {
    const response = await fetch(`${config.url}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function buildWholeSystemSnapshot(
  supabase: SupabaseClient,
  userId: string,
  issue: Issue,
): Promise<WholeSystemSnapshot> {
  const since6h = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const primaryNas = (issue.affected_nas[0] as string | undefined) ?? "edgesynology1";

  const [{ data: activeAlerts }, { data: openIssues }, nasReachable] = await Promise.all([
    supabase.from("alerts").select("severity").eq("status", "active").gte("created_at", since6h),
    supabase
      .from("issues")
      .select("id, title, status, severity")
      .eq("user_id", userId)
      .in("status", ["open", "running", "waiting_on_user", "waiting_for_approval", "waiting_on_issue"]),
    probeNasReachable(primaryNas),
  ]);

  const alertBySeverity = countBy((activeAlerts ?? []) as Array<{ severity?: string }>, (a) => a.severity ?? "info");
  const siblings = ((openIssues ?? []) as Array<{ id: string; title: string; status: string; severity: string }>)
    .filter((i) => i.id !== issue.id)
    .slice(0, 12);

  const text = [
    "## Whole-system snapshot",
    `NAS reachability: ${nasReachable ? `${primaryNas} ONLINE` : `${primaryNas} OFFLINE — use fetch_evidence for diagnosis`}`,
    `Active alerts (6h): ${Object.entries(alertBySeverity).map(([s, n]) => `${s}=${n}`).join(", ") || "none"}`,
    `Open/active issues: ${(openIssues ?? []).length}`,
    siblings.length
      ? `Sibling issues you may correlate with:\n${siblings.map((i) => `- [${i.status}/${i.severity}] ${i.title} (${i.id})`).join("\n")}`
      : "No sibling issues.",
  ].join("\n");

  return { text, nasReachable };
}

// ─── Tool catalog for Stage 2 ────────────────────────────────────────────────

const RUN_COMMAND_TOOL_NAME = "run_command";

/**
 * Read-only tools (write:false) from the SHARED catalog (§6) + fetch_evidence +
 * run_command (free-form tier-1 shell), as model tool schemas.
 */
export function buildStage2Tools(): ToolSchema[] {
  const nasTools: ToolSchema[] = ALL_TOOL_DEFS.filter((def) => !def.write).map((def) => {
    const schema = toInputSchema(def);
    const { target: _target, ...properties } = schema.properties;
    void _target;
    const required = (schema.required ?? []).filter((r) => r !== "target");
    return {
      name: def.name,
      description: def.description,
      input_schema: { type: "object", properties, ...(required.length ? { required } : {}) },
    };
  });
  return [
    {
      name: FETCH_EVIDENCE_TOOL.name,
      description: FETCH_EVIDENCE_TOOL.description,
      input_schema: FETCH_EVIDENCE_TOOL.parameters as Record<string, unknown>,
    },
    {
      name: RUN_COMMAND_TOOL_NAME,
      description:
        "Run any read-only shell command on a Synology NAS for deep diagnosis. " +
        "Use for raw log files (tail -n N /path/to/log), /proc virtual files (cat /proc/mdstat), " +
        "/sys gauges (cat /sys/block/md5/inflight), and diagnostic utilities not covered by " +
        "the predefined tools. Write commands are hard-blocked by the NAS validator.",
      input_schema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Read-only shell command to run, e.g. 'tail -n 100 /var/log/kern.log'",
          },
          target: {
            type: "string",
            enum: ["edgesynology1", "edgesynology2"],
            description: "Which NAS to run on",
          },
        },
        required: ["command", "target"],
      },
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

    if (call.name === RUN_COMMAND_TOOL_NAME) {
      const command = String(call.input.command ?? "").trim();
      if (!command) return { content: "run_command: command is required.", isError: true };

      const reqTarget = call.input.target;
      const target = (reqTarget === "edgesynology1" || reqTarget === "edgesynology2" ? reqTarget : defaultTarget) as NasTarget;
      const config = resolveNasApiConfig(target);
      if (!config) return { content: `No NAS API config for ${target}.`, isError: true };

      try {
        const preview = await withNasReachability(target, () => nasApiPreview(config, command));
        if (isNasUnreachable(preview)) {
          record.nasReachable = false;
          return { content: `NAS ${target} is unreachable (${preview.detail}). Diagnose from stored evidence via fetch_evidence.`, isError: true };
        }
        if (preview.blocked || preview.tier !== 1) {
          return {
            content:
              `run_command: "${command}" requires tier-${preview.tier}${preview.blocked ? " (hard-blocked by the NAS validator)" : ""}. ` +
              `Read-only investigation is tier-1 only. If a privileged action is warranted, propose it as a remediation.`,
            isError: true,
          };
        }

        const exec = await withNasReachability(target, () => nasApiExec(config, command, 1, undefined, 30_000));
        if (isNasUnreachable(exec)) {
          record.nasReachable = false;
          return { content: `NAS ${target} is unreachable. Diagnose from stored evidence via fetch_evidence.`, isError: true };
        }

        const body = `$ ${command}\n${exec.stdout}${exec.stderr ? `\n[stderr] ${exec.stderr}` : ""}`.slice(0, 12_000);
        record.lastResults.push(body);

        await supabase.from("issue_evidence_items").insert({
          issue_id: issue.id,
          nas_id: target,
          source: "tool:run_command",
          severity: exec.exit_code === 0 ? "info" : "error",
          ts: new Date().toISOString(),
          first_ts: new Date().toISOString(),
          last_ts: new Date().toISOString(),
          body,
          dedup_count: 1,
          in_scope: true,
          anomalous: exec.exit_code !== 0,
          metadata: { tool: "run_command", target, exit_code: exec.exit_code, command },
        });

        return { content: body };
      } catch (err) {
        return { content: `run_command failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    }

    const def = findToolByName(call.name);
    if (!def || def.write) {
      return { content: `Tool "${call.name}" is not an available read-only tool.`, isError: true };
    }

    try {
      const reqTarget = call.input.target;
      const target = (reqTarget === "edgesynology1" || reqTarget === "edgesynology2" ? reqTarget : defaultTarget) as NasTarget;
      const config = resolveNasApiConfig(target);
      if (!config) return { content: `No NAS API config for ${target}.`, isError: true };

      // buildCommand ignores target (routing is the executor's job); pass params through.
      const command = def.buildCommand(call.input);

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
      `input, decision=ask_user. Do not return decision=continue unless you actually call a tool ` +
      `in this turn.`
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

  const outcome = toTurnOutcome(parsed, {
    reChewing,
    repeatCount,
    toolCallCount: record.count,
    defaultTarget: issue.affected_nas[0],
  });
  const applied = await applyTurnOutcome(supabase, userId, issue, outcome);
  return { ...applied, reChewed: reChewing, toolCallCount: record.count };
}

// ─── mapping + helpers ───────────────────────────────────────────────────────

export function toTurnOutcome(
  parsed: TurnOutput,
  ctx: { reChewing: boolean; repeatCount: number; toolCallCount?: number; defaultTarget?: string },
): TurnOutcome {
  const issuePatch: IssuePatch = {};
  if (parsed.hypothesis) issuePatch.current_hypothesis = parsed.hypothesis;
  if (parsed.confidence) issuePatch.hypothesis_confidence = parsed.confidence;
  if (parsed.severity) issuePatch.severity = parsed.severity;
  if (parsed.conversation_summary) issuePatch.conversation_summary = parsed.conversation_summary;

  const agentMessage = parsed.agent_message?.trim() || "(no message)";
  let decision = parsed.decision ?? "continue";

  // A model sometimes says "ask_user" but only emits a progress sentence like
  // "now let me inspect X". Treat that as a diagnostic continuation; otherwise
  // the UI freezes on a non-question.
  const userQuestion = parsed.user_question?.trim() || "";
  if (decision === "ask_user" && !userQuestion && !looksLikeOperatorQuestion(agentMessage)) {
    decision = "continue";
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
    case "ask_user": {
      const question = userQuestion || agentMessage;
      const message = question === agentMessage ? agentMessage : `${agentMessage}\n\n${question}`;
      return { kind: "needs_user", agentMessage: message, question, issuePatch };
    }
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

function looksLikeOperatorQuestion(message: string): boolean {
  const text = message.trim().toLowerCase();
  if (text.includes("?")) return true;
  return /\b(confirm|which|what|who|where|when|should i|should we|do you want|can you|please provide|please confirm)\b/.test(text);
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
