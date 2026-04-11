import type { SupabaseClient } from "@/lib/server/issue-store";

export type CapabilityState = "supported" | "unsupported" | "unverified" | "degraded";

export interface CapabilityRecord {
  id: string;
  nas_id: string;
  capability_key: string;
  state: CapabilityState;
  source_kind: string;
  evidence: string;
  raw_error: string | null;
  metadata: Record<string, unknown>;
  checked_at: string;
  updated_at: string;
}

export async function upsertCapabilityState(
  supabase: SupabaseClient,
  input: {
    nasId: string;
    capabilityKey: string;
    state: CapabilityState;
    sourceKind?: string;
    evidence?: string;
    rawError?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("capability_state")
    .upsert({
      nas_id: input.nasId,
      capability_key: input.capabilityKey,
      state: input.state,
      source_kind: input.sourceKind ?? "worker",
      evidence: input.evidence ?? "",
      raw_error: input.rawError ?? null,
      metadata: input.metadata ?? {},
      checked_at: now,
      updated_at: now,
    }, {
      onConflict: "nas_id,capability_key",
    });

  if (error) {
    throw new Error(`Failed to upsert capability state: ${error.message}`);
  }
}

export async function listCapabilityState(
  supabase: SupabaseClient,
  nasIds: string[],
) {
  if (nasIds.length === 0) return [] as CapabilityRecord[];
  const { data, error } = await supabase
    .from("capability_state")
    .select("*")
    .in("nas_id", nasIds)
    .order("checked_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to list capability state: ${error.message}`);
  }

  return (data ?? []) as CapabilityRecord[];
}
