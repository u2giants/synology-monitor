import { NextResponse } from "next/server";
import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";
import { getNasApiConfigs } from "@/lib/server/nas-api-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * NAS reachability probe (PLAN.md §7) — drives the dashboard's Offline-Mode
 * indicator. Pings each configured nas-api /health over Tailscale; when a NAS is
 * unreachable the UI disables live-action controls and shows an offline badge,
 * so operators aren't left clicking actions that will fail. Read-only views and
 * fetch_evidence-backed diagnosis stay available regardless.
 */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const configs = getNasApiConfigs();
  const results = await Promise.all(
    configs.map(async (config) => {
      try {
        const res = await fetch(`${config.url}/health`, {
          headers: { Authorization: `Bearer ${config.apiSecret}` },
          signal: AbortSignal.timeout(5_000),
        });
        return { name: config.name, reachable: res.ok };
      } catch {
        return { name: config.name, reachable: false };
      }
    }),
  );

  return NextResponse.json({
    configured: configs.length,
    units: results,
    anyOffline: results.some((r) => !r.reachable),
    allOffline: configs.length > 0 && results.every((r) => !r.reachable),
  });
}
