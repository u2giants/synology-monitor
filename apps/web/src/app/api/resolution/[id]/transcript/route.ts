import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadIssue } from "@/lib/server/issue-store";
import { loadIssueViewState } from "@/lib/server/issue-view";
import { getLocalAppIntrospectionSnapshot } from "@/lib/server/local-app-introspection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function buildSessionRollups(state: Awaited<ReturnType<typeof loadIssueViewState>>) {
  return state.working_sessions.map((session) => {
    const sessionCost = state.token_usage
      .filter((usage) => usage.session_id === session.id)
      .reduce((sum, usage) => sum + (usage.estimated_cost ?? 0), 0);
    const overrides = state.escalation_events
      .filter((event) => event.approved_by_user && event.session_id === session.id)
      .map((event) => ({
        kind: event.kind,
        to_model: event.to_model,
        to_reasoning: event.to_reasoning,
        created_at: event.created_at,
      }));

    return {
      id: session.id,
      mode: session.mode,
      status: session.status,
      started_at: session.started_at,
      ended_at: session.ended_at,
      rebase_from_session_id: session.rebase_from_session_id,
      estimated_cost: sessionCost,
      overrides,
    };
  });
}

function buildLlmHandoffTranscript(view: Awaited<ReturnType<typeof loadIssueViewState>>) {
  return {
    issue: {
      id: view.issue.id,
      title: view.issue.title,
      summary: view.issue.summary,
      status: view.issue.status,
      severity: view.issue.severity,
      affected_nas: view.issue.affected_nas,
      current_hypothesis: view.issue.current_hypothesis,
      hypothesis_confidence: view.issue.hypothesis_confidence,
      next_step: view.issue.next_step,
      conversation_summary: view.issue.conversation_summary,
      operator_constraints: view.issue.operator_constraints,
      blocked_tools: view.issue.blocked_tools,
    },
    active_session: buildSessionRollups(view).find((session) => session.status === "active") ?? null,
    recent_stage_runs: view.stage_runs.slice(0, 8).map((run) => ({
      stage_key: run.stage_key,
      status: run.status,
      model_name: run.model_name,
      model_tier: run.model_tier,
      effective_reasoning: run.input_summary?.effective_reasoning ?? null,
      session_mode: run.input_summary?.session_mode ?? null,
      input_summary: run.input_summary,
      output: run.output,
      error_text: run.error_text,
      created_at: run.created_at,
    })),
    recent_escalations: view.escalation_events.slice(0, 8),
    key_facts: view.facts.slice(0, 12),
    recent_actions: view.actions.slice(-10),
    recent_evidence: view.evidence.slice(-16),
    investigation_briefs: view.investigation_briefs.slice(0, 4),
  };
}

function buildNextAgentPrompt(view: Awaited<ReturnType<typeof loadIssueViewState>>) {
  const activeSession = buildSessionRollups(view).find((session) => session.status === "active") ?? null;
  const topFacts = view.facts.slice(0, 8).map((fact) => `- ${fact.title}: ${fact.detail}`).join("\n");
  const recentActions = view.actions.slice(-6).map((action) => `- ${action.kind} · ${action.status} · ${action.summary}`).join("\n");
  const recentRuns = view.stage_runs.slice(0, 6).map((run) => {
    const reasoning = typeof run.input_summary?.effective_reasoning === "string" ? run.input_summary.effective_reasoning : "auto";
    return `- ${run.stage_key} · ${run.status}${run.model_name ? ` · ${run.model_name}` : ""} · reasoning ${reasoning}`;
  }).join("\n");
  const overrides = activeSession?.overrides.map((override) => override.to_model ?? override.to_reasoning ?? override.kind).join(", ") ?? "none";
  const latestBrief = view.investigation_briefs[0];
  const unresolved = Array.isArray(latestBrief?.content_json?.unresolved_questions)
    ? (latestBrief?.content_json?.unresolved_questions as unknown[]).map(String).slice(0, 4)
    : [];

  return [
    "You are taking over an in-progress Synology NAS investigation.",
    "",
    `Issue: ${view.issue.title}`,
    `Status: ${view.issue.status} · Severity: ${view.issue.severity}`,
    `Hypothesis: ${view.issue.current_hypothesis || "n/a"}`,
    `Confidence: ${view.issue.hypothesis_confidence}`,
    `Next step: ${view.issue.next_step || "n/a"}`,
    `Affected NAS: ${view.issue.affected_nas.join(", ") || "n/a"}`,
    `Active session: ${activeSession ? `${activeSession.mode} (${activeSession.id.slice(0, 8)})` : "none"}`,
    `Approved overrides: ${overrides}`,
    "",
    "Operator constraints:",
    ...(view.issue.operator_constraints.length > 0 ? view.issue.operator_constraints.map((constraint) => `- ${constraint}`) : ["- none"]),
    "",
    "Top findings:",
    topFacts || "- none",
    "",
    "Recent actions:",
    recentActions || "- none",
    "",
    "Recent stage runs:",
    recentRuns || "- none",
    "",
    "Unresolved questions:",
    ...(unresolved.length > 0 ? unresolved.map((entry) => `- ${entry}`) : ["- none recorded"]),
    "",
    "Continue from here. Do not discard the current hypothesis unless the evidence above justifies it. Prefer read-only investigation first unless the record already supports a concrete remediation.",
  ].join("\n");
}

