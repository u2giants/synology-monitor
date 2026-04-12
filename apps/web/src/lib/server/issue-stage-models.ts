import OpenAI from "openai";
import {
  getExtractorModel,
  getExplainerModel,
  getHypothesisModel,
  getPlannerModel,
  getRemediationPlannerModel,
  getVerifierModel,
} from "@/lib/server/ai-settings";
import { parseJsonObject } from "@/lib/server/model-json";
import type { IssueConfidence, IssueSeverity, IssueStatus } from "@/lib/server/issue-store";

export type ToolActionPlan = {
  /** Raw shell command to run on the NAS. */
  command: string;
  /** 1 = read-only (auto), 2 = service ops (approval), 3 = file ops (approval) */
  tier: 1 | 2 | 3;
  /** NAS name to run on (e.g. "edgesynology1"). Null if unknown — operator must supply. */
  target: string | null;
  summary: string;
  reason: string;
  expected_outcome: string;
  rollback_plan?: string;
  risk?: "low" | "medium" | "high";
};

export type HypothesisRankResult = {
  current_hypothesis: string;
  hypothesis_confidence: IssueConfidence;
  severity: IssueSeverity;
  affected_nas: string[];
  conversation_summary: string;
  supporting_evidence: string[];
  counter_evidence: string[];
  missing_evidence: string[];
};

export type NextStepPlanResult = {
  status: IssueStatus;
  next_step: string;
  constraints_to_add: string[];
  blocked_tools: string[];
  evidence_notes: Array<{ title: string; detail: string }>;
  user_question: string | null;
  diagnostic_action: ToolActionPlan | null;
  remediation_action: ToolActionPlan | null;
  /** ID of a sibling issue this issue is blocked by. If set, this investigation pauses until that issue resolves. */
  depends_on_issue_id: string | null;
};

export type OperatorExplanationResult = {
  response: string;
  summary: string;
};

export type VerificationResult = {
  outcome: "fixed" | "partial" | "failed" | "inconclusive";
  status: Extract<IssueStatus, "running" | "waiting_on_user" | "resolved" | "stuck">;
  summary: string;
  response: string;
  current_hypothesis: string;
  hypothesis_confidence: IssueConfidence;
  next_step: string;
  conversation_summary: string;
  evidence_notes: Array<{ title: string; detail: string }>;
};

function getOpenAIClient() {
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY or OPENAI_API_KEY is not configured.");
  }

  return new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
  });
}

async function callStageModel<T>(
  model: string,
  prompt: string,
) {
  const client = getOpenAIClient();
  const response = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    max_tokens: 2200,
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  return parseJsonObject<T>(raw);
}

export async function rankIssueHypothesis(input: {
  issue: object;
  recent_messages: Array<object>;
  recent_evidence: Array<object>;
  recent_actions: Array<object>;
  telemetry: object;
}) {
  const model = await getHypothesisModel();
  const prompt = `You are ranking the most likely hypothesis for one Synology NAS issue.

Return JSON only:
{
  "current_hypothesis": "best explanation",
  "hypothesis_confidence": "high|medium|low",
  "severity": "critical|warning|info",
  "affected_nas": ["edgesynology1"],
  "conversation_summary": "durable thread summary",
  "supporting_evidence": ["short supporting points"],
  "counter_evidence": ["short counterpoints"],
  "missing_evidence": ["what is still missing"]
}

Rules:
- Use normalized facts before raw logs when they conflict.
- If telemetry visibility is degraded, lower confidence.
- Do not propose tools or fixes here.
- Do not narrate phases.

Context:
${JSON.stringify(input, null, 2)}`;

  const parsed = await callStageModel<HypothesisRankResult>(model, prompt);
  return { model, parsed };
}

