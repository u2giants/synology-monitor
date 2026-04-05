import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createResolution } from "@/lib/server/resolution-store";
import { tick } from "@/lib/server/resolution-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const body = await request.json() as {
      originType: "problem" | "alert" | "manual";
      originId?: string;
      title?: string;
      description?: string;
      lookbackHours?: number;
    };

    let title = body.title ?? "";
    let description = body.description ?? "";
    let severity: "critical" | "warning" | "info" = "warning";
    let affectedNas: string[] = [];

    // Auto-populate from origin
    if (body.originType === "problem" && body.originId) {
      const { data: problem } = await supabase
        .from("smon_analyzed_problems")
        .select("title, explanation, severity, affected_nas, technical_diagnosis")
        .eq("id", body.originId)
        .maybeSingle();

      if (problem) {
        title = title || problem.title;
        description = description || `${problem.explanation}\n\nTechnical diagnosis: ${problem.technical_diagnosis}`;
        severity = problem.severity ?? "warning";
        affectedNas = (problem.affected_nas as string[]) ?? [];
      }
    } else if (body.originType === "alert" && body.originId) {
      const { data: alert } = await supabase
        .from("smon_alerts")
        .select("title, message, severity")
        .eq("id", body.originId)
        .maybeSingle();

      if (alert) {
        title = title || alert.title;
        description = description || alert.message;
        severity = alert.severity ?? "warning";
      }
    }

    if (!title) title = "Manual issue report";
    if (!description) description = title;

    const resolutionId = await createResolution(supabase, user.id, {
      originType: body.originType,
      originId: body.originId,
      title,
      description,
      severity,
      affectedNas,
      lookbackHours: body.lookbackHours,
    });

    // Immediately start planning
    const state = await tick(supabase, user.id, resolutionId);

    return NextResponse.json({ resolutionId, state });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create resolution." },
      { status: 500 }
    );
  }
}
