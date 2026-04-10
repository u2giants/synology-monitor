import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { deleteIssue, loadIssue, updateIssue } from "@/lib/server/issue-store";
import { loadIssueViewState } from "@/lib/server/issue-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const { id } = await params;
    const state = await loadIssue(supabase, user.id, id);
    if (!state) return NextResponse.json({ error: "Not found." }, { status: 404 });
    return NextResponse.json(await loadIssueViewState(supabase, user.id, state));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Load failed." },
      { status: 500 }
    );
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

    const { id } = await params;
    await deleteIssue(supabase, user.id, id);
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
    const body = await request.json() as {
      status?: "cancelled";
    };

    const updates: { status?: "cancelled" } = {};
    if (body.status === "cancelled") updates.status = "cancelled";

    await updateIssue(supabase, user.id, id, updates);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Update failed." },
      { status: 500 }
    );
  }
}
