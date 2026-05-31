/**
 * Stage 3 — Explainer / Memory (PLAN.md §3).
 *
 * Single-shot, cheap, low-effort. Consolidates the old explainer + memory
 * consolidation: it produces the operator-facing wrap-up message for a finished
 * investigation AND extracts durable agent_memory entries for next time. The
 * stable instruction/schema prefix caches across issues; only the issue context
 * is dynamic (§9.3).
 *
 * Dormant until the worker cutover (step 8) — nothing calls it yet.
 */

import { getExplainerConfig } from "@/lib/server/ai-settings";
import { appendIssueMessage, type Issue, type SupabaseClient } from "@/lib/server/issue-store";
import { parseJsonObject } from "@/lib/server/model-json";
import { callModel } from "./call-model";
import { block, type PromptBlock } from "./context-compiler";

const VALID_MEMORY_TYPES = new Set(["nas_profile", "issue_pattern", "calibration", "institutional"]);

const SYSTEM_PROMPT = `You write the closing operator update for a resolved Synology NAS investigation
and extract durable knowledge for future investigations. Be concrete and brief;
the operator is a non-developer who wants to know what happened, what was done,
and what (if anything) they should watch.`;

const OUTPUT_SCHEMA = `Return ONLY a JSON object:
{
  "operator_message": "2-5 sentence plain-language summary: what the issue was, the root cause, what was done or proposed, and any follow-up the operator should watch.",
  "memories": [
    {
      "nas_id": "edgesynology1" | null,   // null when the lesson is universal
      "subject": "ShareSync|BTRFS|HyperBackup|DSM|...|General",
      "memory_type": "issue_pattern|calibration|institutional|nas_profile",
      "title": "one-line label",
      "content": "2-4 sentences of durable, non-obvious knowledge (versions, exact paths, process names where relevant)",
      "tags": ["tag1", "tag2"]
    }
  ]
}
Only emit memories with specific, non-obvious, durable facts. If none, return "memories": [].`;

export interface AgentMemoryEntry {
  nas_id: string | null;
  subject: string;
  memory_type: string;
  title: string;
  content: string;
  tags: string[];
}

interface Stage3Output {
  operator_message?: string;
  memories?: AgentMemoryEntry[];
}

export interface Stage3Result {
  operatorMessage: string;
  memoriesStored: number;
}

export async function runStage3Explainer(
  supabase: SupabaseClient,
  userId: string,
  issue: Issue,
): Promise<Stage3Result> {
  const { model, effort } = await getExplainerConfig();

  const [{ data: evidence }, { data: actions }] = await Promise.all([
    supabase
      .from("issue_evidence_items")
      .select("source, severity, body, ts")
      .eq("issue_id", issue.id)
      .eq("in_scope", true)
      .order("ts", { ascending: false })
      .limit(30),
    supabase
      .from("issue_actions")
      .select("command_preview, summary, status, result_text")
      .eq("issue_id", issue.id)
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(20),
  ]);

  const contextText = JSON.stringify(
    {
      title: issue.title,
      severity: issue.severity,
      status: issue.status,
      affected_nas: issue.affected_nas,
      final_hypothesis: issue.current_hypothesis,
      conversation_summary: issue.conversation_summary,
      evidence_highlights: (evidence ?? []).map((e: Record<string, unknown>) => ({
        source: e.source,
        severity: e.severity,
        ts: e.ts,
        body: String(e.body ?? "").slice(0, 300),
      })),
      actions: (actions ?? []).map((a: Record<string, unknown>) => ({
        command: a.command_preview,
        summary: a.summary,
        status: a.status,
        result_excerpt: String(a.result_text ?? "").slice(0, 400),
      })),
    },
    null,
    2,
  );

  const blocks: PromptBlock[] = [
    block.stable("system", SYSTEM_PROMPT),
    block.stable("output_schema", OUTPUT_SCHEMA),
    block.dynamic("issue_context", `Resolved issue:\n${contextText}`),
  ];

  const result = await callModel({
    model,
    effort,
    blocks,
    json: true,
    maxTokens: 2_048,
    stage: "explainer",
    issueId: issue.id,
  });

  let parsed: Stage3Output;
  try {
    parsed = parseJsonObject<Stage3Output>(result.text);
  } catch {
    parsed = { operator_message: result.text.slice(0, 1_000), memories: [] };
  }

  const operatorMessage = parsed.operator_message?.trim() || "Investigation closed.";
  await appendIssueMessage(supabase, userId, issue.id, "agent", operatorMessage);

  const memoriesStored = await persistMemories(supabase, userId, issue, parsed.memories ?? []);
  return { operatorMessage, memoriesStored };
}

async function persistMemories(
  supabase: SupabaseClient,
  userId: string,
  issue: Issue,
  memories: AgentMemoryEntry[],
): Promise<number> {
  const rows = memories
    .filter((m) => m && m.title && m.content && VALID_MEMORY_TYPES.has(m.memory_type))
    .slice(0, 5)
    .map((m) => ({
      user_id: userId,
      nas_id: m.nas_id ?? null,
      subject: m.subject || "General",
      memory_type: m.memory_type,
      title: m.title,
      content: m.content,
      tags: Array.isArray(m.tags) ? m.tags : [],
      source_issue_id: issue.id,
    }));

  if (rows.length === 0) return 0;
  const { error } = await supabase.from("agent_memory").insert(rows);
  if (error) {
    // Memory is best-effort; never fail the close on a memory write.
    return 0;
  }
  return rows.length;
}
