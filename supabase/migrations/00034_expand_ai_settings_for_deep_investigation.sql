insert into ai_settings (key, value) values
  ('hypothesis_reasoning_effort', 'medium'),
  ('planner_reasoning_effort', 'medium'),
  ('remediation_planner_reasoning_effort', 'medium'),
  ('verifier_reasoning_effort', 'medium'),
  ('guided_mode_default', 'guided'),
  ('deep_mode_default', 'deep'),
  ('deep_mode_model_override', ''),
  ('deep_mode_reasoning_override', 'high'),
  ('deep_mode_max_messages', '80'),
  ('deep_mode_max_evidence', '150'),
  ('deep_mode_include_raw_logs', 'true'),
  ('context_rebase_threshold_pct', '80'),
  ('escalation_policy', 'ask_always'),
  ('escalation_turn_budget_usd', '0.25'),
  ('escalation_issue_budget_usd', '2.00')
on conflict (key) do nothing;