export async function planIssueNextStep(input: {
  issue: object;
  hypothesis: HypothesisRankResult;
  telemetry: object;
  recent_actions: Array<{ command: string; status: string; summary: string; result_text: string }>;
  completed_diagnostic_count: number;
}) {
  const model = await getPlannerModel();
  const prompt = `You are a Synology NAS expert selecting the single best next step for one issue.

You have full shell access to the affected NAS via a tiered execution API. Write the exact shell command you want to run.

Tier system:
- tier 1 (read-only): df, cat, ls, ps, dmesg, grep on logs, smartctl -A, btrfs status, find, sqlite3 SELECT, docker ps, etc. Auto-executes, no approval needed.
- tier 2 (service ops): docker start/stop/restart, synopkg restart, systemctl restart, docker compose up/down. Requires operator approval.
- tier 3 (file ops): mv, cp, rm, touch, or any write to /volume*. Requires operator approval.
Hard-blocked (never use): mkfs, fdisk, dd if=, rm -rf /, useradd/userdel/usermod, firmware flashing, apt/opkg install, umount /volume, shutdown/reboot/halt.

Return JSON only:
{
  "status": "running|waiting_on_user|waiting_for_approval|waiting_on_issue|resolved|stuck",
  "next_step": "one-sentence next step",
  "constraints_to_add": ["new durable operator constraints"],
  "blocked_tools": ["short labels for commands to suppress if already tried"],
  "evidence_notes": [{"title":"", "detail":""}],
  "user_question": "one focused user question" or null,
  "diagnostic_action": {
    "command": "df -h /volume1 && cat /proc/mdstat",
    "tier": 1,
    "target": "edgesynology1",
    "summary": "what this checks",
    "reason": "why this is next",
    "expected_outcome": "what this should clarify"
  } or null,
  "remediation_action": {
    "command": "/usr/syno/bin/synopkg restart SynologyDriveShareSync",
    "tier": 2,
    "target": "edgesynology1",
    "summary": "what exact change to make",
    "reason": "why it is justified now",
    "expected_outcome": "what should improve",
    "rollback_plan": "how to revert",
    "risk": "low|medium|high"
  } or null,
  "depends_on_issue_id": "uuid of sibling issue blocking this one" or null
}

ESCALATION RULES — check these before anything else:
1. If hypothesis_confidence is "high" AND completed_diagnostic_count >= 2: you MUST propose remediation_action or set status "waiting_on_user". Do NOT propose another diagnostic. The diagnosis is done.
2. If completed_diagnostic_count >= 6 regardless of confidence: force a final decision — remediation_action, one focused user_question, or status "stuck". No more diagnostics.
3. Never propose a command that already appears in recent_actions with status "completed" or "failed". Those are done.
4. If hypothesis already names a specific service restart or file operation AND confidence is medium or high: propose that as remediation_action now.
5. If the root cause is confirmed by direct evidence in recent_actions results: stop gathering evidence and escalate.

Additional rules:
- If the context includes sibling_issues and your hypothesis concludes this issue is DIRECTLY CAUSED BY or BLOCKED BY one of them (title/hypothesis match is clear and specific), set depends_on_issue_id to that issue's id and status to "waiting_on_issue". The investigation will pause and auto-resume when that issue resolves. Only use this when the dependency is unambiguous — not for loose correlation.
- Exactly one of user_question, diagnostic_action, remediation_action may be non-null. When depends_on_issue_id is set, all three must be null.
- CRITICAL: status "running" is ONLY valid when diagnostic_action is non-null with a concrete command. If you cannot commit to a specific shell command right now, use status "waiting_on_user" with a user_question. NEVER output status="running" with diagnostic_action=null — that strands the investigation.
- Never propose a remediation without an exact target (NAS name).
- When predefined knowledge is insufficient (e.g. /proc/<pid>/status, BTRFS snapshot state, upgrade logs, custom paths), use the exact shell command needed — you are not limited to a fixed tool list.
- Prefer composable commands: pipe grep/awk to extract the signal, avoid dumping gigabytes.
- If evidence is genuinely thin AND escalation rules do not apply, prefer one discriminating diagnostic.
- If you are blocked by operator knowledge, ask one focused question.

Context:
${JSON.stringify(input, null, 2)}`;

  const parsed = await callStageModel<NextStepPlanResult>(model, prompt);
  return { model, parsed };
}

export async function planIssueRemediation(input: {
  issue: object;
  hypothesis: HypothesisRankResult;
  plan: NextStepPlanResult;
  telemetry: object;
}) {
  const model = await getRemediationPlannerModel();
  const prompt = `You are refining a single remediation candidate for one Synology NAS issue.

Tier system for the command field:
- tier 2 (service ops): docker/synopkg/systemctl restarts. Requires operator approval.
- tier 3 (file ops): mv, cp, rm, writes to /volume*. Requires operator approval.

Return JSON only:
{
  "status": "running|waiting_on_user|waiting_for_approval|resolved|stuck",
  "next_step": "one-sentence next step",
  "constraints_to_add": ["new durable operator constraints"],
  "blocked_tools": ["short labels for commands to suppress"],
  "evidence_notes": [{"title":"", "detail":""}],
  "user_question": "one focused user question" or null,
  "diagnostic_action": null,
  "remediation_action": {
    "command": "/usr/syno/bin/synopkg restart SynologyDriveShareSync",
    "tier": 2,
    "target": "edgesynology1",
    "summary": "what exact change to make",
    "reason": "why it is justified now",
    "expected_outcome": "what should improve",
    "rollback_plan": "how to revert",
    "risk": "low|medium|high"
  } or null
}

Rules:
- This stage exists only to refine or refuse remediation.
- Do not return a diagnostic action.
- If exact remediation is still unsafe, return remediation_action = null and user_question or blocked status.
- Never propose a remediation without an exact target (NAS name).

Context:
${JSON.stringify(input, null, 2)}`;

  const parsed = await callStageModel<NextStepPlanResult>(model, prompt);
  return { model, parsed };
}

