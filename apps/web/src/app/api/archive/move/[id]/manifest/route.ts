// GET /api/archive/move/[id]/manifest?nas=&limit=&cursor= → bounded manifest rows
import { type NextRequest } from "next/server";
import { moveManifest } from "@/lib/server/nas-api-client";
import { getAuthedUser, unauthorized, resolveConfig, passThroughJson, nasUnreachable } from "@/lib/server/archive-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getAuthedUser())) return unauthorized();
  const { id } = await params;
  const sp = request.nextUrl.searchParams;
  const { config, error } = resolveConfig(sp.get("nas"));
  if (error) return error;
  const forward = new URLSearchParams();
  for (const key of ["limit", "cursor"] as const) {
    const v = sp.get(key);
    if (v !== null) forward.set(key, v);
  }
  try {
    return await passThroughJson(await moveManifest(config!, id, forward));
  } catch (err) {
    return nasUnreachable(err);
  }
}