function buildAuditTranscript(view: Awaited<ReturnType<typeof loadIssueViewState>>) {
  const sessionRollups = buildSessionRollups(view);
  const lines = [
    `Issue: ${view.issue.title}`,
    `Status: ${view.issue.status} · Severity: ${view.issue.severity}`,
    `Hypothesis: ${view.issue.current_hypothesis || "n/a"}`,
    `Confidence: ${view.issue.hypothesis_confidence}`,
    `Next step: ${view.issue.next_step || "n/a"}`,
    `Affected NAS: ${view.issue.affected_nas.join(", ") || "n/a"}`,
    "",
    "Session rollups:",
    ...sessionRollups.map((session) =>
      `- ${session.id.slice(0, 8)} · ${session.mode} · ${session.status} · cost $${session.estimated_cost.toFixed(3)}${session.overrides.length > 0 ? ` · overrides ${session.overrides.map((o) => o.to_model ?? o.to_reasoning ?? o.kind).join(", ")}` : ""}`,
    ),
    "",
    "Recent stage runs:",
    ...view.stage_runs.slice(0, 12).map((run) =>
      `- ${run.stage_key} · ${run.status}${run.model_name ? ` · ${run.model_name}` : ""}${typeof run.input_summary?.effective_reasoning === "string" ? ` · reasoning ${run.input_summary.effective_reasoning}` : ""}`,
    ),
    "",
    "Recent escalations:",
    ...view.escalation_events.slice(0, 12).map((event) =>
      `- ${event.kind} · ${event.approved_by_user ? "approved" : "pending"}${event.to_model ? ` · model ${event.to_model}` : ""}${event.to_reasoning ? ` · reasoning ${event.to_reasoning}` : ""}${event.estimated_cost != null ? ` · est. $${event.estimated_cost.toFixed(3)}` : ""}`,
    ),
    "",
    "Key facts:",
    ...view.facts.slice(0, 12).map((fact) => `- ${fact.title}: ${fact.detail}`),
    "",
    "Recent actions:",
    ...view.actions.slice(-10).map((action) => `- ${action.kind} · ${action.status} · ${action.summary}`),
  ];
  return lines.join("\n");
}

function buildEvalFixture(view: Awaited<ReturnType<typeof loadIssueViewState>>) {
  return {
    fixture_version: 1,
    created_at: new Date().toISOString(),
    issue_id: view.issue.id,
    title: view.issue.title,
    prompt: buildNextAgentPrompt(view),
    expected: {
      status: view.issue.status,
      current_hypothesis: view.issue.current_hypothesis,
      hypothesis_confidence: view.issue.hypothesis_confidence,
      next_step: view.issue.next_step,
      approved_escalations: view.escalation_events
        .filter((event) => event.approved_by_user)
        .map((event) => ({ kind: event.kind, to_model: event.to_model, to_reasoning: event.to_reasoning })),
    },
    fixtures: {
      facts: view.facts.slice(0, 12),
      recent_actions: view.actions.slice(-10),
      recent_stage_runs: view.stage_runs.slice(0, 10),
      recent_evidence: view.evidence.slice(-20),
      latest_brief: view.investigation_briefs[0] ?? null,
    },
  };
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const { id } = await params;
    const { searchParams } = new URL(_request.url);
    const variant = searchParams.get("variant") ?? "raw";
    const state = await loadIssue(supabase, user.id, id);
    if (!state) return NextResponse.json({ error: "Not found." }, { status: 404 });

    const view = await loadIssueViewState(supabase, user.id, state);
    const localAppIntrospection = await getLocalAppIntrospectionSnapshot();
    const rawTranscript = {
      exported_at: new Date().toISOString(),
      issue: view.issue,
      next_agent_prompt: buildNextAgentPrompt(view),
      session_rollups: buildSessionRollups(view),
      escalation_events: view.escalation_events,
      recent_stage_runs: view.stage_runs.slice(0, 20),
      recent_token_usage: view.token_usage.slice(0, 30),
      recent_messages: view.messages.slice(-20),
      recent_actions: view.actions.slice(-20),
      recent_evidence: view.evidence.slice(-30),
      facts: view.facts,
      capabilities: view.capabilities,
      investigation_briefs: view.investigation_briefs,
      local_app_introspection: localAppIntrospection,
    };

    if (variant === "llm") {
      return NextResponse.json({
        ...buildLlmHandoffTranscript(view),
        next_agent_prompt: buildNextAgentPrompt(view),
        local_app_introspection: localAppIntrospection,
      }, {
        headers: {
          "Content-Disposition": `attachment; filename=\"issue-${id}-llm-handoff.json\"`,
        },
      });
    }

    if (variant === "audit") {
      return new NextResponse(buildAuditTranscript(view), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename=\"issue-${id}-audit.txt\"`,
        },
      });
    }

    if (variant === "fixture") {
      return NextResponse.json(buildEvalFixture(view), {
        headers: {
          "Content-Disposition": `attachment; filename=\"issue-${id}-eval-fixture.json\"`,
        },
      });
    }

    return NextResponse.json(rawTranscript, {
      headers: {
        "Content-Disposition": `attachment; filename=\"issue-${id}-transcript.json\"`,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Transcript export failed." },
      { status: 500 },
    );
  }
}
