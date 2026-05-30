import { NextResponse } from "next/server";
import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cache-hit-ratio + token observability for the 3-stage pipeline (PLAN.md §9.5).
 * Aggregates the last 7 days of ai_model_calls, overall and per stage, so the
 * admin page can show whether prompt caching is actually landing.
 */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("ai_model_calls")
    .select("stage, provider, model, input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, reasoning_tokens, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(5000);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  type Row = {
    stage: string | null;
    input_tokens: number;
    cached_input_tokens: number;
    cache_write_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
  };
  const rows = (data ?? []) as Row[];

  const blank = () => ({ calls: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 });
  const overall = blank();
  const byStage: Record<string, ReturnType<typeof blank>> = {};

  for (const r of rows) {
    const key = r.stage ?? "unstaged";
    const bucket = (byStage[key] ??= blank());
    for (const b of [overall, bucket]) {
      b.calls += 1;
      b.input += r.input_tokens ?? 0;
      b.cached += r.cached_input_tokens ?? 0;
      b.cacheWrite += r.cache_write_tokens ?? 0;
      b.output += r.output_tokens ?? 0;
      b.reasoning += r.reasoning_tokens ?? 0;
    }
  }

  const withRatio = (b: ReturnType<typeof blank>) => ({
    ...b,
    cacheHitRatio: b.input > 0 ? b.cached / b.input : 0,
  });

  return NextResponse.json({
    windowDays: 7,
    overall: withRatio(overall),
    byStage: Object.fromEntries(Object.entries(byStage).map(([k, v]) => [k, withRatio(v)])),
  });
}