export async function explainIssueState(input: {
  issue: object;
  hypothesis: HypothesisRankResult;
  plan: NextStepPlanResult;
}) {
  const model = await getExplainerModel();
  const prompt = `You are writing the operator-facing response for one issue thread.

Return JSON only:
{
  "response": "concise operator-facing message",
  "summary": "short list-view summary"
}

Rules:
- Explain current belief.
- Say what changed this turn.
- State the one next thing that will happen or is needed.
- If visibility is degraded, say that plainly.
- Do not invent actions beyond the provided plan.

Context:
${JSON.stringify(input, null, 2)}`;

  const parsed = await callStageModel<OperatorExplanationResult>(model, prompt);
  return { model, parsed };
}

export async function verifyIssueAction(input: {
  issue: object;
  action: object;
  telemetry: object;
}) {
  const model = await getVerifierModel();
  const prompt = `You are verifying whether the latest remediation changed the issue.

Return JSON only:
{
  "outcome": "fixed|partial|failed|inconclusive",
  "status": "running|waiting_on_user|resolved|stuck",
  "summary": "short summary",
  "response": "operator-facing verification result",
  "current_hypothesis": "updated belief after the action",
  "hypothesis_confidence": "high|medium|low",
  "next_step": "one sentence next step",
  "conversation_summary": "updated durable summary",
  "evidence_notes": [{"title":"", "detail":""}]
}

Rules:
- Decide whether the action helped, partially helped, failed, or is inconclusive.
- Do not declare resolved unless the evidence really supports it.
- Prefer inconclusive over false confidence.

Context:
${JSON.stringify(input, null, 2)}`;

  const parsed = await callStageModel<VerificationResult>(model, prompt);
  return { model, parsed };
}

export type LogCompressionFact = {
  source: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  is_anomaly: boolean;
};

/**
 * Runs the extractor model (cheap/fast) over raw log rows from high-volume
 * sources. Returns compressed fact summaries so the expensive hypothesis and
 * planner models receive signal, not noise.
 *
 * Design: called once per tick, keys facts by source so they upsert in place.
 * At Mistral Small / Llama Scout prices this costs ~$0.001 per run on 80 rows.
 */
export async function compressLogsToFacts(input: {
  logs: Array<Record<string, unknown>>;
  audit_logs: Array<Record<string, unknown>>;
  nas_context: string;
}): Promise<{ model: string; facts: LogCompressionFact[] }> {
  const allLogs = [...(input.logs ?? []), ...(input.audit_logs ?? [])];
  if (allLogs.length === 0) return { model: "none", facts: [] };

  const model = await getExtractorModel();

  // Group by source so the model has structure to work with
  const bySource: Record<string, Array<Record<string, unknown>>> = {};
  for (const row of allLogs) {
    const src = String(row.source ?? "unknown");
    (bySource[src] ??= []).push(row);
  }

  // Slim each row to message + severity + timestamp only — no metadata blobs
  const slimmed: Record<string, Array<{ t: string; sev: string; msg: string }>> = {};
  for (const [src, rows] of Object.entries(bySource)) {
    slimmed[src] = rows.slice(0, 40).map((r) => ({
      t: String(r.ingested_at ?? r.logged_at ?? ""),
      sev: String(r.severity ?? "info"),
      msg: String(r.message ?? "").slice(0, 200),
    }));
  }

  const prompt = `You are a log analyst for a Synology NAS monitoring system (NAS: ${input.nas_context}).

You receive grouped log entries from multiple sources. For each source:
1. Identify the dominant recurring pattern (1 sentence — this is the baseline noise).
2. Flag ONLY entries that break the pattern as anomalies. An anomaly must meet at least one criterion:
   - Appears for the first time (not a repeat of earlier messages in this batch)
   - Contains a specific file path, PID, username, IP, or API name not seen before
   - Occurs at a timestamp that correlates with another source's anomaly
   - Indicates a state change (service went from ok → error, or an action was taken)

Return JSON only:
{
  "facts": [
    {
      "source": "system",
      "severity": "info|warning|critical",
      "title": "short title (max 80 chars)",
      "detail": "1-2 sentence summary. For anomalies: include exact timestamp, user, IP, or process name from the log.",
      "is_anomaly": true
    }
  ]
}

Rules:
- One fact per source for the baseline pattern summary (is_anomaly: false).
- One fact per distinct anomaly. Do not merge different anomalies into one.
- If a source has only recurring noise with zero anomalies, emit the pattern fact only.
- Do not invent details not present in the logs.
- Do not emit facts for sources with fewer than 2 entries unless the single entry is clearly anomalous.

Log data:
${JSON.stringify(slimmed, null, 2)}`;

  const parsed = await callStageModel<{ facts: LogCompressionFact[] }>(model, prompt);
  return { model, facts: Array.isArray(parsed.facts) ? parsed.facts : [] };
}

