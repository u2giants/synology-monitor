-- Migration: Add sync remediations table for tracking ShareSync fix operations
-- Run this migration against your Supabase database

-- Create the sync_remediations table
CREATE TABLE IF NOT EXISTS smon_sync_remediations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nas_id UUID NOT NULL REFERENCES smon_nas_units(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  issue_type TEXT NOT NULL CHECK (issue_type IN (
    'sync_conflict',
    'sync_failure',
    'invalid_chars',
    'permission_error',
    'path_not_found',
    'unknown'
  )),
  action_taken TEXT NOT NULL CHECK (action_taken IN (
    'rename_file_to_old',
    'remove_invalid_chars',
    'trigger_resync',
    'restart_sharesync',
    'restart_drive_server',
    'restart_agent',
    'check_status',
    'none'
  )),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',
    'in_progress',
    'completed',
    'failed'
  )),
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  resolved_by TEXT
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_sync_remediations_nas_id ON smon_sync_remediations(nas_id);
CREATE INDEX IF NOT EXISTS idx_sync_remediations_status ON smon_sync_remediations(status);
CREATE INDEX IF NOT EXISTS idx_sync_remediations_issue_type ON smon_sync_remediations(issue_type);
CREATE INDEX IF NOT EXISTS idx_sync_remediations_created_at ON smon_sync_remediations(created_at DESC);

-- Create function to auto-update completed_at when status changes to completed
CREATE OR REPLACE FUNCTION update_remediation_completed_at()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'completed' AND OLD.status != 'completed' THEN
    NEW.completed_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for auto-updating completed_at
DROP TRIGGER IF EXISTS trigger_update_remediation_completed_at ON smon_sync_remediations;
CREATE TRIGGER trigger_update_remediation_completed_at
  BEFORE UPDATE ON smon_sync_remediations
  FOR EACH ROW
  EXECUTE FUNCTION update_remediation_completed_at();

-- Create RLS policies (adjust based on your auth setup)
ALTER TABLE smon_sync_remediations ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to read all remediations
CREATE POLICY "Authenticated users can view remediations"
  ON smon_sync_remediations FOR SELECT
  TO authenticated
  USING (true);

-- Allow service role to do everything
CREATE POLICY "Service role can manage remediations"
  ON smon_sync_remediations FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON smon_sync_remediations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON smon_sync_remediations TO service_role;

-- Add helpful comments
COMMENT ON TABLE smon_sync_remediations IS 'Tracks ShareSync fix operations including conflict resolution, file renaming, and character sanitization';
COMMENT ON COLUMN smon_sync_remediations.nas_id IS 'Reference to the NAS unit where the issue occurred';
COMMENT ON COLUMN smon_sync_remediations.file_path IS 'Full path to the problematic file or folder';
COMMENT ON COLUMN smon_sync_remediations.issue_type IS 'Type of sync issue detected';
COMMENT ON COLUMN smon_sync_remediations.action_taken IS 'The remediation action that was performed';
COMMENT ON COLUMN smon_sync_remediations.status IS 'Current status of the remediation (pending, in_progress, completed, failed)';
COMMENT ON COLUMN smon_sync_remediations.details IS 'Additional JSON details about the issue and resolution';
COMMENT ON COLUMN smon_sync_remediations.resolved_by IS 'Email or identifier of who resolved the issue';
