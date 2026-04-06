import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadResolution, listResolutions, updateResolution, deleteResolution } from "@/lib/server/resolution-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const { id } = await params;

    if (id === "list") {
      const resolutions = await listResolutions(supabase, user.id);
      return NextResponse.json({ resolutions });
    }

    const state = await loadResolution(supabase, user.id, id);
    if (!state) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json(state);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Load failed." },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const { id } = await params;
    await deleteResolution(supabase, user.id, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Delete failed." },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const { id } = await params;
    const body = await request.json();

    const allowed: Record<string, unknown> = {};
    if ("auto_approve_reads" in body) allowed.auto_approve_reads = Boolean(body.auto_approve_reads);
    if ("phase" in body && body.phase === "cancelled") allowed.phase = "cancelled";

    await updateResolution(supabase, user.id, id, allowed as Parameters<typeof updateResolution>[3]);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Update failed." },
      { status: 500 }
    );
  }
}
