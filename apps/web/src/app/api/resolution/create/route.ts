import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildBackendFindingsSnapshot } from "@/lib/server/backend-findings";
import { ensureIssueWorkingSession } from "@/lib/server/issue-investigation-store";
import { createIssue, loadIssue } from "@/lib/server/issue-store";
import { seedIssueFromOrigin } from "@/lib/server/issue-agent";
import { drainIssueQueue, queueIssueRun, shouldInlineDrain } from "@/lib/server/issue-workflow";
import { loadIssueViewState } from "@/lib/server/issue-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const body = await request.json() as {
      originType: "manual" | "alert" | "problem";
      originId?: string;
      title?: string;
      description?: string;
      importCurrentFindings?: boolean;
    };

    let title = body.title?.trim() ?? "";
    let seed = body.description?.trim() ?? "";
    let severity: "critical" | "warning" | "info" = "warning";
    let affectedNas: string[] = [];
    let metadata: Record<string, unknown> = {};

    if (body.importCurrentFindings) {
      const snapshot = await buildBackendFindingsSnapshot(supabase);
      title = snapshot.title;
      seed = snapshot.seed;
      severity = snapshot.severity;
      affectedNas = snapshot.affectedNas;
      metadata = snapshot.metadata;
    }

    if (body.originType === "problem" && body.originId) {
      const { data: problem } = await supabase
        .from("analyzed_problems")
        .select("title, explanation, technical_diagnosis, severity, affected_nas")
        .eq("id", body.originId)
        .maybeSingle();

      if (problem) {
        title = title || problem.title;
        seed = seed || `${problem.explanation}\n\nTechnical diagnosis: ${problem.technical_diagnosis}`;
        severity = problem.severity ?? severity;
        affectedNas = (problem.affected_nas as string[]) ?? [];
      }
    }

    if (body.originType === "alert" && body.originId) {
      const { data: alert } = await supabase
        .from("alerts")
        .select("title, message, severity")
        .eq("id", body.originId)
        .maybeSingle();

      if (alert) {
        title = title || alert.title;
        seed = seed || alert.message || alert.title;
        severity = alert.severity ?? severity;
      }
    }

    if (!title) title = "Untitled issue";
    if (!seed) seed = title;

    const issueId = await createIssue(supabase, user.id, {
      originType: body.originType,
      originId: body.originId ?? null,
      title,
      summary: seed,
      severity,
      affectedNas,
      metadata,
    });
    await ensureIssueWorkingSession(supabase, user.id, issueId, "guided");

    const existing = await loadIssue(supabase, user.id, issueId);
    if (existing && existing.messages.length === 0) {
      await seedIssueFromOrigin(supabase, user.id, issueId, seed);
    }

    await queueIssueRun(supabase, user.id, issueId, "run_issue", { reason: "issue_created" });
    if (shouldInlineDrain()) {
      await drainIssueQueue(supabase, user.id, { limit: 1 });
    }
    const state = await loadIssue(supabase, user.id, issueId);
    return NextResponse.json({ resolutionId: issueId, state: state ? await loadIssueViewState(supabase, user.id, state) : null });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create issue." },
      { status: 500 }
    );
  }
}
