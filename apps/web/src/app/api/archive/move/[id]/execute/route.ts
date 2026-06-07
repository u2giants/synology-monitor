// POST /api/archive/move/[id]/execute?nas=<name> → execute a planned move (tier 3)
import { type NextRequest } from "next/server";
import { executeMove } from "@/lib/server/nas-api-client";
import { getAuthedUser, unauthorized, resolveConfig, passThroughJson, nasUnreachable } from "@/lib/server/archive-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getAuthedUser())) return unauthorized();
  const { id } = await params;
  const nas = request.nextUrl.searchParams.get("nas") ?? (await request.json().catch(() => ({})))?.nas ?? null;
  const { config, error } = resolveConfig(nas);
  if (error) return error;
  try {
    return await passThroughJson(await executeMove(config!, id));
  } catch (err) {
    return nasUnreachable(err);
  }
}
