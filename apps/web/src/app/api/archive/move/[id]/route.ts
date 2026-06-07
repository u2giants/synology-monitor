// GET /api/archive/move/[id]?nas=<name> → archive-move job status
import { type NextRequest } from "next/server";
import { moveStatus } from "@/lib/server/nas-api-client";
import { getAuthedUser, unauthorized, resolveConfig, passThroughJson, nasUnreachable } from "@/lib/server/archive-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getAuthedUser())) return unauthorized();
  const { id } = await params;
  const { config, error } = resolveConfig(request.nextUrl.searchParams.get("nas"));
  if (error) return error;
  try {
    return await passThroughJson(await moveStatus(config!, id));
  } catch (err) {
    return nasUnreachable(err);
  }
}
