// GET /api/archive/move/[id]/result?nas=&kind=&download=1
//   download=1 → streams the report file; otherwise → JSON { kind, content }
import { NextResponse, type NextRequest } from "next/server";
import { moveResult } from "@/lib/server/nas-api-client";
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
  for (const key of ["kind", "download"] as const) {
    const v = sp.get(key);
    if (v !== null) forward.set(key, v);
  }
  const isDownload = sp.get("download") === "1";
  try {
    const res = await moveResult(config!, id, forward);
    if (!isDownload || !res.ok) return await passThroughJson(res);
    const kind = sp.get("kind") ?? "move-report";
    const ext = kind === "preflight" ? "json" : "csv";
    const text = await res.text();
    return new NextResponse(text, {
      status: 200,
      headers: {
        "Content-Type": `text/${ext}`,
        "Content-Disposition": `attachment; filename="${id}-${kind}.${ext}"`,
      },
    });
  } catch (err) {
    return nasUnreachable(err);
  }
}
