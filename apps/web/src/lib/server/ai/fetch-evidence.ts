/**
 * fetch_evidence tool (PLAN.md §5, §6).
 *
 * The retrieval surface over the lossless evidence store (issue_evidence_items).
 * Stage 2 uses it to reach the rest of the evidence on demand — the same way an
 * SSH session greps for more — instead of pre-loading everything into the prompt.
 *
 * It reads SUPABASE only (never the NAS), so it keeps working when Tailscale/NAS
 * is down and Stage 2 degrades to diagnosing from stored telemetry (§7).
 *
 * Safety against a cascade that produces tens of thousands of rows (§5):
 *   - server-side HARD limit cap, regardless of what the model requests;
 *   - a bounded start_time/end_time is REQUIRED;
 *   - a byte cap on the RESULT (not just rows) + per-row body truncation, so one
 *     pathological log line can't blow the budget;
 *   - a cursor (has_more / next_offset / total) — more is never silently dropped;
 *   - an aggregation mode (group_by) so the agent sees the SHAPE of 50k lines
 *     cheaply instead of brute-forcing through them.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
const MAX_RESULT_BYTES = 40_000;
const MAX_BODY_CHARS = 600;

export type EvidenceGroupBy = "source" | "error" | "time_bucket";

export interface FetchEvidenceParams {
  issue_id: string;
  start_time: string; // ISO — REQUIRED, bounds the scan
  end_time: string; // ISO — REQUIRED
  source?: string;
  severity?: string;
  /** Case-insensitive substring match on the event body. */
  query?: string;
  /** Aggregation mode: return counts grouped by this dimension instead of rows. */
  group_by?: EvidenceGroupBy;
  limit?: number;
  offset?: number;
}

export interface FetchEvidenceRow {
  source: string;
  severity: string | null;
  ts: string;
  first_ts: string;
  last_ts: string;
  dedup_count: number;
  in_scope: boolean;
  anomalous: boolean;
  body: string; // may be truncated (body_truncated flag set)
  body_truncated: boolean;
}

export interface FetchEvidenceListResult {
  mode: "list";
  rows: FetchEvidenceRow[];
  total: number; // total matching rows, regardless of paging
  returned: number;
  has_more: boolean;
  next_offset: number | null;
  result_bytes_capped: boolean; // true if the byte cap stopped us before `limit`
}

export interface FetchEvidenceAggregateBucket {
  bucket_key: string;
  match_rows: number;
  total_count: number;
  sample_body: string;
  first_ts: string;
  last_ts: string;
}

export interface FetchEvidenceAggregateResult {
  mode: "aggregate";
  group_by: EvidenceGroupBy;
  buckets: FetchEvidenceAggregateBucket[];
}

export type FetchEvidenceResult = FetchEvidenceListResult | FetchEvidenceAggregateResult;

