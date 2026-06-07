// GET /api/archive/jobs/[id]?nas=<name> → status of one inventory job
import { type NextRequest } from "next/server";
import { statusInventory } from "@/lib/server/nas-api-client";
import { getAuthedUser, unauthorized, resolveConfig, passThroughJson, nasUnreachable } from "@/lib/server/archive-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getAuthedUser())) return unauthorized();
  const { id } = await params;
  const { config, error } = resolveConfig(request.nextUrl.searchParams.get("nas"));
  if (error) return error;
  try {
    return await passThroughJson(await statusInventory(config!, id));
  } catch (err) {
    return nasUnreachable(err);
  }
}
