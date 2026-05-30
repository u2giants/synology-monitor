-- ============================================================
-- Migration 00038: issue_evidence_items — the lossless evidence store
-- ============================================================
-- Build step 3 of the issue-agent rebuild (PLAN.md §5). Stage 1 (the lossless
-- structurer) writes the FULL deduped telemetry for an issue window here — every
-- distinct event kept in full, only byte-identical repetition collapsed into a
-- {body, dedup_count, first_ts, last_ts} group. Nothing distinct is dropped.
--
-- This is deliberately separate from the existing `issue_evidence` table, which
-- holds a handful of curated, model-authored evidence notes (title/detail). This
-- table is the raw, complete, machine-deduped record that Stage 2 reaches into on
-- demand via the fetch_evidence tool (§5/§6) — the rest of the lossless set that
-- doesn't fit the bounded prompt slice.
--
-- Written by the service-role worker (bypasses RLS); read by the worker and the
-- dashboard under an authenticated read policy.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.issue_evidence_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL,
  nas_id text,                          -- affected NAS name/id, when known
  source text NOT NULL,                 -- telemetry source (nas_logs source, "alerts", "process_snapshots", …)
  severity text,                        -- critical | error | warning | info | null
  ts timestamptz NOT NULL,              -- representative event time (last occurrence)
  first_ts timestamptz NOT NULL,        -- earliest occurrence in the collapsed group
  last_ts timestamptz NOT NULL,         -- latest occurrence in the collapsed group
  body text NOT NULL,                   -- the full, untruncated event text (the dedup key with source)
  dedup_count integer NOT NULL DEFAULT 1, -- byte-identical occurrences collapsed into this row
  in_scope boolean NOT NULL DEFAULT false,  -- relevant to the issue's NAS / fingerprint
  anomalous boolean NOT NULL DEFAULT false, -- breaks the baseline (severity / state change)
  metadata jsonb,                       -- structured fields preserved from the source row
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS issue_evidence_items_issue_idx ON public.issue_evidence_items (issue_id);
CREATE INDEX IF NOT EXISTS issue_evidence_items_issue_source_idx ON public.issue_evidence_items (issue_id, source);
CREATE INDEX IF NOT EXISTS issue_evidence_items_issue_ts_idx ON public.issue_evidence_items (issue_id, ts DESC);
CREATE INDEX IF NOT EXISTS issue_evidence_items_issue_flags_idx ON public.issue_evidence_items (issue_id, anomalous, in_scope);

ALTER TABLE public.issue_evidence_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS authenticated_read ON public.issue_evidence_items;
CREATE POLICY authenticated_read ON public.issue_evidence_items
  FOR SELECT TO authenticated USING (true);

-- Aggregation mode for fetch_evidence (§5): lets the agent see the *shape* of a
-- large evidence set cheaply (count/group-by) instead of paging through tens of
-- thousands of rows. Grouped by source, normalized error signature, or hour.
CREATE OR REPLACE FUNCTION public.issue_evidence_aggregate(
  p_issue_id uuid,
  p_start timestamptz,
  p_end timestamptz,
  p_source text DEFAULT NULL,
  p_group_by text DEFAULT 'source'
)
RETURNS TABLE (
  bucket_key text,
  match_rows bigint,
  total_count bigint,
  sample_body text,
  first_ts timestamptz,
  last_ts timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    CASE p_group_by
      WHEN 'time_bucket' THEN to_char(date_trunc('hour', i.ts), 'YYYY-MM-DD HH24:00')
      WHEN 'error' THEN left(regexp_replace(coalesce(i.body, ''), '[0-9]+', '#', 'g'), 120)
      ELSE i.source
    END AS bucket_key,
    count(*) AS match_rows,
    sum(coalesce(i.dedup_count, 1)) AS total_count,
    min(i.body) AS sample_body,
    min(i.first_ts) AS first_ts,
    max(i.last_ts) AS last_ts
  FROM public.issue_evidence_items i
  WHERE i.issue_id = p_issue_id
    AND i.ts >= p_start
    AND i.ts <= p_end
    AND (p_source IS NULL OR i.source = p_source)
  GROUP BY 1
  ORDER BY total_count DESC
  LIMIT 200;
$$;
