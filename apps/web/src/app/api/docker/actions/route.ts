import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { executeNasCommand } from "@/lib/server/nas-api-client";
import { getCopilotRole } from "@/lib/server/copilot-store";
import {
  TOOL_DEFINITIONS,
  type CopilotToolName,
  type NasTarget,
} from "@/lib/server/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const ALLOWED_DOCKER_ACTIONS: CopilotToolName[] = [
  "stop_monitor_agent",
  "start_monitor_agent",
  "restart_monitor_agent",
  "pull_monitor_agent",
  "build_monitor_agent",
];

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const roleInfo = await getCopilotRole(supabase, user);
    if (roleInfo.role === "viewer") {
      return NextResponse.json({ error: "Your role is not allowed to execute Docker actions." }, { status: 403 });
    }

    const body = await request.json() as {
      target: NasTarget;
      toolName: CopilotToolName;
    };

    if (!body.target || !body.toolName) {
      return NextResponse.json({ error: "target and toolName are required." }, { status: 400 });
    }

    if (!ALLOWED_DOCKER_ACTIONS.includes(body.toolName)) {
      return NextResponse.json({ error: "Unsupported Docker action." }, { status: 400 });
    }

    const tool = TOOL_DEFINITIONS[body.toolName];
    const command = tool.buildPreview(body.target, {});
    const result = await executeNasCommand(body.target, command);

    return NextResponse.json({
      ok: result.exitCode === 0,
      command,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to execute Docker action." },
      { status: 500 },
    );
  }
}
