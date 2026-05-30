-- ============================================================
-- Migration 00036: 3-stage issue-agent config (PLAN.md §8.1/§8.2)
-- ============================================================
-- Build step 1 of the issue-agent rebuild. The rebuild collapses today's seven
-- model-driven stage keys into THREE stages, each with a (model, abstract
-- effort) pair:
--
--   New stage key                         Replaces (7 -> 3 map, PLAN.md §8.2)
--   ------------------------------------  ------------------------------------
--   stage_structurer_model / _effort      extractor_model
--   stage_reasoning_model  / _effort      hypothesis_model, planner_model,
--                                         remediation_planner_model,
--                                         verifier_model (+ reasoner_model alias)
--   stage_explainer_model  / _effort      explainer_model, memory consolidation
--
-- This migration is intentionally ADDITIVE and idempotent:
--   * It SEEDS the six new keys with provider-NATIVE defaults (the rebuild calls
--     provider SDKs directly, not an aggregator — PLAN.md §9.1), so a fresh /
--     cold-boot ai_settings still runs before anyone opens the admin UI (§8.1).
--     These defaults mirror the hardcoded final-fallbacks in the shared
--     capability matrix (packages/shared/src/ai-capabilities.ts) — keep in sync.
--   * It does NOT migrate the old OpenRouter-style values verbatim: those ids
--     (e.g. "anthropic/claude-sonnet-4.6") are not valid provider-native ids.
--     The operator re-selects models in the new admin UI (build step 7); the
--     getters always read the new keys via the service-role client.
--   * It does NOT touch, rename, or drop ANY existing key. The legacy 7-stage
--     keys keep driving the live pipeline until it is removed in build step 8,
--     and the out-of-scope keys second_opinion_model / cluster_model (and the
--     fallback aliases diagnosis_model / remediation_model) are left intact.
--
-- ON CONFLICT DO NOTHING so re-applying is safe and never clobbers an operator
-- choice made after this runs.
--
-- Effort levels are the abstract set minimal | low | medium | high; the
-- per-provider client maps them onto each provider's concrete reasoning control
-- (or omits the parameter when the model has no knob) — PLAN.md §8.3.
-- ============================================================

INSERT INTO public.ai_settings (key, value) VALUES
  -- Stage 1 — Lossless Structurer (cheap, low effort, single-shot)
  ('stage_structurer_model',  'gemini-3.1-flash-lite-preview'),
  ('stage_structurer_effort', 'minimal'),
  -- Stage 2 — Reasoning Core (strong, cached, live tools, resumable; needs tool use)
  ('stage_reasoning_model',   'claude-sonnet-4-6'),
  ('stage_reasoning_effort',  'high'),
  -- Stage 3 — Explainer / Memory (cheap, low effort, single-shot)
  ('stage_explainer_model',   'gemini-3.1-flash-lite-preview'),
  ('stage_explainer_effort',  'low')
ON CONFLICT (key) DO NOTHING;
