// GET /api/archive/jobs/[id]/result?nas=&result=&limit=&cursor=&download=1
//   download=1 → streams the full CSV as an attachment (web download)
//   otherwise  → bounded JSON envelope (header + paged rows)
import { NextResponse, type NextRequest } from "next/server";
import { fetchInventoryResult } from "@/lib/server/nas-api-client";
import { getAuthedUser, unauthorized, resolveConfig, passThroughJson, nasUnreachable } from "@/lib/server/archive-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getAuthedUser())) return unauthorized();
  const { id } = await params;
  const sp = request.nextUrl.searchParams;
  const { config, error } = resolveConfig(sp.get("nas"));
  if (error) return error;

  // Forward only the nas-api-recognized query params.
  const forward = new URLSearchParams();
  for (const key of ["result", "limit", "cursor", "download"] as const) {
    const v = sp.get(key);
    if (v !== null) forward.set(key, v);
  }
  const isDownload = sp.get("download") === "1";

  try {
    const res = await fetchInventoryResult(config!, id, forward);
    if (!isDownload) return await passThroughJson(res);
    if (!res.ok) return await passThroughJson(res); // surface 404/409 etc. as JSON
    const csv = await res.text();
    const kind = sp.get("result") ?? "yearly";
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="${id}-${kind}.csv"`,
      },
    });
  } catch (err) {
    return nasUnreachable(err);
  }
}
