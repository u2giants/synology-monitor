-- Add second opinion model setting
INSERT INTO smon_ai_settings (key, value) VALUES
  ('second_opinion_model', 'anthropic/claude-sonnet-4')
ON CONFLICT (key) DO NOTHING;

-- Add related_problem_ids to link problems that share a root cause
ALTER TABLE smon_analyzed_problems
ADD COLUMN IF NOT EXISTS related_problem_ids text[] DEFAULT '{}';
