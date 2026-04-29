import {
  appendIssueEvidence,
  appendIssueMessage,
  createIssueAction,
  loadIssue,
  type IssueAction,
  type IssueFull,
  type IssueSeverity,
  type SupabaseClient,
  updateIssue,
  updateIssueAction,
} from "@/lib/server/issue-store";
import { listCapabilityState, upsertCapabilityState } from "@/lib/server/capability-store";
import { attachFactToIssue, deriveFactsFromTelemetry, listIssueFacts, upsertFact } from "@/lib/server/fact-store";
import { recordIssueStageRun } from "@/lib/server/issue-stage-store";
import {
  compressLogsToFacts,
  consolidateIssueMemory,
  explainIssueState,
  planIssueRemediation,
  planIssueNextStep,
  rankIssueHypothesis,
  verifyIssueAction,
  type ToolActionPlan,
  type HypothesisRankResult,
  type NextStepPlanResult,
} from "@/lib/server/issue-stage-models";
import {
  buildNasApiApprovalToken,
  collectNasDiagnostics,
  nasApiExec,
  resolveNasApiConfig,
} from "@/lib/server/nas-api-client";
import {
  getDeepModeModelOverride,
  getContextRebaseThresholdPct,
  getDeepModeIncludeRawLogs,
  getDeepModeMaxEvidence,
  getDeepModeMaxMessages,
  getDeepModeReasoningOverride,
  getEscalationIssueBudgetUsd,
  getEscalationPolicy,
  getEscalationTurnBudgetUsd,
  getPlannerModel,
  getPlannerReasoningEffort,
  type ModelReasoningEffort,
} from "@/lib/server/ai-settings";
import {
  classifyIssueSubjects,
  loadMemoriesForIssue,
  saveMemories,
} from "@/lib/server/agent-memory-store";
import { loadDriveForensics, buildDriveForensicFacts } from "@/lib/server/forensics-drive";
import { loadBackupCleanupTimeline, buildBackupTimelineFacts } from "@/lib/server/forensics-hyperbackup";
import {
  createIssueEscalationEvent,
  ensureIssueWorkingSession,
  getActiveIssueWorkingSession,
  listIssueEscalationEvents,
  listIssueTokenUsage,
  recordIssueTokenUsage,
  type IssueWorkingSession,
} from "@/lib/server/issue-investigation-store";
import {
  estimateOpenRouterCostUsd,
  findBestOpenRouterModelUpgrade,
  findOpenRouterModel,
} from "@/lib/server/openrouter-models";
import {
  estimateInvestigationSessionPressure,
  executeIssueContextRebase,
} from "@/lib/server/investigation-rebase";
import { getLocalAppIntrospectionSnapshot } from "@/lib/server/local-app-introspection";

const MAX_AGENT_CYCLES = 8;
const GUIDED_MESSAGE_WINDOW = 30;
const GUIDED_EVIDENCE_WINDOW = 60;
const GUIDED_ACTION_WINDOW = 25;
const HARD_CASE_MESSAGE_WINDOW = 80;
const HARD_CASE_EVIDENCE_WINDOW = 150;
const HARD_CASE_ACTION_WINDOW = 50;

type ContextWindowProfile = {
  messages: number;
  evidence: number;
  actions: number;
  rawLogRows: number;
  diagnosticChars: number;
  telemetryLimits: {
    alerts: number;
    noisyLogs: number;
    auditLogs: number;
    processSnapshots: number;
    diskStats: number;
    scheduledTasks: number;
    backupTasks: number;
    snapshotReplicas: number;
    containerIo: number;
    syncTasks: number;
    metrics: number;
    storageSnapshots: number;
    dsmErrors: number;
  };
};

type StageRuntimeOverride = {
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
};

function buildStageRuntimeSummary(input: {
  sessionId: string | null;
  mode: IssueWorkingSession["mode"];
  metadata?: { reasoning_effort?: string; model?: string };
  runtimeOverride?: StageRuntimeOverride;
}) {
  return {
    session_id: input.sessionId,
    session_mode: input.mode,
    effective_model: input.metadata?.model ?? null,
    effective_reasoning: input.metadata?.reasoning_effort ?? "auto",
    override_model_active: Boolean(input.runtimeOverride?.model),
    override_reasoning_active: Boolean(input.runtimeOverride?.reasoningEffort),
    override_model: input.runtimeOverride?.model ?? null,
    override_reasoning: input.runtimeOverride?.reasoningEffort ?? null,
  };
}

async function buildContextWindowProfile(
  state: IssueFull,
  mode: IssueWorkingSession["mode"],
): Promise<ContextWindowProfile> {
  if (mode === "deep") {
    return {
      messages: Math.max(await getDeepModeMaxMessages(), HARD_CASE_MESSAGE_WINDOW),
      evidence: Math.max(await getDeepModeMaxEvidence(), HARD_CASE_EVIDENCE_WINDOW),
      actions: HARD_CASE_ACTION_WINDOW,
      rawLogRows: await getDeepModeIncludeRawLogs() ? 160 : 40,
      diagnosticChars: 6000,
      telemetryLimits: {
        alerts: 30,
        noisyLogs: 180,
        auditLogs: 180,
        processSnapshots: 60,
        diskStats: 60,
        scheduledTasks: 40,
        backupTasks: 60,
        snapshotReplicas: 40,
        containerIo: 40,
        syncTasks: 40,
        metrics: 120,
        storageSnapshots: 40,
        dsmErrors: 80,
      },
    };
  }

  return getContextWindowProfile(state);
}

async function recordStageUsage(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
  sessionId: string | null,
  stageKey: string,
  modelName: string,
  usage: { input_tokens?: number; output_tokens?: number; reasoning_tokens?: number },
) {
  if (
    usage.input_tokens == null
    && usage.output_tokens == null
    && usage.reasoning_tokens == null
  ) {
    return;
  }

  const modelInfo = await findOpenRouterModel(modelName);
  const estimatedCost = estimateOpenRouterCostUsd(modelInfo?.pricing ?? null, usage);

  await recordIssueTokenUsage(supabase, userId, {
    issue_id: issueId,
    session_id: sessionId,
    stage_key: stageKey,
    model_name: modelName,
    input_tokens: usage.input_tokens ?? null,
    output_tokens: usage.output_tokens ?? null,
    reasoning_tokens: usage.reasoning_tokens ?? null,
    estimated_cost: estimatedCost,
  });
}

function getApprovedEscalationOverride(
  escalations: Awaited<ReturnType<typeof listIssueEscalationEvents>>,
  sessionId: string | null,
): StageRuntimeOverride {
  const approved = escalations.filter((event) => event.approved_by_user);
  const scoped = approved.filter((event) => event.session_id === sessionId || event.session_id == null);
  const latestReasoning = scoped.find((event) => event.kind === "higher_reasoning" && event.to_reasoning);
  const latestModel = scoped.find((event) => event.kind === "stronger_model" && event.to_model);

  return {
    model: latestModel?.to_model ?? undefined,
    reasoningEffort: (latestReasoning?.to_reasoning as ModelReasoningEffort | undefined) ?? undefined,
  };
}

async function estimateEscalationDeltaUsd(input: {
  recentUsage: Awaited<ReturnType<typeof listIssueTokenUsage>>;
  fromModel?: string | null;
  toModel?: string | null;
  fromReasoning?: string | null;
  toReasoning?: string | null;
}) {
  const recentUsages = input.recentUsage.slice(0, 8);
  const averageInputTokens = recentUsages.reduce((sum, item) => sum + (item.input_tokens ?? 0), 0) / Math.max(recentUsages.length, 1);
  const averageOutputTokens = recentUsages.reduce((sum, item) => sum + (item.output_tokens ?? 0), 0) / Math.max(recentUsages.length, 1);
  const averageReasoningTokens = recentUsages.reduce((sum, item) => sum + (item.reasoning_tokens ?? 0), 0) / Math.max(recentUsages.length, 1);

  if (!input.toModel && input.toReasoning && input.fromReasoning) {
    const baseCost = recentUsages[0]?.estimated_cost ?? 0;
    return Math.max(baseCost * 0.35, 0.01);
  }

  if (!input.toModel) return null;

  const [fromModelInfo, toModelInfo] = await Promise.all([
    input.fromModel ? findOpenRouterModel(input.fromModel) : Promise.resolve(null),
    findOpenRouterModel(input.toModel),
  ]);

  const fromCost = estimateOpenRouterCostUsd(fromModelInfo?.pricing ?? null, {
    input_tokens: averageInputTokens,
    output_tokens: averageOutputTokens,
    reasoning_tokens: averageReasoningTokens,
  }) ?? 0;
  const toCost = estimateOpenRouterCostUsd(toModelInfo?.pricing ?? null, {
    input_tokens: averageInputTokens,
    output_tokens: averageOutputTokens,
    reasoning_tokens: averageReasoningTokens,
  });

  if (toCost == null) return null;
  return Math.max(toCost - fromCost, 0);
}

async function shouldAutoApproveEscalation(input: {
  kind: "higher_reasoning" | "stronger_model";
  estimatedCost: number | null;
  currentIssueSpendUsd: number;
}) {
  const policy = await getEscalationPolicy();
  if (policy === "ask_always") return false;
  if (policy === "manual_for_model_switch_auto_for_reasoning" && input.kind === "stronger_model") return false;

  const turnBudget = await getEscalationTurnBudgetUsd();
  const issueBudget = await getEscalationIssueBudgetUsd();
  if (input.estimatedCost == null) return false;
  return input.estimatedCost <= turnBudget && input.currentIssueSpendUsd + input.estimatedCost <= issueBudget;
}

