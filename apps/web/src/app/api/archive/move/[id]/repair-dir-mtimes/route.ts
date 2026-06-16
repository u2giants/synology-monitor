// POST /api/archive/move/[id]/repair-dir-mtimes?nas=<name>
// Restores Archive folder mtimes from the move job's read-only Btrfs snapshot.
import { type NextRequest } from "next/server";
import { repairMoveDirMtimes } from "@/lib/server/nas-api-client";
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
    return await passThroughJson(await repairMoveDirMtimes(config!, id));
  } catch (err) {
    return nasUnreachable(err);
  }
}
