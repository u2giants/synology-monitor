/**
 * Drive forensics — reads Drive churn signals from Supabase and builds
 * structured attribution and delete/rename classification facts.
 *
 * All data comes from nas_logs rows emitted by the Go agent collectors:
 *   source = "drive_client_attribution"  (Task 1)
 *   source = "drive_event_summary"       (Task 2)
 *
 * No NAS API calls are made here — data is already in Supabase.
 */

import type { SupabaseClient } from "@/lib/server/issue-store";
import type { DerivedFactInput } from "@/lib/server/fact-store";

// ─── Data shapes ──────────────────────────────────────────────────────────────

export interface DriveAttributionData {
  devices: string[];
  users: string[];
  task_ids: string[];
  share_names: string[];
  conflict_device_names: string[];
  confidence: "high" | "medium" | "low";
  notes: string;
  nas_id: string;
  observed_at: string;
}

export interface DriveEventSummary {
  remove_count: number;
  upload_count: number;
  rename_count: number;
  exact_match_count: number;
  same_base_same_dir_count: number;
  same_base_near_dir_count: number;
  rename_into_subdir_count: number;
  classification: "restructure_likely" | "destructive_delete_likely" | "mixed";
  match_rate: number;
  sample_pairs: Array<{ removed: string; matched_by: string; match: string }>;
  nas_id: string;
  observed_at: string;
}

// ─── Supabase reads ───────────────────────────────────────────────────────────

/**
 * Loads the most recent Drive attribution and event-summary logs from nas_logs
 * for the given NAS names within the specified time window.
 */
export async function loadDriveForensics(
  supabase: SupabaseClient,
  nasNames: string[],
  since: string,
): Promise<{ attribution: DriveAttributionData[]; eventSummary: DriveEventSummary[] }> {
  const [attrResult, summaryResult] = await Promise.all([
    supabase
      .from("nas_logs")
      .select("nas_id, metadata, ingested_at")
      .eq("source", "drive_client_attribution")
      .gte("ingested_at", since)
      .order("ingested_at", { ascending: false })
      .limit(10),

    supabase
      .from("nas_logs")
      .select("nas_id, metadata, ingested_at")
      .eq("source", "drive_event_summary")
      .gte("ingested_at", since)
      .order("ingested_at", { ascending: false })
      .limit(10),
  ]);

  const attribution = dedupeByNas<DriveAttributionData>(
    attrResult.data ?? [],
    nasNames,
    (row) => {
      const m = (row.metadata ?? {}) as Record<string, unknown>;
      return {
        devices: asStringArray(m.devices),
        users: asStringArray(m.users),
        task_ids: asStringArray(m.task_ids),
        share_names: asStringArray(m.share_names),
        conflict_device_names: asStringArray(m.conflict_device_names),
        confidence: (m.confidence as "high" | "medium" | "low") ?? "low",
        notes: (m.notes as string) ?? "",
        nas_id: row.nas_id as string,
        observed_at: row.ingested_at as string,
      };
    },
  );

  const eventSummary = dedupeByNas<DriveEventSummary>(
    summaryResult.data ?? [],
    nasNames,
    (row) => {
      const m = (row.metadata ?? {}) as Record<string, unknown>;
      return {
        remove_count: Number(m.remove_count ?? 0),
        upload_count: Number(m.upload_count ?? 0),
        rename_count: Number(m.rename_count ?? 0),
        exact_match_count: Number(m.exact_match_count ?? 0),
        same_base_same_dir_count: Number(m.same_base_same_dir_count ?? 0),
        same_base_near_dir_count: Number(m.same_base_near_dir_count ?? 0),
        rename_into_subdir_count: Number(m.rename_into_subdir_count ?? 0),
        classification: (m.classification as DriveEventSummary["classification"]) ?? "mixed",
        match_rate: Number(m.match_rate ?? 0),
        sample_pairs: Array.isArray(m.sample_pairs)
          ? (m.sample_pairs as Array<{ removed: string; matched_by: string; match: string }>)
          : [],
        nas_id: row.nas_id as string,
        observed_at: row.ingested_at as string,
      };
    },
  );

  return { attribution, eventSummary };
}

// ─── Fact builders ────────────────────────────────────────────────────────────

/**
 * Builds DerivedFactInput entries from Drive forensics data.
 * Only produces facts when meaningful data is present.
 */