async function maybeProposeEscalation(
  supabase: SupabaseClient,
  userId: string,
  state: IssueFull,
  session: IssueWorkingSession,
  profile: ContextWindowProfile,
) {
  const recentEscalations = await listIssueEscalationEvents(supabase, userId, state.issue.id);
  const recentUsage = await listIssueTokenUsage(supabase, userId, state.issue.id);
  const issueSpendUsd = recentUsage.reduce((sum, entry) => sum + (entry.estimated_cost ?? 0), 0);
  const rebaseThreshold = await getContextRebaseThresholdPct();
  const pressure = estimateInvestigationSessionPressure({
    state,
    session,
    profile,
    rebaseThresholdPct: rebaseThreshold,
  });

  const hasPendingExpandedContext = recentEscalations.some((event) => event.kind === "expanded_context" && !event.approved_by_user);
  if (pressure.shouldRebase && !hasPendingExpandedContext) {
    const canAutoApproveReadOnly = await getEscalationPolicy() === "auto_approve_read_only_under_budget";
    const tradeoffReason = `Rebasing will preserve the full issue history but reset the active prompt around a scored investigation brief. Triggered because ${pressure.reasons.join("; ")}.`;
    if (canAutoApproveReadOnly) {
      await executeIssueContextRebase({
        supabase,
        userId,
        state,
        activeSession: session,
        reason: "auto_context_rebase",
        mode: session.mode,
        decisionReason: tradeoffReason,
      });
      await appendIssueMessage(
        supabase,
        userId,
        state.issue.id,
        "agent",
        "I automatically rebased this working session because your escalation policy allows read-only context resets. The full history is preserved, but the active prompt is now anchored around a tighter investigation brief so I can keep working without context drag.",
      );
      return "expanded_context" as const;
    }
    await createIssueEscalationEvent(supabase, userId, {
      issue_id: state.issue.id,
      session_id: session.id,
      kind: "expanded_context",
      from_model: null,
      to_model: null,
      from_reasoning: null,
      to_reasoning: null,
      estimated_cost: null,
      approved_by_user: false,
      decision_reason: tradeoffReason,
    });
    await updateIssue(supabase, userId, state.issue.id, {
      status: "waiting_on_user",
      next_step: "Approve a context rebase so the agent can continue with a fresh working session.",
    });
    await appendIssueMessage(
      supabase,
      userId,
      state.issue.id,
      "agent",
      `The active investigation context is getting crowded. Current pressure is ${pressure.promptPressurePct}% overall and ${pressure.sessionPressurePct}% inside this working session. Rebasing would keep the full history intact but reopen the active prompt around a tighter investigation brief, which should reduce wrapper drag and keep the next turns focused.\n\nUse the "Rebase context" button to approve that reset.`,
    );
    return "expanded_context" as const;
  }

  const hasPendingDeepMode = recentEscalations.some((event) => event.kind === "deep_mode_switch" && !event.approved_by_user);
  if (session.mode === "guided" && isHardCase(state) && !hasPendingDeepMode) {
    await createIssueEscalationEvent(supabase, userId, {
      issue_id: state.issue.id,
      session_id: session.id,
      kind: "deep_mode_switch",
      from_model: null,
      to_model: null,
      from_reasoning: "guided",
      to_reasoning: "deep",
      estimated_cost: null,
      approved_by_user: false,
      decision_reason: "The case is ambiguous enough that larger context and stronger reasoning would likely help.",
    });
    await updateIssue(supabase, userId, state.issue.id, {
      status: "waiting_on_user",
      next_step: "Switch to Deep investigation mode to give the agent a larger context and stronger reasoning budget.",
    });
    await appendIssueMessage(
      supabase,
      userId,
      state.issue.id,
      "agent",
      "This issue has become ambiguous enough that the guided workflow is now a liability. I recommend switching this thread to Deep investigation mode so I can use a larger working context, preserve more raw evidence, and spend more reasoning budget where it matters.",
    );
    return "deep_mode_switch" as const;
  }

  const runtimeOverride = getApprovedEscalationOverride(recentEscalations, session.id);
  const currentModel = runtimeOverride.model
    ?? (session.mode === "deep" ? (await getDeepModeModelOverride()) || await getPlannerModel() : await getPlannerModel());
  const currentReasoning = runtimeOverride.reasoningEffort
    ?? (session.mode === "deep" ? await getDeepModeReasoningOverride() : await getPlannerReasoningEffort());

  const hasPendingHigherReasoning = recentEscalations.some((event) => event.kind === "higher_reasoning" && !event.approved_by_user);
  if (
    state.issue.hypothesis_confidence === "low"
    && currentReasoning !== "high"
    && !hasPendingHigherReasoning
  ) {
    const estimatedCost = await estimateEscalationDeltaUsd({
      recentUsage,
      fromModel: currentModel,
      toModel: currentModel,
      fromReasoning: currentReasoning,
      toReasoning: "high",
    });
    const autoApprove = await shouldAutoApproveEscalation({
      kind: "higher_reasoning",
      estimatedCost,
      currentIssueSpendUsd: issueSpendUsd,
    });
    await createIssueEscalationEvent(supabase, userId, {
      issue_id: state.issue.id,
      session_id: session.id,
      kind: "higher_reasoning",
      from_model: currentModel,
      to_model: currentModel,
      from_reasoning: currentReasoning,
      to_reasoning: "high",
      estimated_cost: estimatedCost,
      approved_by_user: autoApprove,
      decision_reason: `Confidence is still low. Raising reasoning from ${currentReasoning} to high should improve synthesis without changing the tool boundary.${estimatedCost != null ? ` Estimated extra cost: about $${estimatedCost.toFixed(3)} for the next turn.` : ""}`,
    });
    if (autoApprove) {
      await appendIssueMessage(
        supabase,
        userId,
        state.issue.id,
        "system",
        "Escalation applied automatically: reasoning effort was raised to high for this working session because the configured budget policy allows it.",
      );
      return null;
    }
    await updateIssue(supabase, userId, state.issue.id, {
      status: "waiting_on_user",
      next_step: "Approve higher reasoning effort so the agent can spend more thought budget on this issue.",
    });
    await appendIssueMessage(
      supabase,
      userId,
      state.issue.id,
      "agent",
      `I recommend increasing reasoning effort from ${currentReasoning} to high before I continue. This changes thought budget, not tool scope or write permissions, so the main tradeoff is latency and token cost rather than operational risk.${estimatedCost != null ? ` Estimated extra cost for the next turn: about $${estimatedCost.toFixed(3)}.` : ""}`,
    );
    return "higher_reasoning" as const;
  }

  const hasPendingStrongerModel = recentEscalations.some((event) => event.kind === "stronger_model" && !event.approved_by_user);
  if (
    session.mode === "deep"
    && state.issue.hypothesis_confidence === "low"
    && currentReasoning === "high"
    && !hasPendingStrongerModel
  ) {
    const upgrade = await findBestOpenRouterModelUpgrade({ currentModelId: currentModel, minCapabilityDelta: 1 });
    if (upgrade) {
      const estimatedCost = await estimateEscalationDeltaUsd({
        recentUsage,
        fromModel: currentModel,
        toModel: upgrade.model.id,
        fromReasoning: currentReasoning,
        toReasoning: currentReasoning,
      });
      const autoApprove = await shouldAutoApproveEscalation({
        kind: "stronger_model",
        estimatedCost,
        currentIssueSpendUsd: issueSpendUsd,
      });
      await createIssueEscalationEvent(supabase, userId, {
        issue_id: state.issue.id,
        session_id: session.id,
        kind: "stronger_model",
        from_model: currentModel,
        to_model: upgrade.model.id,
        from_reasoning: currentReasoning,
        to_reasoning: currentReasoning,
        estimated_cost: estimatedCost,
        approved_by_user: autoApprove,
        decision_reason: `Current model is still not separating the competing explanations cleanly. ${upgrade.model.name} is the strongest better-value upgrade above the current capability tier.${estimatedCost != null ? ` Estimated extra cost: about $${estimatedCost.toFixed(3)} for the next turn.` : ""}`,
      });
      if (autoApprove) {
        await appendIssueMessage(
          supabase,
          userId,
          state.issue.id,
          "system",
          `Escalation applied automatically: model upgraded from ${currentModel} to ${upgrade.model.id} for this working session because the configured budget policy allows it.`,
        );
        return null;
      }
      await updateIssue(supabase, userId, state.issue.id, {
        status: "waiting_on_user",
        next_step: `Approve a stronger model for this working session (${upgrade.model.id}).`,
      });
      await appendIssueMessage(
        supabase,
        userId,
        state.issue.id,
        "agent",
        `I recommend switching this working session from ${currentModel} to ${upgrade.model.id}. The current model is still not separating the competing explanations cleanly, and this is the best-value upgrade above the current capability tier. This does not change the tool boundary, but it does trade money and some latency for better synthesis.${estimatedCost != null ? ` Estimated extra cost for the next turn: about $${estimatedCost.toFixed(3)}.` : ""}`,
      );
      return "stronger_model" as const;
    }
  }

  return null;
}

function isHardCase(state: IssueFull) {
  const failedOrRejectedActions = state.actions.filter((action) => action.status === "failed" || action.status === "rejected").length;
  const completedDiagnostics = state.actions.filter((action) => action.kind === "diagnostic" && action.status === "completed").length;
  const repeatedStall = state.issue.status === "stuck" || state.issue.status === "waiting_on_user";
  return (
    state.issue.hypothesis_confidence === "low"
    || failedOrRejectedActions >= 2
    || completedDiagnostics >= 3
    || repeatedStall
    || state.messages.length >= GUIDED_MESSAGE_WINDOW
  );
}

