-- ============================================================
-- Migration 00037: ai_model_calls — per-call usage + cache observability
-- ============================================================
-- Build step 2 of the issue-agent rebuild (PLAN.md §9.5). Every provider-native
-- model call (callModel) records BOTH the normalized usage struct and the raw
-- native usage object. Without this you cannot see per-provider cache reads/
-- writes, and an un-normalized provider silently reads 0% cache-hit (§9.6).
--
-- `cache_hit_ratio = cached_input_tokens / input_tokens` (input_tokens is the
-- TOTAL prompt count including cached reads, so the ratio is comparable across
-- providers even though Anthropic reports cache reads as separate fields).
--
-- raw_usage keeps each provider's native usage object un-flattened (§9.1) — the
-- normalized columns are for querying; raw_usage is the source of truth for
-- auditing a normalizer.
--
-- Written by the service-role worker (bypasses RLS); read by the dashboard
-- cache_hit_ratio view (build step 7) under an authenticated read policy.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ai_model_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  issue_id uuid,                       -- nullable: single-shot stages may not be issue-scoped
  stage text,                          -- structurer | reasoning | explainer | null
  provider text NOT NULL,              -- anthropic | openai | gemini | deepseek | qwen
  model text NOT NULL,                 -- provider-native model id
  effort text,                         -- abstract effort level: minimal | low | medium | high
  stable_prefix_hash text,             -- cache reuse key (sha256 of the stable prefix)
  input_tokens integer NOT NULL DEFAULT 0,        -- total prompt tokens, incl. cached reads
  output_tokens integer NOT NULL DEFAULT 0,
  cached_input_tokens integer NOT NULL DEFAULT 0, -- prompt tokens served from cache
  cache_write_tokens integer NOT NULL DEFAULT 0,  -- prompt tokens written to cache
  reasoning_tokens integer NOT NULL DEFAULT 0,
  cache_hit_ratio double precision NOT NULL DEFAULT 0,
  finish_reason text,
  raw_usage jsonb                      -- native provider usage object, never flattened
);

CREATE INDEX IF NOT EXISTS ai_model_calls_created_at_idx ON public.ai_model_calls (created_at DESC);
CREATE INDEX IF NOT EXISTS ai_model_calls_issue_id_idx ON public.ai_model_calls (issue_id);
CREATE INDEX IF NOT EXISTS ai_model_calls_stage_idx ON public.ai_model_calls (stage);

ALTER TABLE public.ai_model_calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS authenticated_read ON public.ai_model_calls;
CREATE POLICY authenticated_read ON public.ai_model_calls
  FOR SELECT TO authenticated USING (true);
