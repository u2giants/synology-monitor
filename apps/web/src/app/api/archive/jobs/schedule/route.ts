// POST /api/archive/jobs/schedule → schedule a future inventory job ({ nas, ...startInput, scheduled_for })
import { NextResponse, type NextRequest } from "next/server";
import { scheduleInventory, type InventoryStartInput } from "@/lib/server/nas-api-client";
import { getAuthedUser, unauthorized, resolveConfig, passThroughJson, nasUnreachable } from "@/lib/server/archive-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!(await getAuthedUser())) return unauthorized();
  const body = (await request.json().catch(() => null)) as ({ nas?: string } & InventoryStartInput) | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const { nas, ...input } = body;
  const { config, error } = resolveConfig(nas ?? null);
  if (error) return error;
  try {
    return await passThroughJson(await scheduleInventory(config!, input));
  } catch (err) {
    return nasUnreachable(err);
  }
}