export function buildDriveForensicFacts(
  nasId: string,
  attribution: DriveAttributionData | undefined,
  eventSummary: DriveEventSummary | undefined,
): DerivedFactInput[] {
  const facts: DerivedFactInput[] = [];

  // ── Fact 1: Drive client attribution ────────────────────────────────────────
  if (attribution) {
    const allDevices = unique([...attribution.devices, ...attribution.conflict_device_names]);
    if (allDevices.length > 0) {
      const topDevices = allDevices.slice(0, 4);
      const remainder = allDevices.length - topDevices.length;
      const deviceList = remainder > 0
        ? `${topDevices.join(", ")} +${remainder} more`
        : topDevices.join(", ");

      const detail = [
        `Devices: ${allDevices.join(", ")}`,
        attribution.users.length > 0 ? `Users: ${attribution.users.join(", ")}` : "",
        attribution.share_names.length > 0 ? `Shares: ${attribution.share_names.join(", ")}` : "",
        attribution.task_ids.length > 0 ? `Active tasks: ${attribution.task_ids.join(", ")}` : "",
        attribution.notes ? `Note: ${attribution.notes}` : "",
      ].filter(Boolean).join("\n");

      facts.push({
        nasId,
        factType: "forensic_drive_attribution",
        factKey: `forensic-drive-attribution:${nasId}`,
        severity: "info",
        title: `Likely Drive clients involved: ${deviceList}`,
        detail,
        value: {
          devices: allDevices,
          users: attribution.users,
          task_ids: attribution.task_ids,
          share_names: attribution.share_names,
          confidence: attribution.confidence,
        },
        observedAt: attribution.observed_at,
      });
    }
  }

  // ── Fact 2: Delete / rename classification ───────────────────────────────────
  if (eventSummary && eventSummary.remove_count > 0) {
    const isRestructure = eventSummary.classification === "restructure_likely";
    const isDestructive = eventSummary.classification === "destructive_delete_likely";
    const matchPct = Math.round(eventSummary.match_rate * 100);
    const totalMatched =
      eventSummary.exact_match_count +
      eventSummary.same_base_same_dir_count +
      eventSummary.same_base_near_dir_count +
      eventSummary.rename_into_subdir_count;

    let title: string;
    if (isRestructure) {
      title = `Recent delete activity mostly matches file moves and replacements (${matchPct}% matched)`;
    } else if (isDestructive) {
      title = `Recent delete activity appears destructive and unmatched (${matchPct}% matched)`;
    } else {
      title = `Recent delete activity is mixed — some moves, some true deletions (${matchPct}% matched)`;
    }

    const sampleLine = eventSummary.sample_pairs[0]
      ? `Example: "${eventSummary.sample_pairs[0].removed}" → ${eventSummary.sample_pairs[0].matched_by}`
      : "";

    facts.push({
      nasId,
      factType: "forensic_drive_classification",
      factKey: `forensic-drive-classification:${nasId}`,
      severity: isDestructive ? "warning" : "info",
      title,
      detail: [
        `${eventSummary.remove_count} removes, ${eventSummary.upload_count} uploads, ${eventSummary.rename_count} renames in recent log window`,
        `${totalMatched} of ${eventSummary.remove_count} removes matched to replacements or renames`,
        sampleLine,
      ].filter(Boolean).join("\n"),
      value: {
        classification: eventSummary.classification,
        match_rate: eventSummary.match_rate,
        remove_count: eventSummary.remove_count,
        upload_count: eventSummary.upload_count,
        rename_count: eventSummary.rename_count,
        total_matched: totalMatched,
        sample_pairs: eventSummary.sample_pairs,
      },
      observedAt: eventSummary.observed_at,
    });
  }

  return facts;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

function unique(ss: string[]): string[] {
  return Array.from(new Set(ss));
}

function dedupeByNas<T>(
  rows: Array<Record<string, unknown>>,
  nasFilter: string[],
  mapper: (row: Record<string, unknown>) => T,
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const row of rows) {
    const nasId = row.nas_id as string;
    if (!nasId) continue;
    if (nasFilter.length > 0 && !nasFilter.some((n) => nasId.includes(n) || n.includes(nasId))) continue;
    if (seen.has(nasId)) continue;
    seen.add(nasId);
    result.push(mapper(row));
  }
  return result;
}