function getContextWindowProfile(state: IssueFull): ContextWindowProfile {
  if (isHardCase(state)) {
    return {
      messages: HARD_CASE_MESSAGE_WINDOW,
      evidence: HARD_CASE_EVIDENCE_WINDOW,
      actions: HARD_CASE_ACTION_WINDOW,
      rawLogRows: 80,
      diagnosticChars: 4000,
      telemetryLimits: {
        alerts: 20,
        noisyLogs: 120,
        auditLogs: 120,
        processSnapshots: 40,
        diskStats: 40,
        scheduledTasks: 30,
        backupTasks: 50,
        snapshotReplicas: 30,
        containerIo: 25,
        syncTasks: 25,
        metrics: 80,
        storageSnapshots: 30,
        dsmErrors: 60,
      },
    };
  }

  return {
    messages: GUIDED_MESSAGE_WINDOW,
    evidence: GUIDED_EVIDENCE_WINDOW,
    actions: GUIDED_ACTION_WINDOW,
    rawLogRows: 24,
    diagnosticChars: 1500,
    telemetryLimits: {
      alerts: 12,
      noisyLogs: 60,
      auditLogs: 80,
      processSnapshots: 20,
      diskStats: 20,
      scheduledTasks: 20,
      backupTasks: 30,
      snapshotReplicas: 20,
      containerIo: 15,
      syncTasks: 15,
      metrics: 40,
      storageSnapshots: 20,
      dsmErrors: 30,
    },
  };
}

function buildRawLogExcerpts(
  logs: Array<Record<string, unknown>>,
  auditLogs: Array<Record<string, unknown>>,
  maxRows: number,
) {
  const rows = [...auditLogs, ...logs].slice(0, maxRows);
  return rows.map((row) => ({
    source: String(row.source ?? "unknown"),
    severity: String(row.severity ?? "info"),
    at: String(row.ingested_at ?? row.logged_at ?? ""),
    message: String(row.message ?? "").slice(0, 400),
    metadata: row.metadata ?? {},
  }));
}

