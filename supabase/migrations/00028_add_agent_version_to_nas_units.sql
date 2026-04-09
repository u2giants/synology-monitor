-- Add agent version tracking to smon_nas_units.
-- Populated by the agent's heartbeat on every startup.
ALTER TABLE smon_nas_units
  ADD COLUMN IF NOT EXISTS agent_version  TEXT,
  ADD COLUMN IF NOT EXISTS agent_built_at TIMESTAMPTZ;
