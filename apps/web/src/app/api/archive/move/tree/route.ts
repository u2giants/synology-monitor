// GET /api/archive/move/tree?nas=&share=&path= → immediate child folders for archive scope picking
import { NextResponse, type NextRequest } from "next/server";
import { moveTree } from "@/lib/server/nas-api-client";
import { getAuthedUser, unauthorized, resolveConfig, passThroughJson, nasUnreachable } from "@/lib/server/archive-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!(await getAuthedUser())) return unauthorized();
  const { searchParams } = request.nextUrl;
  const { config, error } = resolveConfig(searchParams.get("nas"));
  if (error) return error;

  const share = searchParams.get("share") ?? "";
  if (!share) return NextResponse.json({ error: "share parameter is required." }, { status: 400 });

  try {
    return await passThroughJson(await moveTree(config!, share, searchParams.get("path") ?? ""));
  } catch (err) {
    return nasUnreachable(err);
  }
}