// ─── Agent memory consolidation ──────────────────────────────────────────────

export type AgentMemoryEntry = {
  nas_id: string | null;
  subject: string;
  memory_type: "nas_profile" | "issue_pattern" | "calibration" | "institutional";
  title: string;
  content: string;
  tags: string[];
};

/**
 * Runs the extractor model over a resolved issue to extract durable memories.
 * Called once after resolution — cheap model (extractor tier) since this runs
 * in the background and latency doesn't matter.
 *
 * Returns up to 5 memories covering: issue patterns, NAS-specific calibration,
 * version-specific behaviour, institutional Synology knowledge.
 */
export async function consolidateIssueMemory(input: {
  issue_id: string;
  title: string;
  summary: string;
  final_hypothesis: string;
  conversation_summary: string;
  affected_nas: string[];
  evidence_highlights: Array<{ title: string; detail: string }>;
  completed_actions: Array<{ command: string; summary: string; result_excerpt: string; status: string }>;
}): Promise<{ model: string; memories: AgentMemoryEntry[] }> {
  const model = await getExtractorModel();

  const prompt = `You are extracting durable knowledge from a resolved Synology NAS issue.

Extract up to 5 short, precise memories that would help a future agent facing a similar issue.
Focus on facts that are NOT obvious from standard Synology documentation and that will still be
valid weeks or months from now.

Good memory types:
- issue_pattern: "When X happens on Synology, the root cause is usually Y" — diagnostic fingerprints.
- calibration: "Normal baseline on this NAS is X for metric Y" — prevents false alarms next time.
- institutional: "Synology DSM <version> has behaviour Z" — version-specific or firmware-level facts.
- nas_profile: "This specific NAS has configuration/history X" — persistent NAS-specific state.

Subject must be one of: HyperBackup, BTRFS, RAID, ShareSync, SynologyDrive, Docker, SSL, DSM,
SMB, NFS, Network, Disk, Memory, CPU, Process, LogCenter, Security, ShareHealth,
SnapshotReplication, C2Backup, QuickConnect, VPN, Packages, StoragePool, Virtualization,
DDNS, ReverseProxy, SynologyPhotos, ActiveDirectory, iSCSI, Monitoring, General.
If none fit exactly, use General.

Return JSON only:
{
  "memories": [
    {
      "nas_id": "edgesynology1" or null,
      "subject": "HyperBackup",
      "memory_type": "issue_pattern",
      "title": "One-line label (max 100 chars)",
      "content": "2-4 sentences of durable knowledge. Include version numbers, exact paths, or process names when relevant.",
      "tags": ["tag1", "tag2"]
    }
  ]
}

Rules:
- Only emit memories that contain specific, actionable, non-obvious facts.
- Do not emit memories that just restate what happened — extract the generalizable lesson.
- nas_id should be the affected NAS name when the fact is NAS-specific; null when it applies universally.
- Omit memories that duplicate general Synology documentation.
- If no durable lesson can be extracted, return "memories": [].

Issue context:
${JSON.stringify(input, null, 2)}`;

  const parsed = await callStageModel<{ memories: AgentMemoryEntry[] }>(model, prompt);
  const memories = Array.isArray(parsed.memories) ? parsed.memories : [];
  return { model, memories };
}