// Keep only the most recent row per unique field value (e.g. per task_id).
function dedupeLatestByField<T extends Record<string, unknown>>(items: T[], field: keyof T): T[] {
  const seen = new Set<unknown>();
  return items.filter((item) => {
    const key = item[field];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectResult<T>(
  label: string,
  result: { data: T[] | null; error: { message: string } | null },
  telemetryErrors: string[],
) {
  if (result.error) {
    telemetryErrors.push(`${label}: ${result.error.message}`);
    return [] as T[];
  }
  return result.data ?? [];
}

async function resolveNasUnitIds(
  supabase: SupabaseClient,
  nasNames: string[],
) {
  if (nasNames.length === 0) return [] as Array<{ id: string; name: string; hostname: string | null }>;

  // NAS names come from the hypothesis model (LLM-supplied). Restrict to a
  // safe character set before letting them flow into the PostgREST .or()
  // filter grammar; otherwise a name containing "," or ".eq." can break
  // out of the predicate and match unintended rows.
  const safeNames = nasNames.filter((nas) => /^[A-Za-z0-9._-]+$/.test(nas));

  if (safeNames.length === 0) {
    return [] as Array<{ id: string; name: string; hostname: string | null }>;
  }

  const { data, error } = await supabase
    .from("nas_units")
    .select("id, name, hostname")
    .or([
      ...safeNames.map((nas) => `name.eq.${nas}`),
      ...safeNames.map((nas) => `hostname.eq.${nas}`),
    ].join(","));

  if (error) {
    throw new Error(`Failed to resolve NAS units: ${error.message}`);
  }

  return (data ?? []) as Array<{ id: string; name: string; hostname: string | null }>;
}

async function syncTelemetryCapabilities(
  supabase: SupabaseClient,
  userId: string,
  issue: IssueFull["issue"],
  telemetry: Record<string, unknown>,
) {
  const startedAt = new Date().toISOString();
  const nasUnits = await resolveNasUnitIds(supabase, issue.affected_nas);
  if (nasUnits.length === 0) {
    await recordIssueStageRun(supabase, userId, issue.id, {
      stageKey: "capability_refresh",
      status: "skipped",
      modelTier: "deterministic",
      inputSummary: { affected_nas: issue.affected_nas },
      output: { reason: "no_resolved_nas_units" },
      startedAt,
    });
    return [];
  }

  const telemetryErrors = Array.isArray(telemetry.telemetry_errors) ? telemetry.telemetry_errors as string[] : [];
  const capabilities = [
    { key: "can_list_scheduled_tasks", label: "scheduled_tasks_with_issues" },
    { key: "can_list_hyperbackup_tasks", label: "backup_tasks" },
    { key: "can_list_snapshot_replication", label: "snapshot_replicas" },
    { key: "can_read_container_io", label: "container_io_top" },
    { key: "can_read_issue_telemetry", label: "logs" },
  ] as const;

  for (const nas of nasUnits) {
    for (const capability of capabilities) {
      const matchingError = telemetryErrors.find((entry) => entry.startsWith(`${capability.label}:`));
      await upsertCapabilityState(supabase, {
        nasId: nas.id,
        capabilityKey: capability.key,
        state: matchingError ? "degraded" : "supported",
        sourceKind: "issue_worker",
        evidence: matchingError ? "Telemetry query failed during issue run." : "Telemetry query succeeded during issue run.",
        rawError: matchingError ?? null,
        metadata: {
          issue_id: issue.id,
          issue_title: issue.title,
        },
      });
    }
  }

  const state = await listCapabilityState(supabase, nasUnits.map((nas) => nas.id));
  await recordIssueStageRun(supabase, userId, issue.id, {
    stageKey: "capability_refresh",
    status: "completed",
    modelTier: "deterministic",
    inputSummary: { affected_nas: issue.affected_nas, telemetry_error_count: telemetryErrors.length },
    output: { capability_count: state.length },
    startedAt,
  });
  return state;
}

async function syncIssueFacts(
  supabase: SupabaseClient,
  userId: string,
  state: IssueFull,
  telemetry: Record<string, unknown>,
) {
  const startedAt = new Date().toISOString();

  // 1. Deterministic rule-based facts (thresholds, status checks)
  const derivedFacts = deriveFactsFromTelemetry(state.issue, telemetry);
  for (const fact of derivedFacts) {
    const factId = await upsertFact(supabase, fact);
    await attachFactToIssue(supabase, userId, state.issue.id, factId);
  }

  // 2. Model-driven log compression (cheap extractor model).
  //    Turns raw log rows into pattern summaries and anomaly facts so the
  //    expensive hypothesis/planner models never see the raw noise.
  const nasContext = state.issue.affected_nas[0] ?? "unknown";
  let compressedFactCount = 0;
  let compressorModel = "none";
  try {
    const { model, facts: logFacts } = await compressLogsToFacts({
      logs: Array.isArray(telemetry.logs) ? telemetry.logs as Array<Record<string, unknown>> : [],
      audit_logs: Array.isArray(telemetry.audit_logs) ? telemetry.audit_logs as Array<Record<string, unknown>> : [],
      nas_context: nasContext,
    });
    compressorModel = model;

    for (const lf of logFacts) {
      const factId = await upsertFact(supabase, {
        nasId: nasContext,
        factType: lf.is_anomaly ? "log_anomaly" : "log_pattern",
        // Key by source so pattern facts upsert in place each tick;
        // anomaly keys include title hash to preserve distinct events.
        factKey: lf.is_anomaly
          ? `log-anomaly:${nasContext}:${lf.source}:${lf.title.slice(0, 60).replace(/\s+/g, "-").toLowerCase()}`
          : `log-pattern:${nasContext}:${lf.source}`,
        severity: lf.severity,
        title: lf.title,
        detail: lf.detail,
        value: { source: lf.source, is_anomaly: lf.is_anomaly },
      });
      await attachFactToIssue(supabase, userId, state.issue.id, factId);
      compressedFactCount++;
    }
  } catch (err) {
    // Non-fatal — deterministic facts still available
    console.error("[syncIssueFacts] log compressor failed:", err);
  }

  // 3. Forensic Drive attribution and delete/rename classification.
  //    Only runs when there is evidence of Drive churn in recent logs.
  let forensicDriveFactCount = 0;
  try {
    const driveChurnInLogs = (
      Array.isArray(telemetry.logs) ? telemetry.logs as Array<Record<string, unknown>> : []
    ).some((row) => row.source === "drive_churn_signal" || row.source === "drive_client_attribution");

    if (driveChurnInLogs || state.issue.affected_nas.length > 0) {
      const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      const { attribution, eventSummary } = await loadDriveForensics(
        supabase,
        state.issue.affected_nas,
        since48h,
      );

      const nasId = nasContext;
      const attrForNas = attribution.find((a) => a.nas_id.includes(nasId) || nasId.includes(a.nas_id));
      const summaryForNas = eventSummary.find((s) => s.nas_id.includes(nasId) || nasId.includes(s.nas_id));

      const driveFacts = buildDriveForensicFacts(nasId, attrForNas, summaryForNas);
      for (const fact of driveFacts) {
        const factId = await upsertFact(supabase, fact);
        await attachFactToIssue(supabase, userId, state.issue.id, factId);
        forensicDriveFactCount++;
      }
    }
  } catch (err) {
    console.error("[syncIssueFacts] drive forensics failed:", err);
  }

  // 4. Forensic Hyper Backup cleanup timeline.
  //    Only runs when backup tasks are in scope and there is evidence of issues.
  let forensicBackupFactCount = 0;
  try {
    const backupTasksInTelemetry = Array.isArray(telemetry.backup_tasks)
      ? telemetry.backup_tasks as Array<Record<string, unknown>>
      : [];
    const hasBackupActivity =
      backupTasksInTelemetry.length > 0 ||
      state.issue.title.toLowerCase().includes("backup") ||
      state.issue.title.toLowerCase().includes("hyper");

    if (hasBackupActivity && state.issue.affected_nas.length > 0) {
      for (const nasName of state.issue.affected_nas) {
        try {
          const timeline = await loadBackupCleanupTimeline(nasName);
          if (timeline) {
            const backupFacts = buildBackupTimelineFacts(nasContext, timeline);
            for (const fact of backupFacts) {
              const factId = await upsertFact(supabase, fact);
              await attachFactToIssue(supabase, userId, state.issue.id, factId);
              forensicBackupFactCount++;
            }
          }
        } catch (err) {
          console.error(`[syncIssueFacts] backup timeline failed for ${nasName}:`, err);
        }
      }
    }
  } catch (err) {
    console.error("[syncIssueFacts] backup forensics failed:", err);
  }

  const facts = await listIssueFacts(supabase, userId, state.issue.id);
  await recordIssueStageRun(supabase, userId, state.issue.id, {
    stageKey: "fact_refresh",
    status: "completed",
    modelTier: "deterministic",
    inputSummary: {
      derived_fact_count: derivedFacts.length,
      compressed_log_fact_count: compressedFactCount,
      forensic_drive_fact_count: forensicDriveFactCount,
      forensic_backup_fact_count: forensicBackupFactCount,
    },
    output: { attached_fact_count: facts.length, compressor_model: compressorModel },
    startedAt,
  });
  return facts;
}

async function gatherTelemetryContext(supabase: SupabaseClient, userId: string, issue: IssueFull["issue"]) {
  const since6h = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const since30m = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const nasFilter = issue.affected_nas.length > 0 ? issue.affected_nas : null;

  // Kick off memory loading in parallel with telemetry queries.
  // Classified by subject so only relevant topics are loaded.
  const memoriesPromise = loadMemoriesForIssue(
    supabase,
    userId,
    classifyIssueSubjects(issue),
    issue.affected_nas.length > 0 ? issue.affected_nas : undefined,
  );

  const [
    alertsResult,
    logsResult,
    storageLogsResult,
    processResult,
    diskResult,
    scheduledTasksResult,
    backupTasksResult,
    snapshotReplicasResult,
    containerIOResult,
    syncTasksResult,
    ioMetricsResult,
    storageSnapshotsResult,
    dsmErrorsResult,
  ] = await Promise.all([
    supabase
      .from("alerts")
      .select("id, source, severity, title, message, created_at")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(12),

    // Noisy polling sources (share_config, package_health, drive_server,
    // dsm_system_log, backup) — warning+ only, 6h.  At info level these emit
    // hundreds of routine enumeration rows per hour that add no diagnostic
    // signal and fill the context window.
    supabase
      .from("nas_logs")
      .select("id, nas_id, source, severity, message, metadata, ingested_at")
      .gte("ingested_at", since6h)
      .in("severity", ["critical", "error", "warning"])
      .not("source", "in", '("system","storage","scheduled_task","share_quota","share_health")')
      .order("ingested_at", { ascending: false })
      .limit(60),

    // High-signal sources — all severities (including info), 48h window.
    // - system: SSH logins, DSM API authentications, invoked errors.
    //   These are info-level but are the triggering events for anomalous
    //   host-level processes (e.g. a curl-to-DSM auth 34s before rogue greps
    //   start is invisible if info is filtered).
    // - storage: RAID state changes, replication — relevant even when healthy.
    // - scheduled_task: task completions are info-level but form the trigger
    //   trail for scripts that spawn child processes.
    // - share_quota / share_health: low volume, all severities useful.
    supabase
      .from("nas_logs")
      .select("id, nas_id, source, severity, message, metadata, ingested_at")
      .gte("ingested_at", since48h)
      .in("source", ["system", "storage", "scheduled_task", "share_quota", "share_health"])
      .order("ingested_at", { ascending: false })
      .limit(80),

    supabase
      .from("process_snapshots")
      // cmdline and pid are essential: without them the agent sees "grep" but
      // not what it's scanning for, making foreign/stuck processes invisible.
      // read_bps surfaces I/O-heavy processes that don't show up in CPU ranking.
      .select("nas_id, captured_at, pid, name, cmdline, username, cpu_pct, mem_pct, read_bps, write_bps, parent_service")
      .gte("captured_at", since6h)
      .order("captured_at", { ascending: false })
      .limit(20),

    supabase
      .from("disk_io_stats")
      .select("nas_id, captured_at, device, read_bps, write_bps, await_ms, util_pct")
      .gte("captured_at", since6h)
      .order("captured_at", { ascending: false })
      .limit(20),

    supabase
      .from("scheduled_tasks")
      .select("nas_id, task_id, task_name, task_type, owner, enabled, status, last_run_time, next_run_time, last_result, captured_at")
      .gte("captured_at", since48h)
      .or("last_result.neq.0,status.eq.error")
      .order("captured_at", { ascending: false })
      .limit(20),

    supabase
      .from("backup_tasks")
      .select("nas_id, task_id, task_name, enabled, status, last_result, last_run_time, next_run_time, dest_type, dest_name, total_bytes, transferred_bytes, speed_bps, captured_at")
      .gte("captured_at", since6h)
      .order("captured_at", { ascending: false })
      .limit(30),

    supabase
      .from("snapshot_replicas")
      .select("nas_id, task_id, task_name, status, src_share, dst_share, dst_host, last_result, last_run_time, next_run_time, captured_at")
      .gte("captured_at", since6h)
      .order("captured_at", { ascending: false })
      .limit(20),

    supabase
      .from("container_io")
      .select("nas_id, captured_at, container_name, read_bps, write_bps, read_ops, write_ops")
      .gte("captured_at", since30m)
      .order("write_bps", { ascending: false })
      .limit(15),

    supabase
      .from("sync_task_snapshots")
      .select("nas_id, captured_at, task_id, task_name, status, backlog_count, backlog_bytes, current_file, retry_count, last_error, speed_bps")
      .gte("captured_at", since6h)
      .order("captured_at", { ascending: false })
      .limit(15),

    supabase
      .from("metrics")
      .select("nas_id, type, value, unit, metadata, recorded_at")
      .gte("recorded_at", since30m)
      .in("type", [
        "cpu_iowait_pct",
        "hyperbackup_last_new_files",
        "hyperbackup_last_removed_files",
        "hyperbackup_last_renamed_files",
        "hyperbackup_last_copy_miss_files",
        "drive_log_rename_hits",
        "drive_log_delete_hits",
        "drive_log_move_hits",
        "drive_log_conflict_hits",
        "drive_log_connect_hits",
        "drive_log_disconnect_hits",
        "drive_log_mac_hits",
        "nfs_read_bps", "nfs_write_bps", "nfs_calls_ps",
        "vm_pgpgout_ps", "vm_swap_out_ps", "vm_swap_in_ps",
      ])
      .order("recorded_at", { ascending: false })
      .limit(40),

    // Structured DSM volume/RAID state — the authoritative source for storage
    // health.  Includes status (normal/degraded/crashed), raid_type, and disk
    // member details.  48h window so recovery context is preserved.
    supabase
      .from("storage_snapshots")
      .select("nas_id, volume_id, volume_path, total_bytes, used_bytes, status, raid_type, disks, recorded_at")
      .gte("recorded_at", since48h)
      .order("recorded_at", { ascending: false })
      .limit(20),

    // DSM Log Center errors — warning/error events from the NAS OS itself,
    // separate from the high-volume smon_logs stream.
    supabase
      .from("dsm_errors")
      .select("nas_id, level, message, who, log_name, logged_at, created_at")
      .gte("logged_at", since48h)
      .order("logged_at", { ascending: false })
      .limit(30),
  ]);

  const telemetry_errors: string[] = [];

  const alerts = collectResult("alerts", alertsResult, telemetry_errors);
  const logs = collectResult("logs", logsResult, telemetry_errors).filter((row) => {
    if (!nasFilter?.length) return true;
    const nasValue = typeof row.nas_id === "string" ? row.nas_id : "";
    return nasFilter.some((nas) => nasValue.includes(nas) || String((row.metadata as Record<string, unknown> | null)?.nas_name ?? "").includes(nas));
  });

  // High-signal logs (system, storage, scheduled_task, share_quota/health)
  // with 48h window and all severities — apply same NAS filter as general logs.
  const audit_logs = collectResult("audit_logs", storageLogsResult, telemetry_errors).filter((row) => {
    if (!nasFilter?.length) return true;
    const nasValue = typeof row.nas_id === "string" ? row.nas_id : "";
    return nasFilter.some((nas) => nasValue.includes(nas) || String((row.metadata as Record<string, unknown> | null)?.nas_name ?? "").includes(nas));
  });

  // Sibling issues: other open/active investigations for this user.
  // Passed to the planner so it can recognise cross-issue dependencies
  // (e.g. "ShareSync failures caused by disk I/O pressure on the same NAS").
  const siblingResult = await supabase
    .from("issues")
    .select("id, title, summary, status, affected_nas, current_hypothesis")
    .eq("user_id", userId)
    .neq("id", issue.id)
    .not("status", "in", '("resolved","cancelled")')
    .order("updated_at", { ascending: false })
    .limit(10);

  const sibling_issues = (siblingResult.data ?? []).map((s) => ({
    id: s.id as string,
    title: s.title as string,
    summary: s.summary as string,
    status: s.status as string,
    affected_nas: Array.isArray(s.affected_nas) ? s.affected_nas as string[] : [],
    current_hypothesis: s.current_hypothesis as string | null,
  }));

  // Resolve memories (started in parallel above; nearly always resolved by now)
  const agentMemory = await memoriesPromise;

  return {
    alerts,
    logs,
    audit_logs,
    telemetry_errors,
    top_processes: collectResult("top_processes", processResult, telemetry_errors),
    disk_io: collectResult("disk_io", diskResult, telemetry_errors),
    scheduled_tasks_with_issues: collectResult("scheduled_tasks_with_issues", scheduledTasksResult, telemetry_errors),
    backup_tasks: dedupeLatestByField(collectResult("backup_tasks", backupTasksResult, telemetry_errors), "task_id"),
    snapshot_replicas: dedupeLatestByField(collectResult("snapshot_replicas", snapshotReplicasResult, telemetry_errors), "task_id"),
    container_io_top: collectResult("container_io_top", containerIOResult, telemetry_errors),
    sharesync_tasks: dedupeLatestByField(collectResult("sharesync_tasks", syncTasksResult, telemetry_errors), "task_id"),
    io_pressure_metrics: collectResult("io_pressure_metrics", ioMetricsResult, telemetry_errors),
    storage_snapshots: dedupeLatestByField(collectResult("storage_snapshots", storageSnapshotsResult, telemetry_errors), "volume_id"),
    dsm_errors: collectResult("dsm_errors", dsmErrorsResult, telemetry_errors),
    // Persistent knowledge from past resolved issues — loaded per-subject so
    // only relevant topics are included (e.g. HyperBackup memories for backup issues).
    agent_memory: agentMemory.map((m) => ({
      subject: m.subject,
      memory_type: m.memory_type,
      title: m.title,
      content: m.content,
      tags: m.tags,
      nas_id: m.nas_id,
    })),
    // Other open investigations for this user. The planner uses this to detect
    // cross-issue dependencies (e.g. "my root cause is another active issue").
    sibling_issues,
  };
}

async function gatherTelemetryContextForState(
  supabase: SupabaseClient,
  userId: string,
  state: IssueFull,
  profile: ContextWindowProfile,
) {
  const issue = state.issue;
  const since6h = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const since30m = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const nasFilter = issue.affected_nas.length > 0 ? issue.affected_nas : null;

  const memoriesPromise = loadMemoriesForIssue(
    supabase,
    userId,
    classifyIssueSubjects(issue),
    issue.affected_nas.length > 0 ? issue.affected_nas : undefined,
  );

  const [
    alertsResult,
    logsResult,
    storageLogsResult,
    processResult,
    diskResult,
    scheduledTasksResult,
    backupTasksResult,
    snapshotReplicasResult,
    containerIOResult,
    syncTasksResult,
    ioMetricsResult,
    storageSnapshotsResult,
    dsmErrorsResult,
  ] = await Promise.all([
    supabase.from("alerts").select("id, source, severity, title, message, created_at").eq("status", "active").order("created_at", { ascending: false }).limit(profile.telemetryLimits.alerts),
    supabase.from("nas_logs").select("id, nas_id, source, severity, message, metadata, ingested_at").gte("ingested_at", since6h).in("severity", ["critical", "error", "warning"]).not("source", "in", '("system","storage","scheduled_task","share_quota","share_health")').order("ingested_at", { ascending: false }).limit(profile.telemetryLimits.noisyLogs),
    supabase.from("nas_logs").select("id, nas_id, source, severity, message, metadata, ingested_at").gte("ingested_at", since48h).in("source", ["system", "storage", "scheduled_task", "share_quota", "share_health"]).order("ingested_at", { ascending: false }).limit(profile.telemetryLimits.auditLogs),
    supabase.from("process_snapshots").select("nas_id, captured_at, pid, name, cmdline, username, cpu_pct, mem_pct, read_bps, write_bps, parent_service").gte("captured_at", since6h).order("captured_at", { ascending: false }).limit(profile.telemetryLimits.processSnapshots),
    supabase.from("disk_io_stats").select("nas_id, captured_at, device, read_bps, write_bps, await_ms, util_pct").gte("captured_at", since6h).order("captured_at", { ascending: false }).limit(profile.telemetryLimits.diskStats),
    supabase.from("scheduled_tasks").select("nas_id, task_id, task_name, task_type, owner, enabled, status, last_run_time, next_run_time, last_result, captured_at").gte("captured_at", since48h).or("last_result.neq.0,status.eq.error").order("captured_at", { ascending: false }).limit(profile.telemetryLimits.scheduledTasks),
    supabase.from("backup_tasks").select("nas_id, task_id, task_name, enabled, status, last_result, last_run_time, next_run_time, dest_type, dest_name, total_bytes, transferred_bytes, speed_bps, captured_at").gte("captured_at", since6h).order("captured_at", { ascending: false }).limit(profile.telemetryLimits.backupTasks),
    supabase.from("snapshot_replicas").select("nas_id, task_id, task_name, status, src_share, dst_share, dst_host, last_result, last_run_time, next_run_time, captured_at").gte("captured_at", since6h).order("captured_at", { ascending: false }).limit(profile.telemetryLimits.snapshotReplicas),
    supabase.from("container_io").select("nas_id, captured_at, container_name, read_bps, write_bps, read_ops, write_ops").gte("captured_at", since30m).order("write_bps", { ascending: false }).limit(profile.telemetryLimits.containerIo),
    supabase.from("sync_task_snapshots").select("nas_id, captured_at, task_id, task_name, status, backlog_count, backlog_bytes, current_file, retry_count, last_error, speed_bps").gte("captured_at", since6h).order("captured_at", { ascending: false }).limit(profile.telemetryLimits.syncTasks),
    supabase.from("metrics").select("nas_id, type, value, unit, metadata, recorded_at").gte("recorded_at", since30m).in("type", [
      "cpu_iowait_pct",
      "hyperbackup_last_new_files",
      "hyperbackup_last_removed_files",
      "hyperbackup_last_renamed_files",
      "hyperbackup_last_copy_miss_files",
      "drive_log_rename_hits",
      "drive_log_delete_hits",
      "drive_log_move_hits",
      "drive_log_conflict_hits",
      "drive_log_connect_hits",
      "drive_log_disconnect_hits",
      "drive_log_mac_hits",
      "nfs_read_bps", "nfs_write_bps", "nfs_calls_ps",
      "vm_pgpgout_ps", "vm_swap_out_ps", "vm_swap_in_ps",
    ]).order("recorded_at", { ascending: false }).limit(profile.telemetryLimits.metrics),
    supabase.from("storage_snapshots").select("nas_id, volume_id, volume_path, total_bytes, used_bytes, status, raid_type, disks, recorded_at").gte("recorded_at", since48h).order("recorded_at", { ascending: false }).limit(profile.telemetryLimits.storageSnapshots),
    supabase.from("dsm_errors").select("nas_id, level, message, who, log_name, logged_at, created_at").gte("logged_at", since48h).order("logged_at", { ascending: false }).limit(profile.telemetryLimits.dsmErrors),
  ]);

  const telemetry_errors: string[] = [];
  const alerts = collectResult("alerts", alertsResult, telemetry_errors);
  // Equality match (not substring): a NAS named "nas1" must not match logs
  // from "nas10" or "backup-nas1-staging". Substring matching pulled
  // cross-NAS noise into evidence and confused the diagnosis stages.
  const matchesNas = (row: { nas_id?: unknown; metadata?: Record<string, unknown> | null }) => {
    if (!nasFilter?.length) return true;
    const nasValue = typeof row.nas_id === "string" ? row.nas_id : "";
    const metaName = String((row.metadata as Record<string, unknown> | null)?.nas_name ?? "");
    return nasFilter.some((nas) => nasValue === nas || metaName === nas);
  };
  const logs = collectResult("logs", logsResult, telemetry_errors).filter(matchesNas);
  const audit_logs = collectResult("audit_logs", storageLogsResult, telemetry_errors).filter(matchesNas);
  const siblingResult = await supabase
    .from("issues")
    .select("id, title, summary, status, affected_nas, current_hypothesis")
    .eq("user_id", userId)
    .neq("id", issue.id)
    .not("status", "in", '("resolved","cancelled")')
    .order("updated_at", { ascending: false })
    .limit(10);

  const sibling_issues = (siblingResult.data ?? []).map((s) => ({
    id: s.id as string,
    title: s.title as string,
    summary: s.summary as string,
    status: s.status as string,
    affected_nas: Array.isArray(s.affected_nas) ? s.affected_nas as string[] : [],
    current_hypothesis: s.current_hypothesis as string | null,
  }));

  const agentMemory = await memoriesPromise;

  return {
    alerts,
    logs,
    audit_logs,
    raw_log_excerpts: buildRawLogExcerpts(logs, audit_logs, profile.rawLogRows),
    telemetry_errors,
    top_processes: collectResult("top_processes", processResult, telemetry_errors),
    disk_io: collectResult("disk_io", diskResult, telemetry_errors),
    scheduled_tasks_with_issues: collectResult("scheduled_tasks_with_issues", scheduledTasksResult, telemetry_errors),
    backup_tasks: dedupeLatestByField(collectResult("backup_tasks", backupTasksResult, telemetry_errors), "task_id"),
    snapshot_replicas: dedupeLatestByField(collectResult("snapshot_replicas", snapshotReplicasResult, telemetry_errors), "task_id"),
    container_io_top: collectResult("container_io_top", containerIOResult, telemetry_errors),
    sharesync_tasks: dedupeLatestByField(collectResult("sharesync_tasks", syncTasksResult, telemetry_errors), "task_id"),
    io_pressure_metrics: collectResult("io_pressure_metrics", ioMetricsResult, telemetry_errors),
    storage_snapshots: dedupeLatestByField(collectResult("storage_snapshots", storageSnapshotsResult, telemetry_errors), "volume_id"),
    dsm_errors: collectResult("dsm_errors", dsmErrorsResult, telemetry_errors),
    agent_memory: agentMemory.map((m) => ({
      subject: m.subject,
      memory_type: m.memory_type,
      title: m.title,
      content: m.content,
      tags: m.tags,
      nas_id: m.nas_id,
    })),
    sibling_issues,
    _context_profile: profile,
  };
}

function summarizeActionHistory(actions: IssueAction[], profile: ContextWindowProfile) {
  return actions.slice(-profile.actions).map((action) => ({
    kind: action.kind,
    status: action.status,
    command: action.command_preview,
    target: action.target,
    summary: action.summary,
    reason: action.reason,
    result_text: action.result_text?.slice(0, profile.diagnosticChars) ?? "",
  }));
}

function summarizeMessages(state: IssueFull, profile: ContextWindowProfile) {
  return state.messages.slice(-profile.messages).map((message) => ({
    role: message.role,
    content: message.content,
    created_at: message.created_at,
  }));
}

function summarizeEvidence(state: IssueFull, profile: ContextWindowProfile) {
  return state.evidence.slice(-profile.evidence).map((evidence) => ({
    source_kind: evidence.source_kind,
    title: evidence.title,
    detail: evidence.detail,
  }));
}

function mergeStringLists(...lists: string[][]) {
  return Array.from(new Set(lists.flat().map((item) => item.trim()).filter(Boolean)));
}

function hasAlreadyTried(state: IssueFull, plan: ToolActionPlan) {
  const cmd = plan.command?.trim();
  if (!cmd) return false;
  return state.actions.some((action) => {
    const sameCommand = action.command_preview?.trim() === cmd;
    const sameTarget = action.target === plan.target;
    if (sameCommand && sameTarget) return true;
    // Also block if the same command was tried on any target and failed/completed
    if (sameCommand && (action.status === "rejected" || action.status === "completed" || action.status === "failed")) return true;
    return false;
  });
}

async function appendEvidenceNotes(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
  notes: Array<{ title: string; detail: string }>,
) {
  for (const note of notes) {
    if (!note.title || !note.detail) continue;
    await appendIssueEvidence(supabase, userId, issueId, {
      source_kind: "analysis",
      title: note.title,
      detail: note.detail,
      metadata: {},
    });
  }
}

function buildAgentResponse(
  response: string,
  plan: NextStepPlanResult,
) {
  const parts: string[] = [];
  const trimmedResponse = response.trim();
  const userQuestion = plan.user_question?.trim() ?? "";

  if (trimmedResponse) {
    parts.push(trimmedResponse);
  }

  if (userQuestion) {
    const alreadyIncluded = trimmedResponse.toLowerCase().includes(userQuestion.toLowerCase());
    if (!alreadyIncluded) {
      parts.push(`I need one answer from you before I can continue: ${userQuestion}`);
    }
  }

  if (plan.status === "waiting_for_approval" && plan.remediation_action) {
    const approvalPrompt = `Approve or reject this action: ${plan.remediation_action.summary}`;
    const alreadyIncluded = trimmedResponse.toLowerCase().includes("approve")
      || trimmedResponse.toLowerCase().includes(plan.remediation_action.summary.toLowerCase());
    if (!alreadyIncluded) {
      parts.push(approvalPrompt);
    }
  }

  if (parts.length === 0 && plan.next_step.trim()) {
    parts.push(plan.next_step.trim());
  }

  const gaps = (plan.tool_gaps ?? []).filter(Boolean);
  if (gaps.length > 0) {
    parts.push(
      `**Capability gaps identified** (actions needed but not currently possible):\n${gaps.map((g) => `- ${g}`).join("\n")}`,
    );
  }

  return parts.join("\n\n").trim();
}

async function runHypothesisStage(
  supabase: SupabaseClient,
  userId: string,
  state: IssueFull,
  telemetry: Record<string, unknown>,
  profile: ContextWindowProfile,
  sessionId: string | null,
  mode: IssueWorkingSession["mode"],
  runtimeOverride: StageRuntimeOverride,
) {
  const startedAt = new Date().toISOString();
  try {
    const { model, parsed, usage, metadata } = await rankIssueHypothesis({
      issue: state.issue,
      recent_messages: summarizeMessages(state, profile),
      recent_evidence: summarizeEvidence(state, profile),
      recent_actions: summarizeActionHistory(state.actions, profile),
      telemetry,
      mode,
      runtimeOverride,
    });
    await recordStageUsage(supabase, userId, state.issue.id, sessionId, "hypothesis_rank", model, usage);
    await recordIssueStageRun(supabase, userId, state.issue.id, {
      stageKey: "hypothesis_rank",
      status: "completed",
      modelName: model,
      modelTier: "reasoner",
      inputSummary: {
        message_count: state.messages.length,
        evidence_count: state.evidence.length,
        action_count: state.actions.length,
        fact_count: Array.isArray(telemetry.normalized_facts) ? telemetry.normalized_facts.length : 0,
        ...buildStageRuntimeSummary({ sessionId, mode, metadata, runtimeOverride }),
      },
      output: parsed as unknown as Record<string, unknown>,
      startedAt,
    });
    return parsed;
  } catch (error) {
    await recordIssueStageRun(supabase, userId, state.issue.id, {
      stageKey: "hypothesis_rank",
      status: "failed",
      modelTier: "reasoner",
      inputSummary: { message_count: state.messages.length },
      errorText: error instanceof Error ? error.message : "Unknown hypothesis stage error",
      startedAt,
    });
    throw error;
  }
}

async function runPlanningStage(
  supabase: SupabaseClient,
  userId: string,
  state: IssueFull,
  telemetry: Record<string, unknown>,
  hypothesis: HypothesisRankResult,
  profile: ContextWindowProfile,
  sessionId: string | null,
  mode: IssueWorkingSession["mode"],
  runtimeOverride: StageRuntimeOverride,
) {
  const startedAt = new Date().toISOString();
  try {
    const recentActions = summarizeActionHistory(state.actions, profile);
    const completedDiagnosticCount = state.actions.filter(
      (a) => a.kind === "diagnostic" && (a.status === "completed" || a.status === "failed"),
    ).length;
    const { model, parsed, usage, metadata } = await planIssueNextStep({
      issue: state.issue,
      hypothesis,
      telemetry,
      recent_actions: recentActions.map((a) => ({
        command: a.command ?? "",
        status: a.status,
        summary: a.summary ?? "",
        result_text: a.result_text,
      })),
      completed_diagnostic_count: completedDiagnosticCount,
      mode,
      runtimeOverride,
    });
    await recordStageUsage(supabase, userId, state.issue.id, sessionId, "next_step_plan", model, usage);
    await recordIssueStageRun(supabase, userId, state.issue.id, {
      stageKey: "next_step_plan",
      status: "completed",
      modelName: model,
      modelTier: "reasoner",
      inputSummary: {
        hypothesis_confidence: hypothesis.hypothesis_confidence,
        blocked_tool_count: state.issue.blocked_tools.length,
        completed_diagnostic_count: completedDiagnosticCount,
        recent_action_count: recentActions.length,
        ...buildStageRuntimeSummary({ sessionId, mode, metadata, runtimeOverride }),
      },
      output: parsed as unknown as Record<string, unknown>,
      startedAt,
    });
    return parsed;
  } catch (error) {
    await recordIssueStageRun(supabase, userId, state.issue.id, {
      stageKey: "next_step_plan",
      status: "failed",
      modelTier: "reasoner",
      inputSummary: { issue_status: state.issue.status },
      errorText: error instanceof Error ? error.message : "Unknown next-step planning error",
      startedAt,
    });
    throw error;
  }
}

async function runRemediationStage(
  supabase: SupabaseClient,
  userId: string,
  state: IssueFull,
  telemetry: Record<string, unknown>,
  hypothesis: HypothesisRankResult,
  plan: NextStepPlanResult,
  sessionId: string | null,
  mode: IssueWorkingSession["mode"],
  runtimeOverride: StageRuntimeOverride,
) {
  const startedAt = new Date().toISOString();
  try {
    const { model, parsed, usage, metadata } = await planIssueRemediation({
      issue: state.issue,
      hypothesis,
      plan,
      telemetry,
      mode,
      runtimeOverride,
    });
    await recordStageUsage(supabase, userId, state.issue.id, sessionId, "next_step_plan", model, usage);
    await recordIssueStageRun(supabase, userId, state.issue.id, {
      stageKey: "next_step_plan",
      status: "completed",
      modelName: model,
      modelTier: "remediation_planner",
      inputSummary: {
        initial_status: plan.status,
        had_remediation_candidate: Boolean(plan.remediation_action),
        ...buildStageRuntimeSummary({ sessionId, mode, metadata, runtimeOverride }),
      },
      output: parsed as unknown as Record<string, unknown>,
      startedAt,
    });
    return parsed;
  } catch (error) {
    await recordIssueStageRun(supabase, userId, state.issue.id, {
      stageKey: "next_step_plan",
      status: "failed",
      modelTier: "remediation_planner",
      inputSummary: { issue_status: state.issue.status },
      errorText: error instanceof Error ? error.message : "Unknown remediation planning error",
      startedAt,
    });
    throw error;
  }
}

async function runExplanationStage(
  supabase: SupabaseClient,
  userId: string,
  state: IssueFull,
  hypothesis: HypothesisRankResult,
  plan: NextStepPlanResult,
  sessionId: string | null,
  mode: IssueWorkingSession["mode"],
) {
  const startedAt = new Date().toISOString();
  try {
    const { model, parsed, usage, metadata } = await explainIssueState({
      issue: state.issue,
      hypothesis,
      plan,
    });
    await recordStageUsage(supabase, userId, state.issue.id, sessionId, "operator_explanation", model, usage);
    await recordIssueStageRun(supabase, userId, state.issue.id, {
      stageKey: "operator_explanation",
      status: "completed",
      modelName: model,
      modelTier: "explainer",
      inputSummary: {
        status: plan.status,
        next_step: plan.next_step,
        ...buildStageRuntimeSummary({ sessionId, mode, metadata }),
      },
      output: parsed as unknown as Record<string, unknown>,
      startedAt,
    });
    return parsed;
  } catch (error) {
    await recordIssueStageRun(supabase, userId, state.issue.id, {
      stageKey: "operator_explanation",
      status: "failed",
      modelTier: "explainer",
      inputSummary: { issue_status: state.issue.status },
      errorText: error instanceof Error ? error.message : "Unknown operator explanation error",
      startedAt,
    });
    throw error;
  }
}

async function runVerificationStage(
  supabase: SupabaseClient,
  userId: string,
  state: IssueFull,
  action: IssueAction,
  telemetry: Record<string, unknown>,
  sessionId: string | null,
  mode: IssueWorkingSession["mode"],
  runtimeOverride: StageRuntimeOverride,
) {
  const startedAt = new Date().toISOString();
  try {
    const { model, parsed, usage, metadata } = await verifyIssueAction({
      issue: state.issue,
      action,
      telemetry,
      mode,
      runtimeOverride,
    });
    await recordStageUsage(supabase, userId, state.issue.id, sessionId, "verification", model, usage);
    await recordIssueStageRun(supabase, userId, state.issue.id, {
      stageKey: "verification",
      status: "completed",
      modelName: model,
      modelTier: "verifier",
      inputSummary: {
        tool_name: action.tool_name,
        action_status: action.status,
        ...buildStageRuntimeSummary({ sessionId, mode, metadata, runtimeOverride }),
      },
      output: parsed as unknown as Record<string, unknown>,
      startedAt,
    });
    return parsed;
  } catch (error) {
    await recordIssueStageRun(supabase, userId, state.issue.id, {
      stageKey: "verification",
      status: "failed",
      modelTier: "verifier",
      inputSummary: { tool_name: action.tool_name },
      errorText: error instanceof Error ? error.message : "Unknown verification error",
      startedAt,
    });
    throw error;
  }
}

async function executeDiagnosticAction(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
  plan: ToolActionPlan,
) {
  const actionId = await createIssueAction(supabase, userId, issueId, {
    kind: "diagnostic",
    target: plan.target,
    toolName: `shell:tier${plan.tier}`,
    commandPreview: plan.command,
    summary: plan.summary,
    reason: plan.reason,
    expectedOutcome: plan.expected_outcome,
    rollbackPlan: "",
    risk: "low",
    requiresApproval: false,
  });

  await updateIssueAction(supabase, userId, actionId, { status: "running" });

  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let status: IssueAction["status"] = "completed";

  try {
    const nasConfig = plan.target ? resolveNasApiConfig(plan.target) : null;
    if (!nasConfig) {
      throw new Error(`No NAS API config found for target: ${plan.target ?? "(none)"}`);
    }
    const result = await nasApiExec(nasConfig, plan.command, plan.tier as 1 | 2 | 3);
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = result.exit_code;
    status = result.exit_code === 0 ? "completed" : "failed";
  } catch (error) {
    stderr = error instanceof Error ? error.message : "Unknown diagnostic execution error";
    status = "failed";
  }

  const resultText = [stdout, stderr].filter(Boolean).join("\n\n").slice(0, 12000);
  await updateIssueAction(supabase, userId, actionId, {
    status,
    result_text: resultText,
    exit_code: exitCode,
    completed_at: new Date().toISOString(),
  });

  await appendIssueEvidence(supabase, userId, issueId, {
    source_kind: "diagnostic",
    title: plan.summary,
    detail: resultText || "No output returned.",
    metadata: {
      command: plan.command,
      tier: plan.tier,
      target: plan.target,
      exit_code: exitCode,
      status,
    },
  });
}

async function executeApprovedActions(
  supabase: SupabaseClient,
  userId: string,
  state: IssueFull,
) {
  const approved = state.actions.find((action) => action.status === "approved");
  if (!approved) return null;

  await updateIssue(supabase, userId, state.issue.id, { status: "running" });
  await updateIssueAction(supabase, userId, approved.id, { status: "running" });

  let resultText = "";
  let exitCode: number | null = null;
  let status: IssueAction["status"] = "completed";

  try {
    const nasConfig = approved.target ? resolveNasApiConfig(approved.target) : null;
    if (!nasConfig) {
      throw new Error(`No NAS API config found for target: ${approved.target ?? "(none)"}`);
    }
    // Recover tier from tool_name (stored as "shell:tier2", "shell:tier3").
    // Fail closed if the tool_name is missing or malformed — silently
    // defaulting to tier 2 + an absent approval_token would let a bad row
    // execute a write-class command without a valid approval signature.
    const tierMatch = approved.tool_name?.match(/^shell:tier([123])$/);
    if (!tierMatch) {
      throw new Error(
        `Refusing to execute approved action ${approved.id}: tool_name "${approved.tool_name ?? ""}" is not a valid shell:tier1|2|3 marker`,
      );
    }
    const tier = Number(tierMatch[1]) as 1 | 2 | 3;
    if (tier !== 1 && !approved.approval_token) {
      throw new Error(
        `Refusing to execute approved action ${approved.id}: tier ${tier} requires a signed approval_token`,
      );
    }
    const result = await nasApiExec(
      nasConfig,
      approved.command_preview,
      tier,
      approved.approval_token ?? undefined,
      90_000,
    );
    resultText = [result.stdout, result.stderr].filter(Boolean).join("\n\n").slice(0, 12000);
    exitCode = result.exit_code;
    status = result.exit_code === 0 ? "completed" : "failed";
  } catch (error) {
    resultText = error instanceof Error ? error.message : "Unknown remediation execution error";
    status = "failed";
  }

  await updateIssueAction(supabase, userId, approved.id, {
    status,
    result_text: resultText,
    exit_code: exitCode,
    completed_at: new Date().toISOString(),
  });

  await appendIssueEvidence(supabase, userId, state.issue.id, {
    source_kind: "diagnostic",
    title: `Action result: ${approved.summary}`,
    detail: resultText || "No output returned.",
    metadata: {
      tool_name: approved.tool_name,
      target: approved.target,
      exit_code: exitCode,
      status,
    },
  });

  return {
    ...approved,
    status,
    result_text: resultText,
    exit_code: exitCode,
    completed_at: new Date().toISOString(),
  } as IssueAction;
}

async function refreshIssueContext(
  supabase: SupabaseClient,
  userId: string,
  state: IssueFull,
  profile: ContextWindowProfile,
  mode: IssueWorkingSession["mode"],
) {
  const telemetry = await gatherTelemetryContextForState(supabase, userId, state, profile);
  const [facts, capability_state] = await Promise.all([
    syncIssueFacts(supabase, userId, state, telemetry),
    syncTelemetryCapabilities(supabase, userId, state.issue, telemetry),
  ]);
  const localAppIntrospection = mode === "deep" ? await getLocalAppIntrospectionSnapshot() : null;

  // Strip raw log arrays — their signal is now captured in normalized_facts
  // as compressed pattern/anomaly facts by the extractor model. Passing raw
  // rows to the hypothesis and planner models wastes context and adds noise.
  // Also strip raw_log_excerpts: the buildRawLogExcerpts helper still
  // shipped up to ~64 KB of raw log text past the compression step in deep
  // mode (160 rows × 400 chars). The compressed facts already carry the
  // signal; raw excerpts only inflate the prompt.
  const {
    logs: _logs,
    audit_logs: _auditLogs,
    raw_log_excerpts: _rawExcerpts,
    ...telemetryWithoutLogs
  } = telemetry;
  void _logs; void _auditLogs; void _rawExcerpts;

  return {
    ...telemetryWithoutLogs,
    ...(localAppIntrospection ? { local_app_introspection: localAppIntrospection } : {}),
    normalized_facts: facts.map((fact) => ({
      fact_type: fact.fact_type,
      severity: fact.severity,
      title: fact.title,
      detail: fact.detail,
      value: fact.value,
    })),
    capability_state: capability_state.map((record) => ({
      nas_id: record.nas_id,
      capability_key: record.capability_key,
      state: record.state,
      evidence: record.evidence,
      raw_error: record.raw_error,
    })),
  };
}

async function applyHypothesisAndPlan(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
  state: IssueFull,
  hypothesis: HypothesisRankResult,
  plan: NextStepPlanResult,
  summary: string,
) {
  const mergedConstraints = mergeStringLists(
    state.issue.operator_constraints,
    plan.constraints_to_add ?? [],
  );
  const mergedBlockedTools = mergeStringLists(
    state.issue.blocked_tools,
    plan.blocked_tools ?? [],
  );

  await appendEvidenceNotes(supabase, userId, issueId, plan.evidence_notes ?? []);

  await updateIssue(supabase, userId, issueId, {
    summary,
    severity: hypothesis.severity,
    status: plan.status,
    affected_nas: hypothesis.affected_nas,
    current_hypothesis: hypothesis.current_hypothesis,
    hypothesis_confidence: hypothesis.hypothesis_confidence,
    next_step: plan.next_step,
    conversation_summary: hypothesis.conversation_summary,
    operator_constraints: mergedConstraints,
    blocked_tools: mergedBlockedTools,
  });

  return { mergedConstraints, mergedBlockedTools };
}

function deriveTerminalPlanStatus(
  state: IssueFull,
  plan: NextStepPlanResult,
  hasPendingApproval: boolean,
) {
  if (hasPendingApproval) return "waiting_for_approval" as const;
  if (plan.status !== "waiting_on_user") return plan.status;
  if (plan.user_question?.trim()) return "waiting_on_user" as const;
  return "stuck" as const;
}

export async function runIssueAgent(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
) {
  let cycles = 0;

  while (cycles < MAX_AGENT_CYCLES) {
    cycles += 1;
    let state = await loadIssue(supabase, userId, issueId);
    if (!state) return null;
    const session = await ensureIssueWorkingSession(
      supabase,
      userId,
      issueId,
      (await getActiveIssueWorkingSession(supabase, userId, issueId))?.mode ?? "guided",
    );
    const profile = await buildContextWindowProfile(state, session.mode);
    const escalationProposal = await maybeProposeEscalation(supabase, userId, state, session, profile);
    if (escalationProposal) {
      return loadIssue(supabase, userId, issueId);
    }
    const runtimeOverride = getApprovedEscalationOverride(
      await listIssueEscalationEvents(supabase, userId, issueId),
      session.id,
    );

    const executedAction = await executeApprovedActions(supabase, userId, state);
    if (executedAction) {
      state = await loadIssue(supabase, userId, issueId);
      if (!state) return null;
      const telemetry = await refreshIssueContext(supabase, userId, state, profile, session.mode);
      const verification = await runVerificationStage(
        supabase,
        userId,
        state,
        executedAction,
        telemetry,
        session.id,
        session.mode,
        runtimeOverride,
      );
      await appendEvidenceNotes(supabase, userId, issueId, verification.evidence_notes ?? []);
      await updateIssue(supabase, userId, issueId, {
        summary: verification.summary,
        status: verification.status,
        current_hypothesis: verification.current_hypothesis,
        hypothesis_confidence: verification.hypothesis_confidence,
        next_step: verification.next_step,
        conversation_summary: verification.conversation_summary,
        resolved_at: verification.status === "resolved" ? new Date().toISOString() : null,
      });
      await appendIssueMessage(supabase, userId, issueId, "agent", verification.response);
      if (verification.status === "resolved") {
        const finalState = await loadIssue(supabase, userId, issueId);
        // Await rather than fire-and-forget. In serverless/Next.js the
        // request can be terminated mid-call once the response is sent,
        // dropping memory writes and partial token usage. The few extra
        // seconds of latency here are worth the data integrity.
        if (finalState) {
          try {
            await runMemoryConsolidation(supabase, userId, finalState);
          } catch (err) {
            console.error("[runMemoryConsolidation] Failed:", err);
          }
        }
      }
      return loadIssue(supabase, userId, issueId);
    }

    const openProposal = state.actions.find((action) => action.status === "proposed" && action.requires_approval);
    if (openProposal) {
      await updateIssue(supabase, userId, issueId, { status: "waiting_for_approval" });
      return loadIssue(supabase, userId, issueId);
    }

    const telemetry = await refreshIssueContext(supabase, userId, state, profile, session.mode);
    const hypothesis = await runHypothesisStage(
      supabase,
      userId,
      state,
      telemetry,
      profile,
      session.id,
      session.mode,
      runtimeOverride,
    );
    let plan = await runPlanningStage(
      supabase,
      userId,
      state,
      telemetry,
      hypothesis,
      profile,
      session.id,
      session.mode,
      runtimeOverride,
    );
    if (plan.remediation_action) {
      plan = await runRemediationStage(
        supabase,
        userId,
        state,
        telemetry,
        hypothesis,
        plan,
        session.id,
        session.mode,
        runtimeOverride,
      );
    }
    const explanation = await runExplanationStage(supabase, userId, state, hypothesis, plan, session.id, session.mode);
    const agentResponse = buildAgentResponse(explanation.response, plan);

    const { mergedBlockedTools } = await applyHypothesisAndPlan(
      supabase,
      userId,
      issueId,
      state,
      hypothesis,
      plan,
      explanation.summary,
    );

    // Cross-issue dependency: planner identified that this issue is blocked
    // by another active investigation. Park this issue and let the workflow
    // re-queue it when the blocker resolves.
    if (plan.depends_on_issue_id) {
      const { data: blocker } = await supabase
        .from("issues")
        .select("id, title, status")
        .eq("id", plan.depends_on_issue_id)
        .maybeSingle();

      if (blocker && blocker.status !== "resolved" && blocker.status !== "cancelled") {
        await updateIssue(supabase, userId, issueId, {
          status: "waiting_on_issue",
          depends_on_issue_id: plan.depends_on_issue_id as string,
          next_step: `Waiting for "${blocker.title as string}" to resolve first.`,
        });
        await appendIssueMessage(
          supabase,
          userId,
          issueId,
          "agent",
          `I've identified that this issue is directly caused by another active investigation: "${blocker.title as string}".\n\nI'll automatically resume once that issue is resolved. In the meantime, resolving the root cause there will likely clear this one too.`,
        );
        return loadIssue(supabase, userId, issueId);
      }
      // Blocker is already resolved/cancelled — ignore the dependency and continue
    }

    if (plan.diagnostic_action) {
      if (!hasAlreadyTried(state, plan.diagnostic_action)) {
        await appendIssueMessage(supabase, userId, issueId, "agent", agentResponse);
        await executeDiagnosticAction(supabase, userId, issueId, plan.diagnostic_action);
        continue;
      }
    }

    if (plan.remediation_action) {
      if (!hasAlreadyTried(state, plan.remediation_action)) {
        if (!plan.remediation_action.target) {
          await updateIssue(supabase, userId, issueId, { status: "waiting_on_user" });
          await appendIssueMessage(
            supabase,
            userId,
            issueId,
            "agent",
            "I do not have a safe remediation target yet. I need one exact NAS or file target before I can ask you to approve a change.",
          );
          return loadIssue(supabase, userId, issueId);
        }
        const remTier = plan.remediation_action.tier as 2 | 3;
        const nasConfig = resolveNasApiConfig(plan.remediation_action.target);
        const approvalToken = nasConfig
          ? buildNasApiApprovalToken(nasConfig, plan.remediation_action.command, remTier)
          : undefined;
        await createIssueAction(supabase, userId, issueId, {
          kind: "remediation",
          target: plan.remediation_action.target,
          toolName: `shell:tier${remTier}`,
          commandPreview: plan.remediation_action.command,
          summary: plan.remediation_action.summary,
          reason: plan.remediation_action.reason,
          expectedOutcome: plan.remediation_action.expected_outcome,
          rollbackPlan: plan.remediation_action.rollback_plan ?? "",
          risk: plan.remediation_action.risk ?? "medium",
          requiresApproval: true,
          approvalToken,
        });
        await updateIssue(supabase, userId, issueId, { status: "waiting_for_approval" });
      } else {
        await updateIssue(supabase, userId, issueId, {
          status: deriveTerminalPlanStatus(state, plan, false),
        });
      }
    }

    const remediationPlan = plan.remediation_action;
    const hasPendingApproval = remediationPlan
      ? !hasAlreadyTried(state, remediationPlan)
        && Boolean(remediationPlan.target)
      : false;
    let finalStatus = deriveTerminalPlanStatus(state, plan, hasPendingApproval);

    // Guard: if the planner returned status="running" but produced no action,
    // the investigation would silently stall with no follow-up job queued.
    // Treat this as "stuck" so the operator sees it and can click Continue.
    // (waiting_on_issue is handled earlier and never reaches this point.)
    if (finalStatus === "running" && !plan.diagnostic_action && !plan.remediation_action) {
      finalStatus = "stuck";
    }

    await updateIssue(supabase, userId, issueId, { status: finalStatus });
    await appendIssueMessage(supabase, userId, issueId, "agent", agentResponse);

    if (finalStatus === "resolved") {
      await updateIssue(supabase, userId, issueId, {
        status: "resolved",
        resolved_at: new Date().toISOString(),
      });
      const resolvedState = await loadIssue(supabase, userId, issueId);
      if (resolvedState) {
        try {
          await runMemoryConsolidation(supabase, userId, resolvedState);
        } catch (err) {
          console.error("[runMemoryConsolidation] Failed:", err);
        }
      }
    }

    return loadIssue(supabase, userId, issueId);
  }

  return loadIssue(supabase, userId, issueId);
}

/** Fire-and-forget: extract and persist durable memories after an issue resolves. */
async function runMemoryConsolidation(
  supabase: SupabaseClient,
  userId: string,
  state: IssueFull,
): Promise<void> {
  try {
    const completedActions = state.actions
      .filter((a) => a.status === "completed" || a.status === "failed")
      .map((a) => ({
        command: a.command_preview ?? "",
        summary: a.summary ?? "",
        result_excerpt: (a.result_text ?? "").slice(0, 400),
        status: a.status,
      }));

    const evidenceHighlights = state.evidence.slice(-10).map((e) => ({
      title: e.title,
      detail: e.detail.slice(0, 300),
    }));

    const { memories } = await consolidateIssueMemory({
      issue_id: state.issue.id,
      title: state.issue.title,
      summary: state.issue.summary ?? "",
      final_hypothesis: state.issue.current_hypothesis ?? "",
      conversation_summary: state.issue.conversation_summary ?? "",
      affected_nas: state.issue.affected_nas,
      evidence_highlights: evidenceHighlights,
      completed_actions: completedActions,
    });

    if (memories.length > 0) {
      await saveMemories(
        supabase,
        userId,
        memories.map((m) => ({ ...m, source_issue_id: state.issue.id })),
      );
    }
  } catch (err) {
    console.error("[runMemoryConsolidation] Failed:", err);
  }
}

export async function seedIssueFromOrigin(
  supabase: SupabaseClient,
  userId: string,
  issueId: string,
  seedText: string,
) {
  await appendIssueMessage(supabase, userId, issueId, "system", seedText);
  await appendIssueEvidence(supabase, userId, issueId, {
    source_kind: "analysis",
    title: "Issue seed",
    detail: seedText,
    metadata: {},
  });
}

export async function collectGlobalDiagnosticsSnapshot() {
  return collectNasDiagnostics(2);
}
