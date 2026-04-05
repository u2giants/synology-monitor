import { NextResponse } from "next/server";
import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";
import { buildProblemPrompt } from "@/lib/server/copilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const problemId = searchParams.get("problemId");

    if (!problemId) {
      return NextResponse.json({ error: "problemId is required." }, { status: 400 });
    }

    const prompt = await buildProblemPrompt(problemId);

    if (!prompt) {
      return NextResponse.json({ error: "Problem not found." }, { status: 404 });
    }

    return NextResponse.json({ prompt });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to build problem prompt." },
      { status: 500 }
    );
  }
}
