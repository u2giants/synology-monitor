// Shared helpers for the /api/archive/* routes: auth gate, NAS config resolution,
// and pass-through of nas-api responses (preserving status codes like 409/503/403
// so the operator UI can react to them).
import { NextResponse } from "next/server";
import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveNasApiConfig, type NasApiConfig } from "@/lib/server/nas-api-client";

/** Returns the authenticated user, or null. */
export async function getAuthedUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export const unauthorized = () => NextResponse.json({ error: "Authentication required." }, { status: 401 });

/** Resolves the nas-api config for a target name, or returns a 400 response. */
export function resolveConfig(nas: string | null): { config?: NasApiConfig; error?: NextResponse } {
  if (!nas) {
    return { error: NextResponse.json({ error: "nas parameter is required." }, { status: 400 }) };
  }
  const config = resolveNasApiConfig(nas);
  if (!config) {
    return { error: NextResponse.json({ error: `No NAS API is configured for "${nas}".` }, { status: 400 }) };
  }
  return { config };
}

/** Pipes a nas-api JSON response through with its status code preserved. */
export async function passThroughJson(res: Response): Promise<NextResponse> {
  const data = await res.json().catch(() => ({ error: "Invalid JSON from NAS API." }));
  return NextResponse.json(data, { status: res.status });
}

/** Maps a transport-level failure (unreachable NAS, timeout) to a 502. */
export function nasUnreachable(err: unknown): NextResponse {
  const msg = err instanceof Error ? err.message : String(err);
  return NextResponse.json({ error: `NAS API unreachable: ${msg}` }, { status: 502 });
}
