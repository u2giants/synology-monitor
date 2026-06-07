// GET  /api/archive/move?nas=<name>  → list archive-move jobs
// POST /api/archive/move             → plan a move ({ nas, ...MovePlanInput })
import { NextResponse, type NextRequest } from "next/server";
import { listMoves, planMove, type MovePlanInput } from "@/lib/server/nas-api-client";
import { getAuthedUser, unauthorized, resolveConfig, passThroughJson, nasUnreachable } from "@/lib/server/archive-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!(await getAuthedUser())) return unauthorized();
  const { config, error } = resolveConfig(request.nextUrl.searchParams.get("nas"));
  if (error) return error;
  try {
    return await passThroughJson(await listMoves(config!));
  } catch (err) {
    return nasUnreachable(err);
  }
}

export async function POST(request: NextRequest) {
  if (!(await getAuthedUser())) return unauthorized();
  const body = (await request.json().catch(() => null)) as ({ nas?: string } & MovePlanInput) | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const { nas, ...input } = body;
  const { config, error } = resolveConfig(nas ?? null);
  if (error) return error;
  try {
    return await passThroughJson(await planMove(config!, input));
  } catch (err) {
    return nasUnreachable(err);
  }
}