export async function fetchEvidence(
  supabase: SupabaseClient,
  params: FetchEvidenceParams,
): Promise<FetchEvidenceResult> {
  if (!params.issue_id) throw new Error("fetch_evidence: issue_id is required.");
  if (!params.start_time || !params.end_time) {
    throw new Error("fetch_evidence: start_time and end_time are required (bounded scan).");
  }

  if (params.group_by) {
    const { data, error } = await supabase.rpc("issue_evidence_aggregate", {
      p_issue_id: params.issue_id,
      p_start: params.start_time,
      p_end: params.end_time,
      p_source: params.source ?? null,
      p_group_by: params.group_by,
    });
    if (error) throw error;
    const buckets: FetchEvidenceAggregateBucket[] = (data ?? []).map((b: Record<string, unknown>) => ({
      bucket_key: String(b.bucket_key ?? ""),
      match_rows: Number(b.match_rows ?? 0),
      total_count: Number(b.total_count ?? 0),
      sample_body: truncateBody(String(b.sample_body ?? "")).body,
      first_ts: String(b.first_ts ?? ""),
      last_ts: String(b.last_ts ?? ""),
    }));
    return { mode: "aggregate", group_by: params.group_by, buckets };
  }

  // List mode — clamp the limit server-side regardless of the request.
  const limit = clamp(params.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = Math.max(0, params.offset ?? 0);

  let q = supabase
    .from("issue_evidence_items")
    .select(
      "source, severity, ts, first_ts, last_ts, dedup_count, in_scope, anomalous, body",
      { count: "exact" },
    )
    .eq("issue_id", params.issue_id)
    .gte("ts", params.start_time)
    .lte("ts", params.end_time)
    .order("ts", { ascending: false })
    .range(offset, offset + limit - 1);

  if (params.source) q = q.eq("source", params.source);
  if (params.severity) q = q.eq("severity", params.severity);
  if (params.query) q = q.ilike("body", `%${params.query}%`);

  const { data, error, count } = await q;
  if (error) throw error;

  const rows: FetchEvidenceRow[] = [];
  let bytes = 0;
  let resultBytesCapped = false;
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const { body, body_truncated } = truncateBody(String(r.body ?? ""));
    const row: FetchEvidenceRow = {
      source: String(r.source ?? ""),
      severity: (r.severity as string | null) ?? null,
      ts: String(r.ts ?? ""),
      first_ts: String(r.first_ts ?? ""),
      last_ts: String(r.last_ts ?? ""),
      dedup_count: Number(r.dedup_count ?? 1),
      in_scope: Boolean(r.in_scope),
      anomalous: Boolean(r.anomalous),
      body,
      body_truncated,
    };
    const rowBytes = JSON.stringify(row).length;
    if (bytes + rowBytes > MAX_RESULT_BYTES && rows.length > 0) {
      resultBytesCapped = true;
      break;
    }
    rows.push(row);
    bytes += rowBytes;
  }

  const total = count ?? rows.length;
  const consumed = offset + rows.length;
  const has_more = resultBytesCapped || consumed < total;

  return {
    mode: "list",
    rows,
    total,
    returned: rows.length,
    has_more,
    next_offset: has_more ? consumed : null,
    result_bytes_capped: resultBytesCapped,
  };
}

function truncateBody(body: string): { body: string; body_truncated: boolean } {
  if (body.length <= MAX_BODY_CHARS) return { body, body_truncated: false };
  return { body: `${body.slice(0, MAX_BODY_CHARS)}…`, body_truncated: true };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

/**
 * Tool descriptor for Stage 2's catalog (registered in build step 5). The hard
 * caps live in the executor above, not in the schema, so the model can never
 * widen them by asking for a bigger limit.
 */
export const FETCH_EVIDENCE_TOOL = {
  name: "fetch_evidence",
  description:
    "Page or aggregate the issue's lossless evidence store (stored telemetry). " +
    "Reads Supabase, not the NAS, so it works even when the NAS is offline. " +
    "Aggregate first (group_by) to see the shape, then page into specifics. " +
    "limit is capped server-side at 100; a bounded start_time/end_time is required.",
  parameters: {
    type: "object",
    required: ["start_time", "end_time"],
    properties: {
      start_time: { type: "string", description: "ISO timestamp; lower bound of the scan." },
      end_time: { type: "string", description: "ISO timestamp; upper bound of the scan." },
      source: { type: "string", description: "Filter to one source (e.g. 'system', 'alert')." },
      severity: { type: "string", enum: ["critical", "error", "warning", "info"] },
      query: { type: "string", description: "Case-insensitive substring match on the event body." },
      group_by: {
        type: "string",
        enum: ["source", "error", "time_bucket"],
        description: "Aggregation mode — return grouped counts instead of rows.",
      },
      limit: { type: "integer", description: "Rows to return (clamped to 100)." },
      offset: { type: "integer", description: "Pagination cursor; use next_offset from the prior call." },
    },
  },
} as const;
