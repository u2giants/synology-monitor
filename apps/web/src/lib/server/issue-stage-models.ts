import OpenAI from "openai";
import {
  getExplainerModel,
  getHypothesisModel,
  getPlannerModel,
  getRemediationPlannerModel,
  getVerifierModel,
} from "@/lib/server/ai-settings";
import { parseJsonObject } from "@/lib/server/model-json";
import type { CopilotToolName, NasTarget } from "@/lib/server/tools";
import type { IssueConfidence, IssueSeverity, IssueStatus } from "@/lib/server/issue-store";

export type ToolActionPlan = {
  tool_name: CopilotToolName;
  target: NasTarget;
  summary: string;
  reason: string;
  expected_outcome: string;
  rollback_plan?: string;
  risk?: "low" | "medium" | "high";
  filter?: string;
  lookback_hours?: number;
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
  blocked_tools: CopilotToolName[];
  evidence_notes: Array<{ title: string; detail: string }>;
  user_question: string | null;
  diagnostic_action: ToolActionPlan | null;
  remediation_action: ToolActionPlan | null;
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
  allowed_diagnostic_tools: Array<{ tool_name: string; description: string }>;
  allowed_remediation_tools: Array<{ tool_name: string; description: string }>;
}) {
  const model = await getPlannerModel();
  const prompt = `You are selecting the single best next step for one Synology NAS issue.

Return JSON only:
{
  "status": "running|waiting_on_user|waiting_for_approval|resolved|stuck",
  "next_step": "one-sentence next step",
  "constraints_to_add": ["new durable operator constraints"],
  "blocked_tools": ["tool names to suppress unless evidence changes"],
  "evidence_notes": [{"title":"", "detail":""}],
  "user_question": "one focused user question" or null,
  "diagnostic_action": {
    "tool_name": "check_drive_database",
    "target": "edgesynology1",
    "summary": "what to run",
    "reason": "why this is next",
    "expected_outcome": "what this should clarify",
    "filter": "",
    "lookback_hours": 2
  } or null,
  "remediation_action": {
    "tool_name": "remove_invalid_chars",
    "target": "edgesynology1",
    "summary": "what exact change to make",
    "reason": "why it is justified now",
    "expected_outcome": "what should improve",
    "rollback_plan": "how to revert",
    "risk": "low|medium|high",
    "filter": "/exact/path",
    "lookback_hours": 2
  } or null
}

Rules:
- Exactly one of user_question, diagnostic_action, remediation_action may be non-null.
- Never propose a remediation without an exact target.
- Never repeat a blocked or rejected action unless new evidence materially changes the case.
- If evidence is thin, prefer one discriminating diagnostic.
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
  allowed_remediation_tools: Array<{ tool_name: string; description: string }>;
}) {
  const model = await getRemediationPlannerModel();
  const prompt = `You are refining a single remediation candidate for one Synology NAS issue.

Return JSON only:
{
  "status": "running|waiting_on_user|waiting_for_approval|resolved|stuck",
  "next_step": "one-sentence next step",
  "constraints_to_add": ["new durable operator constraints"],
  "blocked_tools": ["tool names to suppress unless evidence changes"],
  "evidence_notes": [{"title":"", "detail":""}],
  "user_question": "one focused user question" or null,
  "diagnostic_action": null,
  "remediation_action": {
    "tool_name": "remove_invalid_chars",
    "target": "edgesynology1",
    "summary": "what exact change to make",
    "reason": "why it is justified now",
    "expected_outcome": "what should improve",
    "rollback_plan": "how to revert",
    "risk": "low|medium|high",
    "filter": "/exact/path",
    "lookback_hours": 2
  } or null
}

Rules:
- This stage exists only to refine or refuse remediation.
- Do not return a diagnostic action.
- If exact remediation is still unsafe, return remediation_action = null and user_question or blocked status.
- Never propose a remediation without an exact target.

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
