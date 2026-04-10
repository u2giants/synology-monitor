-- Add status and error tracking to analysis runs
ALTER TABLE smon_analysis_runs 
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'success',
  ADD COLUMN IF NOT EXISTS error_message TEXT;

-- status values: 'success' | 'failed'
COMMENT ON COLUMN smon_analysis_runs.status IS 'success or failed';
COMMENT ON COLUMN smon_analysis_runs.error_message IS 'Error details if status=failed';
